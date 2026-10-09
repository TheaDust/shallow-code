import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { withModulePipeline, pass, fail } from "./helpers/module-pipeline.js";
import type { ProbePlan } from "../src/judge/probe-schema.js";

test("Missing or empty terminal response gets a 45 minute fresh continuation before dependencies run", async () => {
  for (const reason of ["missing_terminal_response", "empty_terminal_response", "model_length_limit"] as const) {
    await withModulePipeline(async f => {
      f.options.totalBudgetMs = 0;
      const original = f.builder.run.bind(f.builder);
      f.builder.run = async (request, options) => {
        const result = await original(request, options);
        if (f.builder.requests.length === 1) return { ...result, outcome: "failed", terminationReason: reason };
        return result;
      };
      const summary = await f.run();
      assert.equal(summary.status, "delivered");
      assert.equal(f.builder.requests.length, 3);
      assert.equal(f.builder.runOptions[1]?.timeoutMs, 2_700_000);
      assert.equal(f.builder.runOptions[1]?.resumeInterrupted, true);
      assert.equal(f.builder.runOptions[1]?.sessionKey, undefined);
      assert.deepEqual(summary.blockedRequirementIds, []);
    });
  }
});

test("An unfinished compound package is completed atom by atom before its downstream package", async () => {
  await withModulePipeline(async f => {
    const original = f.builder.run.bind(f.builder);
    f.builder.run = async (request, options) => {
      const result = await original(request, options);
      if (request.mode === "implement" && request.packet.requirementIds.length > 1) {
        return { ...result, outcome: "timed_out" };
      }
      return result;
    };
    const summary = await f.run();
    assert.equal(summary.status, "delivered");
    assert.deepEqual(f.builder.requests.map(request => "packet" in request ? request.packet.requirementIds : []),
      [["A", "B"], ["A", "B"], ["A"], ["B"], ["C"]]);
    const split = (await f.events()).find(event => event.type === "implementation_split");
    assert.ok(split?.type === "implementation_split");
    assert.deepEqual(split.detail?.packets.map(packet => packet.requirementIds), [["A"], ["B"]]);
    assert.equal((await f.events()).filter(event => event.type === "dependency_gate_blocked").length, 0);
    assert.ok(f.builder.requests.slice(2, 4).every(request => "packet" in request && request.packet.attempt === 2));
  });
});

test("A compound package that times out after context overflow splits before a whole-package continuation", async () => {
  await withModulePipeline(async f => {
    const original = f.builder.run.bind(f.builder);
    f.builder.run = async (request, options) => {
      const result = await original(request, options);
      if (request.mode === "implement" && request.packet.requirementIds.length > 1) {
        return { ...result, outcome: "timed_out", execution: {
          engine: "fake", version: "1", nodeVersion: process.version, workerPid: 1, resumed: false,
          durationMs: 5_400_000, cleanupMs: 0, usage: { status: "unavailable" },
          termination: { compactionPending: false, retryPending: true, compactionReason: "overflow",
            progressedAfterOverflowCompaction: false },
        } };
      }
      return result;
    };
    const summary = await f.run();
    assert.equal(summary.status, "delivered");
    assert.deepEqual(f.builder.requests.map(request => "packet" in request ? request.packet.requirementIds : []),
      [["A", "B"], ["A"], ["B"], ["C"]]);
    assert.equal(f.builder.runOptions.some(options => options?.resumeInterrupted), false);
    const split = (await f.events()).find(event => event.type === "implementation_split" && event.detail?.kind === "recovery");
    assert.ok(split?.type === "implementation_split");
    assert.ok(split.detail);
    assert.match(split.detail.reason, /exhausted the context window/);
  });
});

test("A compound package that keeps working after an overflow compaction still gets its whole-package continuation", async () => {
  await withModulePipeline(async f => {
    const original = f.builder.run.bind(f.builder);
    f.builder.run = async (request, options) => {
      const result = await original(request, options);
      if (request.mode === "implement" && request.packet.requirementIds.length > 1) {
        return { ...result, outcome: "timed_out", execution: {
          engine: "fake", version: "1", nodeVersion: process.version, workerPid: 1, resumed: false,
          durationMs: 5_400_000, cleanupMs: 0, usage: { status: "unavailable" },
          termination: { compactionPending: false, retryPending: true, compactionReason: "overflow",
            progressedAfterOverflowCompaction: true },
        } };
      }
      return result;
    };
    const summary = await f.run();
    assert.equal(summary.status, "delivered");
    assert.deepEqual(f.builder.requests.map(request => "packet" in request ? request.packet.requirementIds : []),
      [["A", "B"], ["A", "B"], ["A"], ["B"], ["C"]],
      "a clock-bound stop keeps the 45 minute continuation before splitting");
    assert.equal(f.builder.runOptions[1]?.resumeInterrupted, true);
    assert.equal((await f.events()).filter(event => event.type === "implementation_split").length, 1);
  });
});

test("Atomic recovery stays bounded when a foundation cannot complete", async () => {
  await withModulePipeline(async f => {
    f.options.totalBudgetMs = 0;
    const original = f.builder.run.bind(f.builder);
    f.builder.run = async (request, options) => ({ ...await original(request, options), outcome: "timed_out" });
    const summary = await f.run();
    assert.deepEqual(f.builder.requests.map(request => "packet" in request ? request.packet.requirementIds : []),
      [["A", "B"], ["A", "B"], ["A"], ["A"]],
      "initial package, whole-package continuation, then the foundation atom and its own continuation");
    assert.ok(f.builder.requests.slice(2).every(request => "packet" in request && request.packet.attempt === 2));
    assert.equal(f.builder.runOptions[3]?.resumeInterrupted, true, "a split-out atom keeps one bounded continuation");
    assert.equal(f.builder.runOptions[3]?.timeoutMs, 2_700_000);
    assert.deepEqual(summary.blockedRequirementIds, ["A", "B", "C"]);
    assert.deepEqual(summary.implementedRequirementIds, []);
  });
});

test("Interrupted changes that regress an earlier passed path are restored before continuation", async () => {
  await withModulePipeline(async f => {
    let changed = false;
    const original = f.builder.run.bind(f.builder);
    f.builder.run = async (request, options) => {
      const result = await original(request, options);
      if (request.mode === "implement" && request.packet.requirementIds.includes("C") && !options?.resumeInterrupted) {
        changed = true;
        return { ...result, outcome: "failed", terminationReason: "missing_terminal_response" };
      }
      return result;
    };
    const restore = f.git.restoreAccepted.bind(f.git);
    f.git.restoreAccepted = async sha => { changed = false; await restore(sha); };
    f.deps.runner.run = async plan => plan.packetId === "packet-a" && changed ? fail(plan) : pass(plan);
    assert.equal((await f.run()).status, "delivered");
    assert.equal(f.git.restoredShas.length, 1);
    const guard = (await f.events()).find(event => event.type === "builder_work_preserved");
    assert.equal(guard?.detail?.preserved, false);
    assert.match(String(guard?.detail?.reason), /previously passed behavior: A/);
    assert.equal(f.builder.runOptions.at(-1)?.resumeInterrupted, true);
  });
});

for (const partial of [false, true]) {
test(`Interrupted work caches confirmed seed identity guards without losing unchecked cases: partial=${partial}`, async () => {
  await withModulePipeline(async f => {
    const tree = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    tree.children[0].children[0].description = "Seed data: repository `docs`, owner `alice`. Opening the repository displays the main workspace.";
    await writeFile(f.options.requirementsFile, JSON.stringify(tree));
    const originalPlan = f.deps.planner.plan.bind(f.deps.planner);
    f.deps.planner.plan = async (packet, feedback, options) => {
      if (packet.requirementIds[0] !== "A") return originalPlan(packet, feedback, options);
      const plan: ProbePlan = { packetId: packet.id, cases: [{ id: "case-A", requirementIds: ["A"], purpose: "happy_path",
        expectationBasis: ["Opening the repository displays the main workspace."], steps: [
          { op: "goto", path: "/" },
          { op: "expectVisible", locator: { by: "role", role: "link", name: "docs", exact: true } },
          { op: "click", locator: { by: "role", role: "link", name: "docs", exact: true } },
          { op: "expectVisible", locator: { by: "role", role: "main" } },
        ] }] };
      if (partial) plan.cases.push({ ...structuredClone(plan.cases[0]), id: "unchecked-case", purpose: "negative",
        steps: [{ op: "goto", path: "/" }, { op: "expectVisible", locator: { by: "role", role: "main" } }] });
      return plan;
    };
    let duplicate = false;
    const originalBuild = f.builder.run.bind(f.builder);
    f.builder.run = async (request, options) => {
      const result = await originalBuild(request, options);
      if (request.mode === "implement" && request.packet.requirementIds.includes("C") && !options?.resumeInterrupted) {
        duplicate = true;
        return { ...result, outcome: "failed", terminationReason: "missing_terminal_response" };
      }
      return result;
    };
    f.deps.runner.run = async plan => {
      const entry = plan.cases[0].steps[1];
      if (plan.packetId === "packet-a" && duplicate && entry.op === "expectVisible" && !entry.locator.scope) {
        const report = fail(plan, "locator");
        report.failures[0].message = "strict mode violation";
        report.failures[0].locatorSnapshot = '- list:\n  - listitem:\n    - link "docs"\n    - paragraph: alice/docs\n  - listitem:\n    - link "docs"\n    - paragraph: org/docs';
        return report;
      }
      if (plan.cases.some(item => item.id === "unchecked-case")) return { packetId: plan.packetId, verdict: "inconclusive",
        passedCases: ["case-A"], failures: [{ caseId: "unchecked-case", stepIndex: 1, category: "locator",
          message: "strict mode violation", locatorSnapshot: '- main\n- main' }] };
      return pass(plan);
    };
    const summary = await f.run();
    assert.equal(summary.status, partial ? "partial" : "delivered");
    assert.equal(summary.verifiedRequirementIds.includes("A"), !partial);
    assert.equal(f.git.restoredShas.length, 0);
    const events = await f.events();
    assert.equal(events.find(event => event.type === "builder_work_preserved")?.detail?.preserved, true);
    assert.equal(events.filter(event => event.type === "probe_navigation_attempted").length, 1,
      "later audits reuse the confirmed scoped guard");
  });
});
}

test("A mixed dependency group still implements its independent member after a foundation exhausts recovery", async () => {
  await withModulePipeline(async f => {
    const tree = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    tree.children[1].children.push({ id: "D", name: "Independent", type: "ATOMIC", dependencies: [], description: "Display an independent workspace." });
    await writeFile(f.options.requirementsFile, JSON.stringify(tree));
    const original = f.builder.run.bind(f.builder);
    f.builder.run = async (request, options) => {
      const result = await original(request, options);
      if (request.mode === "implement" && request.packet.requirementIds.includes("A")) return { ...result, outcome: "timed_out" };
      return result;
    };
    const summary = await f.run();
    assert.deepEqual(summary.implementedRequirementIds, ["D"]);
    assert.deepEqual(summary.blockedRequirementIds, ["A", "B", "C"]);
    assert.ok(f.builder.requests.some(request => "packet" in request && request.packet.requirementIds.join() === "D"));
    assert.equal(f.builder.requests.some(request => "packet" in request && request.packet.requirementIds.includes("C")), false);
    assert.equal((await f.events()).filter(event => event.type === "implementation_split").length, 2);
  });
});

test("A member split out for dependency readiness keeps first-attempt limits and its continuation", async () => {
  await withModulePipeline(async f => {
    f.options.totalBudgetMs = 0;
    const tree = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    // SECOND becomes a mixed packet: C waits on the blocked B, D is independent.
    tree.children[1].children.push({ id: "D", name: "Independent", type: "ATOMIC", dependencies: [], description: "Display an independent workspace." });
    await writeFile(f.options.requirementsFile, JSON.stringify(tree));
    let dTimedOut = false;
    const original = f.builder.run.bind(f.builder);
    f.builder.run = async (request, options) => {
      const result = await original(request, options);
      if (request.mode !== "implement") return result;
      if (request.packet.requirementIds.includes("A")) return { ...result, outcome: "timed_out" };
      if (request.packet.requirementIds.join() === "D" && !dTimedOut) { dTimedOut = true; return { ...result, outcome: "timed_out" }; }
      return result;
    };
    const summary = await f.run();
    const split = (await f.events()).find(event => event.type === "implementation_split" && event.detail?.kind === "dependency");
    assert.ok(split?.type === "implementation_split");
    assert.ok(split.detail?.packets.every(packet => packet.packetId.includes("-split-")));
    const dIndex = f.builder.requests.findIndex(request => "packet" in request && request.packet.requirementIds.join() === "D");
    const dRequest = f.builder.requests[dIndex];
    assert.ok(dRequest && "packet" in dRequest && dRequest.packet.attempt === 1);
    assert.equal(f.builder.runOptions[dIndex]?.timeoutMs, 5_400_000);
    assert.equal(f.builder.runOptions[dIndex + 1]?.resumeInterrupted, true, "first timeout gets a fresh continuation");
    assert.deepEqual(summary.implementedRequirementIds, ["D"]);
  });
});
