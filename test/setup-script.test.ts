import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/setup.mjs", import.meta.url));

function runSetup(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (data: Buffer) => { stdout += data.toString("utf8"); });
    child.stderr!.on("data", (data: Buffer) => { stderr += data.toString("utf8"); });
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
  });
}

test("setup --check 检查环境并打印完整安装计划，不产生副作用", async () => {
  const result = await runSetup(["--check"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Node\.js \d+\.\d+\.\d+（要求 >= 22\.19\.0）/);
  assert.match(result.stdout, /Git\s+(可用|未找到)/);
  assert.match(result.stdout, /1\. 安装仓库根依赖 — npm ci/);
  assert.match(result.stdout, /2\. 安装 requirements-agent 依赖 — npm ci/);
  assert.match(result.stdout, /3\. 安装 Playwright Chromium — playwright install chromium/);
  assert.match(result.stdout, /4\. 初始化本地凭证文件 — \.env\.example → \.env/);
  assert.match(result.stdout, /5\. 注册全局 shallow 命令 — npm link/);
});

test("setup --skip-browser 的计划与说明省略 Chromium 下载", async () => {
  const result = await runSetup(["--check", "--skip-browser"]);
  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stdout, /Playwright Chromium/);
  assert.match(result.stdout, /3\. 初始化本地凭证文件/);
  assert.match(result.stdout, /4\. 注册全局 shallow 命令/);
});

test("setup --help 说明选项", async () => {
  const result = await runSetup(["--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /--check/);
  assert.match(result.stdout, /--skip-browser/);
});
