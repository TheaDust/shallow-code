import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCoverageAccountedFor, observableFacets } from "../src/judge/probe-coverage.js";
import { assertLocatorOnlyRefinement, declaredLocatorRoles, parseProbePlan, toWireProbePlan, type ProbePlan, type ProbeStep } from "../src/judge/probe-schema.js";
import type { WorkPacket } from "../src/types.js";

function packet(text: string, then = text): WorkPacket {
  return { id: "A", attempt: 1, requirementIds: ["A"], requirements: [{
    id: "A", name: "Anonymous", text, declarationIndex: 0, folderPath: ["ROOT"], ancestors: [],
    dependencyIds: [], scenarios: [], references: [], seedDeclarations: [],
    exactUiStrings: [...text.matchAll(/`([^`]+)`|"([^"\n]+)"/g)].map(match => match[1] ?? match[2]),
    product: { rootId: "ROOT", rootName: "Anonymous", kind: "generic_web", description: "", seedData: [] },
    scenarioContracts: [{ id: "s", name: "Anonymous", steps: [
      { keyword: "WHEN", content: "The visitor opens the home page." }, { keyword: "THEN", content: then },
    ] }],
  }] };
}

function plan(input: WorkPacket, steps: ProbeStep[], indexes = steps.flatMap((step, index) => step.op.startsWith("expect") ? [index] : [])): ProbePlan {
  return { packetId: input.id, cases: [{ id: "s", requirementIds: ["A"], purpose: "happy_path",
    expectationBasis: [input.requirements[0].text], steps,
    outcomeChecks: [{ scenarioId: "s", stepIndex: 1, assertionIndexes: indexes }],
  }], uncoveredOutcomes: [] };
}

test("quoted role syntax binds same-named buttons and both dialog alternatives independently", () => {
  const input = packet('Activate the button "Archive record" or button "Restore record". A confirmation element with the `dialog` role whose accessible name matches "Archive record" or "Restore record" provides the confirmation.', 'The confirmation is visible.');
  for (const name of ["Archive record", "Restore record"]) {
    const button = { by: "role", role: "button", name, exact: true } as const;
    const dialog = { ...button, role: "dialog" };
    assert.deepEqual(declaredLocatorRoles(button, input, "click"), ["button"]);
    assert.deepEqual(declaredLocatorRoles(dialog, input, "expectVisible"), ["dialog"]);
    assert.deepEqual(declaredLocatorRoles(dialog, input, undefined, true), ["dialog"]);
    const valid = plan(input, [{ op: "click", locator: button }, { op: "expectVisible", locator: dialog }]);
    assert.doesNotThrow(() => parseProbePlan(valid, input));
    const wrong = structuredClone(valid);
    wrong.cases[0].steps[0] = { op: "click", locator: { ...button, role: "link" } };
    assert.throws(() => parseProbePlan(wrong, input), /requirement-declared role: button/);
    const fallback = structuredClone(valid);
    fallback.cases[0].steps[1] = { op: "expectVisible", locator: { ...dialog, fallbacks: [{ ...dialog, role: "heading" }] } };
    assert.throws(() => parseProbePlan(fallback, input), /requirement-declared role: dialog/);
  }
});

test("a numeric error string is complete text evidence, not an invented object count", () => {
  const text = 'The exact message "Name must be 80 characters or fewer" is visible.';
  const input = packet(text);
  assert.equal(observableFacets(text).some(facet => facet.kind === "count"), false);
  assert.doesNotThrow(() => assertCoverageAccountedFor(plan(input, [
    { op: "expectVisible", locator: { by: "text", text: "Name must be 80 characters or fewer", exact: true } },
  ]), input.requirements));
});

test("state attribute values are verified as attributes rather than visible strings", () => {
  const input = packet('The cell exposes aria-selected="true".');
  const valid = plan(input, [{ op: "expectAttribute", locator: { by: "role", role: "gridcell", name: "H4", exact: true }, attribute: "aria-selected", value: "true" }]);
  assert.doesNotThrow(() => assertCoverageAccountedFor(valid, input.requirements));
  const wrong = structuredClone(valid);
  const step = wrong.cases[0].steps[0];
  if (step.op !== "expectAttribute") assert.fail("missing state assertion");
  step.value = "false";
  assert.throws(() => assertCoverageAccountedFor(wrong, input.requirements), /state attribute/);
});

test("absence cannot prove an explicitly displayed field", () => {
  const input = packet('The page displays "alpha", "beta".');
  const hidden = plan(input, ["alpha", "beta"].map(name => ({ op: "expectHidden", locator: { by: "role", role: "heading", name, exact: true } })));
  assert.throws(() => assertCoverageAccountedFor(hidden, input.requirements), /displayed field/);
  const visible = plan(input, ["alpha", "beta"].map(name => ({ op: "expectVisible", locator: { by: "role", role: "heading", name, exact: true } })));
  assert.doesNotThrow(() => assertCoverageAccountedFor(visible, input.requirements));
});

test("persistence covers each field after a relevant reload without requiring the last reload", () => {
  const input = packet('The page displays "alpha", "beta" after reload.');
  const alpha: ProbeStep = { op: "expectVisible", locator: { by: "role", role: "heading", name: "alpha", exact: true } };
  const beta: ProbeStep = { op: "expectVisible", locator: { by: "role", role: "heading", name: "beta", exact: true } };
  assert.throws(() => assertCoverageAccountedFor(plan(input, [alpha, { op: "reload" }, beta]), input.requirements), /alpha/);
  assert.doesNotThrow(() => assertCoverageAccountedFor(plan(input, [{ op: "reload" }, alpha, beta, { op: "reload" },
    { op: "expectVisible", locator: { by: "role", role: "main" } }]), input.requirements));
});

test("the address assertion preserves the outcome identifier instead of another declared object", () => {
  const input = packet('Repository "record-1" offers branch "feature-a". The page address identifies "feature-a" after reload.');
  input.requirements[0].scenarioContracts![0].steps[1].content = 'The page address identifies "feature-a" after reload.';
  const wrong = plan(input, [{ op: "goto", path: "/" }, { op: "reload" }, { op: "expectUrlContains", value: "record-1" }]);
  assert.doesNotThrow(() => parseProbePlan(wrong, input));
  assert.throws(() => assertCoverageAccountedFor(wrong, input.requirements), /feature-a/);
  wrong.cases[0].steps[2] = { op: "expectUrlContains", value: "feature-a" };
  assert.doesNotThrow(() => assertCoverageAccountedFor(wrong, input.requirements));
});

test("an unrelated DOM-node count does not prove the displayed business count", () => {
  const input = packet("The page displays its reaction count.");
  assert.throws(() => assertCoverageAccountedFor(plan(input, [{ op: "expectCount", locator: { by: "role", role: "button" }, count: 0 }]), input.requirements), /count-bearing/);
  const valid = plan(input, [{ op: "expectAccessibleCount", noun: "reaction", minimum: 1 }]);
  assert.doesNotThrow(() => assertCoverageAccountedFor(valid, input.requirements));
});

test("a declared complete count message remains valid exact visible evidence", () => {
  const input = packet('The page displays the exact "Replaced 3 cells" message.');
  const valid = plan(input, [{ op: "expectVisible", locator: { by: "text", text: "Replaced 3 cells", exact: true } }]);
  assert.doesNotThrow(() => assertCoverageAccountedFor(valid, input.requirements));
});

test("aggregate counts accept a flat scope but freeze the entity during locator refinement", () => {
  const input = packet("The detail displays its reaction count.");
  const original = parseProbePlan(plan(input, [{ op: "expectAccessibleCount", noun: "reaction", exact: 1,
    scope: { by: "role", role: "region", name: "Target record", exact: true } }]), input);
  assert.deepEqual(parseProbePlan(toWireProbePlan(original)), original);
  const changed = structuredClone(original);
  const step = changed.cases[0].steps[0];
  if (step.op !== "expectAccessibleCount") assert.fail("missing count assertion");
  step.scope = { by: "role", role: "region", name: "Another record", exact: true };
  assert.throws(() => assertLocatorOnlyRefinement(original, changed), /only locator/);
  assert.throws(() => parseProbePlan(plan(input, [{ op: "expectAccessibleCount", noun: "reaction", exact: 1,
    scope: { by: "role", role: "region", scope: { by: "role", role: "main" } } as never }])), /flat/);
});

test("negative fill assertions are bounded, exclusive, and cannot change their expected color during refinement", () => {
  const valid = parseProbePlan({ packetId: "fill", cases: [{ id: "s", requirementIds: ["A"], purpose: "negative", expectationBasis: ["fixture"],
    steps: [{ op: "expectCss", locator: { by: "role", role: "gridcell", name: "L4", exact: true },
      property: "background-color", notValue: "rgb(220, 252, 231)" }] }] });
  assert.deepEqual(parseProbePlan(toWireProbePlan(valid)), valid);
  const both = structuredClone(valid);
  (both.cases[0].steps[0] as unknown as { value: string }).value = "red";
  assert.throws(() => parseProbePlan(both), /exactly one/);
  const changed = structuredClone(valid);
  const step = changed.cases[0].steps[0];
  if (step.op !== "expectCss") assert.fail("missing style assertion");
  step.notValue = "rgb(254, 226, 226)";
  assert.throws(() => assertLocatorOnlyRefinement(valid, changed), /only locator/);
});
