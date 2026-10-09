import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";

import { auditPacket } from "../src/judge/audit.js";
import { loadRequirementCatalog } from "../src/catalog.js";
import { auditPackets } from "../src/scheduler.js";
import { RunStateStore } from "../src/run-state.js";
import { PlaywrightProbeRunner } from "../src/judge/playwright-probe-runner.js";
import { LlmProbePlanner } from "../src/judge/llm-probe-planner.js";
import { probePlanSha256, type ProbePlan } from "../src/judge/probe-schema.js";
import type { PlanCorrection, PlanReview } from "../src/judge/semantic-review.js";
import { FakeProbePlanner } from "./fakes/fake-probe-planner.js";
import { withModulePipeline, type PipelineFixture, fail, pass } from "./helpers/module-pipeline.js";

test("Clipboard content alone cannot establish a seeded state; preparation recovery must apply it", async () => {
  await withModulePipeline(async f => {
    const catalog = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    catalog.children[0].children[0].description = 'Paste into "Editor" to prepare "ready", then "Save" displays "Saved". Seed values: ready.';
    await writeFile(f.options.requirementsFile, JSON.stringify(catalog));
    const packet = auditPackets(await loadRequirementCatalog(f.options.requirementsFile))[0];
    const plan: ProbePlan = { packetId: packet.id, cases: [{ id: "case-A", requirementIds: ["A"], purpose: "happy_path",
      expectationBasis: [packet.requirements[0].text], setupStepCount: 3, steps: [
        { op: "goto", path: "/" }, { op: "setClipboardText", text: "ready" },
        { op: "expectText", locator: { by: "role", role: "status" }, text: "ready" },
        { op: "click", locator: { by: "role", role: "button", name: "Save" } },
        { op: "expectText", locator: { by: "role", role: "status" }, text: "Saved" },
      ] }] };
    let reviews = 0;
    f.deps.planner.reviewPlan = async (_packet, original, _failures, feedback) => {
      if (++reviews === 1) return { status: "sound", rationale: "Seed declaration says ready" };
      assert.match(feedback?.validationError ?? "", /initial-state checkpoint/);
      const corrected = structuredClone(original);
      corrected.cases[0].steps.splice(2, 0, { op: "press", locator: { by: "label", text: "Editor" }, key: "ControlOrMeta+V" });
      corrected.cases[0].setupStepCount = 4;
      return correctedReview(corrected, [{ caseId: "case-A", conflict: "Clipboard was not applied", basis: [packet.requirements[0].text] }]);
    };
    f.deps.runner.run = async current => current.cases[0].steps.some(step => step.op === "press") ? pass(current) : {
      packetId: current.packetId, verdict: "inconclusive", passedCases: [], failures: [
        { caseId: "case-A", stepIndex: 2, category: "precondition", message: "Actual value is a different initial state" },
      ],
    };
    const state = makeState(f);
    assert.equal((await auditPacket(packet, plan, f.options, f.deps, state, () => 60_000)).status, "verified");
    assert.equal(reviews, 2);
    assert.equal(state.semanticCorrectionCount(packet.id, "case-A"), 0);
  });
});

function groundedPlan(steps: ProbePlan["cases"][number]["steps"], basis = ["Display the main workspace."]): ProbePlan {
  return { packetId: "packet-a", cases: [{ id: "case-A", requirementIds: ["A"], purpose: "happy_path", expectationBasis: basis, steps }] };
}
function correctedReview(plan: ProbePlan, corrections: PlanCorrection[], rationale = "计划与需求冲突"): PlanReview {
  return { status: "corrected", rationale, plan, corrections };
}
function makeState(f: PipelineFixture): RunStateStore {
  return new RunStateStore({ statusByRequirementId: { A: "todo" }, acceptedSha: "checkpoint",
    startedAtMs: 0, totalBudgetMs: 60_000 }, f.options.ledgerFile, f.deps.logSink);
}
async function auditWith(f: PipelineFixture, state: RunStateStore, plan: ProbePlan) {
  const packet = auditPackets(await loadRequirementCatalog(f.options.requirementsFile))[0];
  return auditPacket(packet, plan, f.options, f.deps, state, () => 60_000);
}

test("Requirement-backed confirmation completes the original operation without lowering its result assertion", async () => {
  await withModulePipeline(async f => {
    const tree = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    const basis = 'Click “Proceed”; if confirmation is used, click “Confirm” before “Done” is visible.';
    tree.children[0].children[0].description = basis;
    await writeFile(f.options.requirementsFile, JSON.stringify(tree));
    const original = groundedPlan([
      { op: "goto", path: "/" },
      { op: "click", locator: { by: "role", role: "button", name: "Proceed", exact: true } },
      { op: "expectVisible", locator: { by: "role", role: "heading", name: "Done", exact: true } },
    ], [basis]);
    let reviews = 0;
    f.deps.runner.run = async plan => plan.cases[0].steps.some(step => step.op === "click" && step.locator.by === "role" && step.locator.name === "Confirm")
      ? pass(plan) : { packetId: plan.packetId, verdict: "fail", passedCases: [], failures: [{
        caseId: "case-A", stepIndex: 2, category: "assertion", message: "Done is absent while confirmation is open",
        locatorSnapshot: '- dialog "Confirm action":\n  - button "Confirm"',
      }] };
    f.deps.planner.reviewPlan = async (_packet, plan) => {
      reviews++;
      const corrected = structuredClone(plan);
      corrected.cases[0].steps.splice(2, 0, { op: "click", locator: { by: "role", role: "button", name: "Confirm", exact: true } });
      return correctedReview(corrected, [{ caseId: "case-A", conflict: "The allowed confirmation is not submitted", basis: [basis] }]);
    };
    const state = makeState(f);
    const result = await auditWith(f, state, original);
    assert.equal(result.status, "verified");
    assert.equal(reviews, 1);
    assert.deepEqual(result.plan?.cases[0].steps.at(-1), original.cases[0].steps.at(-1));
    assert.equal(state.semanticCorrectionCount("packet-a", "case-A"), 1);
    assert.equal(f.builder.requests.length, 0);
  });
});

test("Prefix response validation and retry use the existing preparation quota without semantic corrections", async () => {
  await withModulePipeline(async f => {
    const original = groundedPlan([
      { op: "goto", path: "/" }, { op: "expectVisible", locator: { by: "role", role: "main" } },
      { op: "click", locator: { by: "role", role: "button", name: "Save", exact: true } },
      { op: "expectText", locator: { by: "role", role: "status" }, text: "Saved" },
    ]);
    original.cases[0].setupStepCount = 2;
    let calls = 0;
    f.deps.planner = new LlmProbePlanner({ baseUrl: "https://gateway.example/v1", apiKey: "test-key", model: "test", timeoutMs: 1_000 },
      async (_input, init) => {
        const payload = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
        const response = ++calls === 1 ? { verdict: "corrected", rationale: "invalid full-plan response", plan: original,
          corrections: [{ caseId: "case-A", conflict: "Navigation", basis: ["Display the main workspace."] }] }
          : { verdict: "corrected", rationale: "Prepare through visible navigation", corrections: [{
            caseId: "case-A", conflict: "Navigation omitted the workspace", basis: ["Display the main workspace."],
            setupSteps: [original.cases[0].steps[0],
              { op: "click", locator: { by: "role", role: "link", name: "Workspace" } }, original.cases[0].steps[1]],
          }] };
        if (calls === 2) assert.match(payload.validationError, /unsupported field: plan/);
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }),
          { headers: { "content-type": "application/json" } });
      });
    let runs = 0;
    f.deps.runner.run = async plan => {
      runs++;
      return plan.cases[0].setupStepCount === 3 ? pass(plan) : { packetId: plan.packetId,
        verdict: "inconclusive", passedCases: [], failures: [{ caseId: "case-A", stepIndex: 1,
          category: "precondition", message: "Workspace not reached" }] };
    };
    const state = makeState(f);
    const result = await auditWith(f, state, original);
    assert.equal(result.status, "verified");
    assert.equal(calls, 2);
    assert.equal(runs, 2);
    assert.equal(state.semanticCorrectionCount(original.packetId, "case-A"), 0);
    assert.deepEqual(result.plan?.cases[0].steps.slice(3), original.cases[0].steps.slice(2));
    assert.equal(f.builder.requests.length, 0);
  });
});

test("Mixed prefix recovery keeps prepared failures separate from reproduced business failures", async () => {
  await withModulePipeline(async f => {
    const original = groundedPlan([
      { op: "goto", path: "/" }, { op: "expectVisible", locator: { by: "role", role: "main" } },
      { op: "click", locator: { by: "role", role: "button", name: "Save", exact: true } },
      { op: "expectText", locator: { by: "role", role: "status" }, text: "Saved" },
    ]);
    original.cases[0].setupStepCount = 2;
    original.cases.push({ id: "business", requirementIds: ["A"], purpose: "persistence", expectationBasis: ["Display the main workspace."],
      steps: [{ op: "goto", path: "/" }, { op: "expectText", locator: { by: "role", role: "status" }, text: "Unsupported feedback" }] },
      { id: "already-passed", requirementIds: ["A"], purpose: "happy_path", expectationBasis: ["Display the main workspace."],
        steps: [{ op: "goto", path: "/" }, { op: "expectVisible", locator: { by: "role", role: "main" } }] });
    let calls = 0;
    f.deps.planner = new LlmProbePlanner({ baseUrl: "https://gateway.example/v1", apiKey: "test-key", model: "test", timeoutMs: 1_000 },
      async (_input, init) => {
        calls++;
        const payload = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
        assert.deepEqual(payload.caseCorrectionIds, ["business"]);
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          verdict: "corrected", rationale: "Independent preparation and expectation problems", corrections: [
            { caseId: "case-A", conflict: "Navigation missing", basis: ["Display the main workspace."],
              setupSteps: [original.cases[0].steps[0], { op: "click", locator: { by: "role", role: "link", name: "Workspace" } },
                original.cases[0].steps[1]] },
            { caseId: "business", conflict: "Unsupported expectation", basis: ["Display the main workspace."],
              case: { ...original.cases[1], setupStepCount: null, steps: [original.cases[1].steps[0]],
                assertion: { op: "expectVisible", locator: { by: "role", role: "main" } } } },
          ],
        }) } }] }), { headers: { "content-type": "application/json" } });
      });
    let runs = 0;
    f.deps.runner.run = async plan => {
      runs++;
      return { packetId: plan.packetId, verdict: "fail", passedCases: ["already-passed"], failures: [
        ...(plan.cases[0].setupStepCount === 2 ? [{ caseId: "case-A", stepIndex: 1, category: "precondition" as const,
          message: "Workspace not reached" }] : []),
        { caseId: "business", stepIndex: 1, category: "assertion", message: "The tested result remains absent" },
      ] };
    };
    const state = makeState(f);
    const result = await auditWith(f, state, original);
    assert.equal(result.status, "failed");
    assert.equal(calls, 1);
    assert.equal(runs, 3);
    assert.deepEqual(result.report?.failures.map(item => item.caseId), ["business"]);
    assert.equal(state.semanticCorrectionCount(original.packetId, "case-A"), 0);
    assert.equal(state.semanticCorrectionCount(original.packetId, "business"), 1);
    assert.deepEqual(result.plan?.cases[2], original.cases[2]);
    assert.equal(f.builder.requests.length, 0);
  });
});

test("A seed misread is corrected from requirement evidence, re-run, and only then verified", async () => {
  await withModulePipeline(async f => {
    const original = groundedPlan([{ op: "goto", path: "/" },
      { op: "expectVisible", locator: { by: "role", role: "tab", name: "Archived" } }]);
    const corrected = groundedPlan([{ op: "goto", path: "/" },
      { op: "expectVisible", locator: { by: "role", role: "main" } }]);
    const planner = new FakeProbePlanner([original]);
    planner.reviewPlan = async (_packet, reviewed, failures) => {
      planner.reviews.push({ plan: structuredClone(reviewed), failures: structuredClone(failures) });
      return correctedReview(corrected,
        [{ caseId: "case-A", conflict: "需求写 active 种子，计划断言归档区", basis: ["Display the main workspace."] }]);
    };
    f.deps.planner = planner;
    let runs = 0;
    const executed: ProbePlan[] = [];
    f.deps.runner.run = async plan => { executed.push(plan); return ++runs === 1 ? fail(plan) : pass(plan); };
    const result = await auditWith(f, makeState(f), original);
    assert.equal(result.status, "verified");
    assert.equal(planner.reviews.length, 1);
    assert.equal(executed.length, 2);
    assert.equal(probePlanSha256(executed[1]), probePlanSha256(corrected));
    assert.deepEqual(f.git.restoredShas, []);
    const events = (await f.events()).map(event => event.type);
    assert.ok(events.includes("probe_review_started"));
    assert.ok(events.includes("probe_reviewed"));
  });
});

test("A grounded expectation is reproduced before any failed verdict", async () => {
  await withModulePipeline(async f => {
    const original = groundedPlan([{ op: "goto", path: "/" },
      { op: "expectText", locator: { by: "role", role: "main" }, text: "saved value" }]);
    const planner = new FakeProbePlanner([original]);
    f.deps.planner = planner;
    let runs = 0;
    f.deps.runner.run = async plan => { runs += 1; return fail(plan); };
    const result = await auditWith(f, makeState(f), original);
    assert.equal(result.status, "failed");
    assert.equal(planner.reviews.length, 1);
    assert.equal(runs, 2);
    const reviewed = (await f.events()).find(event => event.type === "probe_reviewed");
    assert.equal(reviewed?.detail?.verdict, "sound");
  });
});

test("Each case accepts at most one semantic correction per run", async () => {
  await withModulePipeline(async f => {
    const original = groundedPlan([{ op: "goto", path: "/" },
      { op: "expectVisible", locator: { by: "role", role: "tab", name: "Archived" } }]);
    const corrected = groundedPlan([{ op: "goto", path: "/" },
      { op: "expectVisible", locator: { by: "role", role: "main" } }]);
    const planner = new FakeProbePlanner([original]);
    planner.reviewPlan = async (_packet, reviewed, failures) => {
      planner.reviews.push({ plan: structuredClone(reviewed), failures: structuredClone(failures) });
      return correctedReview(corrected,
        [{ caseId: "case-A", conflict: "冲突", basis: ["Display the main workspace."] }]);
    };
    f.deps.planner = planner;
    f.deps.runner.run = async plan => fail(plan);
    const state = makeState(f);
    assert.equal((await auditWith(f, state, original)).status, "failed");
    const second = await auditWith(f, state, corrected);
    assert.equal(second.status, "inconclusive");
    assert.match(second.reason ?? "", /quota/);
    assert.equal(planner.reviews.length, 2);
  });
});

test("An unavailable semantic review never becomes a failed verdict", async () => {
  await withModulePipeline(async f => {
    const original = groundedPlan([{ op: "goto", path: "/" },
      { op: "expectText", locator: { by: "role", role: "main" }, text: "saved value" }]);
    const planner = new FakeProbePlanner([original]);
    planner.reviewPlan = async () => { throw new Error("review gateway down"); };
    f.deps.planner = planner;
    f.deps.runner.run = async plan => fail(plan);
    const result = await auditWith(f, makeState(f), original);
    assert.equal(result.status, "inconclusive");
    assert.match(result.reason ?? "", /semantic review/);
    const events = (await f.events()).map(event => event.type);
    assert.ok(events.includes("probe_review_failed"));
  });
});

for (const checkpoint of ["missing", "view-only"] as const) {
  test(`A declared seed cannot replace executed state evidence: ${checkpoint}`, async () => {
    await withModulePipeline(async f => {
      const catalog = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
      const basis = 'Seed data: cell `A1` contains `2`. Enter a formula and show the calculated result.';
      catalog.children[0].children[0].description = basis;
      await writeFile(f.options.requirementsFile, JSON.stringify(catalog));
      const original = groundedPlan([
        { op: "goto", path: "/" },
        { op: "expectVisible", locator: { by: "role", role: "grid" } },
        { op: "fill", locator: { by: "label", text: "Formula bar" }, value: "=A1+2" },
        { op: "expectText", locator: { by: "role", role: "status" }, text: "4" },
      ], [basis]);
      if (checkpoint === "view-only") original.cases[0].setupStepCount = 2;
      const planner = new FakeProbePlanner([original]);
      f.deps.planner = planner;
      let runs = 0;
      f.deps.runner.run = async plan => { runs++; return { packetId: plan.packetId, verdict: "fail", passedCases: [],
        failures: [{ caseId: "case-A", stepIndex: 3, category: "assertion", message: "expected 4, got #ERROR",
          locatorSnapshot: '- grid:\n  - gridcell "A1": Region' }] }; };
      const result = await auditWith(f, makeState(f), original);
      assert.equal(result.status, "inconclusive");
      assert.equal(result.repairableProbeFailure, undefined);
      assert.equal(planner.reviews.length, 2);
      assert.equal(runs, 1);
      assert.ok((await f.events()).some(event => event.type === "probe_review_failed" &&
        String(event.detail?.message).includes("initial-state checkpoint")));
      assert.equal(f.builder.requests.length, 0);
    });
  });
}

test("A misleading sound verdict gets preparation feedback within the existing review quota", async () => {
  await withModulePipeline(async f => {
    const catalog = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    const basis = 'Seed data: cell `A1` contains `2`. Enter a formula and show the calculated result.';
    catalog.children[0].children[0].description = basis;
    await writeFile(f.options.requirementsFile, JSON.stringify(catalog));
    const original = groundedPlan([{ op: "goto", path: "/" },
      { op: "expectVisible", locator: { by: "role", role: "grid" } },
      { op: "fill", locator: { by: "label", text: "Formula bar" }, value: "=A1+2" },
      { op: "expectText", locator: { by: "role", role: "status" }, text: "4" }], [basis]);
    const corrected = structuredClone(original);
    corrected.cases[0].steps.splice(1, 0,
      { op: "click", locator: { by: "role", role: "gridcell", name: "A1", exact: true } },
      { op: "fill", locator: { by: "label", text: "Formula bar" }, value: "2" },
      { op: "press", locator: { by: "label", text: "Formula bar" }, key: "Enter" },
      { op: "expectText", locator: { by: "role", role: "gridcell", name: "A1", exact: true }, text: "2" });
    corrected.cases[0].setupStepCount = 5;
    let reviews = 0;
    f.deps.planner.reviewPlan = async (_packet, _plan, _failures, feedback) => {
      if (++reviews === 1) return { status: "sound", rationale: "The declared seed should contain 2" };
      assert.match(feedback?.validationError ?? "", /executed initial-state checkpoint/);
      return correctedReview(corrected, [{ caseId: "case-A", conflict: "The seed value was never established", basis: [basis] }]);
    };
    f.deps.runner.run = async plan => plan.cases[0].setupStepCount ? pass(plan) : {
      packetId: plan.packetId, verdict: "fail", passedCases: [], failures: [{
        caseId: "case-A", stepIndex: 3, category: "assertion", message: "expected 4, got #ERROR" }],
    };
    const result = await auditWith(f, makeState(f), original);
    assert.equal(result.status, "verified");
    assert.equal(reviews, 2);
    assert.equal(f.builder.requests.length, 0);
  });
});

test("A corrected plan is re-run on the real browser before any verified verdict", async () => {
  await withModulePipeline(async f => {
    const catalog = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    catalog.children[0].children[0].description = "Display the main workspace with Sprint goals.";
    await writeFile(f.options.requirementsFile, JSON.stringify(catalog));
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end("<main><ul><li>Sprint goals</li></ul></main>");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") assert.fail("missing port");
    f.deps.runner = new PlaywrightProbeRunner();
    f.deps.appLifecycle.start = async () => ({ baseUrl: `http://127.0.0.1:${address.port}`, stop: async () => {} });
    try {
      const original = groundedPlan([{ op: "goto", path: "/" },
        { op: "expectText", locator: { by: "role", role: "listitem" }, text: "Archived" }],
        ["Display the main workspace with Sprint goals."]);
      const corrected = groundedPlan([{ op: "goto", path: "/" },
        { op: "expectText", locator: { by: "role", role: "listitem" }, text: "Sprint goals" }],
        ["Sprint goals"]);
      const planner = new FakeProbePlanner([original]);
      planner.reviewPlan = async () => correctedReview(corrected,
        [{ caseId: "case-A", conflict: "种子条目在 active 列表", basis: ["Sprint goals"] }]);
      f.deps.planner = planner;
      const result = await auditWith(f, makeState(f), original);
      assert.equal(result.status, "verified");
      assert.equal(probePlanSha256(result.plan ?? original), probePlanSha256(corrected));
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
