import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  collectSpecBasePorts,
  createArcPlatformContract,
  deriveModelTimeouts,
  extractBasePorts,
  parseBuilderContextWindow,
  parseEvaluationPort,
  parseEvolutionAuditInherited,
  parseFinalAuditGeneratePlan,
  parseProbePortOverride,
  parseRunDirOverride,
  pickFreePort,
  readEnvFile,
  readGatewayConfig,
  resolvePlatformExtraPorts,
  resolveSseCaptureDir,
} from "../src/runtime-config.js";
import { withTempDir } from "./helpers/temp-dir.js";

test("Evolution inherited audits default off and can be explicitly restored", () => {
  assert.equal(parseEvolutionAuditInherited({}), false);
  for (const value of ["1", "true", " YES ", "ON"]) {
    assert.equal(parseEvolutionAuditInherited({ SHALLOW_EVOLUTION_AUDIT_INHERITED: value }), true);
  }
  for (const value of ["", "0", "false", " NO ", "OFF"]) {
    assert.equal(parseEvolutionAuditInherited({ SHALLOW_EVOLUTION_AUDIT_INHERITED: value }), false);
  }
  assert.throws(() => parseEvolutionAuditInherited({ SHALLOW_EVOLUTION_AUDIT_INHERITED: "fales" }), /SHALLOW_EVOLUTION_AUDIT_INHERITED/);
});

test("Final audit plan generation defaults off and can be explicitly enabled", () => {
  assert.equal(parseFinalAuditGeneratePlan({}), false);
  for (const value of ["1", "true", " YES ", "ON"]) {
    assert.equal(parseFinalAuditGeneratePlan({ SHALLOW_FINAL_AUDIT_GENERATE_PLAN: value }), true);
  }
  for (const value of ["", "0", "false", " NO ", "OFF"]) {
    assert.equal(parseFinalAuditGeneratePlan({ SHALLOW_FINAL_AUDIT_GENERATE_PLAN: value }), false);
  }
  assert.throws(() => parseFinalAuditGeneratePlan({ SHALLOW_FINAL_AUDIT_GENERATE_PLAN: "enabled" }),
    /SHALLOW_FINAL_AUDIT_GENERATE_PLAN/);
});

test("Runtime config requires the three explicit gateway variables", () => {
  const complete = {
    OPENAI_API_KEY: "key",
    OPENAI_BASE_URL: "https://gateway.example/v1/",
    MODEL: "provider/model",
  };
  assert.deepEqual(readGatewayConfig(complete), {
    apiKey: "key",
    baseUrl: "https://gateway.example/v1",
    model: "provider/model",
  });

  for (const missing of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "MODEL"] as const) {
    const env = { ...complete };
    delete env[missing];
    assert.throws(() => readGatewayConfig(env), new RegExp(missing));
  }
});

test("Runtime config expresses the ARC frontend and backend process contract", () => {
  const linux = createArcPlatformContract("linux");
  const windows = createArcPlatformContract("win32");

  assert.deepEqual(linux.installCommands, [
    {
      executable: "npm",
      args: ["install", "--no-audit", "--no-fund"],
      cwd: "frontend",
    },
    {
      executable: "npm",
      args: ["install", "--no-audit", "--no-fund"],
      cwd: "backend",
    },
  ]);
  assert.deepEqual(linux.buildCommands, [
    { executable: "npm", args: ["run", "build"], cwd: "frontend" },
  ]);
  assert.deepEqual(linux.startCommand, {
    executable: "npm",
    args: ["run", "start"],
    cwd: "backend",
  });
  assert.equal(linux.baseUrl, "http://127.0.0.1:3000");
  assert.equal(linux.healthPath, "/health");
  assert.deepEqual(linux.extraPorts, [3301]);
  assert.equal(windows.startCommand.executable, "npm.cmd");
});

test("Runtime config bounds model calls by the total budget", () => {
  assert.deepEqual(deriveModelTimeouts(600_000), {
    builderTimeoutMs: 240_000,
    plannerTimeoutMs: 60_000,
  });
  assert.deepEqual(deriveModelTimeouts(60_000), {
    builderTimeoutMs: 30_000,
    plannerTimeoutMs: 10_000,
  });
  assert.deepEqual(deriveModelTimeouts(0), {
    builderTimeoutMs: 5_400_000,
    plannerTimeoutMs: 720_000,
  });
  assert.deepEqual(deriveModelTimeouts(10_800_000), {
    builderTimeoutMs: 4_320_000,
    plannerTimeoutMs: 720_000,
  });
  assert.deepEqual(deriveModelTimeouts(3_600_000), {
    builderTimeoutMs: 1_440_000,
    plannerTimeoutMs: 360_000,
  });
});

test("Runtime config bounds the mainline Builder context window", () => {
  assert.equal(parseBuilderContextWindow({}), 256_000);
  assert.equal(parseBuilderContextWindow({ SHALLOW_BUILDER_CONTEXT_WINDOW: "400000" }), 400_000);
  for (const value of ["131071", "1000001", "262144.5", "unbounded"]) {
    assert.throws(
      () => parseBuilderContextWindow({ SHALLOW_BUILDER_CONTEXT_WINDOW: value }),
      /SHALLOW_BUILDER_CONTEXT_WINDOW/,
    );
  }
});

test("Runtime config accepts an explicit probe port and derives its base URL", () => {
  const contract = createArcPlatformContract("linux", 3100);
  assert.equal(contract.port, 3100);
  assert.equal(contract.baseUrl, "http://127.0.0.1:3100");
});

test("Runtime config keeps port 3000 as the default contract port", () => {
  const contract = createArcPlatformContract("linux");
  assert.equal(contract.port, 3000);
  assert.equal(contract.baseUrl, "http://127.0.0.1:3000");
});

test("Runtime config lets the caller replace the default extra ports", () => {
  const contract = createArcPlatformContract("linux", 3100, 3000, [4400, 5500]);
  assert.deepEqual(contract.extraPorts, [4400, 5500]);
});

test("Runtime config extracts base ports only from loopback spec URLs", () => {
  const text = [
    "const base = process.env.BASE_URL ?? 'http://127.0.0.1:3301';",
    "await page.goto('http://localhost:4400/api');",
    "const docs = 'https://example.com:8443/docs';",
    "const again = 'http://127.0.0.1:3301/';",
  ].join("\n");
  assert.deepEqual(extractBasePorts(text), [3301, 4400]);
  assert.deepEqual(extractBasePorts("no ports here"), []);
});

test("Runtime config collects spec ports from nested files and ignores non-TypeScript assets", async () => {
  await withTempDir("shallow-ports-", async (directory) => {
    await mkdir(join(directory, "nested"), { recursive: true });
    await writeFile(join(directory, "home.spec.ts"), "goto('http://127.0.0.1:3301')");
    await writeFile(join(directory, "nested", "helpers.ts"), "goto('http://localhost:4400')");
    await writeFile(join(directory, "README.md"), "http://127.0.0.1:5555");
    assert.deepEqual(await collectSpecBasePorts(directory), [3301, 4400]);
  });
});

test("Runtime config resolves extra ports from the acceptance tests directory", async () => {
  await withTempDir("shallow-ports-", async (directory) => {
    await writeFile(join(directory, "home.spec.ts"), [
      "goto('http://127.0.0.1:3301')",
      "goto('http://127.0.0.1:3000')",
      "goto('http://localhost:4400')",
    ].join("\n"));
    assert.deepEqual(
      await resolvePlatformExtraPorts({ ARCBENCH_TESTS_DIR: directory }, 3000),
      [3301, 4400],
    );
  });
});

test("Runtime config falls back to 3301 when no acceptance tests are discoverable", async () => {
  assert.deepEqual(await resolvePlatformExtraPorts({}, 3000, null), [3301]);
  assert.deepEqual(
    await resolvePlatformExtraPorts(
      { ARCBENCH_TESTS_DIR: join(tmpdir(), "shallow-absent-tests-xyz") },
      3000,
    ),
    [3301],
  );
  assert.deepEqual(await resolvePlatformExtraPorts({}, 3301, null), []);
});

test("Runtime config reads the probe port override from the environment", () => {
  assert.throws(() => parseProbePortOverride({ SHALLOW_PROBE_PORT: "3000" }), /reserved evaluation port/);
  assert.equal(parseProbePortOverride({}), null);
  assert.equal(parseProbePortOverride({ SHALLOW_PROBE_PORT: "3100" }), 3100);
  assert.equal(parseProbePortOverride({ SHALLOW_PROBE_PORT: "  3100  " }), 3100);
  assert.throws(
    () => parseProbePortOverride({ SHALLOW_PROBE_PORT: "0" }),
    /SHALLOW_PROBE_PORT/,
  );
  assert.throws(
    () => parseProbePortOverride({ SHALLOW_PROBE_PORT: "not-a-port" }),
    /SHALLOW_PROBE_PORT/,
  );
  assert.throws(
    () => parseProbePortOverride({ SHALLOW_PROBE_PORT: "70000" }),
    /SHALLOW_PROBE_PORT/,
  );
});

test("Runtime config resolves the run directory override from the environment", () => {
  assert.equal(parseRunDirOverride({}), null);
  assert.equal(parseRunDirOverride({ SHALLOW_RUN_DIR: "   " }), null);
  assert.equal(parseRunDirOverride({ SHALLOW_RUN_DIR: " runs " }), resolve("runs"));
  assert.equal(
    parseRunDirOverride({ SHALLOW_RUN_DIR: join(tmpdir(), "shallow-logs") }),
    join(tmpdir(), "shallow-logs"),
  );
});

test("Runtime config resolves the opt-in SSE capture destination", () => {
  const fallback = join(tmpdir(), "shallow-runs", "run-1", "sse-capture");
  assert.equal(resolveSseCaptureDir({}, fallback), null);
  assert.equal(resolveSseCaptureDir({ SHALLOW_CAPTURE_SSE: "   " }, fallback), null);
  for (const off of ["0", "false", "no", "OFF"]) {
    assert.equal(resolveSseCaptureDir({ SHALLOW_CAPTURE_SSE: off }, fallback), null);
  }
  for (const on of ["1", "true", "YES", " on "]) {
    assert.equal(resolveSseCaptureDir({ SHALLOW_CAPTURE_SSE: on }, fallback), resolve(fallback));
  }
  assert.equal(
    resolveSseCaptureDir({ SHALLOW_CAPTURE_SSE: " tmp/sse " }, fallback),
    resolve("tmp/sse"),
  );
});

test("Runtime config picks a free loopback port for probe binding", async () => {
  const port = await pickFreePort();
  assert.ok(Number.isInteger(port));
  assert.ok(port > 0 && port <= 65_535);
});

test("Runtime config reads the evaluation port from the environment", () => {
  assert.equal(parseEvaluationPort({}), null);
  assert.equal(parseEvaluationPort({ SHALLOW_EVAL_PORT: "  " }), null);
  assert.equal(parseEvaluationPort({ SHALLOW_EVAL_PORT: "43100" }), 43100);
  assert.equal(parseEvaluationPort({ SHALLOW_EVAL_PORT: "3000" }), 3000);
  assert.throws(() => parseEvaluationPort({ SHALLOW_EVAL_PORT: "0" }), /SHALLOW_EVAL_PORT/);
  assert.throws(() => parseEvaluationPort({ SHALLOW_EVAL_PORT: "abc" }), /SHALLOW_EVAL_PORT/);
});

test("Runtime config never picks an excluded port", async () => {
  const first = await pickFreePort();
  const port = await pickFreePort([first]);
  assert.notEqual(port, first);
  const contract = createArcPlatformContract("linux", 3100, 43100);
  assert.equal(contract.evaluationPort, 43100);
  assert.equal(createArcPlatformContract("linux", 3100).evaluationPort, 3000);
});

test("Runtime config parses an env file and tolerates a missing one", async () => {
  await withTempDir("shallow-env-", async (directory) => {
    const envFile = join(directory, ".env");
    await writeFile(
      envFile,
      [
        "# gateway config",
        "",
        "OPENAI_API_KEY = file-key",
        "OPENAI_BASE_URL=https://file.example/v1/",
        'MODEL="file/model"',
        "not a pair",
      ].join("\n"),
    );

    assert.deepEqual(await readEnvFile(envFile), {
      OPENAI_API_KEY: "file-key",
      OPENAI_BASE_URL: "https://file.example/v1/",
      MODEL: "file/model",
    });
    assert.deepEqual(await readEnvFile(join(directory, "absent.env")), {});
  });
});
