import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Debug-only SSE tap for the Pi worker.
 *
 * The gateway occasionally returns a `text/event-stream` event whose JSON the
 * OpenAI client cannot parse, which aborts the whole turn and discards every
 * token streamed up to that point. When `SHALLOW_CAPTURE_SSE` is set the worker
 * tees each event-stream response body to disk so the offending payload can be
 * inspected after the fact.
 *
 * Never enabled by default and never throws into the request path: any capture
 * failure is recorded alongside the payload instead of breaking the call.
 */

const EVENT_STREAM_CONTENT_TYPE = /^text\/event-stream\b/i;
const EVENT_SEPARATOR = /\r?\n\r?\n/;
const MAX_ANOMALIES = 5;
const MAX_ANOMALY_CHARS = 4_000;
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;

export interface SseCapture {
  /** Restores the previous fetch implementation and awaits pending writes. */
  uninstall(): Promise<void>;
  /** Number of event-stream responses tapped since installation. */
  capturedResponses(): number;
}

export interface SseAnomaly {
  kind: string;
  raw: string;
}

interface RequestSummary {
  url: string;
  method: string;
  model?: string;
  bodyBytes?: number;
}

/** Installs the tap on `globalThis.fetch`. Call `uninstall()` when the call ends. */
export function installSseCapture(dir: string, label: string): SseCapture {
  const target = globalThis as { fetch: typeof globalThis.fetch };
  const original = target.fetch;
  const safeLabel = label.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 40) || "builder";
  const pending = new Set<Promise<void>>();
  let sequence = 0;
  let captured = 0;
  let installed = true;

  const replacement = (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
    const request = describeRequest(input, init);
    return Promise.resolve(original.call(globalThis, input, init)).then(response => {
      try {
        const contentType = response.headers.get("content-type") ?? "";
        if (!installed || !EVENT_STREAM_CONTENT_TYPE.test(contentType) || response.bodyUsed || !response.body) return response;
        sequence += 1;
        const task = captureResponse(response.clone(), request, safeLabel, dir, sequence)
          .catch(() => {})
          .finally(() => { pending.delete(task); });
        pending.add(task);
        captured += 1;
      } catch {
        // Capture must never affect the request path.
      }
      return response;
    });
  };
  target.fetch = replacement as typeof globalThis.fetch;

  return {
    capturedResponses: () => captured,
    async uninstall() {
      installed = false;
      target.fetch = original;
      await Promise.allSettled([...pending]);
    },
  };
}

async function captureResponse(response: Response, request: RequestSummary, label: string, dir: string, index: number): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const base = join(dir, `${label}-${process.pid}-${index}`);
  const stream = createWriteStream(base + ".sse");
  stream.on("error", () => {});
  const decoder = new TextDecoder();
  const anomalies: SseAnomaly[] = [];
  const note = (kind: string, raw: string): void => {
    if (anomalies.length >= MAX_ANOMALIES) return;
    anomalies.push({ kind, raw: raw.slice(0, MAX_ANOMALY_CHARS) });
  };
  let buffer = "";
  let bytes = 0;
  let events = 0;
  let truncated = false;

  const reader = response.body?.getReader();
  try {
    if (reader) {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        bytes += value.byteLength;
        if (bytes <= MAX_CAPTURE_BYTES) stream.write(Buffer.from(value));
        else truncated = true;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const separator = EVENT_SEPARATOR.exec(buffer);
          if (!separator) break;
          const rawEvent = buffer.slice(0, separator.index);
          buffer = buffer.slice(separator.index + separator[0].length);
          events += 1;
          inspectEvent(rawEvent, note);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) note("trailing_partial_event", buffer);
    }
  } catch (error) {
    note("body_error", error instanceof Error ? error.message : String(error));
  } finally {
    try { reader?.releaseLock(); } catch { /* already released */ }
    await new Promise<void>(resolveStream => { stream.end(() => resolveStream()); });
  }

  await writeFile(base + ".meta.json", JSON.stringify({
    label, pid: process.pid, index, ...request,
    status: response.status,
    contentType: response.headers.get("content-type"),
    capturedBytes: Math.min(bytes, MAX_CAPTURE_BYTES),
    bodyBytes: bytes,
    truncated: truncated || undefined,
    events,
    anomalies,
  }, null, 2));
}

function inspectEvent(rawEvent: string, note: (kind: string, raw: string) => void): void {
  const dataLines = rawEvent.split(/\r?\n/).filter(line => line.startsWith("data:"));
  if (dataLines.length === 0) return;
  if (dataLines.length > 1) note("multi_data_lines", rawEvent);
  const data = dataLines.map(line => line.slice(5).replace(/^ /, "")).join("\n");
  if (data.trim() === "[DONE]") return;
  try {
    JSON.parse(data);
  } catch (error) {
    note(`invalid_json: ${error instanceof Error ? error.message : String(error)}`, rawEvent);
  }
}

function describeRequest(input: unknown, init: unknown): RequestSummary {
  let url = "";
  let method = "GET";
  if (typeof input === "string") url = input;
  else if (input instanceof URL) url = input.href;
  else if (input && typeof input === "object") {
    const request = input as { url?: unknown; method?: unknown };
    if (typeof request.url === "string") url = request.url;
    if (typeof request.method === "string") method = request.method;
  }
  let bodyBytes: number | undefined;
  let model: string | undefined;
  const body = (init as { body?: unknown; method?: unknown } | undefined)?.body;
  const initMethod = (init as { method?: unknown } | undefined)?.method;
  if (typeof initMethod === "string") method = initMethod;
  if (typeof body === "string") {
    bodyBytes = Buffer.byteLength(body);
    const match = /"model"\s*:\s*"([^"]{1,120})"/.exec(body.slice(0, 4_000));
    if (match) model = match[1];
  }
  return { url, method, ...(model ? { model } : {}), ...(bodyBytes === undefined ? {} : { bodyBytes }) };
}
