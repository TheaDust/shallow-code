import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ProcessTerminal } from "@mariozechner/pi-tui";
import { RequirementsTui } from "../src/tui.js";

test("未启动的 TUI 不渲染终端，关闭时不操作终端", async (t) => {
  const write = t.mock.method(ProcessTerminal.prototype, "write", () => {});
  const stop = t.mock.method(ProcessTerminal.prototype, "stop", () => {});
  const tui = new RequirementsTui({ onAbort() {}, onExit() {} });
  t.after(() => tui.stop());
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(write.mock.callCount(), 0);
  tui.stop();
  assert.equal(stop.mock.callCount(), 0);
});

async function launchCli(t: TestContext, preload: string) {
  const base = await mkdtemp(join(tmpdir(), "requirements-tui-lifecycle-"));
  const preloadFile = join(base, "preload.mjs");
  await writeFile(preloadFile,
    "Object.defineProperty(process.stdin, 'isTTY', { value: true });\n" +
    "Object.defineProperty(process.stdout, 'isTTY', { value: true });\n" + preload, "utf8");
  const child = spawn(process.execPath, [
    "--import", pathToFileURL(preloadFile).href,
    "--import", new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href,
    fileURLToPath(new URL("../src/main.ts", import.meta.url)),
  ], {
    cwd: base,
    env: {
      ...process.env,
      REQUIREMENTS_AGENT_API_KEY: "fake-key",
      REQUIREMENTS_AGENT_BASE_URL: "http://127.0.0.1:1/v1",
      REQUIREMENTS_AGENT_MODEL: "fake-model",
      PI_OFFLINE: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data: Buffer) => { stdout += data.toString("utf8"); });
  child.stderr.on("data", (data: Buffer) => { stderr += data.toString("utf8"); });
  const exit = new Promise<number | null>((resolve) => child.once("exit", resolve));
  t.after(async () => {
    child.kill();
    await exit;
    await rm(base, { recursive: true, force: true });
  });
  return {
    child,
    exit,
    stdout: () => stdout,
    stderr: () => stderr,
    async waitFor(pattern: RegExp, source: "stdout" | "stderr" = "stdout") {
      const deadline = Date.now() + 5_000;
      while (!pattern.test(source === "stdout" ? stdout : stderr)) {
        assert.ok(child.exitCode === null && Date.now() < deadline,
          `未显示 ${pattern}；stdout:\n${stdout}\nstderr:\n${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
  };
}

test("Pi 初始化失败时 TUI 不启动，CLI 报错后退出", { timeout: 10_000 }, async (t) => {
  const cli = await launchCli(t, `
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const mkdir = fsPromises.mkdir;
fsPromises.mkdir = async (path, ...args) => {
  if (String(path).endsWith('requirements-agent-' + process.pid)) {
    throw new Error('injected-agent-init-failure');
  }
  return mkdir(path, ...args);
};
syncBuiltinESMExports();
`);
  assert.equal(await cli.exit, 1);
  assert.match(cli.stderr(), /启动失败：injected-agent-init-failure/);
  assert.equal(cli.stdout(), "", "初始化失败不应输出 TUI 控制序列");
});

for (const [name, key] of [["Esc", "\x1b"], ["Ctrl+C", "\x03"]]) {
  test(`${name} 取消自动压缩后可以继续提交下一回合`, { timeout: 10_000 }, async (t) => {
    // 使用真实 SDK 的 abort/abortCompaction，令 prompt 等待压缩取消信号。
    const cli = await launchCli(t, `
import { AgentSession } from ${JSON.stringify(import.meta.resolve("@mariozechner/pi-coding-agent"))};
let turns = 0;
AgentSession.prototype.prompt = async function () {
  if (++turns === 1) {
    const controller = new AbortController();
    this._autoCompactionAbortController = controller;
    this._emit({ type: 'compaction_start', reason: 'overflow' });
    process.stderr.write('test-compaction-start\\n');
    await new Promise((resolve) => controller.signal.addEventListener('abort', resolve, { once: true }));
    this._autoCompactionAbortController = undefined;
    this._emit({ type: 'compaction_end', reason: 'overflow', aborted: true, willRetry: false });
    return;
  }
  const message = {
    role: 'assistant', content: [{ type: 'text', text: '可以继续整理需求。' }],
    stopReason: 'stop', timestamp: Date.now(),
  };
  this.agent.state.messages.push(message);
  this._emit({ type: 'message_end', message });
};
`);
    await cli.waitFor(/需要生成时输入/);
    cli.child.stdin.write("整理需求\r");
    await cli.waitFor(/test-compaction-start/, "stderr");
    cli.child.stdin.write(key);
    await cli.waitFor(/本轮处理失败/);
    cli.child.stdin.write("继续补充需求\r");
    await cli.waitFor(/【本轮修改】/);
    cli.child.stdin.write("\x04");
    assert.equal(await cli.exit, 0);
    assert.match(cli.stdout(), /正在中止当前回合/);
    assert.ok(!cli.stderr().includes("启动失败"));
  });
}
