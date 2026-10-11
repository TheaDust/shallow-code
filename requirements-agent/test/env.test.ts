import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadGatewayEnv, opencodeSessionHeaders, resolveGatewayEnv } from "../src/env.js";

test("opencode 网关附带 x-opencode-session，其他网关不附加", () => {
  assert.deepEqual(
    opencodeSessionHeaders("https://opencode.ai/zen/go/v1", "session-1"),
    { "x-opencode-session": "session-1" },
  );
  assert.deepEqual(
    opencodeSessionHeaders("https://www.opencode.ai/zen/v1", "session-1"),
    { "x-opencode-session": "session-1" },
  );
  assert.deepEqual(opencodeSessionHeaders("https://gateway.example/v1", "session-1"), {});
  assert.deepEqual(opencodeSessionHeaders("https://opencode.ai.evil.example/v1", "session-1"), {});
  assert.deepEqual(opencodeSessionHeaders("not a url", "session-1"), {});
});

test("resolveGatewayEnv 使用公共配置并修剪 baseUrl 末尾斜杠", () => {
  const gateway = resolveGatewayEnv({
    OPENAI_API_KEY: " key ",
    OPENAI_BASE_URL: "https://gateway.example/v1/",
    MODEL: "provider/model",
  });
  assert.deepEqual(gateway, {
    apiKey: "key",
    baseUrl: "https://gateway.example/v1",
    model: "provider/model",
  });
});

test("REQUIREMENTS_AGENT_* 分别覆盖，未覆盖字段回退公共值", () => {
  const gateway = resolveGatewayEnv({
    OPENAI_API_KEY: "key",
    OPENAI_BASE_URL: "https://gateway.example/v1",
    MODEL: "provider/model",
    REQUIREMENTS_AGENT_MODEL: " agent/model ",
    REQUIREMENTS_AGENT_BASE_URL: "",
  });
  assert.deepEqual(gateway, {
    apiKey: "key",
    baseUrl: "https://gateway.example/v1",
    model: "agent/model",
  });

  const agentOnly = resolveGatewayEnv({
    REQUIREMENTS_AGENT_API_KEY: "agent-key",
    REQUIREMENTS_AGENT_BASE_URL: "https://agent.example/v1",
    REQUIREMENTS_AGENT_MODEL: "agent/model",
  });
  assert.deepEqual(agentOnly, {
    apiKey: "agent-key",
    baseUrl: "https://agent.example/v1",
    model: "agent/model",
  });
});

test("缺少必需配置时报错并列出可用变量名", () => {
  assert.throws(
    () => resolveGatewayEnv({ REQUIREMENTS_AGENT_MODEL: "agent/model" }),
    /REQUIREMENTS_AGENT_API_KEY 或 OPENAI_API_KEY/,
  );
  assert.throws(
    () => resolveGatewayEnv({}),
    /REQUIREMENTS_AGENT_BASE_URL 或 OPENAI_BASE_URL/,
  );
  assert.throws(
    () => resolveGatewayEnv({ OPENAI_API_KEY: "key", OPENAI_BASE_URL: "https://g.example/v1" }),
    /REQUIREMENTS_AGENT_MODEL 或 MODEL/,
  );
});

test("loadGatewayEnv 依序合并仓库根 .env、当前目录 .env 与进程环境", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "requirements-agent-env-"));
  t.after(() => rm(base, { recursive: true, force: true }).catch(() => {}));
  const rootEnvFile = join(base, "root.env");
  await writeFile(rootEnvFile, [
    "OPENAI_API_KEY=root-key",
    "OPENAI_BASE_URL=https://root.example/v1",
    "MODEL=root/model",
  ].join("\n") + "\n");
  const cwd = join(base, "work");
  await mkdir(cwd);
  await writeFile(join(cwd, ".env"), "MODEL=local/model\n");

  // 当前目录 .env 覆盖根 .env。
  const fromFiles = await loadGatewayEnv({ cwd, rootEnvFile, env: {} });
  assert.deepEqual(fromFiles, {
    apiKey: "root-key",
    baseUrl: "https://root.example/v1",
    model: "local/model",
  });

  // 进程环境变量最终优先。
  const fromProcess = await loadGatewayEnv({
    cwd,
    rootEnvFile,
    env: { REQUIREMENTS_AGENT_MODEL: "process/model" },
  });
  assert.equal(fromProcess.model, "process/model");
  assert.equal(fromProcess.apiKey, "root-key");

  // 根文件缺失时当前目录 .env 仍可独立提供全部配置；全缺时抛出缺失清单。
  await writeFile(join(cwd, ".env"), [
    "OPENAI_API_KEY=local-key",
    "OPENAI_BASE_URL=https://local.example/v1",
    "MODEL=local/model",
  ].join("\n") + "\n");
  const localOnly = await loadGatewayEnv({ cwd, rootEnvFile: join(base, "absent.env"), env: {} });
  assert.deepEqual(localOnly, {
    apiKey: "local-key",
    baseUrl: "https://local.example/v1",
    model: "local/model",
  });
  await assert.rejects(
    loadGatewayEnv({ cwd: join(base, "empty"), rootEnvFile: join(base, "absent.env"), env: {} }),
    /缺少模型配置/,
  );
});
