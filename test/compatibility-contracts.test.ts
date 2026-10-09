import assert from "node:assert/strict";
import { test } from "node:test";

import { assertCompatibilityPlan, compatibilityApplicability, resultCompatibilityPlan } from "../src/judge/compatibility-contracts.js";
import { globalControlCrossRoutePlan, overlayLifecyclePlan } from "../src/judge/compatibility-probes.js";
import type { ProbePlan } from "../src/judge/probe-schema.js";
import type { WorkPacket } from "../src/types.js";
import { loadRequirementCatalog } from "../src/catalog.js";
import { auditPackets } from "../src/scheduler.js";

function packet(text: string): WorkPacket {
  return { id: "anonymous", attempt: 1, requirementIds: ["A"], requirements: [{
    id: "A", name: "Anonymous", text, declarationIndex: 0, folderPath: ["ROOT", "AREA"],
    dependencyIds: [], scenarios: [], references: [], exactUiStrings: [], seedDeclarations: [], ancestors: [],
    product: { rootId: "ROOT", rootName: "Anonymous product", kind: "generic_web", description: "", seedData: [], evolution: true },
  }] };
}

const nestedPlan: ProbePlan = { packetId: "anonymous", cases: [{ id: "nested", requirementIds: ["A"],
  purpose: "happy_path", expectationBasis: ["fixture"], setupStepCount: 3, steps: [
    { op: "goto", path: "/" }, { op: "click", locator: { by: "role", role: "link", name: "Record", exact: true } },
    { op: "expectVisible", locator: { by: "role", role: "heading", name: "Record", exact: true } },
    { op: "expectVisible", locator: { by: "role", role: "main" } },
  ] }] };

test("compatibility applicability follows requirement semantics rather than product names", () => {
  assert.equal(compatibilityApplicability(packet("The selected value remains in the page address after reload.")).url, true);
  assert.equal(compatibilityApplicability(packet("The selected value remains after reload.")).url, false);
  assert.equal(compatibilityApplicability(packet("Revoking the browser session returns to the sign-in page.")).authPublicEntry, true);
  assert.equal(compatibilityApplicability(packet("The session list is visible.")).authPublicEntry, false);
  assert.equal(compatibilityApplicability(packet("A dialog form creates a unique named view and reports a duplicate.")).uniquePublishConflict, false,
    "local overlay configuration is not treated as an independent entity page");
});

test("revoked sessions preserve the requirement-declared public re-entry link", () => {
  const input = packet('Revoking the browser session redirects to the sign-in page and displays the public entry.');
  input.requirements[0].scenarioContracts = [{ id: "revoked", name: "Revoked", steps: [
    { keyword: "WHEN", content: "The user revokes the browser session." },
    { keyword: "THEN", content: "The revoked browser is redirected to the sign-in page." },
  ] }];
  input.prerequisites = [{ ...structuredClone(input.requirements[0]), id: "P", name: "Public entry",
    text: 'The unauthenticated page exposes a link named "Enter account".' }];
  const base: ProbePlan = { packetId: input.id, cases: [{ id: "revoked", requirementIds: ["A"],
    purpose: "happy_path", expectationBasis: [input.requirements[0].text],
    outcomeChecks: [{ scenarioId: "revoked", stepIndex: 1, assertionIndexes: [0] }],
    steps: [{ op: "click", locator: { by: "role", role: "button", name: "Revoke session", exact: true } },
      { op: "expectVisible", locator: { by: "role", role: "main" } }],
  }] };
  assert.throws(() => assertCompatibilityPlan(base, input), /unauthenticated entry link/);
  base.cases[0].steps.push({ op: "expectVisible", locator: { by: "role", role: "link", name: "Enter account",
    exact: true, scope: { by: "role", role: "main" } } });
  assert.doesNotThrow(() => assertCompatibilityPlan(base, input));
});

test("independent detail identity and uniqueness conflict checks use grounded submitted values", () => {
  const input = packet("The create form publishes an independent record with a unique tag, opens its detail page, and duplicate tags report a conflict without creating another record.");
  input.requirements[0].scenarioContracts = [{ id: "detail", name: "Detail", steps: [
    { keyword: "WHEN", content: "The user opens the exact `stable-1` record." },
    { keyword: "THEN", content: "The record detail displays `stable-1`." },
  ] }, { id: "conflict", name: "Conflict", steps: [
    { keyword: "WHEN", content: "The user enters the existing tag `stable-1` and publishes the form." },
    { keyword: "THEN", content: "The form displays `Tag already exists` and no duplicate record is created." },
  ] }];
  const plan: ProbePlan = { packetId: input.id, cases: [{ id: "detail", requirementIds: ["A"],
    purpose: "happy_path", expectationBasis: [input.requirements[0].text],
    outcomeChecks: [{ scenarioId: "detail", stepIndex: 1, assertionIndexes: [0] }],
    steps: [{ op: "expectVisible", locator: { by: "role", role: "heading", name: "stable-1", exact: true } }],
  }, { id: "conflict", requirementIds: ["A"], purpose: "negative", expectationBasis: [input.requirements[0].text],
    outcomeChecks: [{ scenarioId: "conflict", stepIndex: 1, assertionIndexes: [1] }], steps: [
      { op: "fill", locator: { by: "label", text: "Tag", exact: true }, value: "stable-1" },
      { op: "expectText", locator: { by: "role", role: "alert" }, text: "Tag already exists", exact: true },
      { op: "expectValue", locator: { by: "label", text: "Tag", exact: true }, value: "stable-1" },
      { op: "expectCount", locator: { by: "text", text: "stable-1", exact: true }, count: 1 },
    ] }] };
  assert.doesNotThrow(() => assertCompatibilityPlan(plan, input));
  const weakened = structuredClone(plan);
  weakened.cases[1].steps.splice(2, 1);
  assert.throws(() => assertCompatibilityPlan(weakened, input), /remain in the form/);
  const elsewhere = structuredClone(plan);
  elsewhere.cases[1].steps.splice(3, 0, { op: "goto", path: "/" });
  assert.throws(() => assertCompatibilityPlan(elsewhere, input), /conflict context/);
  const beforeError = structuredClone(plan);
  [beforeError.cases[1].steps[1], beforeError.cases[1].steps[2]] = [beforeError.cases[1].steps[2], beforeError.cases[1].steps[1]];
  assert.throws(() => assertCompatibilityPlan(beforeError, input), /remain in the form/);
});

test("uniqueness compatibility never requires a sensitive submitted value to be echoed", () => {
  const input = packet("The create form stores an independent record with a unique email, opens a detail page, and reports duplicate conflicts.");
  input.requirements[0].scenarioContracts = [{ id: "sensitive", name: "Sensitive", steps: [
    { keyword: "WHEN", content: "The user enters the existing identifier `person@example.test`." },
    { keyword: "THEN", content: "The form displays `Already exists` and no duplicate record is created." },
  ] }];
  assert.doesNotThrow(() => assertCompatibilityPlan({ packetId: input.id, cases: [] }, input));
});

test("closed-overlay compatibility stays separate from business verification", () => {
  const input = packet('Opening the editor displays a dialog named "Editor".');
  const dialogPlan: ProbePlan = { packetId: input.id, cases: [{ id: "dialog", requirementIds: ["A"],
    purpose: "happy_path", expectationBasis: [input.requirements[0].text], steps: [
      { op: "goto", path: "/" },
      { op: "click", locator: { by: "role", role: "button", name: "Open editor", exact: true } },
      { op: "expectVisible", locator: { by: "role", role: "dialog", name: "Editor", exact: true } },
      { op: "click", locator: { by: "role", role: "button", name: "Cancel", exact: true } },
      { op: "expectHidden", locator: { by: "role", role: "dialog", name: "Editor", exact: true } },
    ] }] };
  const compatibility = overlayLifecyclePlan(input, dialogPlan);
  assert.ok(compatibility);
  assert.equal(compatibility.cases[0].steps.at(-3)?.op, "expectClosedOverlaysEmpty");
  assert.equal(compatibility.cases[0].steps.at(-2)?.op, "click");
  assert.equal(compatibility.cases[0].steps.at(-1)?.op, "expectVisible");
  assert.equal(compatibility.cases[0].outcomeChecks, undefined);
  assert.equal(overlayLifecyclePlan(input, nestedPlan), undefined,
    "an unrelated hidden overlay is not checked without a grounded close lifecycle");
});

test("global controls replay a grounded home action after an anonymous nested route", () => {
  const searchPacket = packet('The top global search control has searchbox role and accessible name "Lookup".');
  const search: ProbePlan = { packetId: searchPacket.id, cases: [{ id: "home-search", requirementIds: ["A"],
    purpose: "happy_path", expectationBasis: [searchPacket.requirements[0].text], steps: [
      { op: "goto", path: "/" },
      { op: "fill", locator: { by: "role", role: "searchbox", name: "Lookup", exact: true,
        scope: { by: "role", role: "banner" } }, value: "Record" },
      { op: "press", locator: { by: "role", role: "searchbox", name: "Lookup", exact: true,
        scope: { by: "role", role: "banner" } }, key: "Enter" },
      { op: "expectVisible", locator: { by: "role", role: "link", name: "Record", exact: true } },
    ] }] };
  const crossRoute = globalControlCrossRoutePlan(packet("A record detail is readable."), nestedPlan,
    [{ packet: searchPacket, plan: search }]);
  assert.ok(crossRoute);
  assert.equal(crossRoute.cases[0].setupStepCount, 5);
  assert.equal(crossRoute.cases[0].steps[4].op, "expectAwayFromHome");
  assert.equal(crossRoute.cases[0].steps[5].op, "fill");
});

test("detail conventions execute separately at their original scenario checkpoint", () => {
  const input = packet("A unique tag identifies an independent record detail page.");
  input.requirements[0].scenarioContracts = [{ id: "detail", name: "Open", steps: [
    { keyword: "WHEN", content: "The visitor opens the exact `stable-1` record." },
    { keyword: "THEN", content: "The record detail displays `stable-1`." },
  ] }];
  const plan: ProbePlan = { packetId: input.id, coverageReview: "pending", cases: [{
    id: "detail", requirementIds: ["A"], purpose: "happy_path", expectationBasis: [input.requirements[0].text],
    steps: [{ op: "goto", path: "/" }, { op: "expectVisible", locator: { by: "text", text: "stable-1", exact: true } },
      { op: "click", locator: { by: "role", role: "link", name: "Another record", exact: true } },
      { op: "expectVisible", locator: { by: "role", role: "main" } }],
    outcomeChecks: [{ scenarioId: "detail", stepIndex: 1, assertionIndexes: [1] }],
  }] };
  const original = structuredClone(plan);
  const derived = resultCompatibilityPlan(input, plan)!;
  assert.equal(derived.cases[0].steps.length, 3, "later navigation is not replayed before the detail check");
  assert.deepEqual(derived.cases[0].steps.at(-1), { op: "expectVisible", locator: { by: "role", role: "heading", name: "stable-1", exact: true } });
  assert.equal(derived.coverageReview, undefined);
  assert.equal(derived.cases[0].outcomeChecks, undefined);
  assert.deepEqual(plan, original);
});

test("duplicate identifier diagnostics stay in the failed form before any later navigation", () => {
  const input = packet("The form publishes a unique tag for an independent record detail page and rejects duplicate tags.");
  input.requirements[0].scenarioContracts = [{ id: "conflict", name: "Duplicate", steps: [
    { keyword: "WHEN", content: "The user enters the existing tag `stable-1` and publishes the form." },
    { keyword: "THEN", content: "The form displays `Tag already exists` and no duplicate record is created." },
  ] }];
  const plan: ProbePlan = { packetId: input.id, cases: [{ id: "conflict", requirementIds: ["A"], purpose: "negative",
    expectationBasis: [input.requirements[0].text], steps: [
      { op: "goto", path: "/" }, { op: "fill", locator: { by: "label", text: "Tag", exact: true }, value: "stable-1" },
      { op: "expectText", locator: { by: "role", role: "alert" }, text: "Tag already exists" },
      { op: "click", locator: { by: "role", role: "link", name: "Records", exact: true } },
      { op: "expectVisible", locator: { by: "role", role: "main" } },
    ], outcomeChecks: [{ scenarioId: "conflict", stepIndex: 1, clauseIndex: 0, assertionIndexes: [2] }] }] };
  const derived = resultCompatibilityPlan(input, plan)!;
  assert.equal(derived.cases[0].steps.length, 5);
  assert.equal(derived.cases[0].steps[3].op, "expectValue");
  assert.equal(derived.cases[0].steps[4].op, "expectFormContext");
  assert.ok(!derived.cases[0].steps.some(step => step.op === "click"));
  input.requirements[0].scenarioContracts[0].steps[0].content = "The user enters the existing tag `person@example.test`.";
  const sensitiveField = plan.cases[0].steps[1];
  if (sensitiveField.op === "fill") sensitiveField.value = "person@example.test";
  assert.equal(resultCompatibilityPlan(input, plan), undefined, "sensitive identities are not echoed");
  input.requirements[0].scenarioContracts[0].steps[0].content = "The user enters the existing identifier `opaque-id`.";
  if (sensitiveField.op === "fill") {
    sensitiveField.value = "opaque-id";
    sensitiveField.locator = { by: "label", text: "API token" };
  }
  assert.equal(resultCompatibilityPlan(input, plan), undefined, "field semantics also exclude opaque secrets");
});

test("count diagnostics are bounded expressions and do not replace arithmetic outcome evidence", () => {
  const input = packet("The record detail displays the item type and count.");
  input.requirements[0].scenarioContracts = [{ id: "count", name: "Count", steps: [
    { keyword: "WHEN", content: "The visitor opens the record." },
    { keyword: "THEN", content: "The existing item count is visible." },
  ] }];
  const plan: ProbePlan = { packetId: input.id, cases: [{ id: "count", requirementIds: ["A"], purpose: "happy_path",
    expectationBasis: [input.requirements[0].text], steps: [{ op: "goto", path: "/" },
      { op: "expectVisible", locator: { by: "role", role: "main" } }],
    outcomeChecks: [{ scenarioId: "count", stepIndex: 1, assertionIndexes: [1] }] }] };
  assert.deepEqual(resultCompatibilityPlan(input, plan)!.cases[0].steps.at(-1), { op: "expectAccessibleCount", noun: "item", scope: { by: "role", role: "main" }, minimum: 0 });
  delete input.requirements[0].product.evolution;
  assert.equal(resultCompatibilityPlan(input, plan), undefined);
});

test("the current session corpus checks persistence after revocation, not after an earlier refresh", async () => {
  const catalog = await loadRequirementCatalog("data/final/hackathon-evolution--github/requirements.yaml", { inheritedApplication: true });
  const input = auditPackets(catalog).find(packet => packet.requirementIds.includes("REQ-1-4"))!;
  const scenario = input.requirements[0].scenarioContracts![1];
  const source: ProbePlan = { packetId: input.id, cases: [{ id: "owner", requirementIds: input.requirementIds,
    purpose: "happy_path", expectationBasis: [scenario.steps[2].content], steps: [
      { op: "goto", path: "/" }, { op: "reload" },
      { op: "click", locator: { by: "role", role: "button", name: "Revoke session", exact: true } },
      { op: "expectVisible", locator: { by: "text", text: "Session revoked", exact: true } },
    ], outcomeChecks: [{ scenarioId: scenario.id, stepIndex: 2, clauseIndex: 0, assertionIndexes: [3] }] }] };
  const derived = resultCompatibilityPlan(input, source)!;
  assert.ok(derived.cases[0].id.startsWith("compat-persistence-"));
  assert.equal(derived.cases[0].steps.at(-2)?.op, "reload", "the refresh must follow the actual revoke completion");
  assert.equal(derived.cases[0].steps.at(-1)?.op, "expectVisible");
});

test("public re-entry belongs to the known revoked actor, and ambiguous identities are not guessed", async () => {
  const catalog = await loadRequirementCatalog("data/final/hackathon-evolution--github/requirements.yaml", { inheritedApplication: true });
  const input = auditPackets(catalog).find(packet => packet.requirementIds.includes("REQ-1-4"))!;
  const scenario = input.requirements[0].scenarioContracts![2];
  const signIn = { by: "role" as const, role: "button", name: "Sign in", exact: true };
  const source: ProbePlan = { packetId: input.id, cases: [{ id: "revoked", requirementIds: input.requirementIds,
    purpose: "happy_path", expectationBasis: [scenario.steps[2].content], steps: [
      { op: "goto", path: "/" }, { op: "fill", locator: { by: "label", text: "Username or email" }, value: "owner" },
      { op: "click", locator: signIn }, { op: "newContext", actor: "peer" },
      { op: "fill", locator: { by: "label", text: "Username or email" }, value: "owner" }, { op: "click", locator: signIn },
      { op: "switchContext", actor: "default" }, { op: "click", locator: { by: "role", role: "button", name: "Revoke session" } },
      { op: "reload" }, { op: "switchContext", actor: "peer" }, { op: "reload" },
      { op: "expectVisible", locator: { by: "role", role: "main" } }, { op: "switchContext", actor: "default" },
      { op: "expectVisible", locator: { by: "role", role: "main" } },
    ], outcomeChecks: [{ scenarioId: scenario.id, stepIndex: 2, clauseIndex: 0, assertionIndexes: [11] }] }] };
  const derived = resultCompatibilityPlan(input, source)!;
  assert.equal(derived.cases[0].steps.at(-2)?.op, "reload");
  assert.equal(derived.cases[0].steps.at(-3)?.op, "switchContext");
  const actor = derived.cases[0].steps.at(-3)!;
  assert.ok(actor.op === "switchContext" && actor.actor === "peer");
  const otherIdentity = source.cases[0].steps[4];
  if (otherIdentity.op === "fill") otherIdentity.value = "someone-else";
  assert.equal(resultCompatibilityPlan(input, source), undefined);
});

test("shared closed surfaces are sampled at readiness without requiring a dialog to have been opened", () => {
  const input = packet('The shared account menu is available after sign-in.');
  const ready = overlayLifecyclePlan(input, nestedPlan);
  assert.ok(ready);
  assert.equal(ready.cases[0].steps.at(-1)?.op, "expectClosedOverlaysEmpty");
  assert.equal(ready.cases[0].outcomeChecks, undefined);
});

test("cross-route preparation continues beyond login to an entity and stops before its mutation", () => {
  const input = packet('The global search control has searchbox role and accessible name "Lookup".');
  const source: ProbePlan = { packetId: input.id, cases: [{ id: "search", requirementIds: ["A"], purpose: "happy_path",
    expectationBasis: [input.requirements[0].text], steps: [
      { op: "goto", path: "/" },
      { op: "fill", locator: { by: "role", role: "searchbox", name: "Lookup", exact: true, scope: { by: "role", role: "banner" } }, value: "Record" },
      { op: "press", locator: { by: "role", role: "searchbox", name: "Lookup", exact: true, scope: { by: "role", role: "banner" } }, key: "Enter" },
      { op: "expectVisible", locator: { by: "role", role: "link", name: "Record", exact: true } },
    ] }] };
  const business = structuredClone(nestedPlan);
  business.cases[0].setupStepCount = 3;
  business.cases[0].steps = [
    { op: "goto", path: "/" }, { op: "click", locator: { by: "role", role: "button", name: "Authenticate", exact: true } },
    { op: "expectVisible", locator: { by: "text", text: "Owner", exact: true } },
    { op: "click", locator: { by: "role", role: "link", name: "Record", exact: true } },
    { op: "expectVisible", locator: { by: "role", role: "heading", name: "Record", exact: true } },
    { op: "click", locator: { by: "role", role: "button", name: "Delete record", exact: true } },
    { op: "expectHidden", locator: { by: "role", role: "heading", name: "Record", exact: true } },
  ];
  const derived = globalControlCrossRoutePlan(input, business, [{ packet: input, plan: source }]);
  assert.ok(derived);
  assert.equal(derived.cases[0].steps[4].op, "expectVisible");
  assert.equal(derived.cases[0].steps[5].op, "expectAwayFromHome");
  assert.equal(derived.cases[0].steps.some(step => step.op === "click" && step.locator.by === "role" && step.locator.name === "Delete record"), false);
});
