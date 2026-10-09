import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { GitCliOps } from "../src/git-ops.js";
import { withModulePipeline } from "./helpers/module-pipeline.js";
import type { BuilderResult } from "../src/builder/port.js";

for (const termination of ["timeout", "missing_terminal_response"] as const) for (const runnable of [true, false]) {
  test(`${termination} retries the same packet after ${runnable ? "preserving" : "rolling back"} partial work`, async () => {
    await withModulePipeline(async f => {
      f.options.totalBudgetMs = 0;
      f.deps.git = await GitCliOps.open(f.options.outputDir);
      const marker = join(f.options.outputDir, "partial.txt");
      const original = f.builder.run.bind(f.builder);
      let calls = 0;
      f.deps.appLifecycle.start = async () => {
        if (!runnable && calls === 1) throw new Error("Application port is already occupied");
        return { baseUrl: f.options.platformContract.baseUrl, stop: async () => {} };
      };
      f.deps.builder.run = async (request, options) => {
        if (++calls === 1) {
          await original(request, options);
          await writeFile(marker, "partial work");
          const result: BuilderResult = { sessionId: "interrupted", outcome: termination === "timeout" ? "timed_out" : "failed",
            summary: "implementation interrupted", ...(termination === "timeout" ? {} : { terminationReason: termination }) };
          return result;
        }
        if (calls === 2) {
          assert.equal(request.mode, "implement");
          assert.ok("packet" in request);
          assert.equal(request.packet.id, (f.builder.requests[0] as typeof request).packet.id);
          assert.equal(request.packet.attempt, 2);
          assert.equal(options?.sessionKey, undefined);
          assert.equal(options?.timeoutMs, 2_700_000);
          assert.equal(options?.resumeInterrupted, true);
          if (runnable) assert.equal(await readFile(marker, "utf8"), "partial work");
          else await assert.rejects(readFile(marker), { code: "ENOENT" });
        }
        return original(request, options);
      };
      assert.equal((await f.run()).status, "delivered");
      assert.equal(calls, 3);
      const events = await f.events();
      assert.equal(events.filter(e => e.type === "implementation_retry").length, 1);
      assert.equal(events.find(e => e.type === "implementation_retry")?.detail?.reason, termination);
      assert.ok(events.some(e => e.type === "builder_work_preserved" && e.detail?.preserved === runnable));
      assert.ok(!events.some(e => e.type === "module_rescued"));
    });
  });
}

test("Repeated timeout preserves runnable code without falsely completing its requirements", async () => {
  await withModulePipeline(async f => {
    f.options.totalBudgetMs = 0;
    f.deps.git = await GitCliOps.open(f.options.outputDir);
    const original = f.builder.run.bind(f.builder);
    let calls = 0;
    f.deps.builder.run = async (request, options) => {
      await original(request, options);
      await writeFile(join(request.outputDir, "partial.txt"), `work ${++calls}`);
      return { sessionId: "interrupted", outcome: "timed_out", summary: "implementation interrupted" };
    };
    const summary = await f.run();
    assert.equal(calls, 4); // compound attempt, continuation, then the foundation atom and its own continuation
    assert.equal(summary.status, "partial");
    assert.deepEqual(summary.implementedRequirementIds, []);
    assert.deepEqual(summary.blockedRequirementIds, ["A", "B", "C"]);
    assert.equal(await readFile(join(f.options.outputDir, "partial.txt"), "utf8"), "work 4");
    const checkpoints = (await f.events()).filter(e => e.type === "checkpoint_saved");
    assert.equal(checkpoints.length, 4);
    assert.ok(checkpoints.every(e => e.detail?.requirementIds.length === 0));
  });
});

for (const runnable of [true, false]) test(`Repeated missing terminal gets atomic recovery: ${runnable ? "runnable" : "broken"}`, async () => {
  await withModulePipeline(async f => {
    f.options.totalBudgetMs = 0;
    f.deps.git = await GitCliOps.open(f.options.outputDir);
    const original = f.builder.run.bind(f.builder);
    let calls = 0;
    f.deps.appLifecycle.start = async () => {
      if (!runnable && calls === 2) throw new Error("Continuation left a broken application");
      return { baseUrl: f.options.platformContract.baseUrl, stop: async () => {} };
    };
    f.deps.builder.run = async (request, options) => {
      calls++;
      if (calls === 1) await original(request, options);
      // A second interruption stays incomplete. Reuse the preserved source or
      // restore it if the second attempt broke the application, then recover atomics.
      if (calls === 2 && !runnable) await writeFile(join(request.outputDir, "broken.txt"), "interrupted change");
      if (calls <= 2) return { sessionId: "interrupted", outcome: "failed", terminationReason: "missing_terminal_response",
        summary: "implementation interrupted" };
      return original(request, options);
    };
    const summary = await f.run();
    assert.equal(calls, 5);
    assert.deepEqual(summary.implementedRequirementIds, ["A", "B", "C"]);
    assert.deepEqual(summary.blockedRequirementIds, []);
    const events = await f.events();
    assert.equal(events.filter(event => event.type === "implementation_retry").length, 1);
    assert.equal(events.some(event => event.type === "module_rescued"), false);
    assert.equal(events.filter(event => event.type === "implementation_split").length, 1);
    if (!runnable) {
      assert.ok(events.some(event => event.type === "builder_work_preserved" && event.detail?.preserved === false));
      await assert.rejects(readFile(join(f.options.outputDir, "broken.txt")), { code: "ENOENT" });
    }
  });
});

test("A Builder summary cannot request the missing-terminal retry", async () => {
  await withModulePipeline(async f => {
    const original = f.builder.run.bind(f.builder);
    let calls = 0;
    f.deps.builder.run = async (request, options) => {
      const result = await original(request, options);
      return ++calls === 1 ? { ...result, outcome: "failed", summary: "Pi did not reach a terminal assistant response" } : result;
    };
    assert.equal((await f.run()).status, "delivered");
    assert.equal(calls, 2);
    assert.ok(!(await f.events()).some(event => event.type === "implementation_retry"));
  });
});

for (const termination of ["timeout", "missing_terminal_response"] as const) test(`${termination} does not spend the delivery reserve on another attempt`, async () => {
  await withModulePipeline(async f => {
    let now = 0;
    let calls = 0;
    let delivered = false;
    f.deps.clock = { nowMs: () => now };
    f.git.applicationChanged = false;
    f.deps.builder.run = async () => {
      calls++;
      now = f.options.totalBudgetMs * 0.6;
      return { sessionId: "interrupted", outcome: termination === "timeout" ? "timed_out" : "failed",
        summary: "implementation interrupted", ...(termination === "timeout" ? {} : { terminationReason: termination }) };
    };
    f.deps.finalVerifier.verify = async () => { delivered = true; return { ok: true, stage: "complete", message: "ready" }; };
    const summary = await f.run();
    assert.equal(calls, 1);
    assert.equal(delivered, true);
    assert.deepEqual(summary.implementedRequirementIds, []);
    assert.ok(!(await f.events()).some(e => e.type === "implementation_retry"));
  });
});
