import { webBuilderCapabilities } from "../src/adapters/web/builder-capabilities.js";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createPiSession, type PiSessionSnapshot } from "../src/builder/pi-sdk-adapter.js";
import { resolveRuntimeContract } from "../src/adapters/web/project-spec.js";
import { BUILDER_SKILLS_DIR } from "../src/builder/skills.js";
import { withTempDir } from "./helpers/temp-dir.js";

function reply(res: ServerResponse, tool?: { name: string; arguments: object }) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: "call-1", type: "function",
    function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } : { role: "assistant", content: "done" };
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: 5 } })}\n\n`);
  res.end("data: [DONE]\n\n");
}

test("Pi adapter preserves native file tools and guards their actual execution", { timeout: 30_000 }, async () => {
  await withTempDir("shallow-pi-adapter-", async root => {
    const app = join(root, "app"); await mkdir(app);
    const visibleFile = join(app, "visible.txt");
    const privateFile = join(root, "private.txt");
    await writeFile(visibleFile, "visible content");
    await writeFile(privateFile, "private content");
    const skillFile = fileURLToPath(new URL("../prompts/adapters/web/skills/accessible-web-controls/SKILL.md", import.meta.url));
    const skillContent = await readFile(skillFile, "utf8");
    await mkdir(join(app, ".pi", "skills", "unapproved"), { recursive: true });
    await writeFile(join(app, ".pi", "skills", "unapproved", "SKILL.md"),
      "---\nname: unapproved\ndescription: WORKSPACE_SKILL_SENTINEL\n---\nworkspace skill");
    const cases = [
      { name: "read", arguments: { path: skillFile }, expected: /# 可访问 Web 交互/ },
      { name: "read", arguments: { path: join(BUILDER_SKILLS_DIR, "..", "builder", "builder-system.md") }, expected: /outside the application/ },
      { name: "write", arguments: { path: skillFile, content: skillContent }, expected: /outside the application/ },
      { name: "edit", arguments: { path: skillFile, edits: [{ oldText: "SKILL_GUARD_SENTINEL_NOT_PRESENT", newText: "unchanged" }] }, expected: /outside the application/ },
      { name: "read", arguments: { path: visibleFile }, expected: /visible content/ },
      { name: "read", arguments: { path: privateFile }, expected: /outside the application/ },
      { name: "write", arguments: { path: privateFile, content: "overwritten" }, expected: /outside the application/ },
      { name: "edit", arguments: { path: privateFile, edits: [{ oldText: "private content", newText: "overwritten" }] }, expected: /outside the application/ },
      { name: "write", arguments: { path: visibleFile, content: "updated" }, expected: /Successfully wrote/ },
      { name: "edit", arguments: { path: visibleFile, edits: [{ oldText: "updated", newText: "finished" }] }, expected: /Successfully replaced/ },
    ];
    let calls = 0;
    const server = createServer(async (req, res) => {
      let body = ""; for await (const part of req) body += part;
      const request = JSON.parse(body);
      const index = Math.floor(calls++ / 2);
      if (calls === 1) {
        const system = JSON.stringify(request.messages.filter((message: { role: string }) => message.role === "system"));
        for (const name of ["accessible-web-controls", "persistent-state", "identity-and-permissions", "linked-records", "editable-grid", "web-delivery"]) {
          assert.ok(system.includes(name), name);
        }
        assert.ok(system.includes("SKILL.md"));
        assert.doesNotMatch(system, /# 可访问 Web 交互|WORKSPACE_SKILL_SENTINEL/);
      }
      if (calls % 2 === 1) reply(res, cases[index]);
      else {
        const result = request.messages.at(-1);
        assert.equal(result.role, "tool");
        assert.match(JSON.stringify(result.content), cases[index].expected);
        reply(res);
      }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const progress: PiSessionSnapshot[] = [];
    try {
      const session = await createPiSession({ outputDir: app, sessionDir: join(root, "sessions"),
        gateway: { apiKey: "fixture", model: "fixture", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` },
        systemPrompt: "Use the requested tool and finish.", timeoutMs: 20_000 }, snapshot => progress.push(snapshot), webBuilderCapabilities(app));
      try {
        for (const entry of cases) {
          assert.deepEqual(await session.prompt(`Execute ${entry.name}.`), {
            outcome: "completed", summary: "done", providerError: undefined,
          });
        }
        assert.equal(await readFile(privateFile, "utf8"), "private content");
        assert.equal(await readFile(visibleFile, "utf8"), "finished");
        const snapshot = session.snapshot();
        const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
        assert.equal(snapshot.engineVersion, lock.packages["node_modules/@earendil-works/pi-coding-agent"].version);
        assert.equal(snapshot.toolCalls, cases.length);
        assert.equal(snapshot.usage.status, "available");
        assert.equal(snapshot.termination.compactionPending, false);
        assert.equal(snapshot.termination.retryPending, false);
        assert.ok(progress.length >= cases.length);
      } finally { session.dispose(); }
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

test("Pi adapter executes a project tool with its declared parameters and environment", { timeout: 30_000 }, async () => {
  await withTempDir("shallow-pi-custom-tool-", async root => {
    const app = join(root, "app"); await mkdir(app);
    await writeFile(join(app, "check.cjs"), "require('node:assert/strict').equal(process.env.FLAG, 'declared'); console.log('project-tool-passed');");
    const contract = resolveRuntimeContract({ start: { executable: "node" }, env: { FLAG: "declared" },
      tests: [{ id: "unit", executable: process.execPath, args: ["check.cjs"] }] }, { port: 3100 });
    let calls = 0;
    const server = createServer(async (req, res) => {
      let body = ""; for await (const part of req) body += part;
      const request = JSON.parse(body);
      if (++calls === 1) {
        assert.ok(request.tools.some((tool: { function: { name: string } }) => tool.function.name === "app"));
        reply(res, { name: "run_tests", arguments: { target: "unit" } });
      } else {
        assert.match(JSON.stringify(request.messages.at(-1).content), /project-tool-passed/);
        reply(res);
      }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const session = await createPiSession({ outputDir: app, sessionDir: join(root, "sessions"), applicationContract: contract,
        gateway: { apiKey: "fixture", model: "fixture", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` },
        systemPrompt: "Run the declared tests.", timeoutMs: 20_000 }, () => {});
      try {
        assert.equal((await session.prompt("Run unit.")).outcome, "completed");
        assert.deepEqual(session.snapshot().timing.toolCounts, [{ name: "run_tests", count: 1 }]);
      } finally { session.dispose(); }
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

test("Pi adapter resumes a 0.73.1 session with its checkpoint and keeps credentials in memory", { timeout: 30_000 }, async () => {
  await withTempDir("shallow-pi-legacy-", async root => {
    const app = join(root, "app"); await mkdir(app);
    const sessionDir = join(root, "sessions"); await mkdir(sessionDir);
    const sessionFile = join(sessionDir, "legacy.jsonl");
    const sessionId = "745d0360-0cfa-4fbf-bae3-6e5a1f6d92ef";
    const timestamp = "2026-05-07T00:00:00.000Z";
    // Version 0.73.1 writes version-3 linked entries without transcript system messages.
    const entries = [
      { type: "session", version: 3, id: sessionId, timestamp, cwd: app },
      { type: "model_change", id: "00000001", parentId: null, timestamp, provider: "shallow-gateway", modelId: "fixture" },
      { type: "message", id: "00000002", parentId: "00000001", timestamp,
        message: { role: "user", content: [{ type: "text", text: "Remember legacy alpha." }], timestamp: Date.parse(timestamp) } },
      { type: "message", id: "00000003", parentId: "00000002", timestamp,
        message: { role: "assistant", api: "openai-completions", provider: "shallow-gateway", model: "fixture",
          content: [{ type: "text", text: "Legacy work completed." }], stopReason: "stop", timestamp: Date.parse(timestamp),
          usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 25,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
      { type: "compaction", id: "00000004", parentId: "00000003", timestamp,
        summary: "Legacy checkpoint for alpha.", firstKeptEntryId: "00000002", tokensBefore: 250_000 },
    ];
    await writeFile(sessionFile, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    let request: { messages: unknown[] } | undefined;
    const server = createServer(async (req, res) => {
      let body = ""; for await (const part of req) body += part;
      request = JSON.parse(body);
      assert.equal(req.headers.authorization, "Bearer legacy-session-secret");
      reply(res);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const session = await createPiSession({ outputDir: app, sessionDir, sessionFile,
        gateway: { apiKey: "legacy-session-secret", model: "fixture", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` },
        systemPrompt: "Use the current controller instructions.", timeoutMs: 20_000 }, () => {});
      try {
        assert.equal((await session.prompt("Continue legacy beta.")).outcome, "completed");
        assert.equal(session.snapshot().sessionId, sessionId);
        for (const text of ["Remember legacy alpha.", "Legacy checkpoint for alpha.", "Continue legacy beta.",
          "Use the current controller instructions."]) assert.ok(JSON.stringify(request?.messages).includes(text), text);
        assert.doesNotMatch(await readFile(sessionFile, "utf8"), /legacy-session-secret/);
        assert.deepEqual(await readdir(join(sessionDir, "config")), []);
      } finally { session.dispose(); }
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
