import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { withTempDir } from "./helpers/temp-dir.js";

const BIN = fileURLToPath(new URL("../bin/shallow.mjs", import.meta.url));

/** 固定为假网关，避免仓库根 .env 或宿主环境泄入用例。 */
const FAKE_GATEWAY: Record<string, string> = {
  OPENAI_API_KEY: "fake-key",
  OPENAI_BASE_URL: "http://127.0.0.1:1/v1",
  MODEL: "fake-model",
  SHALLOW_BUILDER_API_KEY: "fake-key",
  SHALLOW_BUILDER_BASE_URL: "http://127.0.0.1:1/v1",
  SHALLOW_BUILDER_MODEL: "fake-model",
  SHALLOW_CHECKER_API_KEY: "fake-key",
  SHALLOW_CHECKER_BASE_URL: "http://127.0.0.1:1/v1",
  SHALLOW_CHECKER_MODEL: "fake-model",
  REQUIREMENTS_AGENT_API_KEY: "fake-key",
  REQUIREMENTS_AGENT_BASE_URL: "http://127.0.0.1:1/v1",
  REQUIREMENTS_AGENT_MODEL: "fake-model",
};

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runShallow(args: string[], cwd: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      env: { ...process.env, ...FAKE_GATEWAY },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (data: Buffer) => { stdout += data.toString("utf8"); });
    child.stderr!.on("data", (data: Buffer) => { stderr += data.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin!.end();
  });
}

test("shallow 无参数、帮助与未知子命令显示用法", { timeout: 60_000 }, async () => {
  await withTempDir("shallow-cli-usage-", async (directory) => {
    const missing = await runShallow([], directory);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /shallow <子命令>/);
    assert.match(missing.stderr, /shallow req/);

    const help = await runShallow(["--help"], directory);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /shallow <子命令>/);
    assert.match(help.stdout, /shallow build/);

    const unknown = await runShallow(["nope"], directory);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /未知子命令：nope/);
  });
});

test("shallow req 与 shallow build 可在任意目录启动", { timeout: 120_000 }, async () => {
  await withTempDir("shallow-cli-boot-", async (directory) => {
    const req = await runShallow(["req"], directory);
    assert.equal(req.code, 0);
    assert.match(req.stdout, /Requirements Agent — 需求整理/);
    assert.match(req.stdout, /未生成需求文档，本次会话结束。/);
    await assert.rejects(access(join(directory, "requirements")), "空输入不应留下需求目录");

    const build = await runShallow(
      ["build", "--requirements-dir", "missing", "--output-dir", "out"],
      directory,
    );
    assert.equal(build.code, 1);
    assert.match(build.stderr, /requirements\.yaml is not readable at /);
    assert.ok(
      build.stderr.includes(join(directory, "missing", "requirements.yaml")),
      "相对参数应相对启动目录解析",
    );
  });
});

test("shallow build 缺省在当前目录子树查找 requirements.yaml", { timeout: 120_000 }, async () => {
  await withTempDir("shallow-cli-discovery-", async (directory) => {
    const none = await runShallow(["build"], directory);
    assert.equal(none.code, 1);
    assert.match(none.stderr, /No requirements\.yaml found under /);

    const requirementsDir = join(directory, "requirements");
    await mkdir(requirementsDir);
    await writeFile(join(requirementsDir, "requirements.yaml"), "id: ROOT\nname: Root\ntype: ROOT\nchildren: []\n");
    await mkdir(join(directory, "other"));
    await writeFile(join(directory, "other", "requirements.yaml"), "id: ROOT\nname: Other\ntype: ROOT\nchildren: []\n");

    const many = await runShallow(["build"], directory);
    assert.equal(many.code, 1);
    assert.match(many.stderr, /Multiple requirements\.yaml files found under /);
    assert.ok(many.stderr.includes(join(requirementsDir, "requirements.yaml")), "错误应列出候选文件");
  });
});
