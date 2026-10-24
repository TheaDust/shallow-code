import type { ContentRef, EvidenceReceipt, ProgramRef } from "./port.js";

interface CheckFeedback {
  receipt: ContentRef;
  kind: string;
  checkpointId?: string;
  assertion?: EvidenceReceipt["assertion"];
  payload: unknown;
}
export interface ExecutionFeedback {
  program?: ProgramRef;
  output?: unknown;
  receipts?: ContentRef[];
  checks?: CheckFeedback[];
  diagnostics?: unknown[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Model previews only: the caller stores the original before using this projection. */
function preview(value: unknown, limit: number): unknown {
  const text = JSON.stringify(value);
  if (text === undefined || text.length <= limit) return value;
  // Preserve small sibling fields (e.g. result/operator/expected) around a long value.
  const shorten = (item: unknown, depth: number): unknown => {
    if (typeof item === "string" && item.length > 256) return {
      truncated: true, type: "string", characters: item.length, head: item.slice(0, 160), tail: item.slice(-80),
    };
    if (depth >= 4 && item !== null && typeof item === "object") return { truncated: true, type: Array.isArray(item) ? "array" : "object" };
    if (Array.isArray(item)) return item.length > 8
      ? { truncated: true, type: "array", length: item.length, items: item.slice(0, 8).map(value => shorten(value, depth + 1)) }
      : item.map(value => shorten(value, depth + 1));
    if (record(item)) {
      const entries = Object.entries(item);
      const fields = Object.fromEntries(entries.slice(0, 16).map(([key, value]) => [key, shorten(value, depth + 1)]));
      return entries.length > 16 ? { truncated: true, type: "object", fields, omittedKeys: entries.length - 16 } : fields;
    }
    return item;
  };
  const small = shorten(value, 0);
  if (JSON.stringify(small).length <= limit) return small;
  const size = Math.floor((limit - 160) / 4);
  return { truncated: true, type: "json", characters: text.length, head: text.slice(0, size), tail: text.slice(-size) };
}

export function compactExecutionFeedback(feedback: ExecutionFeedback): ExecutionFeedback & { receiptsOmitted?: number; diagnosticsOmitted?: number } {
  return {
    ...(feedback.program ? { program: feedback.program } : {}),
    ...("output" in feedback ? { output: preview(feedback.output, 4096) } : {}),
    ...(feedback.receipts ? { receipts: feedback.receipts.slice(0, 8),
      ...(feedback.receipts.length > 8 ? { receiptsOmitted: feedback.receipts.length - 8 } : {}) } : {}),
    ...(feedback.checks ? { checks: feedback.checks.map(check => {
      const result = check.assertion?.result ?? (record(check.payload) ? check.payload.result : undefined);
      return { ...check, payload: result === "satisfied"
        ? { result, ...(record(check.payload) && typeof check.payload.passed === "boolean" ? { passed: check.payload.passed } : {}) }
        : preview(check.payload, 1536) };
    }) } : {}),
    ...(feedback.diagnostics ? { diagnostics: feedback.diagnostics.slice(-8).map(value => preview(value, 1024)),
      ...(feedback.diagnostics.length > 8 ? { diagnosticsOmitted: feedback.diagnostics.length - 8 } : {}) } : {}),
  };
}

/** Read only a requested field/window, rather than reinserting the complete feedback. */
export function feedbackSlice(value: unknown, path: Array<string | number> = [], offset = 0, limit = 2000) {
  if (!Array.isArray(path) || path.length > 16 || path.some(key => typeof key !== "string" && !(Number.isInteger(key) && key >= 0))
    || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 4000)
    throw new Error("Feedback requires a field path, nonnegative offset and limit from 1 to 4000");
  for (const key of path) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) throw new Error("Feedback field path does not exist");
    value = (value as Record<string | number, unknown>)[key];
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const end = Math.min(offset + limit, text.length);
  return { path, encoding: typeof value === "string" ? "text" : "json", offset, totalCharacters: text.length,
    text: text.slice(offset, end), ...(end < text.length ? { nextOffset: end } : {}) };
}
