import assert from "node:assert/strict";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  createRunLogSink,
  defaultEnvFile,
  main,
  type AgentExecution,
  type AgentExecutionContext,
} from "../index.js";
import { withTempDir } from "./helpers/temp-dir.js";
import { loadRunRecord } from "../src/run-record.js";
import { webRuntimeConfig, minimalWebProjectSpec, npmExecutable } from "../src/adapters/web/project-spec.js";
import { GitCliOps } from "../src/git-ops.js";
import { saveImplementationDigests } from "../src/evolution.js";

test("Build discovers project progress after an interruption without selecting an old private run", async () => {
  await withTempDir("shallow-entry-local-progress-", async root => {
    const project = join(root, "project"), requirements = join(project, "requirements");
    await mkdir(requirements, { recursive: true });
    await writeFile(join(project, "server.js"), "current source");
    await writeFile(join(project, "shallowcode.config.json"), JSON.stringify({ start: { executable: "node", args: ["server.js"] } }));
    const input = { id: "ROOT", name: "Product", type: "ROOT", children: [
      { id: "A", name: "A", type: "ATOMIC", description: "Display A." },
      { id: "B", name: "B", type: "ATOMIC", description: "Display B." },
    ] };
    await writeFile(join(requirements, "requirements.yaml"), JSON.stringify(input));
    await assert.rejects(main([], { ...gatewayEnv(), SHALLOW_RUN_DIR: join(root, "first-runs") }, async context => {
      await writeFile(join(project, "server.js"), "partial implementation");
      await saveImplementationDigests(context.pipelineOptions.progressDir!, context.pipelineOptions.requirementDigests!, ["A", "B"]);
      throw new Error("manual interruption");
    }, null, project), /manual interruption/);
    input.children[1].description = "Display the updated B.";
    input.children.push({ id: "C", name: "C", type: "ATOMIC", description: "Display C." });
    await writeFile(join(requirements, "requirements.yaml"), JSON.stringify(input));
    await writeFile(join(project, "user.txt"), "user modification after exit");
    assert.equal(await main([], { ...gatewayEnv(), SHALLOW_RUN_DIR: join(root, "different-runs") }, async context => {
      assert.equal(context.pipelineOptions.outputDir, project);
      assert.deepEqual(context.pipelineOptions.resumedRequirementIds, ["A"]);
      assert.equal(await readFile(join(project, "server.js"), "utf8"), "partial implementation");
      assert.equal(await readFile(join(project, "user.txt"), "utf8"), "user modification after exit");
      return { status: "partial", acceptedSha: "sha", verifiedRequirementIds: [], blockedRequirementIds: [] };
    }, null, project), 2);
  });
});

test("Repeated production builds use current files and requirements in place with private checkpoints", { timeout: 90_000 }, async () => {
  await withTempDir("shallow-entry-continue-", async root => {
    const source = join(root, "project"), requirements = join(source, "requirements"), runs = join(root, "runs");
    await mkdir(requirements, { recursive: true });
    await writeFile(join(source, "server.mjs"), `import { createServer } from 'node:http';
createServer((req,res) => { if(req.url==='/health') return res.end('ok');
if(req.url==='/web') { res.setHeader('content-type','text/html'); return res.end('<html><body>Ready</body></html>'); }
res.statusCode=404; res.end('missing'); }).listen(Number(process.env.PORT),'127.0.0.1');`);
    await writeFile(join(source, "shallowcode.config.json"), JSON.stringify({ start: { executable: process.execPath, args: ["server.mjs"] }, browserPath: "/web" }));
    const requirementFile = join(requirements, "requirements.yaml");
    await writeFile(requirementFile, "id: ROOT\nname: Demo\ntype: ROOT\nchildren: []\n");
    const env = { ...gatewayEnv(), SHALLOW_RUN_DIR: runs };
    assert.equal(await main([], env, undefined, null, source), 0);
    const first = join(runs, (await readdir(runs)).find(name => !name.startsWith("."))!);
    const record = await loadRunRecord(first);
    assert.equal(record.outputDir, source);
    assert.equal(record.sourceProjectDir, undefined);
    assert.equal(record.checkpointGitDirectory, join(first, "checkpoints.git"));
    await assert.rejects(access(join(source, ".git")), "controller checkpoints do not create an application repository");
    const originalLedger = await readFile(join(first, "run-ledger.jsonl"), "utf8");
    await writeFile(join(source, "interrupted.txt"), "keep current work");
    await writeFile(requirementFile, "id: ROOT\nname: Changed\ntype: ROOT\nchildren: []\n");
    const config = JSON.parse(await readFile(join(source, "shallowcode.config.json"), "utf8"));
    config.env = { CURRENT_CONTRACT: "changed" };
    await writeFile(join(source, "shallowcode.config.json"), JSON.stringify(config));
    assert.equal(await main([], env, undefined, null, source), 0);
    assert.equal(await readFile(join(source, "interrupted.txt"), "utf8"), "keep current work");
    assert.equal(await readFile(join(first, "run-ledger.jsonl"), "utf8"), originalLedger);
    const second = join(runs, (await readdir(runs)).find(name => !name.startsWith(".") && join(runs, name) !== first)!);
    const continued = await loadRunRecord(second);
    assert.equal(continued.outputDir, source);
    assert.equal(continued.resumedFrom, undefined);
    assert.deepEqual(continued.projectSpec.env, { CURRENT_CONTRACT: "changed" });
    assert.notEqual(continued.requirementsDigest, record.requirementsDigest);
    assert.notEqual(continued.contractDigest, record.contractDigest);
    await assert.rejects(access(join(second, "workspace")));
    await assert.rejects(access(join(second, "changes.patch")));
  });
});

test("Existing project entry develops in place and passes its current declared runtime", async () => {
  await withTempDir("shallow-entry-project-", async root => {
    const source = join(root, "project"), requirements = join(root, "requirements");
    await mkdir(source); await mkdir(requirements);
    await writeFile(join(source, "server.js"), "original source");
    await writeFile(join(source, "shallowcode.config.json"), JSON.stringify({ start: { executable: "node", args: ["server.js"] },
      tests: [{ id: "unit", executable: "node", args: ["--test"] }], env: { FLAG: "declared" }, dataPaths: ["storage"] }));
    await writeFile(join(requirements, "requirements.yaml"), "id: ROOT\nname: Demo\ntype: ROOT\nchildren: []\n");
    await main(["--requirements-dir", requirements, "--project", source], { ...gatewayEnv(), SHALLOW_RUN_DIR: join(root, "runs") }, async context => {
      assert.equal(context.pipelineOptions.outputDir, source);
      assert.equal(context.pipelineOptions.stageStartingPoint, "inherited_application");
      assert.deepEqual(context.pipelineOptions.applicationContract.env, { FLAG: "declared" });
      assert.equal(context.pipelineOptions.applicationContract.testTargets?.[0].id, "unit");
      await writeFile(join(context.pipelineOptions.outputDir, "server.js"), "implemented");
      return { status: "delivered", acceptedSha: "sha", verifiedRequirementIds: [], blockedRequirementIds: [] };
    }, null);
    assert.equal(await readFile(join(source, "server.js"), "utf8"), "implemented");
  });
});

test("An existing Web project without a run declaration reports the missing configuration", async () => {
  await withTempDir("shallow-entry-project-", async root => {
    const source = join(root, "project"), requirements = join(root, "requirements");
    await mkdir(source); await mkdir(requirements);
    await writeFile(join(source, "server.js"), "source");
    await writeFile(join(requirements, "requirements.yaml"), "id: ROOT\nname: Demo\ntype: ROOT\nchildren: []\n");
    await assert.rejects(main(["--requirements-dir", requirements, "--project", source], gatewayEnv(), async () => { throw new Error("must not execute"); }, null), /Missing project run configuration/);
  });
});

test("An output directory carrying only requirements metadata starts a blank template run and writes its report", async () => {
  await withTempDir("shallow-entry-metadata-", async root => {
    const output = join(root, "web2");
    const requirements = join(output, "requirements");
    await mkdir(requirements, { recursive: true });
    await writeFile(join(requirements, "requirements.yaml"), "id: ROOT\nname: Root\ntype: FOLDER\nchildren: []\n");
    // req 生成后残留的草稿目录属于元数据，输出目录仍按空白模板处理。
    await mkdir(join(output, ".requirements-agent"));
    let received: AgentExecutionContext | undefined;
    const exitCode = await main(
      ["--requirements-dir", requirements, "--output-dir", output],
      { ...gatewayEnv(), SHALLOW_RUN_DIR: join(root, "runs") },
      async context => {
        received = context;
        const git = await GitCliOps.open(context.pipelineOptions.outputDir);
        const baseline = await git.captureAccepted("input baseline");
        context.runRecord.inputBaseline = baseline;
        await writeFile(join(output, "app.txt"), "implemented\n");
        return { status: "delivered", acceptedSha: baseline, verifiedRequirementIds: [], blockedRequirementIds: [] };
      },
      null,
    );
    assert.equal(exitCode, 0);
    assert.equal(received?.runRecord.sourceProjectDir, undefined, "req 元数据目录不应被当作已有项目");
    assert.equal(received?.pipelineOptions.outputDir, output);
    assert.deepEqual(received?.runRecord.projectSpec, minimalWebProjectSpec(npmExecutable()), "空白目录使用随附模板的运行合同");
    const run = join(root, "runs", (await readdir(join(root, "runs")))[0]);
    assert.equal(await readFile(join(output, "app.txt"), "utf8"), "implemented\n");
    await assert.rejects(access(join(run, "changes.patch")));
    assert.equal(JSON.parse(await readFile(join(run, "result.json"), "utf8")).status, "delivered");
    await access(join(run, "report.md"));
    await access(join(output, ".requirements-agent"));
  });
});

test("Agent entry validates paths and passes bounded production context", async () => {
  await withTempDir("shallow-entry-", async (directory) => {
    const requirementsDir = join(directory, "requirements");
    const outputDir = join(directory, "output");
    await mkdir(requirementsDir);
    await writeFile(
      join(requirementsDir, "requirements.yaml"),
      "id: ROOT\nname: Root\ntype: FOLDER\ndependencies: []\ndescription: Root\nchildren: []\n",
    );
    let received: AgentExecutionContext | undefined;
    const execute: AgentExecution = async (context) => {
      received = context;
      return {
        status: "delivered",
        verifiedRequirementIds: [],
        blockedRequirementIds: [],
        acceptedSha: "sha",
      };
    };

    const exitCode = await main(
      [
        "--requirements-dir",
        requirementsDir,
        "--output-dir",
        outputDir,
        "--budget-ms",
        "600000",
      ],
      { ...gatewayEnv(), SHALLOW_PROBE_PORT: "3100", SHALLOW_BUILDER_CONTEXT_WINDOW: "400000" },
      execute,
      null,
    );

    assert.equal(exitCode, 0);
    assert.equal(received?.builderGateway.model, "provider/model");
    assert.equal(received?.verifierGateway.model, "provider/model");
    assert.equal(received?.grouperGateway.model, "provider/model");
    assert.equal(received?.pipelineOptions.requirementsFile, join(dirname(received!.pipelineOptions.ledgerFile), "requirements", "requirements.yaml"));
    assert.equal(await readFile(received!.pipelineOptions.requirementsFile, "utf8"), await readFile(join(requirementsDir, "requirements.yaml"), "utf8"));
    assert.equal(received?.pipelineOptions.outputDir, outputDir);
    assert.equal(received?.pipelineOptions.totalBudgetMs, 600_000);
    assert.equal(webRuntimeConfig(received?.pipelineOptions.applicationContract!).port, 3100);
    assert.equal(received?.builderContextWindow, 400_000);
    assert.equal(received?.requirementTree?.id, "ROOT");
    assert.equal(received?.pipelineOptions.auditInheritedRequirements, false);
  });
});


test("Agent entry loads the Evolution audit switch from env files with real env winning", async () => {
  await withTempDir("shallow-entry-evolution-audit-", async directory => {
    const requirementsDir = join(directory, "requirements");
    await mkdir(requirementsDir);
    await writeFile(join(requirementsDir, "requirements.yaml"), "id: ROOT\nname: Root\ntype: FOLDER\nchildren: []\n");
    const envFile = join(directory, "gateway.env");
    await writeFile(envFile, "SHALLOW_EVOLUTION_AUDIT_INHERITED=0\n");
    const argv = ["--requirements-dir", requirementsDir, "--output-dir", join(directory, "output")];
    const received: boolean[] = [];
    const execute: AgentExecution = async context => {
      received.push(context.pipelineOptions.auditInheritedRequirements!);
      return { status: "delivered", verifiedRequirementIds: [], blockedRequirementIds: [], acceptedSha: "sha" };
    };
    await main(argv, gatewayEnv(), execute, envFile);
    await main(argv, { ...gatewayEnv(), SHALLOW_EVOLUTION_AUDIT_INHERITED: "1" }, execute, envFile);
    assert.deepEqual(received, [false, true]);
  });
});

test("Agent entry picks a non-3000 probe port when the override is absent", async () => {
  await withTempDir("shallow-entry-", async (directory) => {
    const requirementsDir = join(directory, "requirements");
    const outputDir = join(directory, "output");
    await mkdir(requirementsDir);
    await writeFile(
      join(requirementsDir, "requirements.yaml"),
      "id: ROOT\nname: Root\ntype: FOLDER\ndependencies: []\ndescription: Root\nchildren: []\n",
    );
    let received: AgentExecutionContext | undefined;
    const execute: AgentExecution = async (context) => {
      received = context;
      return {
        status: "delivered",
        verifiedRequirementIds: [],
        blockedRequirementIds: [],
        acceptedSha: "sha",
      };
    };

    await main(
      [
        "--requirements-dir",
        requirementsDir,
        "--output-dir",
        outputDir,
        "--budget-ms",
        "0",
      ],
      gatewayEnv(),
      execute,
      null,
    );

    const contract = received?.pipelineOptions.applicationContract;
    assert.ok(contract);
    assert.notEqual(webRuntimeConfig(contract).port, 3000);
    assert.equal(webRuntimeConfig(contract).baseUrl, `http://127.0.0.1:${webRuntimeConfig(contract).port}`);
    assert.equal(received?.builderContextWindow, 256_000);
  });
});

test("Agent entry honors SHALLOW_EVAL_PORT and keeps the probe port off it", async () => {
  await withTempDir("shallow-entry-", async (directory) => {
    const requirementsDir = join(directory, "requirements");
    await mkdir(requirementsDir);
    await writeFile(
      join(requirementsDir, "requirements.yaml"),
      "id: ROOT\nname: Root\ntype: FOLDER\ndependencies: []\ndescription: Root\nchildren: []\n",
    );
    let received: AgentExecutionContext | undefined;
    const execute: AgentExecution = async (context) => {
      received = context;
      return { status: "delivered", verifiedRequirementIds: [], blockedRequirementIds: [], acceptedSha: "sha" };
    };

    await main(
      ["--requirements-dir", requirementsDir, "--output-dir", join(directory, "output"), "--budget-ms", "0"],
      { ...gatewayEnv(), SHALLOW_EVAL_PORT: "43100" },
      execute,
      null,
    );

    const contract = received?.pipelineOptions.applicationContract;
    assert.equal(webRuntimeConfig(contract!).evaluationPort, 43100);
    assert.notEqual(webRuntimeConfig(contract!).port, 43100);
    assert.notEqual(webRuntimeConfig(contract!).port, 3000);
  });
});

test("Agent entry rejects a probe port equal to the evaluation port", async () => {
  await withTempDir("shallow-entry-", async (directory) => {
    const requirementsDir = join(directory, "requirements");
    await mkdir(requirementsDir);
    await writeFile(
      join(requirementsDir, "requirements.yaml"),
      "id: ROOT\nname: Root\ntype: FOLDER\ndependencies: []\ndescription: Root\nchildren: []\n",
    );
    await assert.rejects(
      main(
        ["--requirements-dir", requirementsDir, "--output-dir", join(directory, "output"), "--budget-ms", "0"],
        { ...gatewayEnv(), SHALLOW_EVAL_PORT: "43100", SHALLOW_PROBE_PORT: "43100" },
        async () => { throw new Error("must not execute"); },
        null,
      ),
      /evaluation port 43100/,
    );
  });
});

test("Agent entry rejects a missing requirements.yaml before execution", async () => {
  await withTempDir("shallow-entry-", async (directory) => {
    let calls = 0;
    const execute: AgentExecution = async () => {
      calls += 1;
      throw new Error("must not execute");
    };

    await assert.rejects(
      main(
        [
          "--requirements-dir",
          join(directory, "missing"),
          "--output-dir",
          join(directory, "output"),
          "--budget-ms",
          "600000",
        ],
        gatewayEnv(),
        execute,
        null,
      ),
      /requirements\.yaml/,
    );
    assert.equal(calls, 0);
  });
});

test("Agent entry returns a non-zero exit code when final delivery fails", async () => {
  await withTempDir("shallow-entry-", async (directory) => {
    const requirementsDir = join(directory, "requirements");
    await mkdir(requirementsDir);
    await writeFile(
      join(requirementsDir, "requirements.yaml"),
      "id: ROOT\nname: Root\ntype: FOLDER\ndependencies: []\ndescription: Root\nchildren: []\n",
    );
    const execute: AgentExecution = async () => ({
      status: "failed",
      verifiedRequirementIds: [],
      blockedRequirementIds: [],
      acceptedSha: "sha",
    });

    const exitCode = await main(
      [
        "--requirements-dir",
        requirementsDir,
        "--output-dir",
        join(directory, "output"),
        "--budget-ms",
        "600000",
      ],
        gatewayEnv(),
        execute,
        null,
      );

      assert.equal(exitCode, 1);
  });
});

test("Agent entry loads the gateway from an env file with real env winning", async () => {
  await withTempDir("shallow-entry-", async (directory) => {
    const requirementsDir = join(directory, "requirements");
    await mkdir(requirementsDir);
    await writeFile(
      join(requirementsDir, "requirements.yaml"),
      "id: ROOT\nname: Root\ntype: FOLDER\ndependencies: []\ndescription: Root\nchildren: []\n",
    );
    await writeFile(
      join(directory, "gateway.env"),
      [
        "# gateway config",
        "OPENAI_API_KEY=file-key",
        "OPENAI_BASE_URL=https://file.example/v1",
        'MODEL="file/model"',
        "SHALLOW_BUILDER_MODEL=file/builder",
        "SHALLOW_VERIFIER_MODEL=file/verifier",
        "SHALLOW_GROUPER_MODEL=file/grouper",
        "SHALLOW_GROUPER_API_KEY=grouper-file-key",
        "SHALLOW_GROUPER_BASE_URL=https://grouper.example/v1",
        "SHALLOW_GROUPER_COST_INPUT=1",
        "SHALLOW_GROUPER_COST_OUTPUT=2",
        "SHALLOW_GROUPER_COST_CACHE_READ=0.5",
        "SHALLOW_GROUPER_COST_CACHE_WRITE=0",
        "SHALLOW_VERIFIER_SEMANTIC_REVIEW=1",
        "SHALLOW_VERIFIER_REPLAY=1",
        'SHALLOW_PROBE_PORT=3210',
      ].join("\n"),
    );
    let received: AgentExecutionContext | undefined;
    const execute: AgentExecution = async (context) => {
      received = context;
      return {
        status: "delivered",
        verifiedRequirementIds: [],
        blockedRequirementIds: [],
        acceptedSha: "sha",
      };
    };
    const argv = [
      "--requirements-dir",
      requirementsDir,
      "--output-dir",
      join(directory, "output"),
      "--budget-ms",
      "0",
    ];

    await main(argv, {}, execute, join(directory, "gateway.env"));
    assert.equal(received?.builderGateway.apiKey, "file-key");
    assert.equal(received?.builderGateway.baseUrl, "https://file.example/v1");
    assert.equal(received?.builderGateway.model, "file/builder");
    assert.equal(received?.verifierGateway.model, "file/verifier");
    assert.equal(received?.verifierGateway.apiKey, "file-key");
    assert.deepEqual(received?.grouperGateway, { apiKey: "grouper-file-key", baseUrl: "https://grouper.example/v1", model: "file/grouper" });
    assert.deepEqual(received?.grouperModelCost, { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 });
    assert.equal(received?.pipelineOptions.verifier.semanticReview, true);
    assert.equal(received?.pipelineOptions.verifier.replay, true);
    assert.equal(webRuntimeConfig(received?.pipelineOptions.applicationContract!).port, 3210);

    await main(argv, { MODEL: "env/model", SHALLOW_BUILDER_MODEL: "env/builder", SHALLOW_VERIFIER_MODEL: "env/verifier", SHALLOW_GROUPER_MODEL: "env/grouper", SHALLOW_VERIFIER_SEMANTIC_REVIEW: "0", SHALLOW_VERIFIER_REPLAY: "0" }, execute, join(directory, "gateway.env"));
    assert.equal(received?.builderGateway.model, "env/builder");
    assert.equal(received?.builderGateway.apiKey, "file-key");
    assert.equal(received?.verifierGateway.model, "env/verifier");
    assert.equal(received?.grouperGateway.model, "env/grouper");
    assert.equal(received?.pipelineOptions.verifier.semanticReview, false);
    assert.equal(received?.pipelineOptions.verifier.replay, false);
    await assert.rejects(main(argv, {}, async () => { throw new Error("grouper failed with grouper-file-key"); }, join(directory, "gateway.env")),
      error => error instanceof Error && error.message.includes("grouper failed") && !error.message.includes("grouper-file-key"));
  });
});

test("Agent entry places run artifacts under SHALLOW_RUN_DIR when set", async () => {
  await withTempDir("shallow-entry-", async (directory) => {
    const requirementsDir = join(directory, "requirements");
    const outputDir = join(directory, "output");
    await mkdir(requirementsDir);
    await writeFile(
      join(requirementsDir, "requirements.yaml"),
      "id: ROOT\nname: Root\ntype: FOLDER\ndependencies: []\ndescription: Root\nchildren: []\n",
    );
    const runDir = join(directory, "runs");
    let received: AgentExecutionContext | undefined;
    const execute: AgentExecution = async (context) => {
      received = context;
      return {
        status: "delivered",
        verifiedRequirementIds: [],
        blockedRequirementIds: [],
        acceptedSha: "sha",
      };
    };

    await main(
      [
        "--requirements-dir",
        requirementsDir,
        "--output-dir",
        outputDir,
        "--budget-ms",
        "0",
      ],
      { ...gatewayEnv(), SHALLOW_RUN_DIR: runDir },
      execute,
      null,
    );

    const ledgerFile = received?.pipelineOptions.ledgerFile ?? "";
    assert.equal(basename(ledgerFile), "run-ledger.jsonl");
    assert.equal(dirname(dirname(ledgerFile)), runDir);
    assert.equal(received?.sseCaptureDir, null, "SSE capture must stay off unless opted in");
  });
});

test("Agent entry resolves the opt-in SSE capture directory next to the run log", async () => {
  await withTempDir("shallow-entry-", async (directory) => {
    const requirementsDir = join(directory, "requirements");
    const outputDir = join(directory, "output");
    await mkdir(requirementsDir);
    await writeFile(
      join(requirementsDir, "requirements.yaml"),
      "id: ROOT\nname: Root\ntype: FOLDER\ndependencies: []\ndescription: Root\nchildren: []\n",
    );
    let received: AgentExecutionContext | undefined;
    const execute: AgentExecution = async (context) => {
      received = context;
      return {
        status: "delivered",
        verifiedRequirementIds: [],
        blockedRequirementIds: [],
        acceptedSha: "sha",
      };
    };

    await main(
      ["--requirements-dir", requirementsDir, "--output-dir", outputDir],
      { ...gatewayEnv(), SHALLOW_RUN_DIR: join(directory, "runs"), SHALLOW_CAPTURE_SSE: "1" },
      execute,
      null,
    );

    const ledgerFile = received?.pipelineOptions.ledgerFile ?? "";
    assert.equal(received?.sseCaptureDir, join(dirname(ledgerFile), "sse-capture"));
  });
});

test("Agent entry takes extra ports from the project's own run configuration", async () => {
  await withTempDir("shallow-entry-", async (directory) => {
    const requirementsDir = join(directory, "requirements");
    const outputDir = join(directory, "output");
    await mkdir(requirementsDir);
    await mkdir(outputDir);
    await writeFile(
      join(requirementsDir, "requirements.yaml"),
      "id: ROOT\nname: Root\ntype: FOLDER\ndependencies: []\ndescription: Root\nchildren: []\n",
    );
    await writeFile(join(outputDir, "shallowcode.config.json"), JSON.stringify({
      start: { executable: "node", args: ["server.js"] },
      extraPorts: [3301, 4400],
    }), "utf8");
    let received: AgentExecutionContext | undefined;
    const execute: AgentExecution = async (context) => {
      received = context;
      return {
        status: "delivered",
        verifiedRequirementIds: [],
        blockedRequirementIds: [],
        acceptedSha: "sha",
      };
    };

    await main(
      ["--requirements-dir", requirementsDir, "--output-dir", outputDir],
      gatewayEnv(),
      execute,
      null,
    );

    const contract = received?.pipelineOptions.applicationContract;
    assert.deepEqual(webRuntimeConfig(contract!).extraPorts, [3301, 4400]);
    assert.deepEqual(contract?.startCommand, { executable: "node", args: ["server.js"], cwd: "output" });
    assert.ok(!webRuntimeConfig(contract!).extraPorts?.includes(webRuntimeConfig(contract!).port));
  });
});

test("Agent entry rejects a probe port that collides with a project-declared extra port", async () => {
  await withTempDir("shallow-entry-", async (directory) => {
    const requirementsDir = join(directory, "requirements");
    const outputDir = join(directory, "output");
    await mkdir(requirementsDir);
    await mkdir(outputDir);
    await writeFile(
      join(requirementsDir, "requirements.yaml"),
      "id: ROOT\nname: Root\ntype: FOLDER\ndependencies: []\ndescription: Root\nchildren: []\n",
    );
    await writeFile(join(outputDir, "shallowcode.config.json"), JSON.stringify({
      start: { executable: "node", args: ["server.js"] },
      extraPorts: [3301],
    }), "utf8");

    await assert.rejects(
      main(
        ["--requirements-dir", requirementsDir, "--output-dir", outputDir],
        { ...gatewayEnv(), SHALLOW_PROBE_PORT: "3301" },
        async () => ({ status: "delivered", verifiedRequirementIds: [], blockedRequirementIds: [], acceptedSha: "sha" }),
        null,
      ),
      /SHALLOW_PROBE_PORT/,
    );
  });
});

test("Agent entry keeps default run artifacts under the temp shallowcode-runs directory", async () => {
  await withTempDir("shallow-entry-", async (directory) => {
    const requirementsDir = join(directory, "requirements");
    await mkdir(requirementsDir);
    await writeFile(
      join(requirementsDir, "requirements.yaml"),
      "id: ROOT\nname: Root\ntype: FOLDER\ndependencies: []\ndescription: Root\nchildren: []\n",
    );
    let received: AgentExecutionContext | undefined;
    const execute: AgentExecution = async (context) => {
      received = context;
      return {
        status: "delivered",
        verifiedRequirementIds: [],
        blockedRequirementIds: [],
        acceptedSha: "sha",
      };
    };

    await main(
      [
        "--requirements-dir",
        requirementsDir,
        "--output-dir",
        join(directory, "output"),
        "--budget-ms",
        "0",
      ],
      gatewayEnv(),
      execute,
      null,
    );

    const ledgerDir = dirname(received?.pipelineOptions.ledgerFile ?? "");
    assert.equal(basename(dirname(ledgerDir)), "shallowcode-runs");
    assert.equal(dirname(dirname(ledgerDir)), tmpdir());
  });
});

test("The default gateway env file stays anchored to the repository root", async () => {
  const anchored = defaultEnvFile();
  assert.equal(anchored, fileURLToPath(new URL("../.env", import.meta.url)));
  await withTempDir("shallow-entry-env-", async (directory) => {
    const before = process.cwd();
    process.chdir(directory);
    try {
      // 启动目录变化不改变默认凭证文件：全局命令在任意目录都能读到仓库根 .env。
      assert.equal(defaultEnvFile(), anchored);
    } finally {
      process.chdir(before);
    }
  });
});

test("Agent entry defaults to current-directory requirement discovery and output", async () => {
  await withTempDir("shallow-entry-defaults-", async directory => {
    const requirementsDir = join(directory, "requirements");
    await mkdir(requirementsDir);
    const requirementText = "id: ROOT\nname: Root\ntype: ROOT\nchildren: []\n";
    await writeFile(join(requirementsDir, "requirements.yaml"), requirementText);
    let received: AgentExecutionContext | undefined;
    const execute: AgentExecution = async context => {
      received = context;
      return { status: "delivered", verifiedRequirementIds: [], blockedRequirementIds: [], acceptedSha: "sha" };
    };

    assert.equal(await main([], gatewayEnv(), execute, null, directory), 0);
    assert.equal(received?.runRecord.requirementsDir, requirementsDir);
    assert.equal(received?.pipelineOptions.outputDir, directory);
    assert.equal(await readFile(received!.pipelineOptions.requirementsFile, "utf8"), requirementText);
  });
});

test("Agent entry rejects ambiguous or missing default requirement discovery before execution", async () => {
  await withTempDir("shallow-entry-ambiguous-", async directory => {
    let calls = 0;
    const execute: AgentExecution = async () => {
      calls += 1;
      throw new Error("must not execute");
    };

    await assert.rejects(main([], gatewayEnv(), execute, null, directory), /No requirements\.yaml/);
    for (const name of ["a", "b"]) {
      await mkdir(join(directory, name));
      await writeFile(join(directory, name, "requirements.yaml"), "id: ROOT\nname: Root\ntype: ROOT\nchildren: []\n");
    }
    await assert.rejects(main([], gatewayEnv(), execute, null, directory), /Multiple requirements\.yaml/);
    assert.equal(calls, 0);
  });
});

test("Run console output uses the human-readable log line", async () => {
  await withTempDir("shallow-entry-console-", async directory => {
    const written: string[] = [];
    const sink = createRunLogSink(join(directory, "run-log.txt"), undefined, {
      write: chunk => { written.push(chunk); },
    });
    const event = {
      at: "2026-01-01T00:00:00.000Z", type: "phase_started", detail: { phase: "implementation" },
      runId: "run", eventId: "run:1", sequence: 1, phase: "pipeline",
    };

    sink.write(`${JSON.stringify(event)}\n`);
    assert.equal(written.length, 1);
    assert.match(written[0], /进入模块实现阶段/);
    assert.doesNotMatch(written[0], /"phase_started"/);
    assert.match(await readFile(join(directory, "run-log.txt"), "utf8"), /进入模块实现阶段/);

    sink.write(`${JSON.stringify({ ...event, type: "not_a_known_event", sequence: 2 })}\n`);
    assert.equal(written.length, 1, "没有人类可读行的机器事件不进入终端");
  });
});

function gatewayEnv(): Record<string, string> {
  return {
    OPENAI_API_KEY: "key",
    OPENAI_BASE_URL: "https://gateway.example/v1",
    MODEL: "provider/model",
  };
}
