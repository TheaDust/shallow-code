import assert from "node:assert/strict";
import { test } from "node:test";

import { installSseResilience, tolerateSseStream } from "../src/builder/sse-resilience.js";

const encoder = new TextEncoder();
const terminal = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n';

function chunkedStream(chunks: string[], errorAfter?: Error): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index++]));
        return;
      }
      if (errorAfter) controller.error(errorAfter);
      else controller.close();
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return text;
    text += decoder.decode(value, { stream: true });
  }
}

function parseDataEvents(body: string): string[] {
  return body
    .split(/\r?\n\r?\n/)
    .map((block) => block.split(/\r?\n/).filter((line) => line.startsWith("data:")))
    .filter((lines) => lines.length > 0)
    .map((lines) => lines.map((line) => line.slice(5).replace(/^ /, "")).join("\n"));
}

test("SSE resilience drops a truncated terminal event and still terminates the stream", async () => {
  const dropped: string[] = [];
  const body = [
    `data: ${JSON.stringify({ created: 1, choices: [{ delta: { content: "hi" }, index: 0 }] })}\n\n`,
    terminal,
    'data: {"created":2,"usage":nu\n\n',
  ].join("");
  const output = await readAll(tolerateSseStream(chunkedStream([body]), (raw) => dropped.push(raw)));
  const events = parseDataEvents(output);
  assert.deepEqual(events.at(-1), "[DONE]", `stream must end with [DONE], got ${output}`);
  assert.equal(events.filter((event) => event === "[DONE]").length, 1);
  for (const event of events.filter((event) => event !== "[DONE]")) {
    assert.doesNotThrow(() => JSON.parse(event), `forwarded event must be valid JSON: ${event}`);
  }
  assert.equal(dropped.length, 1);
  assert.match(dropped[0], /"usage":nu/);
});

test("SSE resilience keeps a well-formed stream intact and never duplicates [DONE]", async () => {
  const body = [
    `data: ${JSON.stringify({ id: "a", choices: [{ delta: { content: "one" } }] })}\n\n`,
    `data: ${JSON.stringify({ id: "b", choices: [{ delta: { content: "two" } }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  const output = await readAll(tolerateSseStream(chunkedStream([body])));
  assert.equal(parseDataEvents(output).filter((event) => event === "[DONE]").length, 1);
  assert.deepEqual(parseDataEvents(output).slice(0, 2), [
    JSON.stringify({ id: "a", choices: [{ delta: { content: "one" } }] }),
    JSON.stringify({ id: "b", choices: [{ delta: { content: "two" } }] }),
  ]);
});

test("SSE resilience reassembles events split across chunks and supports CRLF", async () => {
  const dropped: string[] = [];
  const chunks = [
    'data: {"id":"a",',
    '"choices":[{"index":0,"finish_reason":"stop"}]}\r\n',
    "\r\n",
    'data: {"broken":\r\n\r\n',
    "data: [DONE]\r\n\r\n",
  ];
  const output = await readAll(tolerateSseStream(chunkedStream(chunks), (raw) => dropped.push(raw)));
  const events = parseDataEvents(output);
  assert.deepEqual(events, [JSON.stringify({ id: "a", choices: [{ index: 0, finish_reason: "stop" }] }), "[DONE]"]);
  assert.equal(dropped.length, 1);
});

test("SSE resilience propagates source body errors instead of masking them", async () => {
  const stream = tolerateSseStream(chunkedStream(['data: {"id":"a"}\n\n'], new Error("connection lost")));
  await assert.rejects(readAll(stream), /connection lost/);
});

test("SSE resilience fails a truncated content-bearing event instead of accepting it", async () => {
  const dropped: string[] = [];
  const body = [
    `data: ${JSON.stringify({ id: "a", choices: [{ delta: { content: "ok" } }] })}\n\n`,
    'data: {"choices":[{"delta":{"content":"trunca\n\n',
  ].join("");
  const stream = tolerateSseStream(chunkedStream([body]), (raw) => dropped.push(raw));
  await assert.rejects(readAll(stream), /provider returned error: gateway truncated a content-bearing SSE event/);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0], /"choices"/);
});

test("SSE resilience fails an event that never terminates instead of buffering forever", async () => {
  const stream = tolerateSseStream(chunkedStream([`data: ${"x".repeat(1024 * 1024 + 1)}`]));
  await assert.rejects(readAll(stream), /provider returned error: gateway truncated a content-bearing SSE event/);
});

test("SSE resilience installer transforms event-stream responses and leaves JSON untouched", async () => {
  const originalFetch = globalThis.fetch;
  const dropped: string[] = [];
  const sseBody = terminal + 'data: {"created":1,"usage":nu\n\n';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const contentType = String(input).includes("json") ? "application/json" : "text/event-stream; charset=utf-8";
    const payload = contentType.startsWith("application/json") ? '{"ok":true}' : sseBody;
    return new Response(payload, { status: 200, headers: { "content-type": contentType } });
  }) as typeof globalThis.fetch;
  const resilience = installSseResilience((raw) => dropped.push(raw));
  try {
    const repaired = await (await globalThis.fetch("http://gateway.local/sse")).text();
    assert.deepEqual(parseDataEvents(repaired), [...parseDataEvents(terminal), "[DONE]"]);
    assert.equal(await (await globalThis.fetch("http://gateway.local/json")).text(), '{"ok":true}');
    assert.equal(resilience.repairedEvents(), 1);
    assert.equal(dropped.length, 1);
  } finally {
    resilience.uninstall();
    globalThis.fetch = originalFetch;
  }
});

test("SSE resilience rejects early truncation even before a choices key is visible", async () => {
  const partial = 'data: {"choices":[{"index":0,"delta":{"content":"working"},"finish_reason":null}]}\n\n';
  for (const tail of ['', 'data: {"id":"cut","cho', 'data: {"usage":nu\n\ndata: [DONE]\n\n']) {
    await assert.rejects(readAll(tolerateSseStream(chunkedStream([partial, tail]))), /provider returned error/);
  }
  await assert.rejects(readAll(tolerateSseStream(chunkedStream([]))), /provider returned error/);
});

test("SSE resilience accepts missing DONE only after the requested choice finishes", async () => {
  for (const reason of ['stop', 'tool_calls', 'length', 'content_filter']) {
    const body = terminal.replace('"stop"', JSON.stringify(reason));
    const output = await readAll(tolerateSseStream(chunkedStream([body])));
    assert.deepEqual(parseDataEvents(output), [...parseDataEvents(body), '[DONE]']);
  }
  for (const body of ['data: {"choices":[]}\n\n', terminal.replace('"index":0', '"index":1')]) {
    await assert.rejects(readAll(tolerateSseStream(chunkedStream([body]))), /provider returned error/);
  }
});

test("SSE resilience still rejects damaged content after finish_reason", async () => {
  await assert.rejects(readAll(tolerateSseStream(chunkedStream([terminal, 'data: {"choices":['] ))), /provider returned error/);
});
