import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { applications } from "../src/adapters/index.js";
import { ApplicationRegistry } from "../src/application/registry.js";
import type { RuntimeAdapter } from "../src/application/port.js";
import { parseProjectSpec, resolveApplicationContract } from "../src/project-spec.js";
import type { CodingAgentPort, CodingAgentRequest, CodingAgentResult } from "../src/builder/execution-port.js";
import { initializeProject, readProjectIntent, selectInitializationPath } from "../src/project-initialization.js";
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
    assert.match(seen[0].systemPrompt, /Web 工程.*PORT/);
    assert.equal(result.contract.startCommand.executable, "python");
    await assert.rejects(readFile(join(outputDir, "frontend", "package.json")));
  });
});

test("initialization uses the selected adapter's instructions without imposing Web runtime rules", async () => {
  await withTempDir("shallow-init-adapter-", async root => {
    const outputDir = join(root, "app"); await mkdir(outputDir);
    const spec = parseProjectSpec({ adapter: "fixture", start: { executable: "fixture-host" } });
    await writeFile(join(outputDir, "shallowcode.config.json"), JSON.stringify(spec));
    const adapter: RuntimeAdapter = {
      id: "fixture", initializationInstructions: "FIXTURE_INITIALIZATION: use the declared input stream.",
      parseSpec: parseProjectSpec, defaultSpec: () => spec,
      configure: async value => resolveApplicationContract(value),
      lifecycle: { async start() { throw new Error("Not used"); } },
      async installScaffold() { throw new Error("Not used"); },
      builderCapabilities: () => ({ tools: [], skillDirectories: [], async close() {} }),
      async verifyDelivery() { throw new Error("Not used"); },
    };
    let calls = 0;
    const result = await initializeProject({ outputDir, privateDir: join(root, "private"),
      requirementsContext: "Process an input stream", intent: null, env: {}, startedAtMs: Date.now(), budgetMs: 0,
      applications: new ApplicationRegistry([adapter]), verify: async () => {},
      createBuilder: () => ({ async run(request) {
        calls++;
        assert.match(request.systemPrompt, /FIXTURE_INITIALIZATION/);
        assert.doesNotMatch(request.systemPrompt, /Web|PORT|浏览器|健康检查/);
        return { outcome: "completed", sessionId: "fixture", summary: "ready" };
      }, async close() {} }),
    });
    assert.equal(result.contract.adapterId, "fixture"); assert.equal(calls, 1);
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
