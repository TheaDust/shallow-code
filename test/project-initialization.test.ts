import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { applications } from "../src/adapters/index.js";
import type { CodingAgentPort, CodingAgentRequest, CodingAgentResult } from "../src/builder/execution-port.js";
import { initializeProject, readProjectIntent, selectInitializationPath } from "../src/project-initialization.js";
import { loadPendingInitialization, savePendingInitialization } from "../src/run-record.js";
import { withTempDir } from "./helpers/temp-dir.js";

test("initialization routing distinguishes all five input states", () => {
  assert.equal(selectInitializationPath(false, false, null), "default_scaffold");
  assert.equal(selectInitializationPath(false, false, "Vue"), "custom");
  assert.equal(selectInitializationPath(true, false, null), "complete_existing");
  assert.equal(selectInitializationPath(true, true, "Vue"), "existing");
  assert.equal(selectInitializationPath(false, true, null), "declared_empty");
});

test("blank project without technical intent installs the shipped scaffold without a model call", async () => {
  await withTempDir("shallow-init-", async root => {
    const outputDir = join(root, "app");
    await mkdir(outputDir);
    let calls = 0;
    const result = await initializeProject({ outputDir, privateDir: join(root, "private"),
      requirementsContext: "minimal", intent: null, env: {}, startedAtMs: Date.now(), budgetMs: 0,
      applications, createBuilder: () => { calls++; throw new Error("unexpected model call"); },
      verify: async () => {}, });
    assert.equal(result.path, "default_scaffold");
    assert.equal(calls, 0);
    assert.match(await readFile(join(outputDir, "shallowcode.config.json"), "utf8"), /frontend/);
  });
});

test("explicit stack initializes without copying the default scaffold and retries configuration failures", async () => {
  await withTempDir("shallow-init-", async root => {
    const outputDir = join(root, "app");
    await mkdir(outputDir);
    const seen: CodingAgentRequest[] = [];
    const fake: CodingAgentPort = {
      async run(input): Promise<CodingAgentResult> {
        seen.push(input);
        if (seen.length === 1) await writeFile(join(outputDir, "shallowcode.config.json"), "{}");
        else {
          await writeFile(join(outputDir, "shallowcode.config.json"), JSON.stringify({
            start: { executable: "python", args: ["server.py"] }, adapter: "web",
          }));
          await writeFile(join(outputDir, "server.py"), "print('ready')\n");
        }
        return { sessionId: "fake", outcome: "completed", summary: "done" };
      },
      async close() {},
    };
    const result = await initializeProject({ outputDir, privateDir: join(root, "private"),
      requirementsContext: "a Web app", intent: "使用 Python 后端", env: {}, startedAtMs: Date.now(), budgetMs: 0,
      applications, createBuilder: () => fake, verify: async () => {}, });
    assert.equal(result.path, "custom");
    assert.equal(seen.length, 2);
    assert.match(seen[1].taskPrompt, /上一次控制器验证失败/);
    assert.equal(seen[0].applicationContract, undefined);
    assert.equal(result.contract.startCommand.executable, "python");
    await assert.rejects(readFile(join(outputDir, "frontend", "package.json")));
  });
});

test("existing configuration conflict is inspected with read only tools", async () => {
  await withTempDir("shallow-init-", async root => {
    const outputDir = join(root, "app");
    await mkdir(outputDir);
    const config = JSON.stringify({ start: { executable: "node", args: ["server.js"] } });
    await writeFile(join(outputDir, "shallowcode.config.json"), config);
    await writeFile(join(outputDir, "server.js"), "// existing\n");
    let mode: string | undefined;
    const fake: CodingAgentPort = {
      async run(input) { mode = input.toolMode; return { sessionId: "fake", outcome: "completed", summary: "CONFLICT: Node backend conflicts with explicit FastAPI requirement" }; },
      async close() {},
    };
    await assert.rejects(initializeProject({ outputDir, privateDir: join(root, "private"),
      requirementsContext: "app", intent: "使用 FastAPI", env: {}, startedAtMs: Date.now(), budgetMs: 0,
      applications, createBuilder: () => fake, verify: async () => {}, }), /CONFLICT:/);
    assert.equal(mode, "read_only");
    assert.equal(await readFile(join(outputDir, "shallowcode.config.json"), "utf8"), config);
  });
});

test("technical intent input is optional and empty files are rejected", async () => {
  await withTempDir("shallow-init-", async root => {
    assert.equal(await readProjectIntent(root), null);
    await writeFile(join(root, "project-intent.md"), "Vue + SQLite\n");
    assert.equal(await readProjectIntent(root), "Vue + SQLite");
    await writeFile(join(root, "project-intent.md"), "   ");
    await assert.rejects(readProjectIntent(root), /empty/);
  });
});

test("interrupted custom initialization reuses generated files and its durable record", async () => {
  await withTempDir("shallow-init-", async root => {
    const outputDir = join(root, "app");
    const privateDir = join(root, "private");
    await mkdir(outputDir);
    await writeFile(join(outputDir, "shallowcode.config.json"), JSON.stringify({
      start: { executable: "node", args: ["server.mjs"] }, adapter: "web",
    }));
    await writeFile(join(outputDir, "server.mjs"), "// existing generated code\n");
    const record = { version: 1 as const, requirementsDir: root, requirementsDigest: "digest",
      outputDir, inputBaseline: "a".repeat(40), inputFiles: {}, path: "custom" as const, modelUsage: [] };
    await savePendingInitialization(privateDir, record);
    assert.deepEqual(await loadPendingInitialization(privateDir), record);
    let modelCalls = 0;
    const result = await initializeProject({ outputDir, privateDir, requirementsContext: "app",
      intent: "自定义技术栈", resumePath: record.path, env: {}, startedAtMs: Date.now(), budgetMs: 0,
      applications, createBuilder: () => { modelCalls++; throw new Error("resumed runnable project should not call model"); },
      verify: async () => {}, });
    assert.equal(result.path, "custom");
    assert.equal(modelCalls, 0);
    assert.match(await readFile(join(outputDir, "server.mjs"), "utf8"), /existing/);
  });
});
