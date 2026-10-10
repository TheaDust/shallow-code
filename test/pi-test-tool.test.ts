import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createTestTool } from "../src/builder/pi-test-tool.js";
import { resolveRuntimeContract } from "../src/project-spec.js";
import { withTempDir } from "./helpers/temp-dir.js";

interface SpawnCall { file: string; args: string[]; cwd: string }

class FakeStream extends EventEmitter {
  destroy(): void { this.removeAllListeners(); }
}

class FakeChild extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  killed = false;
  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit("close", null));
    return true;
  }
}

function fakeSpawn(behavior?: (child: FakeChild, call: SpawnCall) => void) {
  const calls: SpawnCall[] = [];
  const spawnFn = (file: string, args?: readonly string[], options?: { cwd?: string }): FakeChild => {
    const call: SpawnCall = { file, args: [...(args ?? [])], cwd: options?.cwd ?? "" };
    calls.push(call);
    const child = new FakeChild();
    queueMicrotask(() => {
      if (behavior) behavior(child, call);
      else { child.stdout.emit("data", "ok\n"); child.emit("close", 0); }
    });
    return child;
  };
  return { calls, spawnFn: spawnFn as never };
}

async function makeApp(root: string, { frontend = true, backend = true } = {}): Promise<void> {
  if (frontend) {
    await mkdir(join(root, "frontend", "node_modules", "vitest"), { recursive: true });
    await writeFile(join(root, "frontend", "node_modules", "vitest", "vitest.mjs"), "", "utf8");
  }
  if (backend) await mkdir(join(root, "backend"), { recursive: true });
}

function execute(tool: ReturnType<typeof createTestTool>, params: { target: string; filter?: string; reuse?: boolean }, signal?: AbortSignal) {
  return tool.execute("call-1", params, signal);
}

test("Declared tests run from a custom directory with project environment and isolated data", async () => {
  await withTempDir("shallow-custom-test-", async root => {
    await mkdir(join(root, "web"));
    await writeFile(join(root, "web/check.cjs"), `require('node:assert/strict').equal(process.env.FLAG, 'declared');
      require('node:assert/strict').equal(process.env.APP_DATA_DIR, 'isolated'); console.log(process.argv[2]);`);
    const contract = resolveRuntimeContract({ start: { executable: "node" }, env: { FLAG: "declared", APP_DATA_DIR: "wrong" },
      dataEnvVar: "APP_DATA_DIR", tests: [{ id: "unit", executable: process.execPath, args: ["check.cjs"], cwd: "web" }] }, { port: 3100 });
    contract.dataDirectory = "isolated";
    const tool = createTestTool(root, { contract });
    const result = await execute(tool, { target: "unit", filter: "specific-case" });
    assert.equal((result.details as { results: Array<{ exitCode: number }> }).results[0].exitCode, 0);
    assert.match((result.content[0] as { text: string }).text, /specific-case/);
    await assert.rejects(execute(tool, { target: "backend" }), /No declared test target/);
    await assert.rejects(execute(tool, { target: "unit", filter: "../outside" }), /inside the project/);
  });
});

test("A project without test targets reports the missing declaration", async () => {
  await withTempDir("shallow-no-tests-", async root => {
    const contract = resolveRuntimeContract({ start: { executable: "node" } }, { port: 3100 });
    await assert.rejects(execute(createTestTool(root, { contract }), { target: "all" }), /configure tests/);
  });
});

test("Source in a directory named build still invalidates explicit reuse", async () => {
  await withTempDir("shallow-test-input-", async root => {
    await mkdir(join(root, "build"));
    await writeFile(join(root, "build/value.cjs"), "module.exports = 'valid';");
    await writeFile(join(root, "check.cjs"), "require('node:assert/strict').equal(require('./build/value.cjs'), 'valid');");
    const contract = resolveRuntimeContract({ start: { executable: "node" }, tests: [
      { id: "unit", executable: process.execPath, args: ["check.cjs"] },
    ] }, { port: 3100 });
    const tool = createTestTool(root, { contract });
    const first = await execute(tool, { target: "unit", reuse: true });
    assert.equal((first.details as { results: Array<{ exitCode: number }> }).results[0].exitCode, 0);
    await writeFile(join(root, "build/value.cjs"), "module.exports = 'invalid';");
    const next = await execute(tool, { target: "unit", reuse: true });
    const result = (next.details as { results: Array<{ exitCode: number; cached: boolean }> }).results[0];
    assert.equal(result.exitCode, 1);
    assert.equal(result.cached, false);
  });
});

test("run_tests runs the frontend Vitest suite single-worker in frontend/", async () => {
  await withTempDir("shallow-test-tool-", async root => {
    await makeApp(root);
    const { calls, spawnFn } = fakeSpawn();
    const tool = createTestTool(root, { spawnFn });
    const result = await execute(tool, { target: "frontend", filter: "HomePage" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, process.execPath);
    assert.deepEqual(calls[0].args.slice(1), ["run", "--maxWorkers=1", "HomePage"]);
    assert.match(calls[0].args[0], /frontend[\\/]node_modules[\\/]vitest[\\/]vitest\.mjs$/);
    assert.match(calls[0].cwd, /frontend$/);
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /exit code 0/);
    assert.match(text, /vitest.mjs run --maxWorkers=1 HomePage/);
  });
});

test("run_tests runs backend node:test with single concurrency in backend/", async () => {
  await withTempDir("shallow-test-tool-", async root => {
    await makeApp(root);
    const { calls, spawnFn } = fakeSpawn();
    const tool = createTestTool(root, { spawnFn });
    await execute(tool, { target: "backend" });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ["--test", "--test-concurrency=1"]);
    assert.match(calls[0].cwd, /backend$/);
  });
});

test("run_tests target=all runs frontend then backend in sequence", async () => {
  await withTempDir("shallow-test-tool-", async root => {
    await makeApp(root);
    const { calls, spawnFn } = fakeSpawn();
    const tool = createTestTool(root, { spawnFn });
    const result = await execute(tool, { target: "all" });
    assert.equal(calls.length, 2);
    assert.match(calls[0].cwd, /frontend$/);
    assert.match(calls[1].cwd, /backend$/);
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /\[frontend\]/);
    assert.match(text, /\[backend\]/);
  });
});

test("run_tests reuses only successful results with an unchanged exact source digest", async () => {
  await withTempDir("shallow-test-tool-", async root => {
    await makeApp(root);
    await mkdir(join(root, "frontend", "src"), { recursive: true });
    const source = join(root, "frontend", "src", "App.tsx");
    await writeFile(source, "export const value = 1;", "utf8");
    const { calls, spawnFn } = fakeSpawn();
    const tool = createTestTool(root, { spawnFn });
    await execute(tool, { target: "frontend", filter: "App", reuse: true });
    const cached = await execute(tool, { target: "frontend", filter: "App", reuse: true });
    assert.equal(calls.length, 1);
    assert.match((cached.content[0] as { text: string }).text, /reused successful result: source digest unchanged/);
    assert.equal((cached.details as { results: Array<{ cached: boolean }> }).results[0].cached, true);

    await writeFile(source, "export const value = 2;", "utf8");
    const changed = await execute(tool, { target: "frontend", filter: "App", reuse: true });
    assert.equal(calls.length, 2);
    assert.doesNotMatch((changed.content[0] as { text: string }).text, /reused successful result/);
  });
});

test("Explicit test reuse invalidates when shared, cross-suite or root configuration inputs change", async () => {
  await withTempDir("shallow-test-tool-", async root => {
    await makeApp(root);
    await mkdir(join(root, "backend", "test"));
    await mkdir(join(root, "shared"));
    const inputs = ["shared/contract.txt", "frontend/contract.txt", "test-config.json"];
    for (const path of inputs) await writeFile(join(root, path), "valid");
    await writeFile(join(root, "backend", "test", "contract.test.mjs"), `
      import { test } from 'node:test';
      import assert from 'node:assert/strict';
      import { readFile } from 'node:fs/promises';
      test('project contracts', async () => {
        for (const path of ${JSON.stringify(inputs)}) {
          assert.equal(await readFile(new URL('../../' + path, import.meta.url), 'utf8'), 'valid');
        }
      });
    `);
    const tool = createTestTool(root);
    const first = await execute(tool, { target: "backend", reuse: true });
    assert.equal((first.details as { results: Array<{ exitCode: number }> }).results[0].exitCode, 0);
    for (const path of inputs) {
      await writeFile(join(root, path), "invalid");
      const result = await execute(tool, { target: "backend", reuse: true });
      const suite = (result.details as { results: Array<{ exitCode: number; cached: boolean }> }).results[0];
      assert.equal(suite.cached, false, path);
      assert.equal(suite.exitCode, 1, path);
      await writeFile(join(root, path), "valid");
    }
  });
});

test("Tests execute by default even when only generated or runtime inputs change", async () => {
  await withTempDir("shallow-test-tool-", async root => {
    await makeApp(root);
    await mkdir(join(root, "backend", ".data"));
    const { calls, spawnFn } = fakeSpawn();
    const tool = createTestTool(root, { spawnFn });
    await execute(tool, { target: "backend" });
    await writeFile(join(root, "backend", ".data", "state.json"), '{"changed":true}');
    const result = await execute(tool, { target: "backend" });
    assert.equal(calls.length, 2);
    assert.equal((result.details as { results: Array<{ cached: boolean }> }).results[0].cached, false);
  });
});

test("Explicit test reuse excludes private controller plans and evidence", async () => {
  await withTempDir("shallow-test-tool-", async root => {
    await makeApp(root);
    for (const directory of [".arc", "shallow-progress"]) await mkdir(join(root, directory));
    const { calls, spawnFn } = fakeSpawn();
    const tool = createTestTool(root, { spawnFn });
    await execute(tool, { target: "backend", reuse: true });
    for (const directory of [".arc", "shallow-progress"]) await writeFile(join(root, directory, "plan.json"), "private plan");
    await execute(tool, { target: "backend", reuse: true });
    assert.equal(calls.length, 1);
  });
});

test("run_tests never caches a failed result", async () => {
  await withTempDir("shallow-test-tool-", async root => {
    await makeApp(root);
    const { calls, spawnFn } = fakeSpawn(child => {
      child.stderr.emit("data", "failure\n");
      child.emit("close", 1);
    });
    const tool = createTestTool(root, { spawnFn });
    await execute(tool, { target: "backend", reuse: true });
    await execute(tool, { target: "backend", reuse: true });
    assert.equal(calls.length, 2);
  });
});

test("run_tests reports failures with the output tail and a non-zero exit code", async () => {
  await withTempDir("shallow-test-tool-", async root => {
    await makeApp(root);
    const { spawnFn } = fakeSpawn(child => {
      child.stderr.emit("data", "FAIL src/App.test.tsx > renders\n");
      child.emit("close", 1);
    });
    const tool = createTestTool(root, { spawnFn });
    const result = await execute(tool, { target: "frontend" });
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /exit code 1/);
    assert.match(text, /FAIL src\/App\.test\.tsx > renders/);
  });
});

test("run_tests abbreviates successful output while retaining the suite summary", async () => {
  await withTempDir("shallow-test-tool-", async root => {
    await makeApp(root);
    const { spawnFn } = fakeSpawn(child => {
      child.stdout.emit("data", `start-marker${"x".repeat(40_000)}end-marker`);
      child.emit("close", 0);
    });
    const tool = createTestTool(root, { spawnFn });
    const result = await execute(tool, { target: "frontend" });
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /successful output abbreviated to the last 2000 characters/);
    assert.match(text, /end-marker/);
    assert.doesNotMatch(text, /start-marker/);
    assert.ok(text.length < 2_400, `expected concise success output, got ${text.length}`);
  });
});

test("run_tests retains the longer failure tail for diagnosis", async () => {
  await withTempDir("shallow-test-tool-", async root => {
    await makeApp(root);
    const { spawnFn } = fakeSpawn(child => {
      child.stdout.emit("data", `start-marker${"x".repeat(40_000)}FAIL final assertion`);
      child.emit("close", 1);
    });
    const result = await execute(createTestTool(root, { spawnFn }), { target: "frontend" });
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /output truncated to the last 30000 characters/);
    assert.match(text, /FAIL final assertion/);
    assert.doesNotMatch(text, /start-marker/);
  });
});

test("run_tests kills a suite that exceeds its timeout", async () => {
  await withTempDir("shallow-test-tool-", async root => {
    await makeApp(root);
    let childRef: FakeChild | undefined;
    const { spawnFn } = fakeSpawn(child => { childRef = child; /* never exits on its own; the timeout must kill it */ });
    const tool = createTestTool(root, { spawnFn, frontendTimeoutMs: 20 });
    const result = await execute(tool, { target: "frontend" });
    assert.ok(childRef!.killed, "suite process was not killed on timeout");
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /timed out/);
  });
});

test("run_tests points at installation when the frontend Vitest entry is missing", async () => {
  await withTempDir("shallow-test-tool-", async root => {
    await makeApp(root, { frontend: false });
    const { calls, spawnFn } = fakeSpawn();
    const tool = createTestTool(root, { spawnFn });
    await assert.rejects(execute(tool, { target: "frontend" }), /Test (entry|working directory).*install command first/s);
    assert.equal(calls.length, 0);
  });
});
