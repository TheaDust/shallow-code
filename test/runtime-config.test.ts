import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  deriveModelTimeouts,
  parseBuilderContextWindow,
  parseEvaluationPort,
  parseEvolutionAuditInherited,
  parseFinalAuditGeneratePlan,
  parseProbePortOverride,
  parseRunDirOverride,
  pickFreePort,
  readEnvFile,
  readGatewayConfig,
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

test("Runtime config supports component-scoped gateway overrides", () => {
  const complete = {
    OPENAI_API_KEY: "key",
    OPENAI_BASE_URL: "https://gateway.example/v1/",
    MODEL: "provider/model",
  };
  // 未配置覆盖时与公共网关完全一致。
  assert.deepEqual(readGatewayConfig(complete, "SHALLOW_BUILDER"), {
    apiKey: "key",
    baseUrl: "https://gateway.example/v1",
    model: "provider/model",
  });

  // 三个字段可分别覆盖，未覆盖的字段回退公共值；空白覆盖视为缺省。
  const scoped = {
    ...complete,
    SHALLOW_BUILDER_API_KEY: " builder-key ",
    SHALLOW_BUILDER_MODEL: "  ",
    SHALLOW_JUDGE_BASE_URL: "https://judge.example/v1",
    SHALLOW_JUDGE_MODEL: "judge/model",
  };
  assert.deepEqual(readGatewayConfig(scoped, "SHALLOW_BUILDER"), {
    apiKey: "builder-key",
    baseUrl: "https://gateway.example/v1",
    model: "provider/model",
  });
  assert.deepEqual(readGatewayConfig(scoped, "SHALLOW_JUDGE"), {
    apiKey: "key",
    baseUrl: "https://judge.example/v1",
    model: "judge/model",
  });

  // 组件值可独立成立；组件与公共值都缺失时错误信息包含组件变量名。
  const onlyBuilder = {
    SHALLOW_BUILDER_API_KEY: "key",
    SHALLOW_BUILDER_BASE_URL: "https://builder.example/v1",
    SHALLOW_BUILDER_MODEL: "builder/model",
  };
  assert.deepEqual(readGatewayConfig(onlyBuilder, "SHALLOW_BUILDER"), {
    apiKey: "key",
    baseUrl: "https://builder.example/v1",
    model: "builder/model",
  });
  assert.throws(
    () => readGatewayConfig(onlyBuilder, "SHALLOW_JUDGE"),
    /SHALLOW_JUDGE_API_KEY or OPENAI_API_KEY/,
  );
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

test("Runtime config reads the probe port override from the environment", () => {
  assert.equal(parseProbePortOverride({ SHALLOW_PROBE_PORT: "3000" }), 3000);
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
