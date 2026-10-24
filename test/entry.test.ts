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

test("The production entry resumes an owned checkpoint with fresh artifacts and applies without gateway credentials", { timeout: 60_000 }, async () => {
  await withTempDir("shallow-entry-resume-", async root => {
    const source = join(root, "project"), requirements = join(root, "requirements"), runs = join(root, "runs");
    await mkdir(source); await mkdir(requirements);
    await writeFile(join(source, "server.mjs"), `import { createServer } from 'node:http';
createServer((req,res) => { if(req.url==='/health') return res.end('ok');
if(req.url==='/web') { res.setHeader('content-type','text/html'); return res.end('<html><body>Ready</body></html>'); }
res.statusCode=404; res.end('missing'); }).listen(Number(process.env.PORT),'127.0.0.1');`);
    await writeFile(join(source, "shallowcode.config.json"), JSON.stringify({ start: { executable: process.execPath, args: ["server.mjs"] }, browserPath: "/web" }));
    const requirementFile = join(requirements, "requirements.yaml");
    await writeFile(requirementFile, "id: ROOT\nname: Demo\ntype: ROOT\nchildren: []\n");
    const env = { ...gatewayEnv(), SHALLOW_RUN_DIR: runs };
    assert.equal(await main(["--requirements-dir", requirements, "--project", source], env, undefined, null), 0);
    const first = join(runs, (await readdir(runs))[0]);
    const record = await loadRunRecord(first);
    const originalLedger = await readFile(join(first, "run-ledger.jsonl"), "utf8");
    await writeFile(join(record.outputDir, "interrupted.txt"), "unaccepted work");
    assert.equal(await main(["resume", "--run-dir", first], env, undefined, null), 0);
    await assert.rejects(access(join(record.outputDir, "interrupted.txt")));
    assert.equal(await readFile(join(first, "run-ledger.jsonl"), "utf8"), originalLedger);
    const second = join(runs, (await readdir(runs)).find(name => join(runs, name) !== first)!);
    const resumed = await loadRunRecord(second);
    assert.equal(resumed.resumedFrom, first);
    assert.equal(resumed.inputBaseline, record.inputBaseline);
    assert.equal(await main(["apply", "--run-dir", second], {}, undefined, null), 0);
    await writeFile(requirementFile, "id: ROOT\nname: Changed\ntype: ROOT\nchildren: []\n");
    await assert.rejects(main(["resume", "--run-dir", second], env, undefined, null), /Resume inputs changed/);
    assert.equal((await readdir(runs)).length, 2);
  });
});

test("Existing project entry develops in a separate copy and passes its declared runtime", async () => {
  await withTempDir("shallow-entry-project-", async root => {
    const source = join(root, "project"), requirements = join(root, "requirements");
    await mkdir(source); await mkdir(requirements);
    await writeFile(join(source, "server.js"), "original source");
    await writeFile(join(source, "shallowcode.config.json"), JSON.stringify({ start: { executable: "node", args: ["server.js"] },
      tests: [{ id: "unit", executable: "node", args: ["--test"] }], env: { FLAG: "declared" }, dataPaths: ["storage"] }));
    await writeFile(join(requirements, "requirements.yaml"), "id: ROOT\nname: Demo\ntype: ROOT\nchildren: []\n");
    await main(["--requirements-dir", requirements, "--project", source], { ...gatewayEnv(), SHALLOW_RUN_DIR: join(root, "runs") }, async context => {
      assert.equal(context.sourceProjectDir, source);
      assert.notEqual(context.pipelineOptions.outputDir, source);
      assert.equal(context.pipelineOptions.stageStartingPoint, "inherited_application");
      assert.deepEqual(context.pipelineOptions.applicationContract.env, { FLAG: "declared" });
      assert.equal(context.pipelineOptions.applicationContract.testTargets?.[0].id, "unit");
      await writeFile(join(context.pipelineOptions.outputDir, "server.js"), "implemented");
      return { status: "delivered", acceptedSha: "sha", verifiedRequirementIds: [], blockedRequirementIds: [] };
    }, null);
    assert.equal(await (await import("node:fs/promises")).readFile(join(source, "server.js"), "utf8"), "original source");
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

test("An output directory carrying only requirements metadata starts a blank template run and exports its delivery", async () => {
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
    const patch = await readFile(join(run, "changes.patch"), "utf8");
    assert.match(patch, /app\.txt/);
    assert.doesNotMatch(patch, /\.requirements-agent/);
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
    assert.equal(received?.checkerGateway.model, "provider/model");
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
        "SHALLOW_CHECKER_MODEL=file/judge",
        "SHALLOW_CHECKER_SEMANTIC_REVIEW=1",
        "SHALLOW_CHECKER_REPLAY=1",
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
    assert.equal(received?.builderGateway.model, "file/model");
    assert.equal(received?.checkerGateway.model, "file/judge");
    assert.equal(received?.checkerGateway.apiKey, "file-key");
    assert.equal(received?.pipelineOptions.checker.semanticReview, true);
    assert.equal(received?.pipelineOptions.checker.replay, true);
    assert.equal(webRuntimeConfig(received?.pipelineOptions.applicationContract!).port, 3210);

    await main(argv, { MODEL: "env/model", SHALLOW_CHECKER_MODEL: "env/judge", SHALLOW_CHECKER_SEMANTIC_REVIEW: "0", SHALLOW_CHECKER_REPLAY: "0" }, execute, join(directory, "gateway.env"));
    assert.equal(received?.builderGateway.model, "env/model");
    assert.equal(received?.builderGateway.apiKey, "file-key");
    assert.equal(received?.checkerGateway.model, "env/judge");
    assert.equal(received?.pipelineOptions.checker.semanticReview, false);
    assert.equal(received?.pipelineOptions.checker.replay, false);
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
