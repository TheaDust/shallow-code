import assert from "node:assert/strict";
import { test } from "node:test";
import { executeSandboxProgram } from "../src/checker/adapters/web/program-runtime.js";
import { fileFixture } from "../src/checker/adapters/web/fixtures.js";
import { webReviewEvidence } from "../src/checker/adapters/web/review-evidence.js";
import { hashBytes } from "../src/checker/artifacts.js";
import type { EvidenceReceipt, ReviewEvidence, TypedRef } from "../src/checker/port.js";

const signal = new AbortController().signal;
test("QuickJS supports ordinary functions, loops and asynchronous JSON host calls", async () => {
  const calls: unknown[] = [];
  const result = await executeSandboxProgram(`
    function double(n) { return n * 2; }
    const page = await browser.actor('alice');
    const values = [];
    for (let i = 0; i < 3; i++) { const observation = await page.getByRole('status').innerText(); values.push(double(Number(observation.value))); }
    return values;
  `, async (method, input) => { calls.push({ method, input }); return method === "actor" ? {} : { id: "receipt", value: "4" }; }, { signal, timeoutMs: 1_000 });
  assert.deepEqual(result, [8, 8, 8]);
  assert.equal(calls.length, 4);
});

test("QuickJS omits Node and browser mutation capabilities and rejects imports", async () => {
  const result = await executeSandboxProgram("return [typeof process, typeof require, typeof fetch, typeof document, typeof browser.evaluate];", async () => ({}), { signal, timeoutMs: 1_000 });
  assert.deepEqual(result, ["undefined", "undefined", "undefined", "undefined", "undefined"]);
  await assert.rejects(executeSandboxProgram("return import('node:fs');", async () => ({}), { signal, timeoutMs: 1_000 }));
});

test("QuickJS interrupts infinite loops and disposes realms for subsequent cases", async () => {
  await assert.rejects(executeSandboxProgram("while (true) {}", async () => ({}), { signal, timeoutMs: 25 }), /interrupt|timed out/);
  assert.equal(await executeSandboxProgram("return 42", async () => ({}), { signal, timeoutMs: 1_000 }), 42);
});

test("QuickJS cancels a pending asynchronous host call without late realm access", async () => {
  const controller = new AbortController();
  const promise = executeSandboxProgram("await browser.actor('alice');", async () => new Promise((resolve) => setTimeout(() => resolve({}), 80)), { signal: controller.signal, timeoutMs: 1_000 });
  setTimeout(() => controller.abort(new Error("cancelled-case")), 10);
  await assert.rejects(promise, /cancelled-case/);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await executeSandboxProgram("return 'clean'", async () => ({}), { signal, timeoutMs: 1_000 }), "clean");
});

test("host file fixtures enforce bounded real text and PNG inputs", () => {
  const text = fileFixture({ kind: "text", bytes: 6 * 1024 * 1024, text: "# Test\n" });
  assert.equal(text.buffer.length, 6 * 1024 * 1024);
  assert.equal(text.buffer.subarray(0, 7).toString(), "# Test\n");
  const png = fileFixture({ kind: "png", bytes: 6 * 1024 * 1024 });
  assert.equal(png.mimeType, "image/png");
  assert.equal(png.buffer.length, 6 * 1024 * 1024);
  for (const value of [
    { kind: "text", bytes: 9 * 1024 * 1024 }, { kind: "text", bytes: -1 }, { kind: "text", bytes: 1.5 },
    { kind: "text", bytes: 1, text: 5 }, { kind: "text", bytes: 1, text: "" }, { kind: "png", bytes: 10 },
    { kind: "png", bytes: 128, path: "private" }, { kind: "other", bytes: 128 },
  ]) assert.throws(() => fileFixture(value));
});

test("binary review projection bounds repeated download data while retaining text and original evidence", () => {
  const bytes = Buffer.alloc(2 * 1024 * 1024, 173), binary = bytes.toString("base64");
  const artifact: TypedRef = { id: "binary", digest: "binary", schema: { id: "schema", digest: "schema" }, mediaType: "application/json" };
  const text = "<html>required export content</html>";
  const evidence: ReviewEvidence[] = [
    { receipt: { kind: "observation", payload: artifact } as EvidenceReceipt, payload: { kind: "download", encoding: "base64", filename: "export.png", value: binary }, environment: {} },
    { receipt: { kind: "assertion" } as EvidenceReceipt, payload: { actual: binary, expected: { metadata: "preserved" } }, environment: {} },
    { receipt: { kind: "observation" } as EvidenceReceipt, payload: { kind: "download", encoding: "text", value: text }, environment: {} },
  ];
  const projected = webReviewEvidence(evidence);
  assert(JSON.stringify(projected).length < 2000);
  const summary = (projected[0]!.payload as { value: unknown }).value;
  assert.deepEqual(summary, { encoding: "base64", bytes: bytes.length, sha256: hashBytes(bytes), artifact });
  assert.deepEqual((projected[1]!.payload as { actual: unknown }).actual, summary);
  assert.equal((projected[2]!.payload as { value: string }).value, text);
  assert.equal((evidence[0]!.payload as { value: string }).value, binary);
  assert.equal((evidence[1]!.payload as { actual: string }).actual, binary);
});
