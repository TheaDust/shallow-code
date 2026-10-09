import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { PiWorkerClient } from "../src/builder/pi-worker-client.js";
import { withTempDir } from "./helpers/temp-dir.js";

function reply(res: ServerResponse, content: string, finish = "stop", tool = false,
  promptTokens = tool ? 230_000 : 100, completionTokens = 100) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: "write-1", type: "function",
    function: { name: "write", arguments: JSON.stringify({ path: "progress.txt", content: "unfinished work" }) } }] }
    : { role: "assistant", content, reasoning_content: "reasoning alone is not a receipt" };
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : finish }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens } })}\n\n`);
  res.end("data: [DONE]\n\n");
}

async function fixture(handler: (body: Record<string, unknown>, response: ServerResponse, count: number) => void | Promise<void>,
  check: (client: PiWorkerClient, app: string) => Promise<void>) {
  await withTempDir("shallow-pi-recovery-", async root => {
    const app = join(root, "app"); await mkdir(app);
    let count = 0;
    const server = createServer(async (req, res) => {
      let raw = ""; for await (const part of req) raw += part;
      await handler(JSON.parse(raw), res, ++count);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const client = new PiWorkerClient({ apiKey: "local-fixture", model: "fixture",
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` }, join(root, "sessions"));
    try { await check(client, app); }
    finally { await client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
}
const prompt = { systemPrompt: "Finish the task using tools.", taskPrompt: "Write progress.txt and finish.", timeoutMs: 20_000 };

test("Worker waits for SDK overflow compaction and its delayed continuation before reporting completion", { timeout: 35_000 }, async () => {
  const requests: number[] = [];
  await fixture(async (body, res, n) => {
    requests.push((body.tools as unknown[] | undefined)?.length ?? 0);
    if (n === 2) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "maximum context length is 256000 tokens", code: "context_length_exceeded" } }));
    } else {
      if (n === 3) await new Promise(resolve => setTimeout(resolve, 250));
      reply(res, n === 3 ? "Summary: the file exists. Finish the task." : "Implementation finished after recovery.", "stop", n === 1);
    }
  }, async (client, app) => {
    const result = await client.run({ ...prompt, outputDir: app });
    assert.equal(result.outcome, "completed", result.summary);
    assert.equal(result.compactions, 1);
    assert.equal(result.terminationReason, undefined);
    assert.equal(result.execution?.termination?.compactionReason, "overflow");
    assert.equal(result.execution?.termination?.compactionPending, false);
    assert.equal(result.execution?.termination?.retryPending, false);
    assert.equal(result.execution?.termination?.progressedAfterOverflowCompaction, false,
      "no tool call followed the overflow compaction, so it was not a context-bound continuation");
    assert.equal(requests.length, 4, "tool turn, overflow, compaction, continued completion");
    assert.equal(requests[2], 0, "SDK compaction request has no business tools");
    assert.equal(await readFile(join(app, "progress.txt"), "utf8"), "unfinished work");
  });
});

for (const reason of ["overflow", "threshold"] as const) {
  for (const empty of [false, true]) {
    test(`A successful ${reason} response keeps its receipt after compaction: empty=${empty}`, { timeout: 35_000 }, async () => {
      const requests: Record<string, unknown>[] = [];
      await fixture((body, res, n) => {
        requests.push(body);
        if (n === 4) assert.match(JSON.stringify(body.messages), /完成回执/);
        const content = n === 3 ? "Compaction summary, not a completion receipt."
          : n === 2 && empty ? "" : "Implementation finished with the original receipt.";
        reply(res, content, "stop", n === 1, n === 2 ? reason === "overflow" ? 257_000 : 250_000 : n === 1 ? 230_000 : 100);
      }, async (client, app) => {
        const result = await client.run({ ...prompt, outputDir: app });
        assert.equal(result.outcome, "completed", result.summary);
        assert.equal(result.summary, "Implementation finished with the original receipt.");
        assert.equal(result.execution?.termination?.compactionReason, reason);
        assert.equal(result.execution?.termination?.compactionPending, false);
        assert.equal(result.execution?.termination?.retryPending, false);
        // Only an overflow compaction is tracked; a threshold compaction has no signal.
        assert.equal(result.execution?.termination?.progressedAfterOverflowCompaction,
          reason === "overflow" ? false : undefined);
        assert.equal(requests.length, empty ? 4 : 3);
        assert.equal((requests[2].tools as unknown[] | undefined)?.length ?? 0, 0);
        assert.equal(await readFile(join(app, "progress.txt"), "utf8"), "unfinished work");
      });
    });
  }
}

test("A zero-output length overflow reports a recoverable terminal failure after compaction", { timeout: 35_000 }, async () => {
  let requests = 0;
  await fixture((_body, res, n) => {
    requests = n;
    reply(res, n === 2 ? "" : "Compaction summary", n === 2 ? "length" : "stop", n === 1,
      n === 2 ? 257_000 : n === 1 ? 230_000 : 100, n === 2 ? 0 : 100);
  }, async (client, app) => {
    const result = await client.run({ ...prompt, outputDir: app });
    assert.equal(result.outcome, "failed");
    assert.equal(result.terminationReason, "model_length_limit");
    assert.equal(result.execution?.termination?.compactionPending, false);
    assert.equal(result.execution?.termination?.retryPending, false);
    assert.equal(requests, 3);
  });
});

for (const completes of [true, false]) {
  test(`Empty terminal response requests a receipt once: completes=${completes}`, { timeout: 30_000 }, async () => {
    let calls = 0;
    await fixture((body, res, n) => {
      calls = n;
      if (n === 2) assert.match(JSON.stringify(body.messages), /完成回执/);
      reply(res, n === 2 && completes ? "Completed with a receipt." : "");
    }, async (client, app) => {
      const result = await client.run({ ...prompt, outputDir: app });
      assert.equal(result.outcome, completes ? "completed" : "failed", result.summary);
      assert.equal(result.terminationReason, completes ? undefined : "empty_terminal_response");
      assert.equal(calls, 2);
    });
  });
}

test("Worker deadline preserves already reported usage and termination diagnostics", { timeout: 30_000 }, async () => {
  let calls = 0;
  await fixture((_body, res, n) => { calls = n; if (n === 1) reply(res, "", "stop", true); }, async (client, app) => {
    const result = await client.run({ ...prompt, outputDir: app, timeoutMs: 10_000 });
    assert.equal(calls, 2);
    assert.equal(result.outcome, "timed_out");
    const usage = result.execution?.usage;
    assert.equal(usage?.status, "available");
    assert.ok(usage?.status === "available" && usage.input >= 230_000);
    assert.equal(result.execution?.toolCalls, 1);
    assert.equal(result.execution?.termination?.lastMessageRole, "toolResult");
  });
});
