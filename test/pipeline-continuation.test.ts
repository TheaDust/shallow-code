import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withModulePipeline } from "./helpers/module-pipeline.js";

for (const scenario of ["runnable", "unchanged", "broken", "timed_out"] as const) {
  test(`Failed continuation rescue: ${scenario}`, async () => {
    await withModulePipeline(async f => {
      let starts = 0;
      f.deps.appLifecycle.start = async () => {
        if (++starts === 1 || (scenario === "broken" && starts === 2)) throw new Error("build failed");
        return { baseUrl: f.options.platformContract.baseUrl, stop: async () => {} };
      };
      const original = f.builder.run.bind(f.builder);
      f.builder.run = async (request, options) => {
        const result = await original(request, options);
        if (!options?.continuationFeedback) return result;
        f.git.applicationChanged = scenario !== "unchanged";
        if (f.git.applicationChanged) await writeFile(join(request.outputDir, "fixed.txt"), "fixed");
        return { ...result, outcome: scenario === "timed_out" ? "timed_out" : "failed",
          summary: "terminal response incomplete" };
      };
      const summary = await f.run();
      const rescued = (await f.events()).filter(e => e.type === "module_rescued");
      if (scenario === "runnable" || scenario === "timed_out") {
        assert.equal(f.builder.requests.length, scenario === "runnable" ? 3 : 5,
          "a timed-out continuation recovers the foundation atom by atom before its dependent packet");
        assert.equal(summary.status, "delivered");
        assert.deepEqual(summary.implementedRequirementIds, ["A", "B", "C"]);
        assert.equal(rescued.length, scenario === "runnable" ? 1 : 0);
        assert.deepEqual(f.git.restoredShas, []);
      } else {
        assert.equal(f.builder.requests.length, 2, "no dependent Builder call after the foundation failed");
        assert.deepEqual(summary.blockedRequirementIds, ["A", "B", "C"]);
        assert.deepEqual(summary.implementedRequirementIds, []);
        assert.equal(rescued.length, 0);
        assert.equal(f.git.restoredShas.length, 1);
      }
    });
  });
}

test("Build failure continues only the same packet/session within its remaining budget", async () => {
  await withModulePipeline(async f => {
    let clock = 0;
    f.deps.clock = { nowMs: () => clock };
    const original = f.builder.run.bind(f.builder);
    f.deps.builder.run = async (request, options) => {
      const result = await original(request, options);
      clock += 1000;
      return result;
    };
    let starts = 0;
    f.deps.appLifecycle.start = async () => {
      if (++starts === 1) throw new Error("build exited 1: missing export");
      return { baseUrl: f.options.platformContract.baseUrl, stop: async () => {} };
    };
    const summary = await f.run();
    assert.equal(summary.status, "delivered");
    assert.equal(f.builder.requests.length, 3);
    const [first, continued, next] = f.builder.runOptions;
    assert.ok(first?.sessionKey);
    assert.equal(continued?.sessionKey, first.sessionKey);
    assert.notEqual(next?.sessionKey, first.sessionKey);
    assert.equal(continued?.timeoutMs, first.timeoutMs! - 1000);
    assert.match(continued?.continuationFeedback ?? "", /missing export/);
    assert.deepEqual(f.git.restoredShas, []);
    assert.equal((await f.events()).filter(e => e.type === "implementation_continued").length, 1);
  });
});

test("Persistent foundation build failure gets one continuation then blocks the dependent packet", async () => {
  await withModulePipeline(async f => {
    f.deps.appLifecycle.start = async () => { throw new Error("build failed"); };
    const summary = await f.run();
    assert.equal(f.builder.requests.length, 2);
    assert.equal(summary.status, "partial");
    assert.deepEqual(summary.implementedRequirementIds, []);
    assert.deepEqual(summary.blockedRequirementIds, ["A", "B", "C"]);
    assert.equal(f.git.restoredShas.length, 1);
    assert.equal(f.builder.runOptions[1]?.sessionKey, f.builder.runOptions[0]?.sessionKey);
    assert.equal((await f.events()).filter(e => e.type === "implementation_continued").length, 1);
  });
});

test("Exhausted implementation budget prevents continuation and retains delivery time", async () => {
  await withModulePipeline(async f => {
    let clock = 0;
    f.deps.clock = { nowMs: () => clock };
    f.deps.appLifecycle.start = async () => { clock = 36_000; throw new Error("build failed"); };
    const summary = await f.run();
    assert.equal(f.builder.requests.length, 1);
    assert.equal(summary.status, "partial");
    assert.ok(!(await f.events()).some(e => e.type === "implementation_continued"));
  });
});
