import assert from "node:assert/strict";
import { test } from "node:test";
import { executeSandboxProgram } from "../src/checker/adapters/web/program-runtime.js";

const signal = new AbortController().signal;
test("QuickJS supports ordinary functions, loops and asynchronous JSON host calls", async () => {
  const calls: unknown[] = [];
  const result = await executeSandboxProgram(`
    function double(n) { return n * 2; }
    const page = await browser.actor('alice');
    const values = [];
    for (let i = 0; i < 3; i++) { const observation = await page.read({role:'status'}, 'text'); values.push(double(Number(observation.value))); }
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
