import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { httpGatewayFailure } from "../src/gateway-failure.js";
import { GatewayRecovery } from "../src/gateway-recovery.js";
import { ExecutionFault } from "../src/execution-fault.js";
import { GitCliOps } from "../src/git-ops.js";
import { ProbePlannerError } from "../src/judge/llm-probe-planner.js";
import { withModulePipeline, testPlan, fail, pass } from "./helpers/module-pipeline.js";

test("Final auditing replans a missing packet after its boundary gateway window expires", async () => {
  await withModulePipeline(async f => {
    f.options.totalBudgetMs = 0;
    f.options.generateFinalAuditPlans = true;
    let elapsed = 0;
    let attempts = 0;
    let boundaryUnknown = false;
    f.deps.clock = { nowMs: () => elapsed };
    f.deps.gatewayRecovery = new GatewayRecovery({ now: () => elapsed, sleep: async ms => { elapsed += ms; } });
    f.deps.planner.plan = async packet => {
      if (packet.id === "packet-a") {
        attempts++;
        if (attempts <= 2) throw new ProbePlannerError("schema", "invalid initial plan", { cause: new Error("missing result") });
        if (attempts === 3) {
          elapsed += 720_000;
          throw new ProbePlannerError("transport", "headers timeout");
        }
      }
      return testPlan(packet);
    };
    f.deps.logSink = { write: line => {
      const event = JSON.parse(line);
      if (event.type === "module_boundary_audit_finished" && event.detail?.moduleId === "FIRST") {
        boundaryUnknown = event.detail.results["packet-a"] === "inconclusive";
      }
    } };
    const summary = await f.run();
    assert.equal(boundaryUnknown, true);
    assert.equal(attempts, 4);
    assert.equal(summary.status, "delivered");
    assert.deepEqual(summary.missingPlanRequirementIds, []);
  });
});

test("Final auditing does not generate a missing plan by default", async () => {
  await withModulePipeline(async f => {
    f.options.totalBudgetMs = 0;
    let elapsed = 0;
    let attempts = 0;
    f.deps.clock = { nowMs: () => elapsed };
    f.deps.gatewayRecovery = new GatewayRecovery({ now: () => elapsed, sleep: async ms => { elapsed += ms; } });
    f.deps.planner.plan = async packet => {
      if (packet.id === "packet-a") {
        attempts++;
        if (attempts <= 2) throw new ProbePlannerError("schema", "invalid initial plan", { cause: new Error("missing result") });
        elapsed += 720_000;
        throw new ProbePlannerError("transport", "headers timeout");
      }
      return testPlan(packet);
    };
    const summary = await f.run();
    assert.equal(attempts, 3);
    assert.equal(summary.status, "partial");
    assert.deepEqual(summary.inconclusiveRequirementIds, ["A"]);
    assert.deepEqual(summary.missingPlanRequirementIds, ["A"]);
  });
});

test("Zero-tool 429 retries the same feature group before advancing implementation", async () => {
  await withModulePipeline(async f => {
    f.options.totalBudgetMs = 0;
    const original = f.builder.run.bind(f.builder);
    const calls: string[] = [];
    f.deps.builder.run = async (request, options) => {
      assert.ok("packet" in request);
      calls.push(request.packet.id);
      if (calls.length <= 4) {
        f.git.applicationChanged = false;
        return { sessionId: "down", outcome: "failed", summary: "429 Free allocated quota exceeded.", gatewayFailure: httpGatewayFailure(429) };
      }
      return original(request, options);
    };
    const summary = await f.run();
    assert.equal(summary.status, "delivered");
    assert.equal(new Set(calls.slice(0, 5)).size, 1);
    assert.notEqual(calls[5], calls[0]);
    assert.deepEqual(summary.pendingRequirementIds, []);
    assert.equal((await f.events()).filter(event => event.type === "module_rescued").length, 0);
  });
});

test("A bounded implementation budget leaves gateway-blocked requirements blocked and still delivers", async () => {
  await withModulePipeline(async f => {
    let elapsed = 0;
    f.options.totalBudgetMs = 10_000;
    f.deps.clock = { nowMs: () => elapsed };
    f.deps.gatewayRecovery = new GatewayRecovery({ now: () => elapsed, sleep: async ms => { elapsed += ms; } });
    const original = f.builder.run.bind(f.builder);
    f.deps.builder.run = async (request, options) => {
      assert.ok("packet" in request);
      if (request.packet.requirementIds.includes("C")) {
        f.git.applicationChanged = false;
        return { sessionId: "down", outcome: "failed", summary: "quota exhausted", gatewayFailure: httpGatewayFailure(429) };
      }
      return original(request, options);
    };
    const summary = await f.run();
    assert.equal(summary.status, "partial");
    assert.deepEqual(summary.implementedRequirementIds, ["A", "B"]);
    assert.deepEqual(summary.blockedRequirementIds, ["C"]);
    assert.deepEqual(summary.pendingRequirementIds, []);
    const events = await f.events();
    assert.ok(events.some(event => event.type === "implementation_paused"));
    assert.ok(events.some(event => event.type === "verification_finished" && event.detail?.ok));
    assert.ok(events.some(event => event.type === "delivery_finished"));
  });
});

test("A gateway outage longer than one call window pauses and resumes the same packet", async () => {
  await withModulePipeline(async f => {
    let elapsed = 0;
    f.options.totalBudgetMs = 0;
    f.deps.clock = { nowMs: () => elapsed };
    f.deps.gatewayRecovery = new GatewayRecovery({ now: () => elapsed, sleep: async ms => { elapsed += ms; } });
    const original = f.builder.run.bind(f.builder);
    const calls: string[] = [];
    f.deps.builder.run = async (request, options) => {
      assert.ok("packet" in request);
      calls.push(request.packet.id);
      if (calls.length <= 25) {
        f.git.applicationChanged = false;
        return { sessionId: "down", outcome: "failed", summary: "quota exhausted", gatewayFailure: httpGatewayFailure(429) };
      }
      return original(request, options);
    };
    const summary = await f.run();
    assert.equal(summary.status, "delivered");
    assert.deepEqual(summary.pendingRequirementIds, []);
    assert.equal(new Set(calls.slice(0, 26)).size, 1);
    assert.ok(elapsed > 90 * 60_000, `expected the outage to outlast one call window, saw ${elapsed}ms`);
    const events = await f.events();
    assert.ok(events.some(event => event.type === "implementation_paused"));
    assert.equal(events.filter(event => event.type === "module_rescued").length, 0);
  });
});

test("A non-retryable gateway rejection stops dispatch instead of retrying without backoff", async () => {
  await withModulePipeline(async f => {
    f.options.totalBudgetMs = 0;
    let calls = 0;
    f.deps.builder.run = async () => {
      calls++;
      if (calls > 1) throw new Error("non-retryable rejection was retried");
      return { sessionId: "bad", outcome: "failed", summary: "HTTP 400 bad request", gatewayFailure: httpGatewayFailure(400) };
    };
    const summary = await f.run();
    assert.equal(calls, 1);
    assert.equal(summary.status, "partial");
    assert.deepEqual(summary.pendingRequirementIds, ["A", "B", "C"]);
    const events = await f.events();
    assert.ok(events.some(event => event.type === "implementation_stopped"));
    assert.equal(events.filter(event => event.type === "implementation_paused").length, 0);
  });
});

test("An upstream reset wrapped in HTTP 400 retries the same feature group", async () => {
  await withModulePipeline(async f => {
    f.options.totalBudgetMs = 0;
    let elapsed = 0;
    f.deps.clock = { nowMs: () => elapsed };
    f.deps.gatewayRecovery = new GatewayRecovery({ now: () => elapsed, sleep: async ms => { elapsed += ms; } });
    const original = f.builder.run.bind(f.builder);
    const calls: string[] = [];
    f.deps.builder.run = async (request, options) => {
      if (request.mode === "implement") {
        calls.push(request.packet.id);
        if (calls.length === 1) return { sessionId: "upstream-reset", outcome: "failed", summary: "connection reset by peer",
          gatewayFailure: { kind: "unavailable", retryable: true, status: 400 } };
      }
      return original(request, options);
    };
    const summary = await f.run();
    assert.equal(summary.status, "delivered");
    assert.equal(calls[0], calls[1]);
    assert.equal(elapsed, 5_000);
    assert.ok(!(await f.events()).some(event => event.type === "implementation_stopped"));
  });
});

test("Unrunnable partial gateway work is rolled back before retrying the same packet", async () => {
  await withModulePipeline(async f => {
    f.options.totalBudgetMs = 0;
    f.deps.git = await GitCliOps.open(f.options.outputDir);
    const original = f.builder.run.bind(f.builder);
    const marker = join(f.options.outputDir, "broken.txt");
    let calls = 0;
    f.deps.appLifecycle.start = async () => {
      const broken = await readFile(marker, "utf8").catch(() => "");
      if (broken) throw new Error("build is broken");
      return { baseUrl: f.options.platformContract.baseUrl, stop: async () => {} };
    };
    f.deps.builder.run = async (request, options) => {
      if (++calls === 1) {
        await original(request, options);
        await writeFile(marker, "broken");
        return { sessionId: "down", outcome: "failed", summary: "429", gatewayFailure: httpGatewayFailure(429) };
      }
      await assert.rejects(readFile(marker, "utf8"), { code: "ENOENT" });
      return original(request, options);
    };
    assert.equal((await f.run()).status, "delivered");
    const events = await f.events();
    assert.ok(events.some(event => event.type === "builder_work_preserved" && event.detail?.preserved === false));
    assert.ok(!events.some(event => event.type === "module_rescued"));
  });
});

test("Interrupted source changes survive recovery and are not marked implemented when the gateway stays unavailable", async () => {
  await withModulePipeline(async f => {
    let elapsed = 0;
    f.options.totalBudgetMs = 100_000;
    f.deps.clock = { nowMs: () => elapsed };
    f.deps.gatewayRecovery = new GatewayRecovery({ now: () => elapsed, sleep: async ms => { elapsed += ms; } });
    f.deps.git = await GitCliOps.open(f.options.outputDir);
    const original = f.builder.run.bind(f.builder);
    let calls = 0;
    f.deps.builder.run = async (request, options) => {
      calls++;
      if (calls === 1) {
        await original(request, options);
        await writeFile(join(request.outputDir, "partial.txt"), "keep this work");
      } else assert.equal(await readFile(join(request.outputDir, "partial.txt"), "utf8"), "keep this work");
      return { sessionId: "interrupted", outcome: "failed", summary: "429", gatewayFailure: httpGatewayFailure(429) };
    };
    const summary = await f.run();
    assert.equal(summary.status, "partial");
    assert.deepEqual(summary.implementedRequirementIds, []);
    assert.deepEqual(summary.blockedRequirementIds, ["A", "B"]);
    assert.deepEqual(summary.pendingRequirementIds, ["C"]);
    assert.equal(await readFile(join(f.options.outputDir, "partial.txt"), "utf8"), "keep this work");
    const checkpoints = (await f.events()).filter(event => event.type === "checkpoint_saved");
    assert.equal(checkpoints.length, 1);
    assert.deepEqual(checkpoints[0].detail?.requirementIds, []);
  });
});

test("Ordinary failed calls cannot rescue an unchanged old application", async () => {
  await withModulePipeline(async f => {
    f.deps.git = await GitCliOps.open(f.options.outputDir);
    const original = f.builder.run.bind(f.builder);
    f.deps.builder.run = async (request, options) => {
      if ("packet" in request && request.packet.requirementIds.includes("C")) {
        return { sessionId: "empty", outcome: "failed", summary: "No model response" };
      }
      return original(request, options);
    };
    const summary = await f.run();
    assert.deepEqual(summary.implementedRequirementIds, ["A", "B"]);
    assert.deepEqual(summary.blockedRequirementIds, ["C"]);
    assert.ok(!(await f.events()).some(event => event.type === "module_rescued"));
  });
});

test("Planner 429 recovers within the module rather than deferring all feedback to the final audit", async () => {
  await withModulePipeline(async f => {
    f.options.totalBudgetMs = 0;
    let attempts = 0;
    f.deps.planner.plan = async packet => {
      if (++attempts === 1) throw new ProbePlannerError("transport", "HTTP 429", { httpStatus: 429 });
      return testPlan(packet);
    };
    assert.equal((await f.run()).status, "delivered");
    const events = await f.events();
    assert.ok(events.some(event => event.type === "gateway_wait" && event.detail?.source === "planner"));
    assert.ok(!events.some(event => event.type === "probe_planner_failed"));
  });
});

test("Planner calls use the phase budget instead of a 180-second attempt timer", async () => {
  await withModulePipeline(async f => {
    f.options.totalBudgetMs = 1_000_000;
    f.deps.clock = { nowMs: () => 0 };
    const timeouts: number[] = [];
    f.deps.planner.plan = async (packet, _feedback, options) => {
      timeouts.push(options?.timeoutMs ?? 0);
      return testPlan(packet);
    };
    assert.equal((await f.run()).status, "delivered");
    assert.ok(timeouts.length > 0);
    assert.ok(timeouts.every(timeout => timeout >= 600_000), JSON.stringify(timeouts));
  });
});

test("Planner calls get a recovery window when the run budget is unlimited", async () => {
  await withModulePipeline(async f => {
    f.options.totalBudgetMs = 0;
    const timeouts: number[] = [];
    f.deps.planner.plan = async (packet, _feedback, options) => {
      timeouts.push(options?.timeoutMs ?? 0);
      return testPlan(packet);
    };
    assert.equal((await f.run()).status, "delivered");
    assert.ok(timeouts.length > 0);
    assert.ok(timeouts.every(timeout => timeout === 720_000), JSON.stringify(timeouts));
  });
});

test("Builder checkpoints before a background probe plan settles", async () => {
  await withModulePipeline(async f => {
    f.options.totalBudgetMs = 0;
    let releasePlan!: () => void;
    const heldPlan = new Promise<void>(resolve => { releasePlan = resolve; });
    const originalPlan = f.deps.planner.plan.bind(f.deps.planner);
    f.deps.planner.plan = async (packet, feedback, options) => {
      if (packet.id === "packet-a") await heldPlan;
      return originalPlan(packet, feedback, options);
    };
    let checkpointSaved!: () => void;
    const checkpoint = new Promise<void>(resolve => { checkpointSaved = resolve; });
    const capture = f.deps.git.captureAccepted.bind(f.deps.git);
    f.deps.git.captureAccepted = async reason => {
      const sha = await capture(reason);
      if (reason.startsWith("shallow: checkpoint feature-")) checkpointSaved();
      return sha;
    };
    const running = f.run();
    try {
      await Promise.race([checkpoint, new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Builder checkpoint waited for the probe plan")), 1_000))]);
    } finally { releasePlan(); }
    assert.equal((await running).status, "delivered");
  });
});

test("Background planning renews an exhausted window before Builder finishes", async () => {
  await withModulePipeline(async f => {
    f.options.totalBudgetMs = 0;
    let elapsed = 0;
    let builderRunning = false;
    let attempts = 0;
    let recovered!: () => void;
    const recovery = new Promise<void>(resolve => { recovered = resolve; });
    f.deps.clock = { nowMs: () => elapsed };
    f.deps.gatewayRecovery = new GatewayRecovery({ now: () => elapsed, sleep: async ms => { elapsed += ms; } });
    f.deps.planner.plan = async packet => {
      if (packet.id === "packet-a") {
        if (++attempts === 1) {
          elapsed = 720_000;
          throw new ProbePlannerError("transport", "headers timeout");
        }
        assert.equal(builderRunning, true, "recovery was deferred until the module audit");
        recovered();
      }
      return testPlan(packet);
    };
    const originalBuild = f.builder.run.bind(f.builder);
    f.deps.builder.run = async (request, options) => {
      builderRunning = true;
      try {
        await Promise.race([recovery, new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error("background planning did not resume")), 1_000);
          timer.unref();
        })]);
        return originalBuild(request, options);
      } finally { builderRunning = false; }
    };
    assert.equal((await f.run()).status, "delivered");
    const events = await f.events();
    assert.ok(events.some(event => event.type === "probe_planner_retry" && event.packetId === "packet-a"));
    assert.ok(!events.some(event => event.type === "probe_preplan_failed"));
  });
});

test("A planning outage respects stage budgets and retains completed code", async () => {
  await withModulePipeline(async f => {
    f.options.totalBudgetMs = 1_000_000;
    let elapsed = 0;
    f.deps.clock = { nowMs: () => elapsed };
    f.deps.gatewayRecovery = new GatewayRecovery({ now: () => elapsed, sleep: async ms => { elapsed += ms; } });
    f.deps.planner.plan = async packet => {
      if (packet.id === "packet-a") throw new ProbePlannerError("transport", "headers timeout");
      return testPlan(packet);
    };
    const summary = await f.run();
    assert.deepEqual(summary.implementedRequirementIds, ["A", "B"]);
    assert.deepEqual(summary.blockedRequirementIds, ["C"]);
    assert.deepEqual(summary.pendingRequirementIds, []);
    assert.ok(summary.inconclusiveRequirementIds?.includes("A"));
    assert.ok(elapsed <= 800_000, `planner exceeded the audit budget: ${elapsed}ms`);
    const events = await f.events();
    assert.ok(events.some(event => event.type === "checkpoint_saved" && event.detail?.requirementIds.includes("A")));
    assert.ok(events.some(event => event.type === "probe_preplan_failed" && event.packetId === "packet-a" && event.phase === "planner"));
  });
});

test("Queued background plans receive full windows after slow earlier plans", async () => {
  await withModulePipeline(async f => {
    const ids = ["A", "B", "D", "E", "F"];
    await writeFile(f.options.requirementsFile, JSON.stringify({ id: "ROOT", name: "Product", type: "FOLDER",
      dependencies: [], children: [{ id: "FIRST", name: "First", type: "FOLDER", dependencies: [],
        children: ids.map(id => ({ id, name: id, type: "ATOMIC", dependencies: [], description: "Display the main workspace." })) }] }));
    f.options.totalBudgetMs = 0;
    let elapsed = 0;
    let started = 0;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const timeouts = new Map<string, number>();
    f.deps.clock = { nowMs: () => elapsed };
    f.deps.planner.plan = async (packet, _feedback, options) => {
      timeouts.set(packet.id, options!.timeoutMs);
      if (packet.id === "packet-a" || packet.id === "packet-b") {
        if (++started === 2) { elapsed = 640_000; release(); }
        await held;
      }
      return testPlan(packet);
    };
    assert.equal((await f.run()).status, "delivered");
    assert.equal(timeouts.size, ids.length);
    assert.ok([...timeouts.values()].every(timeout => timeout === 720_000), JSON.stringify([...timeouts]));
    assert.ok(!(await f.events()).some(event => event.type === "probe_preplan_failed"));
  });
});

test("A permanent planning error stays isolated to its packet", async () => {
  await withModulePipeline(async f => {
    f.deps.planner.plan = async packet => {
      if (packet.id === "packet-a") throw new ProbePlannerError("response", "Probe planner response has no message content");
      return testPlan(packet);
    };
    const summary = await f.run();
    assert.deepEqual(summary.implementedRequirementIds, ["A", "B", "C"]);
    assert.deepEqual(summary.verifiedRequirementIds, ["B", "C"]);
    assert.deepEqual(summary.inconclusiveRequirementIds, ["A"]);
    assert.deepEqual((await f.events()).filter(event => event.type === "probe_preplan_failed").map(event => event.packetId), ["packet-a"]);
  });
});

test("A failed background plan is recovered once at the module boundary without enabling final planning", async () => {
  await withModulePipeline(async f => {
    f.options.generateFinalAuditPlans = false;
    const calls = new Map<string, number>();
    f.deps.planner.plan = async packet => {
      const count = (calls.get(packet.id) ?? 0) + 1;
      calls.set(packet.id, count);
      if (packet.id === "packet-a" && count === 1) {
        throw new ProbePlannerError("response", "background response was empty");
      }
      return testPlan(packet);
    };
    const summary = await f.run();
    assert.equal(summary.status, "delivered");
    assert.deepEqual(summary.verifiedRequirementIds, ["A", "B", "C"]);
    assert.equal(calls.get("packet-a"), 2, "one background attempt plus one boundary recovery");
    assert.equal(calls.get("packet-b"), 1);
    assert.equal(calls.get("packet-c"), 1);
    assert.ok((await f.events()).some(event => event.type === "probe_preplan_failed" && event.packetId === "packet-a"));
  });
});

test("Pipeline failure cancels active background planning before cleanup completes", async () => {
  await withModulePipeline(async f => {
    let started!: () => void;
    let cancelled = 0;
    const planning = new Promise<void>(resolve => { started = resolve; });
    f.deps.planner.plan = async (_packet, _feedback, options) => {
      assert.ok(options?.signal);
      started();
      return new Promise((_, reject) => {
        options.signal!.addEventListener("abort", () => { cancelled++; reject(options.signal!.reason); }, { once: true });
      });
    };
    f.deps.builder.run = async () => {
      await planning;
      throw new ExecutionFault("builder", "builder_start", false);
    };
    await assert.rejects(f.run(), ExecutionFault);
    assert.ok(cancelled > 0);
    assert.ok(!(await f.events()).some(event => event.type === "probe_preplan_failed"));
  });
});

test("A gateway outage during boundary repair postpones the round instead of abandoning the module", async () => {
  await withModulePipeline(async f => {
    let runs = 0;
    f.deps.runner.run = async plan => { runs++; return runs <= 2 ? fail(plan) : pass(plan); };
    const original = f.builder.run.bind(f.builder);
    let repairCalls = 0;
    f.deps.builder.run = async (request, options) => {
      if (request.mode === "repair" && ++repairCalls <= 6) {
        return { sessionId: "down", outcome: "failed", summary: "429", gatewayFailure: httpGatewayFailure(429) };
      }
      return original(request, options);
    };
    const summary = await f.run();
    assert.equal(summary.status, "delivered");
    const finished = (await f.events()).filter(event => event.type === "repair_batch_finished");
    assert.equal(finished.length, 1);
    assert.equal(finished[0].detail?.retained, true);
    assert.equal(repairCalls, 7);
  });
});

test("A short implementation budget bounds gateway recovery and preserves delivery time", async () => {
  await withModulePipeline(async f => {
    let elapsed = 0;
    f.options.totalBudgetMs = 10_000;
    f.deps.clock = { nowMs: () => elapsed };
    f.deps.gatewayRecovery = new GatewayRecovery({ now: () => elapsed, sleep: async ms => { elapsed += ms; } });
    f.git.applicationChanged = false;
    let calls = 0;
    f.deps.builder.run = async () => {
      calls++;
      return { sessionId: "down", outcome: "failed", summary: "429", gatewayFailure: httpGatewayFailure(429) };
    };
    const summary = await f.run();
    assert.equal(calls, 1);
    assert.equal(elapsed, 6_000);
    assert.deepEqual(summary.implementedRequirementIds, []);
    assert.deepEqual(summary.blockedRequirementIds, ["A", "B"]);
    assert.deepEqual(summary.pendingRequirementIds, ["C"]);
    assert.ok((await f.events()).some(event => event.type === "delivery_finished"));
  });
});

test("A gateway outage during the timeout retry pauses and resumes the same packet", async () => {
  await withModulePipeline(async f => {
    let elapsed = 0;
    f.options.totalBudgetMs = 0;
    f.deps.clock = { nowMs: () => elapsed };
    f.deps.gatewayRecovery = new GatewayRecovery({ now: () => elapsed, sleep: async ms => { elapsed += ms; } });
    const original = f.builder.run.bind(f.builder);
    const calls: string[] = [];
    f.deps.builder.run = async (request, options) => {
      assert.ok("packet" in request);
      calls.push(request.packet.id);
      if (calls.length === 1) return { sessionId: "slow", outcome: "timed_out", summary: "deadline" };
      if (elapsed < 90 * 60_000) {
        return { sessionId: "down", outcome: "failed", summary: "429", gatewayFailure: httpGatewayFailure(429) };
      }
      return original(request, options);
    };
    const summary = await f.run();
    assert.equal(summary.status, "delivered");
    assert.ok(elapsed > 45 * 60_000, `expected the outage to outlast the timeout-retry window, saw ${elapsed}ms`);
    const events = await f.events();
    assert.ok(events.some(event => event.type === "implementation_retry"));
    assert.ok(events.some(event => event.type === "implementation_paused"));
    assert.equal(events.filter(event => event.type === "module_rescued").length, 0);
  });
});

test("A gateway outage spanning multiple call windows pauses repeatedly and still completes the same packet", async () => {
  await withModulePipeline(async f => {
    let elapsed = 0;
    f.options.totalBudgetMs = 0;
    f.deps.clock = { nowMs: () => elapsed };
    f.deps.gatewayRecovery = new GatewayRecovery({ now: () => elapsed, sleep: async ms => { elapsed += ms; } });
    const original = f.builder.run.bind(f.builder);
    const calls: string[] = [];
    f.deps.builder.run = async (request, options) => {
      assert.ok("packet" in request);
      calls.push(request.packet.id);
      // One implementation call window is 90 minutes; fail past two windows.
      if (elapsed < 190 * 60_000) {
        f.git.applicationChanged = false;
        return { sessionId: "down", outcome: "failed", summary: "quota exhausted", gatewayFailure: httpGatewayFailure(429) };
      }
      return original(request, options);
    };
    const summary = await f.run();
    assert.equal(summary.status, "delivered");
    assert.deepEqual(summary.pendingRequirementIds, []);
    const firstPacketId = calls[0];
    let samePacketCalls = 0;
    while (samePacketCalls < calls.length && calls[samePacketCalls] === firstPacketId) samePacketCalls++;
    assert.ok(samePacketCalls > 20, `expected the same packet to be retried across call windows, saw ${samePacketCalls} calls`);
    const events = await f.events();
    const pauses = events.filter(event => event.type === "implementation_paused" && event.packetId === firstPacketId);
    assert.ok(pauses.length >= 2, `expected repeated implementation_paused events, saw ${pauses.length}`);
    assert.ok(elapsed >= 190 * 60_000, `expected the outage to span multiple call windows, saw ${elapsed}ms`);
    assert.equal(events.filter(event => event.type === "module_rescued").length, 0);
  });
});

test("Semantic review is routed through planner gateway recovery", async () => {
  await withModulePipeline(async f => {
    f.options.totalBudgetMs = 0;
    f.deps.runner.run = async plan => fail(plan);
    let reviews = 0;
    f.deps.planner.reviewPlan = async () => {
      reviews += 1;
      if (reviews === 1) throw new ProbePlannerError("transport", "HTTP 429", { httpStatus: 429 });
      return { status: "sound", rationale: "429 recovered" };
    };
    await f.run();
    assert.ok(reviews >= 2);
    assert.ok((await f.events()).some(event => event.type === "gateway_wait" && event.detail?.source === "planner"));
  });
});

test("Probe Planner token usage is recorded as planner-phase diagnostics", async () => {
  await withModulePipeline(async f => {
    const generate = f.deps.planner.plan.bind(f.deps.planner);
    f.deps.planner.plan = async (packet, feedback, options) => {
      await options?.onUsage?.({ input: 700, output: 50, cacheRead: 200, cacheWrite: 100, total: 1050 });
      return generate(packet, feedback, options);
    };
    const summary = await f.run();
    assert.equal(summary.status, "delivered");
    const usage = (await f.events()).filter(event => event.type === "probe_planner_usage");
    assert.ok(usage.length >= 1);
    assert.equal(usage[0].phase, "planner");
    assert.equal(usage[0].detail?.operation, "plan");
    assert.equal(usage[0].detail?.input, 700);
    assert.equal(usage[0].detail?.total, 1050);
  });
});
