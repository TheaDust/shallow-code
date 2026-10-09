/**
 * Client-side tolerance for the streaming gateway.
 *
 * The gateway intermittently truncates a single SSE event near the end of a
 * long completion. The captured payload was a terminal usage trailer whose JSON
 * was cut mid-key (`data: {"created":<ts>,"usage":nu`) and which was followed by
 * no `data: [DONE]`. The OpenAI client JSON-parses every `data:` payload
 * strictly, so one truncated event throws and aborts the entire turn, discarding
 * every token streamed before it (14+ minutes in one observed run).
 *
 * This wrapper sits on `globalThis.fetch`, the same layer as the diagnostic
 * capture, and rewrites event-stream bodies before the client sees them:
 *  - buffers complete event blocks (bounded), tolerating arbitrary chunk splits;
 *  - forwards every block whose `data:` payload is valid JSON or `[DONE]`;
 *  - rejects malformed events before the completion's finish_reason;
 *  - tolerates damaged non-content trailers after finish_reason;
 *  - appends `[DONE]` only when finish_reason confirms completion.
 *
 * The observed truncation only ever carried the final usage trailer: all content
 * and tool deltas had already arrived in earlier valid events, so dropping it
 * recovers the turn and loses only usage accounting, provided a valid terminal
 * finish_reason has already arrived. A dropped event that still
 * looks content-bearing (a `choices`/`tool_calls` payload) is treated as an
 * incomplete response instead: the stream fails with a retryable "provider
 * returned error" message so the agent's auto-retry regenerates it rather than
 * silently executing a corrupt tool call. A body-level error is never masked; it
 * propagates so the existing retryable-error handling still applies.
 * Non-event-stream responses (and consumed bodies) pass through untouched.
 */

const EVENT_STREAM_CONTENT_TYPE = /^text\/event-stream\b/i;
const EVENT_SEPARATOR = /\r?\n\r?\n/;
/** Guard against an endless event that never terminates (mirrors the capture tap). */
const MAX_BUFFER_CHARS = 1024 * 1024;
const MAX_REPORTED_CHARS = 400;
/** A truncated event that carries content or a tool call must not be accepted silently. */
const CONTENT_BEARING = /"(?:choices|tool_calls)"\s*:/;
/** Matches the agent's retryable-error patterns so an incomplete stream is retried. */
const INCOMPLETE_MESSAGE = "provider returned error: gateway truncated a content-bearing SSE event";

const encoder = new TextEncoder();

export interface SseResilience {
  /** Restores the previous fetch implementation. */
  uninstall(): void;
  /** Number of malformed events dropped since installation. */
  repairedEvents(): number;
}

/** Installs the tolerant rewriter on `globalThis.fetch`. */
export function installSseResilience(onRepair?: (raw: string) => void): SseResilience {
  const target = globalThis as { fetch: typeof globalThis.fetch };
  const original = target.fetch;
  let repaired = 0;

  const replacement = async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
    const response = await original.call(globalThis, input, init);
    try {
      const contentType = response.headers.get("content-type") ?? "";
      if (!EVENT_STREAM_CONTENT_TYPE.test(contentType) || response.bodyUsed || !response.body) return response;
      const body = tolerateSseStream(response.body, raw => {
        repaired += 1;
        onRepair?.(raw.slice(0, MAX_REPORTED_CHARS));
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch {
      // Resilience must never break a response the client could otherwise read.
      return response;
    }
  };
  target.fetch = replacement as typeof globalThis.fetch;

  return {
    repairedEvents: () => repaired,
    uninstall() { target.fetch = original; },
  };
}

/**
 * Rewrites an SSE byte stream. Valid `data:` events and `[DONE]` are forwarded;
 * malformed events are tolerated only after finish_reason and only when they
 * do not look content-bearing. Missing termination is a retryable error.
 * Exported for focused testing.
 */
export function tolerateSseStream(source: ReadableStream<Uint8Array>, onDrop?: (raw: string) => void): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawDone = false;
  let sawFinish = false;

  const forward = (raw: string): string => {
    if (!raw.trim()) return "";
    const dataLines = raw.split(/\r?\n/).filter(line => line.startsWith("data:"));
    if (dataLines.length > 0) {
      const data = dataLines.map(line => line.slice(5).replace(/^ /, "")).join("\n");
      if (data.trim() === "[DONE]") {
        sawDone = true;
      } else {
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          onDrop?.(raw);
          // A truncated content/tool event cannot be recovered by dropping it;
          // fail with a retryable error instead of silently corrupting the turn.
          if (!sawFinish || CONTENT_BEARING.test(raw)) throw new Error(INCOMPLETE_MESSAGE);
          return "";
        }
        // Pi requests one completion and consumes choice zero. Usage-only
        // chunks (choices: []) are not evidence that it finished.
        if (Array.isArray(event?.choices) && event.choices.some((choice: { index?: number; finish_reason?: unknown } | null) =>
          choice?.index === 0 && typeof choice.finish_reason === "string" && choice.finish_reason.length > 0)) {
          sawFinish = true;
        }
      }
    }
    return `${raw}\n\n`;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          const output = forward(buffer);
          if (!sawDone && !sawFinish) throw new Error(INCOMPLETE_MESSAGE);
          if (output) controller.enqueue(encoder.encode(output));
          if (!sawDone) controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        let output = "";
        for (;;) {
          const separator = EVENT_SEPARATOR.exec(buffer);
          if (!separator) break;
          output += forward(buffer.slice(0, separator.index));
          buffer = buffer.slice(separator.index + separator[0].length);
        }
        // A single event that never ends must not grow without bound, and its
        // integrity cannot be verified: surface it as a retryable incomplete stream.
        if (buffer.length > MAX_BUFFER_CHARS) {
          onDrop?.(buffer.slice(0, MAX_REPORTED_CHARS));
          throw new Error(INCOMPLETE_MESSAGE);
        }
        if (output) {
          controller.enqueue(encoder.encode(output));
          return;
        }
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}
