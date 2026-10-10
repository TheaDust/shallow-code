import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createPiSession, type PiSessionSnapshot } from "../src/builder/pi-sdk-adapter.js";
import { resolveRuntimeContract } from "../src/project-spec.js";
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
    const cases = [
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
        systemPrompt: "Use the requested tool and finish.", timeoutMs: 20_000 }, snapshot => progress.push(snapshot));
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
        assert.equal(snapshot.engineVersion, lock.packages["node_modules/@mariozechner/pi-coding-agent"].version);
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
      const session = await createPiSession({ outputDir: app, sessionDir: join(root, "sessions"), platformContract: contract,
        gateway: { apiKey: "fixture", model: "fixture", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` },
        systemPrompt: "Run the declared tests.", timeoutMs: 20_000 }, () => {});
      try {
        assert.equal((await session.prompt("Run unit.")).outcome, "completed");
        assert.deepEqual(session.snapshot().timing.toolCounts, [{ name: "run_tests", count: 1 }]);
      } finally { session.dispose(); }
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
