import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { ownProcessTree, runtimeEnvironment, toolEnvironment } from "../src/process-lifecycle.js";

test("Owned process tree removes descendants even when their parent has already exited", async () => {
  const script = `process.stdin.once('data', () => { const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore', windowsHide:true}); console.log(c.pid); c.unref(); process.exit(0); });`;
  const parent = spawn(process.execPath, ["-e", script], { detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(parent, "exit");
  const tree = await ownProcessTree(parent);
  try {
    const output = once(parent.stdout, "data");
    parent.stdin.end("go");
    const [pidText] = await output;
    const pid = Number(String(pidText).trim());
    assert.ok(pid > 0);
    await exited;
    await tree.stop();
    // Windows reaps immediately. Linux may briefly retain a dead orphan as a zombie.
    if (process.platform === "win32") assert.throws(() => process.kill(pid, 0), /ESRCH/);
    else {
      const { readFile } = await import("node:fs/promises");
      const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
      assert.ok(!stat || /\) Z /.test(stat));
    }
  } finally { await tree.stop(); }
});

test("Tool environments retain runtime paths but exclude gateway credentials", () => {
  const prior = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "do-not-inherit";
  try {
    const env = toolEnvironment();
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.MODEL, undefined);
    assert.ok(Object.keys(env).some(key => key.toLowerCase() === "path"));
  } finally { if (prior === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prior; }
});

test("Tool environments inherit npm/Playwright mirror settings set by the adapter entry", () => {
  const priorRegistry = process.env.npm_config_registry;
  const priorHost = process.env.PLAYWRIGHT_DOWNLOAD_HOST;
  const priorGc = process.env.PLAYWRIGHT_SKIP_BROWSER_GC;
  process.env.npm_config_registry = "https://registry.npmmirror.com";
  process.env.PLAYWRIGHT_DOWNLOAD_HOST = "https://npmmirror.com/mirrors/playwright";
  process.env.PLAYWRIGHT_SKIP_BROWSER_GC = "1";
  try {
    const env = toolEnvironment();
    assert.equal(env.npm_config_registry, "https://registry.npmmirror.com");
    assert.equal(env.PLAYWRIGHT_DOWNLOAD_HOST, "https://npmmirror.com/mirrors/playwright");
    assert.equal(env.PLAYWRIGHT_SKIP_BROWSER_GC, "1");
  } finally {
    if (priorRegistry === undefined) delete process.env.npm_config_registry;
    else process.env.npm_config_registry = priorRegistry;
    if (priorHost === undefined) delete process.env.PLAYWRIGHT_DOWNLOAD_HOST;
    else process.env.PLAYWRIGHT_DOWNLOAD_HOST = priorHost;
    if (priorGc === undefined) delete process.env.PLAYWRIGHT_SKIP_BROWSER_GC;
    else process.env.PLAYWRIGHT_SKIP_BROWSER_GC = priorGc;
  }
});

test("Runtime environments keep host tooling but never gateway credentials", () => {
  const priorKey = process.env.OPENAI_API_KEY;
  const priorToken = process.env.GITHUB_TOKEN;
  const priorNpmTokenKey = "npm_config_//registry.example.com/:_authToken";
  const priorNpmToken = process.env[priorNpmTokenKey];
  process.env.OPENAI_API_KEY = "do-not-inherit";
  process.env.GITHUB_TOKEN = "do-not-inherit";
  process.env[priorNpmTokenKey] = "do-not-inherit";
  try {
    const env = runtimeEnvironment({ PORT: "43210" });
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env[priorNpmTokenKey], undefined);
    assert.equal(env.PORT, "43210");
    assert.equal(env.npm_config_registry, process.env.npm_config_registry);
    assert.ok(Object.keys(env).some(key => key.toLowerCase() === "path"));
  } finally {
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = priorKey;
    if (priorToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = priorToken;
    if (priorNpmToken === undefined) delete process.env[priorNpmTokenKey]; else process.env[priorNpmTokenKey] = priorNpmToken;
  }
});
