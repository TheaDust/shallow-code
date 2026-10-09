import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";

import {
  main,
  type AgentExecution,
  type AgentExecutionContext,
} from "../index.js";
import { withTempDir } from "./helpers/temp-dir.js";

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
    assert.equal(received?.gateway.model, "provider/model");
    assert.equal(received?.pipelineOptions.requirementsFile, join(requirementsDir, "requirements.yaml"));
    assert.equal(received?.pipelineOptions.outputDir, outputDir);
    assert.equal(received?.pipelineOptions.totalBudgetMs, 600_000);
    assert.equal(received?.pipelineOptions.platformContract.port, 3100);
    assert.equal(received?.builderContextWindow, 400_000);
    assert.equal(received?.pipelineOptions.auditInheritedRequirements, false);
    assert.equal(received?.pipelineOptions.generateFinalAuditPlans, false);
  });
});

test("Agent entry loads the final audit plan switch from env files with real env winning", async () => {
  await withTempDir("shallow-entry-final-audit-plan-", async directory => {
    const requirementsDir = join(directory, "requirements");
    await mkdir(requirementsDir);
    await writeFile(join(requirementsDir, "requirements.yaml"), "id: ROOT\nname: Root\ntype: FOLDER\nchildren: []\n");
    const envFile = join(directory, "gateway.env");
    await writeFile(envFile, "SHALLOW_FINAL_AUDIT_GENERATE_PLAN=0\n");
    const argv = ["--requirements-dir", requirementsDir, "--output-dir", join(directory, "output")];
    const received: boolean[] = [];
    const execute: AgentExecution = async context => {
      received.push(context.pipelineOptions.generateFinalAuditPlans!);
      return { status: "delivered", verifiedRequirementIds: [], blockedRequirementIds: [], acceptedSha: "sha" };
    };
    await main(argv, gatewayEnv(), execute, envFile);
    await main(argv, { ...gatewayEnv(), SHALLOW_FINAL_AUDIT_GENERATE_PLAN: "1" }, execute, envFile);
    assert.deepEqual(received, [false, true]);
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

    const contract = received?.pipelineOptions.platformContract;
    assert.ok(contract);
    assert.notEqual(contract.port, 3000);
    assert.equal(contract.baseUrl, `http://127.0.0.1:${contract.port}`);
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

    const contract = received?.pipelineOptions.platformContract;
    assert.equal(contract?.evaluationPort, 43100);
    assert.notEqual(contract?.port, 43100);
    assert.notEqual(contract?.port, 3000);
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
    assert.equal(received?.gateway.apiKey, "file-key");
    assert.equal(received?.gateway.baseUrl, "https://file.example/v1");
    assert.equal(received?.gateway.model, "file/model");
    assert.equal(received?.pipelineOptions.platformContract.port, 3210);

    await main(argv, { MODEL: "env/model" }, execute, join(directory, "gateway.env"));
    assert.equal(received?.gateway.model, "env/model");
    assert.equal(received?.gateway.apiKey, "file-key");
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

test("Agent entry uses the public port contract without reading an acceptance test bundle", async () => {
  await withTempDir("shallow-entry-", async (directory) => {
    const requirementsDir = join(directory, "requirements");
    const testsDir = join(directory, "tests");
    await mkdir(requirementsDir);
    await mkdir(testsDir);
    await writeFile(
      join(requirementsDir, "requirements.yaml"),
      "id: ROOT\nname: Root\ntype: FOLDER\ndependencies: []\ndescription: Root\nchildren: []\n",
    );
    await writeFile(
      join(testsDir, "home.spec.ts"),
      "await page.goto('http://127.0.0.1:3301'); await page.goto('http://localhost:4400');",
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
      ["--requirements-dir", requirementsDir, "--output-dir", join(directory, "output")],
      { ...gatewayEnv(), ARCBENCH_TESTS_DIR: testsDir },
      execute,
      null,
    );

    const contract = received?.pipelineOptions.platformContract;
    assert.deepEqual(contract?.extraPorts, [3301]);
    assert.ok(!contract?.extraPorts?.includes(contract.port));
  });
});

test("Agent entry rejects a probe port that collides with a public compatibility port", async () => {
  await withTempDir("shallow-entry-", async (directory) => {
    const requirementsDir = join(directory, "requirements");
    const testsDir = join(directory, "tests");
    await mkdir(requirementsDir);
    await mkdir(testsDir);
    await writeFile(
      join(requirementsDir, "requirements.yaml"),
      "id: ROOT\nname: Root\ntype: FOLDER\ndependencies: []\ndescription: Root\nchildren: []\n",
    );
    await writeFile(join(testsDir, "home.spec.ts"), "await page.goto('http://127.0.0.1:3301');");

    await assert.rejects(
      main(
        ["--requirements-dir", requirementsDir, "--output-dir", join(directory, "output")],
        { ...gatewayEnv(), ARCBENCH_TESTS_DIR: testsDir, SHALLOW_PROBE_PORT: "3301" },
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

function gatewayEnv(): Record<string, string> {
  return {
    OPENAI_API_KEY: "key",
    OPENAI_BASE_URL: "https://gateway.example/v1",
    MODEL: "provider/model",
  };
}
