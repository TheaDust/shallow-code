import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { PiWorkerClient } from "../src/builder/pi-worker-client.js";
import { createArcPlatformContract, pickFreePort } from "../src/runtime-config.js";
import { withTempDir } from "./helpers/temp-dir.js";

function completion(res: ServerResponse, tool?: { name: string; arguments: Record<string, unknown> }, finish = "stop") {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } : { role: "assistant", content: "done" };
  for (const choice of [{ delta, finish_reason: null }, { delta: {}, finish_reason: tool ? "tool_calls" : finish }]) {
    res.write(`data: ${JSON.stringify({ id: "response", choices: [{ index: 0, ...choice }] })}\n\n`);
  }
  res.end("data: [DONE]\n\n");
}

async function fixture(handler: (body: Record<string, unknown>, response: ServerResponse, count: number) => void,
  check: (client: PiWorkerClient, app: string, root: string) => Promise<void>) {
  await withTempDir("shallow-pi-errors-", async root => {
    const app = join(root, "app"); await mkdir(app);
    let count = 0;
    const server = createServer(async (req, res) => {
      let raw = ""; for await (const chunk of req) raw += chunk;
      handler(JSON.parse(raw), res, ++count);
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const client = new PiWorkerClient({ apiKey: "test-key", model: "test/model", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` }, join(root, "sessions"));
    try { await check(client, app, root); }
    finally { await client.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  });
}
const prompt = { systemPrompt: "Use tools when requested.", taskPrompt: "do the task", timeoutMs: 10_000, sessionKey: "implementation" };

for (const timeout of [false, true]) {
  test(`Managed app IPC starts the real app and cleans it after Worker ${timeout ? "timeout" : "completion"}`, { timeout: 30_000 }, async () => {
    let ready!: (response: ServerResponse) => void;
    const appReady = new Promise<ServerResponse>(resolve => { ready = resolve; });
    await fixture((_body, response, count) => {
      if (count === 1) completion(response, { name: "app", arguments: { action: "start" } });
      else ready(response);
    }, async (client, app) => {
      await writeFile(join(app, "server.cjs"), `
require('node:http').createServer((req,res)=>res.end(JSON.stringify({data:process.env.SHALLOW_DATA_DIR,extra:process.env.ARC_EXTRA_PORTS}))).listen(Number(process.env.PORT),'127.0.0.1');
`);
      const platformContract = createArcPlatformContract(process.platform, await pickFreePort([3000, 3301]));
      platformContract.startCommand = { executable: process.execPath, args: ["server.cjs"], cwd: "output" };
      const running = client.run({ ...prompt, timeoutMs: 8_000, outputDir: app, platformContract });
      const response = await appReady;
      const live = await fetch(platformContract.baseUrl).then(r => r.json()) as { data: string; extra: string };
      assert.ok(live.data);
      assert.equal(live.extra, "0");
      if (!timeout) completion(response);
      const result = await running;
      assert.equal(result.outcome, timeout ? "timed_out" : "completed", result.summary);
      await assert.rejects(fetch(platformContract.baseUrl, { signal: AbortSignal.timeout(1000) }));
      await assert.rejects(readdir(live.data), { code: "ENOENT" });
    });
  });
}

test("Authentication failure is not retried and its session is not reused", { timeout: 30_000 }, async () => {
  let count = 0;
  await fixture((_body, res, n) => { count = n; if (n === 1) { res.writeHead(401); res.end(JSON.stringify({ error: { message: "Invalid API key" } })); } else completion(res); }, async (client, app) => {
    const failed = await client.run({ ...prompt, outputDir: app });
    assert.equal(failed.outcome, "failed"); assert.equal(count, 1);
    assert.deepEqual(failed.gatewayFailure, { kind: "authentication", retryable: false, status: 401 });
    const recovered = await client.run({ ...prompt, outputDir: app });
    assert.equal(recovered.outcome, "completed", recovered.summary);
    assert.notEqual(failed.sessionId, recovered.sessionId);
    assert.equal(recovered.execution?.resumed, false);
    assert.equal(recovered.gatewayFailure, undefined);
  });
});

test("Worker identifies an upstream reset wrapped in HTTP 400 as retryable", { timeout: 30_000 }, async () => {
  await fixture((_body, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: '400 Post "https://api.taotoken.net/v1/chat/completions": read tcp 192.168.0.12:35232->119.3.253.96:443: read: connection reset by peer (request id: example)' } }));
  }, async (client, app) => {
    const result = await client.run({ ...prompt, outputDir: app });
    assert.equal(result.outcome, "failed");
    assert.deepEqual(result.gatewayFailure, { kind: "unavailable", retryable: true, status: 400 }, result.summary);
  });
});

for (const afterTool of [false, true]) {
  test(`Worker preserves actual quota failure metadata, including partial work: afterTool=${afterTool}`, { timeout: 30_000 }, async () => {
    await fixture((_body, res, count) => {
      if (afterTool && count === 1) return completion(res, { name: "write", arguments: { path: "partial.txt", content: "keep" } });
      res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
      res.end(JSON.stringify({ error: { message: "Free allocated quota exceeded." } }));
    }, async (client, app) => {
      const result = await client.run({ ...prompt, outputDir: app });
      assert.equal(result.outcome, "failed");
      assert.deepEqual(result.gatewayFailure, { kind: "rate_limit", retryable: true, status: 429, retryAfterMs: 0 });
      assert.equal(result.execution?.toolCalls, afterTool ? 1 : 0);
      if (afterTool) assert.equal(await readFile(join(app, "partial.txt"), "utf8"), "keep");
    });
  });
}

test("Truncated assistant output is failure, not successful completion", async () => {
  await fixture((_body, res) => completion(res, undefined, "length"), async (client, app) => {
    const result = await client.run({ ...prompt, outputDir: app });
    assert.equal(result.outcome, "failed");
  });
});

test("A hanging gateway is cancelled and the client can start a fresh worker", { timeout: 30_000 }, async () => {
  let hang = true;
  await fixture((_body, res) => { if (!hang) completion(res); }, async (client, app) => {
    const result = await client.run({ ...prompt, timeoutMs: 1_000, outputDir: app });
    assert.equal(result.outcome, "timed_out");
    hang = false;
    assert.equal((await client.run({ ...prompt, outputDir: app })).outcome, "completed");
  });
});

test("Worker tool data is isolated per call and removed after completion or timeout", { timeout: 60_000 }, async () => {
  await fixture((_body, res, count) => {
    if ([1, 3, 5].includes(count)) return completion(res, { name: "shell", arguments: { command: "node data-probe.cjs" } });
    if (count < 6) completion(res);
  }, async (client, app, root) => {
    await writeFile(join(app, "data-probe.cjs"), `
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.SHALLOW_DATA_DIR;
if (!dir) throw new Error('missing isolated data directory');
const file = path.join(dir, 'state.json');
const existed = fs.existsSync(file);
fs.writeFileSync(file, 'debug mutation');
fs.writeFileSync('data-proof.json', JSON.stringify({ dir, existed }));
`);
    const paths = new Set<string>();
    for (const outcome of ["completed", "completed", "timed_out"]) {
      const result = await client.run({ ...prompt, outputDir: app, timeoutMs: 10_000 });
      assert.equal(result.outcome, outcome, result.summary);
      const proof = JSON.parse(await readFile(join(app, "data-proof.json"), "utf8"));
      assert.equal(proof.existed, false, "a new call must not inherit debug mutations");
      assert.ok(!proof.dir.startsWith(app));
      assert.ok(!paths.has(proof.dir));
      paths.add(proof.dir);
      await assert.rejects(readdir(proof.dir), { code: "ENOENT" });
      assert.ok(!(await readdir(join(root, "sessions"))).some(name => name.startsWith("data-")));
    }
  });
});

for (const afterTool of [false, true]) {
  test(`Image rejection is eligible for fallback only before tools: afterTool=${afterTool}`, { timeout: 30_000 }, async () => {
    await fixture((_body, res, count) => {
      if (afterTool && count === 1) return completion(res, { name: "write", arguments: { path: "proof.txt", content: "written" } });
      res.writeHead(400); res.end(JSON.stringify({ error: { message: "This model does not support image input" } }));
    }, async (client, app, root) => {
      await writeFile(join(root, "image.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"));
      const result = await client.run({ ...prompt, outputDir: app, requirementsDir: root, references: ["image.png"] });
      assert.equal(result.outcome, "failed");
      assert.equal(result.referenceImages?.attachedCount, 1);
      assert.equal(result.imageUnsupported, !afterTool);
      if (afterTool) assert.equal(await readFile(join(app, "proof.txt"), "utf8"), "written");
    });
  });
}
