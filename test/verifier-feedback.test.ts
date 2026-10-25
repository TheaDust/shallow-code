import assert from "node:assert/strict";
import { test } from "node:test";
import { compactExecutionFeedback, feedbackSlice } from "../src/verifier/feedback.js";

test("execution feedback preserves every result while removing passed values and bounding failed values", () => {
  const long = "document-body-".repeat(20_000);
  const receipt = { id: "receipt", digest: "digest" };
  const original = { checks: [
    { receipt, kind: "precondition", checkpointId: "given", payload: { result: "satisfied", passed: true, actual: long, expected: long } },
    { receipt, kind: "assertion", checkpointId: "then", assertion: { clauseId: "clause", result: "violated" as const },
      payload: { result: "violated", passed: false, actual: long + "WRONG", expected: "required", operator: "equal" } },
    { receipt, kind: "assertion", payload: { result: "inconclusive", message: "Observation missing" } },
  ] };
  const projected = compactExecutionFeedback(original);
  assert.deepEqual(projected.checks![0]!.payload, { result: "satisfied", passed: true });
  const failed = projected.checks![1]!.payload as { result: string; actual: { truncated: boolean; tail: string }; expected: string };
  assert.equal(failed.result, "violated");
  assert.equal(failed.actual.truncated, true);
  assert.match(failed.actual.tail, /WRONG$/);
  assert.equal(failed.expected, "required");
  assert.deepEqual(projected.checks![2], original.checks[2]);
  assert.equal(original.checks[0]!.payload.actual, long, "projection does not mutate host evidence");
  assert(JSON.stringify(projected).length < JSON.stringify(original).length / 100);
});

test("bulk output and diagnostics stay bounded, retain the final error, and disclose omitted entries", () => {
  const diagnostics = Array.from({ length: 21 }, (_, index) => index === 20
    ? { category: "execution", message: "Runtime failed", detail: "detail".repeat(10_000) }
    : { method: "fill", value: "payload".repeat(10_000) });
  const value = { output: { rows: Array.from({ length: 1000 }, () => ({ content: "\"\\\n".repeat(1000) })) },
    receipts: Array.from({ length: 90 }, (_, index) => ({ id: String(index), digest: String(index) })), diagnostics };
  const projected = compactExecutionFeedback(value);
  assert(JSON.stringify(projected.output).length <= 4096);
  assert(projected.diagnostics!.every(item => JSON.stringify(item).length <= 1024));
  assert.equal(projected.receipts!.length, 8);
  assert.equal(projected.receiptsOmitted, 82);
  assert.equal(projected.diagnostics!.length, 8);
  assert.equal(projected.diagnosticsOmitted, 13);
  assert.match(JSON.stringify(projected.diagnostics!.at(-1)), /Runtime failed/);
  assert.equal(value.receipts.length, 90);
  assert.equal(value.diagnostics[0]!.value!.length, 70_000);
});

test("targeted feedback reads recover exact omitted data through bounded field windows", () => {
  const actual = "prefix" + "正文\n".repeat(2500) + "unique-tail";
  const original = { checks: [{ payload: { actual } }], diagnostics: [{ message: "Failure" }] };
  const path = ["checks", 0, "payload", "actual"];
  let cursor = 0, restored = "";
  do {
    const slice = feedbackSlice(original, path, cursor, 2000);
    assert.equal(slice.encoding, "text");
    assert.equal(slice.totalCharacters, actual.length);
    assert(slice.text.length <= 2000);
    restored += slice.text;
    if (slice.nextOffset === undefined) break;
    assert(slice.nextOffset > cursor);
    cursor = slice.nextOffset;
  } while (true);
  assert.equal(restored, actual);
  assert.equal(feedbackSlice(original, ["diagnostics", 0]).text, JSON.stringify(original.diagnostics[0]));
  for (const path of [["__proto__"], ["checks", "not-there"]]) assert.throws(() => feedbackSlice(original, path), /does not exist/);
  for (const limit of [0, 4001]) assert.throws(() => feedbackSlice(original, [], 0, limit), /limit/);
  assert.throws(() => feedbackSlice(original, [], -1), /offset/);
});
