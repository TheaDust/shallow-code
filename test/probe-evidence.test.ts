import assert from "node:assert/strict";
import { test } from "node:test";
import { auditPacket } from "../src/judge/audit.js";
import { assertCoverageAccountedFor, probeCoverageGaps, scenarioOutcomes, validateOutcomeChecks } from "../src/judge/probe-coverage.js";
import { loadRequirementCatalog } from "../src/catalog.js";
import { auditPackets } from "../src/scheduler.js";
import { PlanCache } from "../src/judge/plan-cache.js";
import { withTempDir } from "./helpers/temp-dir.js";
import { parseProbePlan, toWireProbePlan, type ProbePlan } from "../src/judge/probe-schema.js";
import { parsePlanReview } from "../src/judge/semantic-review.js";
import { rootSearchNavigationPlan } from "../src/judge/navigation-recovery.js";
import { RunStateStore } from "../src/run-state.js";
import { LlmProbePlanner, ProbePlannerError } from "../src/judge/llm-probe-planner.js";
import type { WorkPacket } from "../src/types.js";
import { withModulePipeline } from "./helpers/module-pipeline.js";

function packet(): WorkPacket {
  return { id: "p", attempt: 1, requirementIds: ["r"], requirements: [{ id: "r", name: "Edit", text: "Save title and description.",
    folderPath: ["ROOT", "AREA"], declarationIndex: 0, dependencyIds: [], scenarios: [], references: [], exactUiStrings: [], seedDeclarations: [], ancestors: [],
    product: { rootId: "ROOT", rootName: "Product", kind: "generic_web", description: "", seedData: [] },
    scenarioContracts: [{ id: "edit", name: "Save", steps: [{ keyword: "GIVEN", content: "A record exists." },
      { keyword: "WHEN", content: "Save changes." }, { keyword: "THEN", content: "The title is saved." },
      { keyword: "AND", content: "The description is saved." }] }] }] };
}
function plan(): ProbePlan {
  return { packetId: "p", uncoveredOutcomes: [], cases: [{ id: "edit-case", requirementIds: ["r"], purpose: "happy_path",
    expectationBasis: ["Save title and description."], setupStepCount: 2,
    steps: [{ op: "goto", path: "/" }, { op: "expectVisible", locator: { by: "role", role: "main" } },
      { op: "click", locator: { by: "role", role: "button", name: "Save", exact: true } },
      { op: "expectText", locator: { by: "role", role: "heading" }, text: "Saved title" },
      { op: "expectText", locator: { by: "role", role: "status" }, text: "Saved description" }],
    outcomeChecks: [{ scenarioId: "edit", stepIndex: 2, assertionIndexes: [1] },
      { scenarioId: "edit", stepIndex: 3, assertionIndexes: [2] }] }] };
}

test("Scenario coverage requires every THEN and following AND and points to business assertions", () => {
  const input = packet();
  const complete = parseProbePlan(plan(), input);
  assertCoverageAccountedFor(complete, input.requirements);
  assert.deepEqual(probeCoverageGaps(complete, input.requirements), []);
  const missing = structuredClone(complete);
  missing.cases[0].outcomeChecks!.pop();
  assert.throws(() => assertCoverageAccountedFor(missing, input.requirements), /unaccounted/);
  missing.uncoveredOutcomes = [{ scenarioId: "edit", stepIndex: 3, reason: "DSL cannot express this result" }];
  assertCoverageAccountedFor(missing, input.requirements);
  assert.equal(probeCoverageGaps(missing, input.requirements).length, 1);
  for (const index of [0, 3]) {
    const invalid = plan();
    invalid.cases[0].outcomeChecks![0].assertionIndexes = [index];
    assert.throws(() => parseProbePlan(invalid, input), /result assertions/);
  }
  const phantom = plan();
  phantom.cases[0].outcomeChecks![0].scenarioId = "unrelated";
  assert.throws(() => parseProbePlan(phantom, input), /undeclared scenario outcome/);
});

test("Passing a weak plan with an omitted THEN cannot grant verified; a sampled guard checks only its paths", async () => {
  await withModulePipeline(async f => {
    const incomplete = plan();
    incomplete.cases[0].outcomeChecks!.pop();
    const state = new RunStateStore({ statusByRequirementId: { r: "todo" }, acceptedSha: "baseline", startedAtMs: 0, totalBudgetMs: 60_000 });
    const result = await auditPacket(packet(), incomplete, f.options, f.deps, state, () => 60_000, { refineLocators: false });
    assert.equal(result.status, "inconclusive");
    assert.equal(result.failureKind, "coverage");
    assert.equal(result.coverageGaps?.[0].stepIndex, 3);
    const guard = await auditPacket(packet(), incomplete, f.options, f.deps, state, () => 60_000, { refineLocators: false, checkCoverage: false });
    assert.equal(guard.status, "verified");
  });
});

test("A cached pending plan retries only completeness review before verification", async () => {
  await withModulePipeline(async f => {
    let planCalls = 0;
    let reviewCalls = 0;
    f.deps.planner.plan = async () => {
      planCalls += 1;
      return plan();
    };
    f.deps.planner.reviewPlan = async (_packet, original, failures, _feedback, options) => {
      reviewCalls += 1;
      assert.deepEqual(failures, []);
      assert.equal(options?.coverageReview, true);
      return { status: "sound", rationale: "cached completeness is grounded" };
    };
    const state = new RunStateStore({ statusByRequirementId: { r: "todo" }, acceptedSha: "baseline", startedAtMs: 0, totalBudgetMs: 60_000 });
    const result = await auditPacket(packet(), { ...plan(), coverageReview: "pending" }, f.options, f.deps, state,
      () => 60_000, { refineLocators: true });
    assert.equal(result.status, "verified");
    assert.equal(result.plan?.coverageReview, "verified");
    assert.equal(planCalls, 0);
    assert.equal(reviewCalls, 1);
  });
});

test("A pending completeness review retries the review with validation feedback", async () => {
  await withModulePipeline(async f => {
    let reviewCalls = 0;
    f.deps.planner.reviewPlan = async (_packet, _original, _failures, feedback, options) => {
      reviewCalls += 1;
      assert.equal(options?.coverageReview, true);
      if (reviewCalls === 1) {
        assert.equal(feedback, undefined);
        throw new ProbePlannerError("review", "review contract failed", {
          cause: new Error("corrections must identify an affected case"), content: "invalid review" });
      }
      assert.equal(feedback?.validationError, "corrections must identify an affected case");
      assert.equal(feedback?.contentPreview, "invalid review");
      return { status: "sound", rationale: "the cached plan remains complete" };
    };
    const state = new RunStateStore({ statusByRequirementId: { r: "todo" }, acceptedSha: "baseline", startedAtMs: 0, totalBudgetMs: 60_000 });
    const result = await auditPacket(packet(), { ...plan(), coverageReview: "pending" }, f.options, f.deps, state,
      () => 60_000, { refineLocators: true });
    assert.equal(result.status, "verified");
    assert.equal(result.plan?.coverageReview, "verified");
    assert.equal(reviewCalls, 2);
  });
});

test("Detection-only audit leaves a pending completeness review inconclusive", async () => {
  await withModulePipeline(async f => {
    let reviewCalls = 0;
    f.deps.planner.reviewPlan = async () => {
      reviewCalls += 1;
      throw new Error("detection-only audit must not review");
    };
    const state = new RunStateStore({ statusByRequirementId: { r: "todo" }, acceptedSha: "baseline", startedAtMs: 0, totalBudgetMs: 60_000 });
    const result = await auditPacket(packet(), { ...plan(), coverageReview: "pending" }, f.options, f.deps, state,
      () => 60_000, { refineLocators: false });
    assert.equal(result.status, "inconclusive");
    assert.equal(result.failureKind, "review");
    assert.equal(reviewCalls, 0);
  });
});

test("Invalid outcome indexes report the exact field, preparation offset and terminal assertion index", () => {
  const input = packet();
  for (const indexes of [[0], [3], []]) {
    const invalid = plan();
    invalid.cases[0].outcomeChecks![0].assertionIndexes = indexes;
    for (const validate of [
      () => parseProbePlan(toWireProbePlan(invalid), input),
      () => validateOutcomeChecks(invalid.cases[0], input.requirements),
    ]) {
      assert.throws(validate, error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /outcomeChecks\[0\]\.assertionIndexes/);
        assert.ok(error.message.includes(`[${indexes.join(", ")}]`));
        assert.match(error.message, /setupStepCount=2/);
        assert.match(error.message, /zero-based relative to the business suffix, including the terminal assertion/);
        assert.match(error.message, /Valid assertion indexes: \[1:expectText, 2:expectText\]/);
        return true;
      });
    }
    assert.deepEqual(invalid.cases[0].outcomeChecks![0].assertionIndexes, indexes);
  }
  assert.doesNotThrow(() => parseProbePlan(toWireProbePlan(plan()), input));
});

test("Compound THEN results retain source fragments and preserve quoted alternatives", () => {
  const input = packet();
  input.requirements[0].scenarioContracts![0].steps = [{ keyword: "THEN",
    content: 'The title is `Read and write. Again!`; the description is "A; B" and the status is Open or Closed.' }];
  assert.deepEqual(scenarioOutcomes(input.requirements).map(item => [item.clauseIndex, item.text]), [
    [0, 'The title is `Read and write. Again!`'], [1, 'the description is "A; B"'], [2, 'the status is Open or Closed.'],
  ]);
});

test("Real GitHub compound results cannot be covered by a single whole-THEN mapping", async () => {
  const catalog = await loadRequirementCatalog("data/official-competition/hackathon--github/requirements.yaml");
  const input = auditPackets(catalog).find(item => item.requirementIds.includes("REQ-5-2-2"))!;
  const requirement = input.requirements[0];
  const scenario = requirement.scenarioContracts![0];
  const outcomes = scenarioOutcomes([requirement]).filter(item => item.scenarioId === scenario.id);
  assert.equal(outcomes.length, 2);
  assert.match(outcomes[1].text, /new description/);
  const weak: ProbePlan = { packetId: input.id, cases: [{ id: "edit", requirementIds: input.requirementIds,
    purpose: "happy_path", expectationBasis: [scenario.steps.at(-1)!.content], steps: [
      { op: "goto", path: "/" }, { op: "fill", locator: { by: "label", text: "Issue title", exact: true }, value: "New title" },
      { op: "reload" },
      { op: "expectVisible", locator: { by: "role", role: "heading", name: "New title", exact: true } },
    ], outcomeChecks: [{ scenarioId: scenario.id, stepIndex: 2, assertionIndexes: [3] }] }] };
  assert.throws(() => parseProbePlan(weak, input), /compound result.*clauseIndex/);
  weak.cases[0].outcomeChecks![0].clauseIndex = 0;
  const parsed = parseProbePlan(weak, input);
  const gaps = probeCoverageGaps(parsed, input.requirements);
  assert.ok(gaps.some(item => item.scenarioId === scenario.id && item.clauseIndex === 1));
  assert.throws(() => assertCoverageAccountedFor(parsed, input.requirements), /unaccounted/);
  parsed.uncoveredOutcomes = gaps;
  assert.doesNotThrow(() => assertCoverageAccountedFor(parsed, input.requirements));
  await withModulePipeline(async f => {
    const state = new RunStateStore({ statusByRequirementId: { [requirement.id]: "todo" }, acceptedSha: "baseline", startedAtMs: 0, totalBudgetMs: 60_000 });
    const result = await auditPacket(input, parsed, f.options, f.deps, state, () => 60_000, { refineLocators: false });
    assert.equal(result.status, "inconclusive");
    assert.equal(result.failureKind, "coverage");
  });
  await withTempDir("compound-plan-cache-", async directory => {
    const cache = new PlanCache(directory);
    delete weak.cases[0].outcomeChecks![0].clauseIndex;
    await cache.write(input.id, weak);
    assert.equal(await cache.read(input), undefined);
  });
});

test("Complete compound mappings survive preparation correction and reject a lost clause", () => {
  const input = packet();
  input.requirements[0].scenarioContracts![0].steps = [{ keyword: "GIVEN", content: "A record exists." },
    { keyword: "WHEN", content: "Save changes." }, { keyword: "THEN", content: "The title is saved and the description is saved." }];
  const original = plan();
  original.cases[0].outcomeChecks = [{ scenarioId: "edit", stepIndex: 2, clauseIndex: 0, assertionIndexes: [1] },
    { scenarioId: "edit", stepIndex: 2, clauseIndex: 1, assertionIndexes: [2] }];
  assertCoverageAccountedFor(parseProbePlan(original, input), input.requirements);
  const corrected = parsePlanReview({ verdict: "corrected", rationale: "Prepare the record", corrections: [{
    caseId: "edit-case", conflict: "Initial state", basis: ["A record exists."], setupSteps: [
      { op: "goto", path: "/" }, { op: "reload" }, { op: "expectVisible", locator: { by: "role", role: "main" } },
    ],
  }] }, input, original, { preparationOnlyCaseIds: ["edit-case"], caseCorrectionIds: [] });
  assert.equal(corrected.status, "corrected");
  if (corrected.status !== "corrected") assert.fail("expected correction");
  assertCoverageAccountedFor(corrected.plan, input.requirements);
  const changed = structuredClone(original.cases[0]);
  changed.outcomeChecks!.pop();
  const assertion = changed.steps.pop();
  assert.throws(() => parsePlanReview({ verdict: "corrected", rationale: "Change checks", corrections: [{
    caseId: "edit-case", conflict: "Saved values", basis: ["The title is saved"], case: { ...changed, assertion },
  }] }, input, original), /preserve scenario outcome coverage/);
});

test("A compound plan gets one semantic completeness review with the remaining deadline and separate usage", async t => {
  const input = packet();
  input.requirements[0].scenarioContracts![0].steps = [{ keyword: "GIVEN", content: "A record exists." },
    { keyword: "WHEN", content: "Save changes." }, { keyword: "THEN", content: "The title is saved and the description is saved." }];
  const complete = plan();
  complete.cases[0].outcomeChecks = [{ scenarioId: "edit", stepIndex: 2, clauseIndex: 0, assertionIndexes: [1] },
    { scenarioId: "edit", stepIndex: 2, clauseIndex: 1, assertionIndexes: [2] }];
  const weak = structuredClone(complete);
  weak.cases[0].steps.pop();
  weak.cases[0].outcomeChecks![1].assertionIndexes = [1];
  assertCoverageAccountedFor(parseProbePlan(weak, input), input.requirements);
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  let requests = 0;
  const usage: Array<[string, number]> = [];
  const planner = new LlmProbePlanner({ baseUrl: "https://gateway.invalid/v1", apiKey: "test", model: "model", timeoutMs: 300 }, async (_url, options) => {
    requests++;
    const body = JSON.parse(String(options?.body));
    const payload = JSON.parse(body.messages[1].content);
    let content: unknown = weak;
    if (requests === 1) now = 1210;
    else {
      assert.equal(payload.coverageReview, true);
      assert.equal(payload.requirements[0].scenarioOutcomes.length, 2);
      assert.deepEqual(payload.failures, []);
      content = { verdict: "corrected", rationale: "The description needs its own result assertion", corrections: [{
        caseId: "edit-case", conflict: "A title assertion does not check the saved description", basis: ["the description is saved"],
        case: (toWireProbePlan(complete) as { cases: unknown[] }).cases[0],
      }] };
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }],
      usage: { prompt_tokens: 4 + requests, completion_tokens: 1, total_tokens: 5 + requests } }), { headers: { "Content-Type": "application/json" } });
  });
  const review = t.mock.method(planner, "reviewPlan");
  const checked = await planner.plan(input, undefined, { timeoutMs: 300,
    onUsage: value => { usage.push(["plan", value.total]); }, onReviewUsage: value => { usage.push(["review", value.total]); } });
  assert.equal(requests, 2);
  assert.equal(review.mock.callCount(), 1);
  assert.equal(review.mock.calls[0].arguments[4]?.timeoutMs, 90);
  assert.deepEqual(checked.cases[0].steps, complete.cases[0].steps);
  assert.deepEqual(usage, [["plan", 6], ["review", 7]]);
});

test("Simple plans skip completeness review and partial plans retain omissions when review is invalid", async () => {
  for (const partial of [false, true]) {
    const input = packet();
    const original = plan();
    if (partial) {
      input.requirements[0].scenarioContracts![0].steps = [{ keyword: "THEN", content: "The title is saved and the description is saved." }];
      original.cases[0].outcomeChecks = [{ scenarioId: "edit", stepIndex: 0, clauseIndex: 0, assertionIndexes: [1] }];
      original.uncoveredOutcomes = [{ scenarioId: "edit", stepIndex: 0, clauseIndex: 1, reason: "Description check unavailable" }];
    }
    let requests = 0;
    const planner = new LlmProbePlanner({ baseUrl: "https://gateway.invalid/v1", apiKey: "test", model: "model", timeoutMs: 1000 }, async () => {
      requests++;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(original) } }] }), { headers: { "Content-Type": "application/json" } });
    });
    const checked = await planner.plan(input);
    assert.equal(requests, partial ? 2 : 1);
    assert.deepEqual(checked.uncoveredOutcomes, original.uncoveredOutcomes);
  }
});

test("Invalid complete compound reviews keep the valid plan pending without a full-plan retry", async () => {
  const input = packet();
  input.requirements[0].scenarioContracts![0].steps = [{ keyword: "THEN", content: "The title is saved and the description is saved." }];
  const original = plan();
  original.cases[0].outcomeChecks = [{ scenarioId: "edit", stepIndex: 0, clauseIndex: 0, assertionIndexes: [1] },
    { scenarioId: "edit", stepIndex: 0, clauseIndex: 1, assertionIndexes: [2] }];
  let requests = 0;
  const planner = new LlmProbePlanner({ baseUrl: "https://gateway.invalid/v1", apiKey: "test", model: "model", timeoutMs: 1000 }, async () => {
    const content = ++requests === 1 ? original : { verdict: "corrected", rationale: "Missing checks", corrections: [] };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { headers: { "Content-Type": "application/json" } });
  });
  const checked = await planner.plan(input);
  assert.equal(requests, 2);
  assert.equal(checked.coverageReview, "pending");
  assert.equal(checked.cases.length, original.cases.length);
});

test("An omission review adds a real result assertion before removing the coverage gap", async () => {
  const input = packet();
  const complete = plan();
  const partial = structuredClone(complete);
  partial.cases[0].steps.pop();
  partial.cases[0].outcomeChecks!.pop();
  partial.uncoveredOutcomes = [{ scenarioId: "edit", stepIndex: 3, reason: "Description check unavailable" }];
  let requests = 0;
  const planner = new LlmProbePlanner({ baseUrl: "https://gateway.invalid/v1", apiKey: "test", model: "model", timeoutMs: 1000 }, async (_url, options) => {
    const payload = JSON.parse(JSON.parse(String(options?.body)).messages[1].content);
    let content: unknown = partial;
    if (++requests === 2) {
      assert.equal(payload.coverageReview, true);
      assert.equal(payload.originalPlan.uncoveredOutcomes.length, 1);
      content = { verdict: "corrected", rationale: "Description is observable", corrections: [{
        caseId: "edit-case", conflict: "The saved description needs its own assertion", basis: ["The description is saved."],
        case: (toWireProbePlan(complete) as { cases: unknown[] }).cases[0],
      }] };
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { headers: { "Content-Type": "application/json" } });
  });
  const checked = await planner.plan(input);
  assert.equal(requests, 2);
  assert.deepEqual(checked.cases[0].steps, complete.cases[0].steps);
  assert.deepEqual(probeCoverageGaps(checked, input.requirements), []);
});

test("An omission cannot be resolved by mapping the title assertion to the description", () => {
  const input = packet();
  const partial = plan();
  partial.cases[0].steps.pop();
  partial.cases[0].outcomeChecks!.pop();
  partial.uncoveredOutcomes = [{ scenarioId: "edit", stepIndex: 3, reason: "Description check unavailable" }];
  const changed = structuredClone(partial);
  changed.cases[0].outcomeChecks!.push({ scenarioId: "edit", stepIndex: 3, assertionIndexes: [1] });
  assert.throws(() => parsePlanReview({ verdict: "corrected", rationale: "Reuse the title", corrections: [{
    caseId: "edit-case", conflict: "Description was omitted", basis: ["The description is saved."],
    case: (toWireProbePlan(changed) as { cases: unknown[] }).cases[0],
  }] }, input, partial), /distinct result assertion/);
  const unused = plan();
  unused.cases[0].outcomeChecks!.pop();
  unused.uncoveredOutcomes = partial.uncoveredOutcomes;
  const review = parsePlanReview({ verdict: "corrected", rationale: "The description assertion already exists", corrections: [{
    caseId: "edit-case", conflict: "Description assertion was not mapped", basis: ["The description is saved."],
    case: (toWireProbePlan(plan()) as { cases: unknown[] }).cases[0],
  }] }, input, unused);
  assert.equal(review.status, "corrected");
  if (review.status === "corrected") assert.deepEqual(probeCoverageGaps(review.plan, input.requirements), []);
});

test("A sound omission review retains the gap, and caller cancellation remains observable", async () => {
  for (const cancelled of [false, true]) {
    const input = packet();
    const partial = plan();
    partial.cases[0].outcomeChecks!.pop();
    partial.uncoveredOutcomes = [{ scenarioId: "edit", stepIndex: 3, reason: "Unsupported result" }];
    const controller = new AbortController();
    let requests = 0;
    const planner = new LlmProbePlanner({ baseUrl: "https://gateway.invalid/v1", apiKey: "test", model: "model", timeoutMs: 1000 }, async () => {
      const content = ++requests === 1 ? partial : { verdict: "sound", rationale: "The explicit limitation remains" };
      if (requests === 2 && cancelled) { controller.abort(); throw new Error("caller cancelled"); }
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { headers: { "Content-Type": "application/json" } });
    });
    const checked = planner.plan(input, undefined, { timeoutMs: 1000, signal: controller.signal });
    if (cancelled) await assert.rejects(checked);
    else assert.equal(probeCoverageGaps(await checked, input.requirements).length, 1);
    assert.equal(requests, 2);
  }
});

test("A repeated result assertion after a new operation can resolve an omitted sequential outcome", () => {
  const input = packet();
  input.requirements[0].text = 'Click the button named "Save" twice. Each save displays "Saved" in the status named "Result".';
  input.requirements[0].scenarioContracts![0].steps[2].content = 'The first save displays "Saved".';
  input.requirements[0].scenarioContracts![0].steps[3].content = 'The second save displays "Saved".';
  const partial = plan();
  partial.cases[0].expectationBasis = [input.requirements[0].text];
  partial.cases[0].steps = [...partial.cases[0].steps.slice(0, 3), {
    op: "expectText", locator: { by: "role", role: "status", name: "Result", exact: true }, text: "Saved", exact: true,
  }];
  partial.cases[0].outcomeChecks!.pop();
  partial.uncoveredOutcomes = [{ scenarioId: "edit", stepIndex: 3, reason: "Second operation was not checked" }];
  const changed = structuredClone(partial);
  changed.cases[0].steps.push(structuredClone(changed.cases[0].steps[2]), structuredClone(changed.cases[0].steps[3]));
  changed.cases[0].outcomeChecks!.push({ scenarioId: "edit", stepIndex: 3, assertionIndexes: [3] });
  const review = parsePlanReview({ verdict: "corrected", rationale: "Verify the second save independently", corrections: [{
    caseId: "edit-case", conflict: "The second save was omitted", basis: [input.requirements[0].text],
    case: (toWireProbePlan(changed) as { cases: unknown[] }).cases[0],
  }] }, input, partial);
  assert.equal(review.status, "corrected");
});

test("Omission review outages preserve a valid partial plan and expired windows start no extra request", async t => {
  for (const expired of [false, true]) {
    const input = packet();
    const partial = plan();
    partial.cases[0].outcomeChecks!.pop();
    partial.uncoveredOutcomes = [{ scenarioId: "edit", stepIndex: 3, reason: "Unsupported result" }];
    let now = 1000;
    const clock = t.mock.method(Date, "now", () => now);
    let requests = 0;
    const planner = new LlmProbePlanner({ baseUrl: "https://gateway.invalid/v1", apiKey: "test", model: "model", timeoutMs: 1000 }, async () => {
      if (++requests > 1) return new Response("gateway unavailable", { status: 503 });
      if (expired) now += 1001;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(partial) } }] }), { headers: { "Content-Type": "application/json" } });
    });
    const checked = await planner.plan(input);
    assert.equal(requests, expired ? 1 : 2);
    assert.deepEqual(checked, { ...partial, coverageReview: "pending" });
    assert.equal(probeCoverageGaps(checked, input.requirements).length, 1);
    clock.mock.restore();
  }
});

test("An explicitly unbounded planning window remains unbounded for omission review", async t => {
  const input = packet();
  const partial = plan();
  partial.cases[0].outcomeChecks!.pop();
  partial.uncoveredOutcomes = [{ scenarioId: "edit", stepIndex: 3, reason: "Unsupported result" }];
  let requests = 0;
  const planner = new LlmProbePlanner({ baseUrl: "https://gateway.invalid/v1", apiKey: "test", model: "model", timeoutMs: 1000 }, async () => {
    const content = ++requests === 1 ? partial : { verdict: "sound", rationale: "The explicit limitation remains" };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { headers: { "Content-Type": "application/json" } });
  });
  const review = t.mock.method(planner, "reviewPlan");
  await planner.plan(input, undefined, { timeoutMs: 0 });
  assert.equal(requests, 2);
  assert.equal(review.mock.calls[0].arguments[4]?.timeoutMs, 0);
});

test("LLM planning rejects an unexplained coverage omission and accepts an explicitly partial plan", async () => {
  const incomplete = plan();
  incomplete.cases[0].outcomeChecks!.pop();
  const planner = new LlmProbePlanner({ baseUrl: "https://gateway.invalid/v1", apiKey: "test", model: "model", timeoutMs: 1000 },
    async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(incomplete) } }] }), { headers: { "Content-Type": "application/json" } }));
  await assert.rejects(planner.plan(packet()), (error: unknown) => error instanceof ProbePlannerError && error.category === "schema" &&
    error.diagnostics.validationError?.includes("unaccounted") === true);
  incomplete.uncoveredOutcomes = [{ scenarioId: "edit", stepIndex: 3, reason: "Unsupported result" }];
  const partial = await planner.plan(packet());
  assert.equal(probeCoverageGaps(partial, packet().requirements).length, 1);
  incomplete.navigationRecovered = true;
  await assert.rejects(planner.plan(packet()), (error: unknown) => error instanceof ProbePlannerError &&
    error.diagnostics.validationError?.includes("controller navigation recovery evidence") === true);
});

test("Case capacity follows independent source scenarios while remaining bounded", () => {
  const input = packet();
  const expanded = plan();
  expanded.cases = Array.from({ length: 7 }, (_, index) => ({ ...structuredClone(expanded.cases[0]), id: `case-${index}` }));
  assert.throws(() => parseProbePlan(expanded, input), /at most 6 cases/);
  const original = input.requirements[0].scenarioContracts![0];
  input.requirements[0].scenarioContracts = Array.from({ length: 7 }, (_, index) => ({ ...original, id: `scenario-${index}` }));
  expanded.cases.forEach((item, index) => item.outcomeChecks!.forEach(check => { check.scenarioId = `scenario-${index}`; }));
  assert.equal(parseProbePlan(expanded, input).cases.length, 7);
  assertCoverageAccountedFor(expanded, input.requirements);
});

test("Preparation corrections keep outcome positions relative to the frozen business suffix", () => {
  const original = plan();
  const reviewed = parsePlanReview({ verdict: "corrected", rationale: "Establish the declared record",
    corrections: [{ caseId: "edit-case", conflict: "The record was not prepared", basis: ["A record exists."], setupSteps: [
      { op: "goto", path: "/" }, { op: "reload" }, { op: "expectVisible", locator: { by: "role", role: "main" } },
    ] }] }, packet(), original, { preparationOnlyCaseIds: ["edit-case"], caseCorrectionIds: [] });
  assert.equal(reviewed.status, "corrected");
  if (reviewed.status !== "corrected") return;
  assert.deepEqual(reviewed.plan.cases[0].outcomeChecks, original.cases[0].outcomeChecks);
  assert.equal(reviewed.plan.cases[0].setupStepCount, 3);
  assertCoverageAccountedFor(reviewed.plan, packet().requirements);
});

test("A semantic rewrite cannot remove a previously covered scenario outcome", () => {
  const original = plan();
  const changed = structuredClone(original.cases[0]);
  changed.outcomeChecks!.pop();
  const assertion = changed.steps.pop();
  assert.throws(() => parsePlanReview({ verdict: "corrected", rationale: "Correct the result",
    corrections: [{ caseId: "edit-case", conflict: "Expected title", basis: ["The title is saved."], case: { ...changed, assertion } }] },
  packet(), original), /preserve scenario outcome coverage/);
});

test("Explicit owner/name heading templates reject shortened, slugged and weak alternatives", () => {
  const input = packet();
  input.requirements[0].scenarioContracts = [];
  input.requirements[0].text = 'Open a heading displaying “organization name/repository name”.';
  input.requirements[0].seedDeclarations = ['Seed values: organization `Acme Demo`, repository `acme-docs`.'];
  const make = (text: string, exact = true): ProbePlan => ({ packetId: "p", cases: [{ id: "title", requirementIds: ["r"], purpose: "happy_path",
    expectationBasis: [input.requirements[0].text], steps: [{ op: "goto", path: "/" },
      { op: "expectText", locator: { by: "role", role: "heading" }, text, exact }] }] });
  assert.doesNotThrow(() => parseProbePlan(make("Acme Demo/acme-docs"), input));
  for (const title of ["acme-docs", "acme-demo/acme-docs", "Acme Demo/other"]) {
    assert.throws(() => parseProbePlan(make(title), input), /complete.*heading/);
  }
  assert.throws(() => parseProbePlan(make("Acme Demo/acme-docs", false), input), /exact matching/);
  const alternatives = make("Acme Demo/acme-docs");
  const last = alternatives.cases[0].steps[1];
  if (last.op === "expectText") last.anyOf = ["Acme Demo/acme-docs", "acme-docs"];
  assert.throws(() => parseProbePlan(alternatives, input), /complete.*heading/);
  const negative = make("Permission denied");
  negative.cases[0].purpose = "permission";
  assert.doesNotThrow(() => parseProbePlan(negative, input));
});

test("Preparation has its own bounded allowance while tested business stays within 30 steps", () => {
  const extended = plan();
  extended.cases[0].steps.splice(1, 0, ...Array.from({ length: 10 }, () => ({ op: "reload" as const })));
  extended.cases[0].setupStepCount = 12;
  extended.cases[0].steps.splice(13, 0, ...Array.from({ length: 26 }, () => ({ op: "reload" as const })));
  extended.cases[0].outcomeChecks![0].assertionIndexes = [27];
  extended.cases[0].outcomeChecks![1].assertionIndexes = [28];
  assert.equal(parseProbePlan(extended, packet()).cases[0].steps.length, 41);
  const tooMuchBusiness = structuredClone(extended);
  tooMuchBusiness.cases[0].steps.splice(13, 0, { op: "reload" }, { op: "reload" });
  assert.throws(() => parseProbePlan(tooMuchBusiness, packet()), /at most 30 steps after preparation/);
});

test("Search recovery preserves outcome mappings in setup and leaves a tested entry assertion intact", () => {
  const input = packet();
  input.requirements[0].text = 'Open workspace `Shared` from search results.';
  input.requirements[0].seedDeclarations = ['Seed data: workspace `Shared`.'];
  input.requirements[0].exactUiStrings = ["Shared"];
  const original = plan();
  original.cases[0].steps[1] = { op: "expectVisible", locator: { by: "role", role: "link", name: "Shared", exact: true } };
  original.cases[0].expectationBasis = [input.requirements[0].text];
  const failure = { caseId: "edit-case", stepIndex: 1, category: "precondition" as const, message: "missing link",
    locatorSnapshot: '- searchbox "Search"' };
  const recovered = rootSearchNavigationPlan(input, original, { packetId: "p", verdict: "inconclusive", passedCases: [], failures: [failure] });
  assert.equal(recovered?.navigationRecovered, true);
  assert.equal(recovered?.cases[0].setupStepCount, 4);
  assert.deepEqual(recovered?.cases[0].outcomeChecks, original.cases[0].outcomeChecks);
  const businessEntry = structuredClone(original);
  businessEntry.cases[0].steps[3] = businessEntry.cases[0].steps[1];
  assert.equal(rootSearchNavigationPlan(input, businessEntry, { packetId: "p", verdict: "inconclusive", passedCases: [],
    failures: [{ ...failure, stepIndex: 3, category: "locator" }] }), undefined);
});

test("New GitHub provisioned records authorize the declared global-search preparation path", async () => {
  const catalog = await loadRequirementCatalog("data/official-competition/hackathon--github/requirements.yaml");
  const input = auditPackets(catalog).find(item => item.requirementIds.includes("REQ-3-3"))!;
  const original: ProbePlan = { packetId: input.id, cases: [{ id: "overview", requirementIds: input.requirementIds,
    purpose: "happy_path", expectationBasis: [input.requirements[0].text], setupStepCount: 2, steps: [
      { op: "goto", path: "/" }, { op: "expectVisible", locator: { by: "role", role: "link", name: "acme-docs", exact: true } },
      { op: "click", locator: { by: "role", role: "link", name: "acme-docs", exact: true } },
      { op: "expectVisible", locator: { by: "role", role: "heading", name: "acme-docs" } },
    ],
  }] };
  const report = { packetId: input.id, verdict: "inconclusive" as const, passedCases: [], failures: [{
    caseId: "overview", stepIndex: 1, category: "precondition" as const, message: "missing homepage entry",
    locatorSnapshot: '- searchbox "Search"',
  }] };
  const recovered = rootSearchNavigationPlan(input, original, report);
  assert.ok(recovered);
  assert.equal(recovered.cases[0].steps[1].op, "fill");
  assert.equal(recovered.cases[0].steps[2].op, "press");
  assert.equal(recovered.cases[0].setupStepCount, 4);
  const absentDeclaration = { ...input, requirements: input.requirements.map(item => ({ ...item, seedDeclarations: [] })) };
  assert.equal(rootSearchNavigationPlan(absentDeclaration, original, report), undefined);
});
