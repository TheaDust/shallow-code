import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { installSseCapture, type SseAnomaly } from "../src/builder/sse-capture.js";
import { withTempDir } from "./helpers/temp-dir.js";

const encoder = new TextEncoder();

function streamedResponse(body: string, contentType = "text/event-stream; charset=utf-8"): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": contentType } });
}

test("SSE capture tees event-stream bodies and flags malformed events", async () => {
  await withTempDir("shallow-sse-", async (directory) => {
    const body = [
      `data: ${JSON.stringify({ id: "ok", choices: [{ delta: { content: "hi" } }] })}\n\n`,
      'data: {"id":"truncated",\n\n',
      'data: {"id":"split",\n',
      'data: "choices":[]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => streamedResponse(body)) as typeof globalThis.fetch;
    const capture = installSseCapture(directory, "builder");
    try {
      const response = await globalThis.fetch("http://gateway.local/v1/chat/completions");
      assert.equal(await response.text(), body, "capture must not alter the caller's response");
    } finally {
      await capture.uninstall();
      globalThis.fetch = originalFetch;
    }

    assert.equal(capture.capturedResponses(), 1);
    const base = join(directory, `builder-${process.pid}-1`);
    assert.equal(await readFile(base + ".sse", "utf8"), body, "capture must store the raw bytes");
    const meta = JSON.parse(await readFile(base + ".meta.json", "utf8")) as {
      url: string; status: number; events: number; anomalies: SseAnomaly[];
    };
    assert.equal(meta.url, "http://gateway.local/v1/chat/completions");
    assert.equal(meta.status, 200);
    assert.equal(meta.events, 4);
    const kinds = meta.anomalies.map((anomaly) => anomaly.kind);
    assert.ok(kinds.some((kind) => kind.startsWith("invalid_json:")), `expected invalid_json in ${JSON.stringify(kinds)}`);
    assert.ok(kinds.includes("multi_data_lines"), `expected multi_data_lines in ${JSON.stringify(kinds)}`);
  });
});

test("SSE capture records the request model and ignores non event-stream responses", async () => {
  await withTempDir("shallow-sse-", async (directory) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => streamedResponse('data: {"id":"ok"}\n\ndata: [DONE]\n\n')) as typeof globalThis.fetch;
    const capture = installSseCapture(directory, "builder");
    try {
      await (await globalThis.fetch("http://gateway.local/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "provider/model", stream: true }),
      })).text();
    } finally {
      await capture.uninstall();
    }

    const meta = JSON.parse(await readFile(join(directory, `builder-${process.pid}-1.meta.json`), "utf8")) as {
      model?: string; method?: string; anomalies: SseAnomaly[];
    };
    assert.equal(meta.model, "provider/model");
    assert.equal(meta.method, "POST");
    assert.deepEqual(meta.anomalies, []);

    globalThis.fetch = (async () => streamedResponse('{"ok":true}', "application/json")) as typeof globalThis.fetch;
    const jsonCapture = installSseCapture(directory, "builder");
    try {
      assert.equal(await (await globalThis.fetch("http://gateway.local/v1/chat/completions")).text(), '{"ok":true}');
    } finally {
      await jsonCapture.uninstall();
      globalThis.fetch = originalFetch;
    }
    assert.equal(jsonCapture.capturedResponses(), 0);
    await assert.rejects(readFile(join(directory, `builder-${process.pid}-2.meta.json`), "utf8"));
  });
});
