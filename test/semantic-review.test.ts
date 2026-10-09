import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePlanReview, preparationReviewJsonSchema, PROBE_REVIEW_JSON_SCHEMA,
  type PreparationReviewTargets } from "../src/judge/semantic-review.js";
import { parseProbePlan, toWireProbePlan, type ProbePlan } from "../src/judge/probe-schema.js";
import type { WorkPacket } from "../src/types.js";

test("A sound review carries no plan and requires a rationale", () => {
  const review = parsePlanReview({ verdict: "sound", rationale: "线索来自 active 列表的原文" }, packet(), original());
  assert.deepEqual(review, { status: "sound", rationale: "线索来自 active 列表的原文" });
  assert.throws(() => parsePlanReview({ verdict: "sound", rationale: "x", plan: {} }, packet(), original()), /must not carry/);
  assert.throws(() => parsePlanReview({ verdict: "sound" }, packet(), original()), /rationale/);
});

test("A corrected review must change the plan, cite conflicts, and ground its basis quotes", () => {
  const review = parsePlanReview({
    verdict: "corrected",
    rationale: "计划误读 active 种子",
    corrections: [{ caseId: "case-A", conflict: "计划去归档区恢复，但需求写明 active", basis: ["Display the main workspace."] }],
    plan: corrected(),
  }, packet(), original());
  assert.equal(review.status, "corrected");
  if (review.status !== "corrected") return;
  assert.equal(review.corrections.length, 1);
  assert.equal(review.plan.cases[0].steps.length, 2);
});

test("A business review returns only corrected cases and reconstructs untouched cases locally", () => {
  const before = original();
  before.cases.push({ ...structuredClone(before.cases[0]), id: "case-B", purpose: "persistence" });
  const correctedCase = (toWire(parseProbePlan(corrected(), packet())) as { cases: Array<Record<string, unknown>> }).cases[0];
  const response = { verdict: "corrected", rationale: "计划误读结果", corrections: [{
    caseId: "case-A", conflict: "结果目标不符合需求", basis: ["Display the main workspace."], case: correctedCase,
  }] };
  const review = parsePlanReview(response, packet(), before,
    { preparationOnlyCaseIds: [], caseCorrectionIds: ["case-A"] });
  if (review.status !== "corrected") assert.fail("missing corrected plan");
  assert.deepEqual(review.plan.cases[0].steps, parseProbePlan(corrected(), packet()).cases[0].steps);
  assert.deepEqual(review.plan.cases[1], before.cases[1]);
  assert.doesNotMatch(JSON.stringify(PROBE_REVIEW_JSON_SCHEMA.properties), /"plan"/);
  assert.match(JSON.stringify(PROBE_REVIEW_JSON_SCHEMA.properties), /"case"/);
  assert.throws(() => parsePlanReview({ ...response, corrections: [{ ...response.corrections[0], caseId: "case-B" }] },
    packet(), before, { preparationOnlyCaseIds: [], caseCorrectionIds: ["case-A"] }), /not a failed case/);
});

test("Corrected reviews reject unchanged plans, phantom cases, weak citations, and uncovered requirements", () => {
  const base = {
    verdict: "corrected",
    rationale: "原因",
    corrections: [{ caseId: "case-A", conflict: "冲突", basis: ["Display the main workspace."] }],
  };
  assert.throws(() => parsePlanReview({ ...base, plan: toWire(original()) }, packet(), original()), /must differ/);
  assert.throws(() => parsePlanReview({ ...base, corrections: [{ ...base.corrections[0], caseId: "ghost" }], plan: corrected() },
    packet(), original()), /reviewed and corrected plans/);
  assert.throws(() => parsePlanReview({ ...base, corrections: [{ ...base.corrections[0], basis: ["invented expectation"] }], plan: corrected() },
    packet(), original()), /verbatim/);
  const uncovered = corrected();
  uncovered.cases[0] = { ...uncovered.cases[0], requirementIds: ["OTHER"] };
  assert.throws(() => parsePlanReview({ ...base, plan: uncovered }, packet(), original()), /outside packet/);
});

test("Plan reconstruction preserves independent cases, their purposes and requirement mapping", () => {
  const base = { verdict: "corrected", rationale: "missing navigation",
    corrections: [{ caseId: "case-A", conflict: "omitted entry", basis: ["Display the main workspace."] }] };
  const before = original();
  before.cases.push({ ...structuredClone(before.cases[0]), id: "case-B", purpose: "persistence" });
  assert.throws(() => parsePlanReview({ ...base, plan: corrected() }, packet(), before), /case set/);
  const after = corrected();
  after.cases.push(structuredClone(before.cases[1]));
  after.cases[1].steps[1] = { op: "expectVisible", locator: { by: "role", role: "main" } };
  assert.throws(() => parsePlanReview({ ...base, plan: after }, packet(), before), /every changed case/);
  after.cases[1] = structuredClone(before.cases[1]);
  after.cases[0].purpose = "negative";
  assert.throws(() => parsePlanReview({ ...base, plan: after }, packet(), before), /purpose and requirementIds/);
});

function preparedPlan(): ProbePlan {
  const before = original();
  before.cases[0].setupStepCount = 2;
  before.cases[0].steps = [
    { op: "goto", path: "/" }, { op: "expectVisible", locator: { by: "role", role: "main" } },
    { op: "fill", locator: { by: "label", text: "Title", exact: true }, value: "original input" },
    { op: "click", locator: { by: "role", role: "button", name: "Save", exact: true } },
    { op: "expectText", locator: { by: "role", role: "status" }, text: "Saved", exact: true },
  ];
  before.cases.push({ ...structuredClone(before.cases[0]), id: "case-B", purpose: "persistence" });
  return before;
}

const preparationTargets: PreparationReviewTargets = { preparationOnlyCaseIds: ["case-A"], caseCorrectionIds: [] };
function prefixReview() {
  return { verdict: "corrected", rationale: "Establish the initial state", corrections: [{
    caseId: "case-A", conflict: "Navigation omitted the workspace", basis: ["Display the main workspace."],
    setupSteps: [
      { op: "goto", path: "/" },
      { op: "click", locator: { by: "role", role: "link", name: "Workspace" } },
      { op: "expectVisible", locator: { by: "role", role: "main" } },
    ],
  }] };
}

test("Prefix recovery reconstructs the plan with the exact tested suffix and untouched independent cases", () => {
  const before = preparedPlan();
  const snapshot = structuredClone(before);
  const response = prefixReview();
  const review = parsePlanReview(response, packet(), before, preparationTargets);
  assert.equal(review.status, "corrected");
  if (review.status !== "corrected") assert.fail("missing corrected plan");
  assert.deepEqual(before, snapshot);
  assert.deepEqual(review.plan.cases.map(item => item.id), ["case-A", "case-B"]);
  assert.equal(review.plan.cases[0].setupStepCount, 3);
  assert.deepEqual(review.plan.cases[0].steps.slice(3), before.cases[0].steps.slice(2));
  assert.deepEqual(review.plan.cases[0].expectationBasis, before.cases[0].expectationBasis);
  assert.deepEqual(review.plan.cases[1], before.cases[1]);
  assert.deepEqual(review.corrections, [{ caseId: "case-A", conflict: response.corrections[0].conflict,
    basis: ["Display the main workspace."] }]);
  assert.ok(JSON.stringify(response).length < JSON.stringify(toWireProbePlan(review.plan)).length);
});

test("Prefix review supports sound and excludes full-case output when all failures are preparation", () => {
  assert.deepEqual(parsePlanReview({ verdict: "sound", rationale: "The original preparation is grounded" },
    packet(), preparedPlan(), preparationTargets), { status: "sound", rationale: "The original preparation is grounded" });
  const schema = JSON.stringify(preparationReviewJsonSchema());
  assert.match(schema, /"setupSteps"/);
  assert.doesNotMatch(schema, /"plan"|"purpose"|"expectationBasis"|"setupStepCount"/);
  const response = prefixReview();
  assert.throws(() => parsePlanReview({ ...response, plan: toWireProbePlan(preparedPlan()) },
    packet(), preparedPlan(), preparationTargets), /unsupported field: plan/);
  assert.throws(() => parsePlanReview({ ...response, corrections: [{ ...response.corrections[0], case: {} }] },
    packet(), preparedPlan(), preparationTargets), /unsupported field: case/);
  assert.throws(() => parsePlanReview({ verdict: "sound", rationale: "x", corrections: response.corrections },
    packet(), preparedPlan(), preparationTargets), /must not carry/);
});

test("Prefix recovery rejects empty, ungrounded, duplicate, unknown and unchanged proposals", () => {
  const response = prefixReview();
  const before = preparedPlan();
  const correction = response.corrections[0];
  const parse = (corrections: unknown[]) => parsePlanReview({ ...response, corrections }, packet(), before, preparationTargets);
  assert.throws(() => parse([]), /must differ/);
  assert.throws(() => parse([{ ...correction, setupSteps: [] }]), /initial-state assertion/);
  assert.throws(() => parse([{ ...correction, basis: ["invented evidence"] }]), /verbatim/);
  assert.throws(() => parse([correction, correction]), /duplicated/);
  assert.throws(() => parse([{ ...correction, caseId: "unknown" }]), /reviewed plan/);
  assert.throws(() => parse([{ ...correction, caseId: "case-B" }]), /not a failed case/);
  assert.throws(() => parse([{ ...correction, setupSteps: before.cases[0].steps.slice(0, 2) }]), /must differ/);
  before.cases[0].setupStepCount = undefined;
  assert.throws(() => parse([correction]), /existing preparation boundary/);
});

test("Reconstructed prefixes still obey initial-state assertions, the combined step limit and the Probe DSL", () => {
  const response = prefixReview();
  const parse = (setupSteps: unknown[]) => parsePlanReview({ ...response,
    corrections: [{ ...response.corrections[0], setupSteps }] }, packet(), preparedPlan(), preparationTargets);
  assert.throws(() => parse([{ op: "goto", path: "/" }]), /end preparation with an initial-state assertion/);
  assert.throws(() => parse([...Array.from({ length: 27 }, () => ({ op: "reload" })),
    { op: "expectVisible", locator: { by: "role", role: "main" } }]), /at most 15 preparation steps/);
  assert.throws(() => parse([{ op: "execute", code: "arbitrary code" }]), /operation is not allowed/);
  assert.throws(() => parse([{ op: "goto", path: "/private" },
    { op: "expectVisible", locator: { by: "role", role: "main" } }]), /undeclared goto path/);
});

test("Mixed reviews correct failed business cases while protecting preparation suffixes and case identity", () => {
  const before = preparedPlan();
  before.cases.push({ ...structuredClone(before.cases[1]), id: "passed-case" });
  const businessCase = { ...before.cases[1], steps: before.cases[1].steps.slice(0, -1),
    assertion: { op: "expectVisible", locator: { by: "role", role: "main" } } };
  const response = prefixReview();
  const businessCorrection = { caseId: "case-B", conflict: "Unexpected result text", basis: ["Display the main workspace."], case: businessCase };
  const targets = { ...preparationTargets, caseCorrectionIds: ["case-B"] };
  const parse = (correction = businessCorrection) => parsePlanReview({ ...response,
    corrections: [response.corrections[0], correction] }, packet(), before, targets);
  const review = parse();
  if (review.status !== "corrected") assert.fail("missing corrected plan");
  assert.deepEqual(review.plan.cases[0].steps.slice(3), before.cases[0].steps.slice(2));
  assert.equal(review.plan.cases[1].steps.at(-1)?.op, "expectVisible");
  assert.deepEqual(review.plan.cases[2], before.cases[2]);
  assert.equal(review.corrections.length, 2);
  assert.throws(() => parse({ ...businessCorrection, caseId: "case-A" }), /duplicated/);
  assert.throws(() => parse({ ...businessCorrection, caseId: "passed-case" }), /not a failed case/);
  assert.throws(() => parse({ ...businessCorrection, case: { ...businessCase, id: "case-A" } }), /must match caseId/);
  assert.throws(() => parse({ ...businessCorrection, case: { ...businessCase, purpose: "negative" } }), /purpose and requirementIds/);
  assert.throws(() => parse({ ...businessCorrection, case: { ...businessCase, assertion: null } } as unknown as typeof businessCorrection), /terminal assertion/);
  assert.match(JSON.stringify(preparationReviewJsonSchema(true)), /"case"/);
});

function packet(): WorkPacket {
  return { id: "packet-a", requirementIds: ["A"], attempt: 1, requirements: [{
    id: "A", name: "Workspace", text: "Display the main workspace.", declarationIndex: 0, folderPath: ["ROOT"],
    ancestors: [], dependencyIds: [], scenarios: ["Open the workspace"], references: [], exactUiStrings: [], seedDeclarations: [],
    product: { kind: "generic_web", rootId: "ROOT", rootName: "Product", description: "", seedData: [] },
  }] };
}
function original(): ProbePlan {
  return parseProbePlan({ packetId: "packet-a", cases: [{ id: "case-A", requirementIds: ["A"], purpose: "happy_path",
    expectationBasis: ["Display the main workspace."], steps: [{ op: "goto", path: "/" },
    { op: "expectVisible", locator: { by: "role", role: "tab", name: "Home" } }] }] }, packet());
}
function corrected(): { packetId: string; cases: Array<{ id: string; requirementIds: string[];
  purpose: string; expectationBasis?: string[]; steps: Array<Record<string, unknown>> }> } {
  return { packetId: "packet-a", cases: [{ id: "case-A", requirementIds: ["A"], purpose: "happy_path",
    expectationBasis: ["Display the main workspace."], steps: [{ op: "goto", path: "/" },
    { op: "expectVisible", locator: { by: "role", role: "main" } }] }] };
}
function toWire(plan: ProbePlan): unknown {
  return { packetId: plan.packetId, cases: plan.cases.map(item => ({ ...item,
    steps: item.steps.slice(0, -1), assertion: item.steps.at(-1) })) };
}
