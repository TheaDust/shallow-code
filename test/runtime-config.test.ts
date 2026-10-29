import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { deriveModelTimeouts, parseBuilderContextWindow, parseRunDirOverride, readEnvFile, readGatewayConfig, resolveSseCaptureDir } from "../src/runtime-config.js";
import { parseEvaluationPort, parseProbePortOverride, pickFreePort } from "../src/adapters/web/ports.js";
import { withTempDir } from "./helpers/temp-dir.js";

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

test("Runtime config supports independent Grouper, Builder and Verifier gateway overrides", () => {
  const complete = {
    OPENAI_API_KEY: "key",
    OPENAI_BASE_URL: "https://gateway.example/v1/",
    MODEL: "provider/model",
  };
  // 未配置覆盖时与公共网关完全一致。
  for (const role of ["grouper", "builder", "verifier"] as const) {
    assert.deepEqual(readGatewayConfig(complete, role), {
      apiKey: "key",
      baseUrl: "https://gateway.example/v1",
      model: "provider/model",
    });
  }

  // 三个角色可分别覆盖不同字段，未覆盖的字段回退公共值；空白覆盖视为缺省。
  const scoped = {
    ...complete,
    SHALLOW_GROUPER_MODEL: "grouper/model",
    SHALLOW_BUILDER_API_KEY: " builder-key ",
    SHALLOW_BUILDER_MODEL: "  ",
    SHALLOW_VERIFIER_BASE_URL: "https://verifier.example/v1",
    SHALLOW_VERIFIER_MODEL: "verifier/model",
  };
  assert.deepEqual(readGatewayConfig(scoped, "grouper"), {
    apiKey: "key",
    baseUrl: "https://gateway.example/v1",
    model: "grouper/model",
  });
  assert.deepEqual(readGatewayConfig(scoped, "builder"), {
    apiKey: "builder-key",
    baseUrl: "https://gateway.example/v1",
    model: "provider/model",
  });
  assert.deepEqual(readGatewayConfig(scoped, "verifier"), {
    apiKey: "key",
    baseUrl: "https://verifier.example/v1",
    model: "verifier/model",
  });

  // 角色值可独立成立；角色与公共值都缺失时错误信息包含角色变量名。
  const onlyBuilder = {
    SHALLOW_BUILDER_API_KEY: "key",
    SHALLOW_BUILDER_BASE_URL: "https://builder.example/v1",
    SHALLOW_BUILDER_MODEL: "builder/model",
  };
  assert.deepEqual(readGatewayConfig(onlyBuilder, "builder"), {
    apiKey: "key",
    baseUrl: "https://builder.example/v1",
    model: "builder/model",
  });
  assert.throws(
    () => readGatewayConfig(onlyBuilder, "verifier"),
    /SHALLOW_VERIFIER_API_KEY or OPENAI_API_KEY/,
  );
  assert.deepEqual(readGatewayConfig({ ...scoped, SHALLOW_GROUPER_MODEL: "grouper/model" }, "grouper"), {
    apiKey: "key", baseUrl: "https://gateway.example/v1", model: "grouper/model",
  });
  assert.deepEqual(readGatewayConfig({ SHALLOW_GROUPER_API_KEY: "grouper-key",
    SHALLOW_GROUPER_BASE_URL: "https://grouper.example/v1/", SHALLOW_GROUPER_MODEL: "grouper/model" }, "grouper"), {
    apiKey: "grouper-key", baseUrl: "https://grouper.example/v1", model: "grouper/model",
  });

});

test("Runtime config bounds model calls by the total budget", () => {
  assert.deepEqual(deriveModelTimeouts(600_000), {
    builderTimeoutMs: 240_000,
    verifierTimeoutMs: 60_000,
  });
  assert.deepEqual(deriveModelTimeouts(60_000), {
    builderTimeoutMs: 30_000,
    verifierTimeoutMs: 10_000,
  });
  assert.deepEqual(deriveModelTimeouts(0), {
    builderTimeoutMs: 5_400_000,
    verifierTimeoutMs: 720_000,
  });
  assert.deepEqual(deriveModelTimeouts(10_800_000), {
    builderTimeoutMs: 4_320_000,
    verifierTimeoutMs: 720_000,
  });
  assert.deepEqual(deriveModelTimeouts(3_600_000), {
    builderTimeoutMs: 1_440_000,
    verifierTimeoutMs: 360_000,
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
