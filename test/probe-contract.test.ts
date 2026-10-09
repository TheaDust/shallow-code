import assert from "node:assert/strict";
import { test } from "node:test";
import { publicEntryPlan } from "../src/judge/public-entry.js";
import { assertCoverageAccountedFor, observableFacets } from "../src/judge/probe-coverage.js";

test("Computed background assertions are bounded and keep comparison targets frozen", () => {
  const locator = { by: "role", role: "gridcell", name: "F4", exact: true } as const;
  const other = { ...locator, name: "F5" };
  const wire = (assertion: unknown) => ({ packetId: "styles", cases: [{ id: "fill", requirementIds: ["A"],
    purpose: "happy_path", expectationBasis: ["fixture"], steps: [{ op: "goto", path: "/" }], assertion }] });
  const step = { op: "expectCss", locator, property: "background-color", differentFrom: other };
  const original = parseProbePlan(wire(step));
  assert.deepEqual(original.cases[0].steps.at(-1), step);
  assert.doesNotThrow(() => parseProbePlan(toWireProbePlan(original)));
  assert.doesNotThrow(() => parseProbePlan(wire({ op: "expectCss", locator, property: "background-color", value: "rgb(255, 0, 0)" })));
  assert.throws(() => parseProbePlan(wire({ ...step, property: "display" })), /only supports background-color/);
  assert.throws(() => parseProbePlan(wire({ ...step, value: "red" })), /exactly one/);
  assert.throws(() => parseProbePlan(wire({ ...step, differentFrom: null })), /exactly one/);
  assert.throws(() => parseProbePlan(wire({ ...step, script: "document.body" })), /unsupported/);
  assert.throws(() => parseProbePlan(wire({ ...step, immediate: "yes" })), /immediate must be a boolean/);
  const immediate = parseProbePlan(wire({ ...step, immediate: true }));
  assert.deepEqual(parseProbePlan(toWireProbePlan(immediate)), immediate);
  const changed = structuredClone(original);
  const assertion = changed.cases[0].steps.at(-1);
  if (assertion?.op !== "expectCss" || !assertion.differentFrom) assert.fail("missing comparison");
  assertion.differentFrom = { ...other, name: "G5" };
  assert.throws(() => assertLocatorOnlyRefinement(original, changed), /only locator/);
  const input = packet('Use the gridcell named "F4".');
  const ungrounded: ProbePlan = { packetId: input.id, cases: [{ id: "colors", requirementIds: input.requirementIds,
    purpose: "happy_path", expectationBasis: [input.requirements[0].text], steps: [{ op: "goto", path: "/" },
      { op: "expectCss", locator, property: "background-color", differentFrom: { by: "text", text: "guessed comparison" } },
    ] }] };
  assert.throws(() => parseProbePlan(ungrounded, input), /unanchored text locator/);
});

test("URL assertions require an explicit address contract and a grounded value", () => {
  const input = packet("Selecting branch `feature-a` keeps `feature-a` in the page address after reload.");
  input.requirements[0].scenarioContracts = [{ id: "address", name: "Address", steps: [
    { keyword: "WHEN", content: "The visitor selects `feature-a`." },
    { keyword: "THEN", content: "The page address identifies `feature-a` after reload." },
  ] }];
  const wire = (value: string) => ({ packetId: input.id, uncoveredOutcomes: [], cases: [{ id: "address",
    requirementIds: input.requirementIds, purpose: "persistence", expectationBasis: [input.requirements[0].text],
    outcomeChecks: [{ scenarioId: "address", stepIndex: 1, assertionIndexes: [2] }],
    steps: [{ op: "goto", path: "/" }, { op: "reload" }], assertion: { op: "expectUrlContains", value } }] });
  assert.doesNotThrow(() => assertCoverageAccountedFor(parseProbePlan(wire("feature-a"), input), input.requirements));
  assert.throws(() => parseProbePlan(wire("invented"), input), /requirement evidence or a prior scenario input/);
  const noAddress = packet("Selecting branch `feature-a` keeps it selected after reload.");
  noAddress.requirements[0].scenarioContracts = [{ id: "address", name: "Address", steps: [
    { keyword: "WHEN", content: "The visitor selects `feature-a`." },
    { keyword: "THEN", content: noAddress.requirements[0].text },
  ] }];
  assert.throws(() => parseProbePlan({ ...wire("feature-a"), packetId: noAddress.id }, noAddress), /explicit page address\/URL/);
  const changed = parseProbePlan(wire("feature-a"), input);
  const assertion = changed.cases[0].steps.at(-1);
  if (assertion?.op !== "expectUrlContains") assert.fail("missing URL assertion");
  const original = structuredClone(changed);
  assertion.value = "feature-b";
  assert.throws(() => assertLocatorOnlyRefinement(original, changed), /only locator/);
});

test("Accessible aggregate counts are noun-grounded and do not replace exact status text", () => {
  const input = packet("The detail displays the reaction type and count; adding one updates the reaction count.");
  const wire = (assertion: unknown) => ({ packetId: input.id, cases: [{ id: "count", requirementIds: input.requirementIds,
    purpose: "happy_path", expectationBasis: [input.requirements[0].text], steps: [{ op: "goto", path: "/" }], assertion }] });
  assert.doesNotThrow(() => parseProbePlan(wire({ op: "expectAccessibleCount", noun: "reaction", exact: 1 }), input));
  assert.doesNotThrow(() => parseProbePlan(wire({ op: "expectAccessibleCount", noun: "reactions", minimum: 1 }), input));
  assert.throws(() => parseProbePlan(wire({ op: "expectAccessibleCount", noun: "release", exact: 1 }), input), /requirement-declared noun/);
  assert.throws(() => parseProbePlan(wire({ op: "expectAccessibleCount", noun: "reaction", exact: 1, minimum: 0 }), input), /exactly one/);
});

test("observable facets preserve one outcome while separating explicit displayed fields", () => {
  const fields = observableFacets("The detail displays `alpha`, `beta`, and `gamma` after reload.");
  assert.deepEqual(fields.filter(item => item.kind === "visibility").map(item => item.text),
    ["alpha", "beta", "gamma"]);
  assert.ok(fields.every(item => item.phase === "after_reload"));
  assert.equal(fields.filter(item => item.kind === "persistence").length, 1);

  const alternative = observableFacets("The page displays `Ready` or an inactive marker.");
  assert.equal(alternative.filter(item => item.kind === "visibility").length, 1,
    "alternatives remain one observable fact");
  const status = observableFacets("The page displays the exact `Replaced 3 cells` message.");
  assert.equal(status.filter(item => item.kind === "count").length, 1);
  assert.equal(status.filter(item => item.kind === "visibility").length, 1);
  assert.deepEqual(observableFacets("The Archived marker is gone, the record is Active.")
    .filter(item => item.kind === "state").map(item => item.text),
  ["The Archived marker is gone", "the record is Active."]);
});

test("setChecked accepts explicit state only on checkable controls", () => {
  const wire = (step: unknown) => ({ packetId: "checked", cases: [{ id: "case", requirementIds: ["A"], purpose: "happy_path",
    expectationBasis: ["fixture"], steps: [step], assertion: { op: "expectVisible", locator: { by: "role", role: "main" } } }] });
  assert.doesNotThrow(() => parseProbePlan(wire({ op: "setChecked", locator: { by: "role", role: "checkbox", name: "Header row" }, checked: true })));
  assert.throws(() => parseProbePlan(wire({ op: "setChecked", locator: { by: "role", role: "button", name: "Save" }, checked: true })), /checkbox\/radio/);
  assert.throws(() => parseProbePlan(wire({ op: "setChecked", locator: { by: "label", text: "Header row" }, checked: "true" })), /boolean/);
});

test("Download assertions use an interactive trigger and preserve expected content during refinement", () => {
  const wire = (assertion: unknown) => ({ packetId: "download", cases: [{ id: "export", requirementIds: ["A"], purpose: "happy_path",
    expectationBasis: ["fixture"], steps: [{ op: "goto", path: "/" }], assertion }] });
  const step = { op: "expectDownload", locator: { by: "role", role: "button", name: "Export CSV", exact: true },
    fileNameSuffix: ".csv", text: "2,4" };
  const original = parseProbePlan(wire(step));
  assert.deepEqual(original.cases[0].steps.at(-1), step);
  assert.throws(() => parseProbePlan(wire({ ...step, locator: { by: "text", text: "Export CSV" } })), /interactive control/);
  assert.throws(() => parseProbePlan(wire({ ...step, fileNameSuffix: "" })), /fileNameSuffix/);
  assert.throws(() => parseProbePlan(wire({ ...step, path: "private.csv" })), /unsupported/);
  const changed = structuredClone(original);
  const assertion = changed.cases[0].steps.at(-1);
  if (assertion?.op !== "expectDownload") assert.fail("missing download assertion");
  assertion.text = "2,=A1*2";
  assert.throws(() => assertLocatorOnlyRefinement(original, changed), /only locator/);
});
import { assertLocatorOnlyRefinement, declaredLocatorRoles, groundedLocatorAnchors, parseProbePlan, PROBE_PLAN_BODY, toWireProbePlan, type ProbeLocator, type ProbePlan } from "../src/judge/probe-schema.js";
import type { WorkPacket } from "../src/types.js";
import { loadRequirementCatalog } from "../src/catalog.js";

function packet(text = 'Open "Items" and click "Publish".'): WorkPacket {
  return { id: "packet-a", requirementIds: ["A"], attempt: 1, requirements: [{
    id: "A", name: "Publish", text, declarationIndex: 0, folderPath: ["ROOT"], ancestors: [],
    dependencyIds: [], scenarios: [], references: [], exactUiStrings: ["Items", "Publish"], seedDeclarations: [],
    product: { kind: "generic_web", rootId: "ROOT", rootName: "Product", description: "", seedData: [] },
  }] };
}

function plan(path = "/"): ProbePlan {
  return { packetId: "packet-a", cases: [{ id: "publish", requirementIds: ["A"], purpose: "happy_path",
    expectationBasis: ["Open"], steps: [
    { op: "goto", path },
    { op: "click", locator: { by: "role", role: "button", name: "Publish", exact: true } },
    { op: "expectVisible", locator: { by: "role", role: "status" } },
  ] }] };
}

test("Requirement-declared top global search is deterministically scoped to banner", () => {
  const input = packet('The top global search control has searchbox role and accessible name "Publish".');
  const original = plan();
  original.cases[0].expectationBasis = [input.requirements[0].text];
  original.cases[0].steps[1] = { op: "fill", locator: {
    by: "role", role: "searchbox", name: "Publish", exact: true,
    fallbacks: [{ by: "label", text: "Publish", exact: true }],
  }, value: "query" };
  const parsed = parseProbePlan(original, input);
  const step = parsed.cases[0].steps[1];
  assert.equal(step.op, "fill");
  if (step.op !== "fill") assert.fail("missing search fill");
  assert.deepEqual(step.locator.scope, { by: "role", role: "banner" });
  assert.deepEqual(step.locator.fallbacks?.[0].scope, { by: "role", role: "banner" });
  const weakened = structuredClone(parsed);
  const weakenedStep = weakened.cases[0].steps[1];
  if (weakenedStep.op !== "fill") assert.fail("missing search fill");
  delete weakenedStep.locator.scope;
  for (const fallback of weakenedStep.locator.fallbacks ?? []) delete fallback.scope;
  assert.throws(() => assertLocatorOnlyRefinement(parsed, weakened), /preserve the banner scope/);

  const conflicting = structuredClone(original);
  const locator = conflicting.cases[0].steps[1];
  if (locator.op !== "fill") assert.fail("missing search fill");
  locator.locator.scope = { by: "role", role: "main" };
  assert.throws(() => parseProbePlan(conflicting, input), /global search must be scoped to the banner/);
});

test("Public entry samples need an explicit visitor home contract and stay separate from full coverage", () => {
  const input = packet('The visitor starts at the home page. Visitors can search. The top global search uses a searchbox named "Lookup".');
  const sample = publicEntryPlan(input);
  assert.ok(sample);
  assert.equal(sample.cases[0].steps[1].op, "expectCount");
  assert.equal(sample.cases[0].outcomeChecks, undefined);
  assert.equal(publicEntryPlan(packet('Only signed-in users see the global searchbox named "Lookup".')), undefined);
  assert.equal(publicEntryPlan(packet('The visitor starts at the home page, then signs in before using the global searchbox named "Lookup".')), undefined);
  assert.equal(publicEntryPlan(packet('The visitor starts at the home page. Local search uses a searchbox named "Lookup".')), undefined);
  assert.equal(publicEntryPlan(packet('The visitor starts at the home page. The textbox named "global search" is data.')), undefined);
});

test("A result link and a heading containing the same data keep their own roles", () => {
  const input = packet('The results show a link named "Shared area". Opening it displays a heading containing "Shared area".');
  const result: ProbePlan = { packetId: input.id, cases: [{ id: "open-result", requirementIds: input.requirementIds,
    purpose: "happy_path", expectationBasis: [input.requirements[0].text], steps: [
      { op: "goto", path: "/" },
      { op: "click", locator: { by: "role", role: "link", name: "Shared area", exact: true } },
      { op: "expectVisible", locator: { by: "role", role: "heading", name: "Shared area", exact: false } },
    ] }] };
  assert.doesNotThrow(() => parseProbePlan(result, input));
  assert.deepEqual(declaredLocatorRoles({ by: "role", role: "heading", name: "Shared area" }, input, "expectVisible"), ["heading"]);
  assert.deepEqual(declaredLocatorRoles({ by: "role", role: "link", name: "Shared area" }, input, "click"), ["link"]);
  const wrongResult = structuredClone(result);
  const click = wrongResult.cases[0].steps[1];
  if (click.op !== "click") assert.fail("missing link click");
  click.locator = { by: "role", role: "button", name: "Shared area", exact: true };
  assert.throws(() => parseProbePlan(wrongResult, input), /requirement-declared role.*link/);
  const wrongHeading = structuredClone(result);
  const heading = wrongHeading.cases[0].steps[2];
  if (heading.op !== "expectVisible") assert.fail("missing heading");
  heading.locator.fallbacks = [{ by: "role", role: "link", name: "Shared area" }];
  assert.throws(() => parseProbePlan(wrongHeading, input), /requirement-declared role.*heading/);
  const headingOnly = packet('The opened page displays a heading containing "Shared area".');
  assert.deepEqual(declaredLocatorRoles({ by: "role", role: "link", name: "Shared area" }, headingOnly, "click"), []);
  assert.deepEqual(declaredLocatorRoles({ by: "role", role: "heading", name: "Shared area" }, headingOnly, "expectVisible"), ["heading"]);
});

test("Named browser contexts can be revisited only after they are created", () => {
  const valid = plan();
  valid.cases[0].steps.splice(1, 0,
    { op: "newContext", actor: "revoked-browser" },
    { op: "switchContext", actor: "default" },
    { op: "switchContext", actor: "revoked-browser" });
  assert.doesNotThrow(() => parseProbePlan(valid));

  const unknown = plan();
  unknown.cases[0].steps.splice(1, 0, { op: "switchContext", actor: "missing" });
  assert.throws(() => parseProbePlan(unknown), /unknown browser context actor missing/);

  const obsoleteExcuse = { ...plan(), uncoveredOutcomes: [{ scenarioId: "A::0", stepIndex: 2,
    reason: "The plan operations can only operate on the current browser context and cannot switch back." }] };
  assert.throws(() => parseProbePlan(obsoleteExcuse), /use named newContext and switchContext/);
});

test("Explicit control roles survive refinement, including every fallback", () => {
  const input = packet('Click the button named "Publish".');
  const original = plan();
  const changed = structuredClone(original);
  changed.cases[0].steps[1] = { op: "click", locator: { by: "role", role: "link", name: "Publish", exact: true } };
  assert.throws(() => assertLocatorOnlyRefinement(original, changed, [], input), /requirement-declared role.*button/);
  assert.throws(() => parseProbePlan(changed, input), /requirement-declared role.*button/);
  changed.cases[0].steps[1] = { op: "click", locator: { by: "role", role: "button", name: "Publish", exact: true,
    fallbacks: [{ by: "role", role: "link", name: "Publish", exact: true }] } };
  assert.throws(() => assertLocatorOnlyRefinement(original, changed, [], input), /requirement-declared role/);
  assert.throws(() => parseProbePlan(changed, input), /requirement-declared role/);
  assert.doesNotThrow(() => assertLocatorOnlyRefinement(original, changed, [], packet()));
});

test("Role evidence binds the quoted target, alternatives and explicit scope", () => {
  const target: ProbeLocator = { by: "role", role: "button", name: "Publish" };
  for (const text of ['The "Publish" button saves.', 'Use a button with accessible name “Publish”.',
    'The control has button role and accessible name "Publish".']) {
    assert.deepEqual(declaredLocatorRoles(target, packet(text)), ["button"]);
  }
  assert.deepEqual(declaredLocatorRoles(target, packet('Use a button or link named "Publish".')), ["button", "link"]);
  assert.deepEqual(declaredLocatorRoles(target, packet('The dialog named "Details" contains "Publish".')), []);
  assert.deepEqual(declaredLocatorRoles(target, packet('The example value is `button named "Publish"`.')), []);
  const scoped = packet('Use a button named "Publish" in dialog named "Editor". Use a link named "Publish" in region named "History".');
  assert.deepEqual(declaredLocatorRoles({ ...target, scope: { by: "role", role: "dialog", name: "Editor" } }, scoped), ["button"]);
  assert.deepEqual(declaredLocatorRoles(target, scoped), []);
});

test("An option named after a Style field does not turn the field into an option", () => {
  const input = packet('Users choose a "Style" option named "Red fill", "Yellow fill", or "Green fill".');
  input.requirements[0].exactUiStrings = ["Style", "Red fill", "Yellow fill", "Green fill"];
  const field: ProbeLocator = { by: "role", role: "combobox", name: "Style", exact: true };
  const option: ProbeLocator = { by: "role", role: "option", name: "Red fill", exact: true };
  assert.deepEqual(declaredLocatorRoles(field, input, "select"), []);
  assert.deepEqual(declaredLocatorRoles(option, input, "click"), ["option"]);
  const original = plan();
  original.cases[0].expectationBasis = [input.requirements[0].text];
  original.cases[0].steps[1] = { op: "select", locator: field, value: "Red fill" };
  assert.doesNotThrow(() => parseProbePlan(original, input));
});

test("A same-named list scope does not inherit the page heading role", () => {
  const text = 'The page displays the heading "Active sessions". The page lists active sessions. ' +
    'Each row provides a button named "Revoke session".';
  const input = packet(text);
  input.requirements[0].exactUiStrings = ["Active sessions", "Revoke session"];
  const list: ProbeLocator = { by: "role", role: "list", name: "Active sessions", exact: true };
  const heading: ProbeLocator = { by: "role", role: "heading", name: "Active sessions", exact: true };
  assert.deepEqual(declaredLocatorRoles(list, input, undefined, true), []);
  assert.deepEqual(declaredLocatorRoles(heading, input, "expectVisible"), ["heading"]);
  const original = plan();
  original.cases[0].expectationBasis = [text];
  original.cases[0].steps[1] = { op: "click", locator: { by: "role", role: "button", name: "Revoke session", exact: true,
    scope: { by: "role", role: "list", name: "Active sessions", exact: true } } };
  assert.doesNotThrow(() => parseProbePlan(original, input));
});

test("Explicit form roles preserve label queries when refinement adds a field scope", () => {
  const input = packet('Fill the textbox named "Publish".');
  const original = plan();
  original.cases[0].steps[1] = { op: "fill", locator: { by: "label", text: "Publish", exact: true }, value: "draft" };
  const changed = structuredClone(original);
  changed.cases[0].steps[1] = { op: "fill", locator: { by: "label", text: "Publish", exact: true,
    scope: { by: "role", role: "dialog", name: "Editor" } }, value: "draft" };
  assert.doesNotThrow(() => assertLocatorOnlyRefinement(original, changed, [], input));
  changed.cases[0].steps[1] = { op: "fill", locator: { by: "role", role: "button", name: "Publish", exact: true }, value: "draft" };
  assert.throws(() => assertLocatorOnlyRefinement(original, changed, [], input), /requirement-declared role.*textbox/);
});

test("Composite role phrases bind navigation links and menu items without changing quoted names", () => {
  for (const [name, role, text] of [
    ["Code", "link", 'The overview has a “Code” navigation link.'],
    ["Code", "link", 'Use a navigation link named "Code".'],
    ["Rename", "menuitem", 'The "Rename" menu item opens the editor.'],
    ["Rename", "menuitem", 'Use a menu item named "Rename".'],
    ["Publish", "button", 'The "Publish" confirmation button saves.'],
    ["Publish", "button", 'Use a confirmation button named "Publish".'],
    ["navigation link", "button", 'Click the button named "navigation link".'],
    ["confirmation button", "link", 'Use a link named "confirmation button".'],
  ]) {
    const input = packet(text);
    input.requirements[0].exactUiStrings = [name];
    const target: ProbeLocator = { by: "role", role, name, exact: true };
    assert.deepEqual(declaredLocatorRoles(target, input), [role]);
    const original = plan();
    original.cases[0].expectationBasis = [text];
    original.cases[0].steps[1] = { op: "click", locator: target };
    assert.doesNotThrow(() => parseProbePlan(original, input));
    const changed = structuredClone(original);
    changed.cases[0].steps[1] = { op: "click", locator: { ...target, role: role === "button" ? "link" : "button" } };
    assert.throws(() => assertLocatorOnlyRefinement(original, changed, [], input), /requirement-declared role/);
  }
});

test("A confirmation button keeps its role when the dialog has the same name", () => {
  const input = packet('A dialog named "Publish" provides a "Publish" confirmation button.');
  const original = plan();
  original.cases[0].expectationBasis = [input.requirements[0].text];
  original.cases[0].steps.push({ op: "expectVisible", locator: { by: "role", role: "dialog", name: "Publish", exact: true } });
  assert.deepEqual(declaredLocatorRoles({ by: "role", role: "button", name: "Publish" }, input, "click"), ["button"]);
  assert.deepEqual(declaredLocatorRoles({ by: "role", role: "dialog", name: "Publish" }, input, "expectVisible"), ["dialog"]);
  assert.doesNotThrow(() => parseProbePlan(original, input));
  const changed = structuredClone(original);
  changed.cases[0].steps[1] = { op: "click", locator: { by: "role", role: "link", name: "Publish", exact: true } };
  assert.throws(() => parseProbePlan(changed, input), /requirement-declared role.*button/);
  assert.throws(() => assertLocatorOnlyRefinement(original, changed, [], input), /requirement-declared role.*button/);
  const replacedDialog = structuredClone(original);
  replacedDialog.cases[0].steps[3] = { op: "expectVisible", locator: { by: "role", role: "button", name: "Publish", exact: true } };
  assert.throws(() => assertLocatorOnlyRefinement(original, replacedDialog, [], input), /requirement-declared role.*dialog/);
  const mixedDialog = structuredClone(original);
  mixedDialog.cases[0].steps[3] = { op: "expectVisible", locator: { by: "role", role: "dialog", name: "Publish", exact: true,
    fallbacks: [{ by: "role", role: "button", name: "Publish", exact: true }] } };
  assert.throws(() => parseProbePlan(mixedDialog, input), /requirement-declared role.*dialog/);
  const controlOnly = packet('Use a confirmation button named "Publish".');
  const wrongRole = plan();
  wrongRole.cases[0].expectationBasis = [controlOnly.requirements[0].text];
  wrongRole.cases[0].steps[1] = { op: "expectVisible", locator: { by: "role", role: "heading", name: "Publish", exact: true } };
  assert.throws(() => parseProbePlan(wrongRole, controlOnly), /requirement-declared role.*button/);
});

test("A named popup and its untyped menu trigger keep separate role contracts", () => {
  const input = packet('Click "Data validation" in the "Data" menu. A dialog named "Data validation" provides the rule editor.');
  input.requirements[0].exactUiStrings = ["Data validation", "Data"];
  const trigger: ProbeLocator = { by: "role", role: "menuitem", name: "Data validation", exact: true };
  const popup: ProbeLocator = { by: "role", role: "dialog", name: "Data validation", exact: true };
  const original = plan();
  original.cases[0].expectationBasis = [input.requirements[0].text];
  original.cases[0].steps = [{ op: "goto", path: "/" }, { op: "expectVisible", locator: trigger },
    { op: "click", locator: trigger }, { op: "expectVisible", locator: popup }];
  assert.deepEqual(declaredLocatorRoles(trigger, input, "click"), []);
  assert.deepEqual(declaredLocatorRoles(popup, input, "expectVisible"), ["dialog"]);
  assert.doesNotThrow(() => parseProbePlan(original, input));
  const changed = structuredClone(original);
  changed.cases[0].steps[3] = { op: "expectVisible", locator: { by: "text", text: "Data validation", exact: true } };
  assert.throws(() => parseProbePlan(changed, input), /requirement-declared role.*dialog/);
  const popupFallback = structuredClone(original);
  popupFallback.cases[0].steps[2] = { op: "click", locator: { ...trigger, fallbacks: [popup] } };
  assert.throws(() => parseProbePlan(popupFallback, input), /trigger control.*same-named popup/);
  const switchedTarget = structuredClone(original);
  switchedTarget.cases[0].steps[2] = { op: "click", locator: popup };
  assert.throws(() => assertLocatorOnlyRefinement(original, switchedTarget, [], input), /interactive control role/);
  const containerOnly = packet('The dialog named "Publish" is visible.');
  assert.throws(() => parseProbePlan(plan(), containerOnly), /requirement-declared role.*dialog/);
});

test("An explicit trigger role remains mandatory when a popup has the same name", () => {
  const input = packet('Click the button named "Publish". A dialog named "Publish" opens after the visitor clicks "Publish".');
  const original = plan();
  original.cases[0].expectationBasis = [input.requirements[0].text];
  original.cases[0].steps.push({ op: "expectVisible", locator: { by: "role", role: "dialog", name: "Publish", exact: true } });
  assert.deepEqual(declaredLocatorRoles({ by: "role", role: "button", name: "Publish", exact: true }, input, "click"), ["button"]);
  assert.doesNotThrow(() => parseProbePlan(original, input));
  const changed = structuredClone(original);
  changed.cases[0].steps[1] = { op: "click", locator: { by: "role", role: "link", name: "Publish", exact: true,
    fallbacks: [{ by: "role", role: "button", name: "Publish", exact: true }] } };
  assert.throws(() => parseProbePlan(changed, input), /requirement-declared role.*button/);
  assert.throws(() => assertLocatorOnlyRefinement(original, changed, [], input), /requirement-declared role.*button/);
});

test("Opening a named menu binds its trigger separately from the menu container", () => {
  for (const name of ["Data", "View", "Edit"]) {
    const description = `Users open the "${name}" menu and click "Run". A button named "Run" performs the action.`;
    const input = packet(description);
    input.requirements[0].exactUiStrings = [name, "Run"];
    const original = plan();
    original.cases[0].expectationBasis = [description];
    original.cases[0].steps = [
      { op: "goto", path: "/" },
      { op: "click", locator: { by: "role", role: "button", name, exact: true } },
      { op: "expectVisible", locator: { by: "role", role: "menu", name, exact: true } },
      { op: "click", locator: { by: "role", role: "button", name: "Run", exact: true } },
      { op: "expectVisible", locator: { by: "role", role: "status" } },
    ];
    assert.deepEqual(declaredLocatorRoles({ by: "role", role: "button", name }, input, "click"), []);
    assert.deepEqual(declaredLocatorRoles({ by: "role", role: "menu", name }, input, "expectVisible"), ["menu"]);
    assert.doesNotThrow(() => parseProbePlan(original, input));
    const containerClick = structuredClone(original);
    containerClick.cases[0].steps[1] = { op: "click", locator: { by: "role", role: "menu", name, exact: true } };
    assert.throws(() => parseProbePlan(containerClick, input), /trigger control.*same-named popup/);
    assert.throws(() => assertLocatorOnlyRefinement(original, containerClick, [], input), /interactive control role/);
  }
});

test("A bare heading role is distinct from its same-named navigation link", () => {
  const description = 'The overview exposes an "Activity log" link. The page displays the heading "Activity log".';
  const input = packet(description);
  input.requirements[0].exactUiStrings = ["Activity log"];
  const heading: ProbeLocator = { by: "role", role: "heading", name: "Activity log", exact: true };
  const original = plan();
  original.cases[0].expectationBasis = [description];
  original.cases[0].steps = [
    { op: "goto", path: "/" },
    { op: "click", locator: { by: "role", role: "link", name: "Activity log", exact: true } },
    { op: "expectVisible", locator: heading },
  ];
  assert.deepEqual(declaredLocatorRoles(heading, input, "expectVisible"), ["heading"]);
  assert.doesNotThrow(() => parseProbePlan(original, input));
  const wrongControl = structuredClone(original);
  wrongControl.cases[0].steps[1] = { op: "click", locator: { by: "role", role: "button", name: "Activity log", exact: true } };
  assert.throws(() => parseProbePlan(wrongControl, input), /requirement-declared role.*link/);
  const wrongHeading = structuredClone(original);
  wrongHeading.cases[0].steps[2] = { op: "expectVisible", locator: { by: "role", role: "link", name: "Activity log", exact: true } };
  assert.throws(() => assertLocatorOnlyRefinement(original, wrongHeading, [], input), /requirement-declared role.*heading/);
});

test("An untyped home-page entry does not inherit its same-named submit button role", () => {
  const input = packet('The form contains a button named "Log in".');
  input.requirements[0].ancestors = [{ id: "ROOT", name: "Access", description:
    'Visitors enter the account-access page from "Register", "Log in", or "Recover account" on the home page.' }];
  input.requirements[0].exactUiStrings = ["Log in"];
  const link: ProbeLocator = { by: "role", role: "link", name: "Log in", exact: true };
  const button: ProbeLocator = { by: "role", role: "button", name: "Log in", exact: true };
  assert.deepEqual(declaredLocatorRoles(link, input, "click"), []);
  assert.deepEqual(declaredLocatorRoles(button, input, "click"), ["button"]);
  assert.deepEqual(declaredLocatorRoles({ ...link, scope: { by: "role", role: "form" } }, input, "click"), ["button"]);
  const original = plan();
  original.cases[0].expectationBasis = [input.requirements[0].text];
  original.cases[0].steps = [{ op: "goto", path: "/" }, { op: "click", locator: link },
    { op: "click", locator: button }, { op: "expectVisible", locator: { by: "role", role: "status" } }];
  assert.doesNotThrow(() => parseProbePlan(original, input));
  const guessedEntry = structuredClone(original);
  guessedEntry.cases[0].steps[1] = { op: "click", locator: button };
  assert.doesNotThrow(() => parseProbePlan(guessedEntry, input));
  assert.doesNotThrow(() => assertLocatorOnlyRefinement(guessedEntry, original, [], input));
  const scopedEntry = structuredClone(original);
  scopedEntry.cases[0].steps[1] = { op: "click", locator: { ...link, scope: { by: "role", role: "banner" } } };
  assert.doesNotThrow(() => parseProbePlan(scopedEntry, input));
  const changed = structuredClone(original);
  changed.cases[0].steps[2] = { op: "click", locator: link };
  assert.throws(() => parseProbePlan(changed, input), /requirement-declared role.*button/);
  assert.throws(() => assertLocatorOnlyRefinement(original, changed, [], input), /requirement-declared role.*button/);
});

test("Role validation reports the failed step and offending fallback", () => {
  const input = packet('Click the button named "Publish".');
  const original = plan();
  original.cases[0].steps[1] = { op: "click", locator: { by: "role", role: "button", name: "Publish", exact: true,
    fallbacks: [{ by: "role", role: "link", name: "Publish", exact: true }] } };
  assert.throws(() => parseProbePlan(original, input), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /case publish step 1/);
    assert.match(error.message, /requirement-declared role: button/);
    assert.match(error.message, /"role":"link"/);
    assert.match(error.message, /"name":"Publish"/);
    return true;
  });
});

test("A control's role does not define its same-named scope and explicit container roles remain enforced", () => {
  const input = packet('Click the button named "Publish".');
  const original = plan();
  original.cases[0].expectationBasis = [input.requirements[0].text];
  original.cases[0].steps[1] = { op: "click", locator: { by: "role", role: "button", name: "Publish", exact: true,
    scope: { by: "role", role: "form", name: "Publish", exact: true } } };
  assert.doesNotThrow(() => parseProbePlan(original, input));
  input.requirements[0].text += ' The form named "Publish" contains the submit control.';
  assert.doesNotThrow(() => parseProbePlan(original, input));
  const changed = structuredClone(original);
  changed.cases[0].steps[1] = { op: "click", locator: { by: "role", role: "button", name: "Publish", exact: true,
    scope: { by: "role", role: "region", name: "Publish", exact: true } } };
  assert.throws(() => parseProbePlan(changed, input), /requirement-declared role.*form/);
  assert.throws(() => assertLocatorOnlyRefinement(original, changed, [], input), /requirement-declared role.*form/);
});

test("First-match selection requires an explicit instruction for the same named control", () => {
  const quote = 'Click the first "Publish" button.';
  const input = packet(quote);
  const original = plan();
  const action = original.cases[0].steps[1];
  if (action.op !== "click") assert.fail("missing action");
  action.locator.firstMatch = quote;
  original.cases[0].expectationBasis = [quote];
  assert.deepEqual(parseProbePlan(original, input), original);
  assert.throws(() => parseProbePlan(original, packet()), /quote the requirement evidence verbatim/);
  for (const text of ['Click "Publish". The first attempt succeeds.', 'The data value is "first Publish".']) {
    const invalid = structuredClone(original);
    const step = invalid.cases[0].steps[1];
    if (step.op !== "click") assert.fail("missing action");
    step.locator.firstMatch = text;
    invalid.cases[0].expectationBasis = [text];
    assert.throws(() => parseProbePlan(invalid, packet(text)), /explicitly select the first/);
  }
  const count = structuredClone(original);
  count.cases[0].steps[1] = { op: "expectCount", locator: action.locator, count: 0 };
  assert.throws(() => parseProbePlan(count, input), /absence or count/);
  const weak = structuredClone(original);
  const step = weak.cases[0].steps[1];
  if (step.op !== "click") assert.fail("missing action");
  step.locator.exact = false;
  assert.throws(() => parseProbePlan(weak, input), /exact named interactive/);
  step.locator = { by: "text", text: "Publish", exact: true, firstMatch: quote };
  assert.throws(() => parseProbePlan(weak, input), /exact named interactive/);
  action.locator.fallbacks = [{ by: "role", role: "link", name: "Publish", exact: true }];
  assert.throws(() => parseProbePlan(original, input), /fallbacks must preserve firstMatch/);
});

test("First-match authorization comes from the relevant scenario prose rather than data or another case", () => {
  const quote = 'Click the first “Publish” button.';
  const original = plan();
  original.cases[0].expectationBasis = [quote];
  const step = original.cases[0].steps[1];
  if (step.op !== "click") assert.fail("missing action");
  step.locator.firstMatch = quote;
  const data = packet(`The stored message is \`${quote}\`.`);
  data.requirements[0].exactUiStrings.push(quote);
  assert.throws(() => parseProbePlan(original, data), /prose instruction/);
  const otherCase = packet('Click “Publish”.');
  otherCase.requirements[0].scenarioContracts = [
    { id: "first", name: "First", steps: [{ keyword: "WHEN", content: quote }] },
    { id: "ordinary", name: "Ordinary", steps: [{ keyword: "THEN", content: "The status is visible." }] },
  ];
  otherCase.requirements[0].scenarios = [quote, "The status is visible."];
  original.cases[0].outcomeChecks = [{ scenarioId: "ordinary", stepIndex: 0, assertionIndexes: [2] }];
  assert.throws(() => parseProbePlan(original, otherCase), /quote the requirement evidence verbatim/);
});

test("Locator refinement cannot add or remove first-match selection", () => {
  const original = plan();
  const refined = structuredClone(original);
  const action = refined.cases[0].steps[1];
  if (action.op !== "click") assert.fail("missing action");
  action.locator.firstMatch = 'Click the first "Publish" button.';
  assert.throws(() => assertLocatorOnlyRefinement(original, refined), /preserve firstMatch/);
  assert.throws(() => assertLocatorOnlyRefinement(refined, original), /preserve firstMatch/);
});

test("First-container selection needs the named control's declared relationship and the same action", () => {
  const instruction = "Start a comment on the first changed line.";
  const text = 'Use the “Add comment” button on a changed line. ' + instruction;
  const original = plan();
  original.cases[0].expectationBasis = [instruction];
  const action = original.cases[0].steps[1];
  if (action.op !== "click") assert.fail("missing action");
  action.locator = { by: "role", role: "button", name: "Add comment", exact: true, firstMatch: instruction };
  assert.doesNotThrow(() => parseProbePlan(original, packet(text)));
  assert.throws(() => parseProbePlan(original, packet('Use “Add comment”. ' + instruction)), /explicitly select the first/);
  action.locator.name = "Delete line";
  assert.throws(() => parseProbePlan(original, packet('Use “Delete line” on a changed line. ' + instruction)), /explicitly select the first/);
});

test("The latest GitHub pending-review scenario binds its first changed line to Add comment", async () => {
  const catalog = await loadRequirementCatalog("data/official-competition/hackathon--github-stage-3/requirements.yaml");
  const requirement = catalog.requirements.find(item => item.id === "REQ-6-3-3")!;
  const scenario = requirement.scenarioContracts![1];
  const input: WorkPacket = { id: "pending", requirementIds: [requirement.id], requirements: [requirement], attempt: 1 };
  const firstMatch = "starts a comment on the first changed line";
  const raw: ProbePlan = { packetId: input.id, cases: [{ id: "pending", requirementIds: input.requirementIds,
    purpose: "happy_path", expectationBasis: [scenario.steps[1].content], steps: [
      { op: "goto", path: "/" }, { op: "click", locator: { by: "role", role: "button", name: "Add comment", exact: true, firstMatch } },
      { op: "expectVisible", locator: { by: "label", text: "Comment", exact: true } },
    ], outcomeChecks: [{ scenarioId: scenario.id, stepIndex: 2, clauseIndex: 0, assertionIndexes: [2] }],
  }] };
  assert.doesNotThrow(() => parseProbePlan(raw, input));
});

test("Locators reject impossible ARIA roles in targets, fallbacks and scopes", () => {
  for (const variant of ["target", "fallback", "scope"]) {
    const invalid = plan();
    const step = invalid.cases[0].steps[1];
    if (step.op !== "click") assert.fail("missing action");
    if (variant === "target") step.locator = { by: "role", role: "text", name: "Publish" };
    if (variant === "fallback") step.locator.fallbacks = [{ by: "role", role: "text", name: "Publish" }];
    if (variant === "scope") step.locator.scope = { by: "role", role: "input" };
    assert.throws(() => parseProbePlan(invalid, packet()), /valid ARIA role/);
  }
});

test("Preparation ends in an initial-state assertion and cannot absorb the result assertion", () => {
  const prepared = plan();
  prepared.cases[0].steps.splice(1, 0, { op: "expectVisible", locator: { by: "role", role: "main" } });
  prepared.cases[0].setupStepCount = 2;
  assert.equal(parseProbePlan(toWireProbePlan(prepared)).cases[0].setupStepCount, 2);
  for (const count of [-1, 1.5, 3, 4]) {
    const invalid = structuredClone(prepared);
    invalid.cases[0].setupStepCount = count;
    assert.throws(() => parseProbePlan(invalid), /setupStepCount/);
  }
  const changed = structuredClone(prepared);
  changed.cases[0].setupStepCount = 0;
  assert.throws(() => assertLocatorOnlyRefinement(prepared, changed), /only locator/);
});

test("Deep links require exact public path evidence, including hash and query", () => {
  assert.doesNotThrow(() => parseProbePlan(plan(), packet()));
  for (const path of ["/items", "/login", "/items/42", "/#/items"]) {
    assert.throws(() => parseProbePlan(plan(path), packet()), /undeclared goto path.*start at \//);
  }
  for (const path of ["/items", "/#/items?tab=recent", "/item/42"]) {
    assert.doesNotThrow(() => parseProbePlan(plan(path), packet(`Open \`${path}\`.`)));
    assert.doesNotThrow(() => parseProbePlan(plan(path), packet(`Open https://example.invalid${path}.`)));
  }
  assert.throws(() => parseProbePlan(plan("/items"), packet("Open /items/42.")), /undeclared/);
  assert.throws(() => parseProbePlan(plan("/items"), packet("See ![view](/items).")), /undeclared/);
  const input = packet();
  input.prerequisites = [{ ...input.requirements[0], id: "P", text: "Open `/workspace`." }];
  assert.doesNotThrow(() => parseProbePlan(plan("/workspace"), input));
  const rootPath = packet();
  rootPath.requirements[0].product.description = "Open /workspace from the home page.";
  assert.doesNotThrow(() => parseProbePlan(plan("/workspace"), rootPath));
  rootPath.requirements[0].product.description = "See ![preview](/workspace).";
  assert.throws(() => parseProbePlan(plan("/workspace"), rootPath), /undeclared/);
});

test("Root product contract can ground a probe expectation", () => {
  assert.match(PROBE_PLAN_BODY.properties.cases.items.properties.expectationBasis.description, /ROOT product description/);
  const input = packet();
  input.requirements[0].product.description = "The workspace shows saved items.";
  const grounded = plan();
  grounded.cases[0].expectationBasis = ["The workspace shows saved items."];
  assert.doesNotThrow(() => parseProbePlan(grounded, input));
});

test("Spreadsheet plans require real file, menu, and clipboard setup", () => {
  const input = packet('A file control labeled "CSV file" imports CSV. The grid context menu provides "Paste".');
  input.requirements[0].product.kind = "spreadsheet";
  const csv = plan();
  csv.cases[0].expectationBasis = ["A file control labeled"];
  csv.cases[0].steps = [
    { op: "goto", path: "/" },
    { op: "fill", locator: { by: "label", text: "CSV file" }, value: "fixtures/data.csv" },
    { op: "expectVisible", locator: { by: "role", role: "main" } },
  ];
  assert.throws(() => parseProbePlan(csv, input), /requires uploadFile/);
  csv.cases[0].steps[1] = { op: "uploadFile", locator: { by: "label", text: "CSV file" },
    fileName: "data.csv", content: "Name,Value\nEast,1200" };
  assert.doesNotThrow(() => parseProbePlan(csv, input));
  csv.cases[0].steps[1] = { op: "uploadFile", locator: { by: "label", text: "CSV file" },
    fileName: "fixtures/data.csv", content: "Name,Value" };
  assert.throws(() => parseProbePlan(csv, input), /plain file name/);

  const paste = plan();
  paste.cases[0].expectationBasis = ["The grid context menu provides"];
  paste.cases[0].steps = [
    { op: "goto", path: "/" },
    { op: "click", locator: { by: "role", role: "menuitem", name: "Paste" } },
    { op: "expectVisible", locator: { by: "role", role: "main" } },
  ];
  assert.throws(() => parseProbePlan(paste, input), /requires rightClick/);
  paste.cases[0].steps[1] = { op: "click", locator: { by: "role", role: "button", name: "Paste",
    fallbacks: [{ by: "role", role: "menuitem", name: "Paste" }] } };
  assert.throws(() => parseProbePlan(paste, input), /requires rightClick/);
  paste.cases[0].steps.splice(1, 0, { op: "rightClick", locator: { by: "role", role: "gridcell", name: "D1" } });
  assert.throws(() => parseProbePlan(paste, input), /requires clipboard setup/);
  paste.cases[0].steps.splice(1, 0, { op: "setClipboardText", text: "East\t1200" });
  assert.doesNotThrow(() => parseProbePlan(paste, input));
  paste.cases[0].steps.splice(2, 0, { op: "drag", from: { by: "role", role: "gridcell", name: "A1" },
    to: { by: "role", role: "gridcell", name: "B2" } });
  assert.doesNotThrow(() => parseProbePlan(paste, input));
});

test("Refinement can change rendering but cannot replace a declared action with an error or unrelated control", () => {
  const original = plan();
  const target = [{ caseId: "publish", stepIndex: 1 }];
  const refined = plan();
  for (const locator of [
    { by: "text", text: "Not Found" },
    { by: "role", role: "button", name: "Login" },
    { by: "role", role: "button", name: "Unpublish" },
    { by: "role", role: "main" },
    { by: "text", text: "Not Found", scope: { by: "text", text: "Publish" } },
    { by: "role", role: "link", name: "Publish", fallbacks: [{ by: "text", text: "Not Found" }] },
  ] satisfies ProbeLocator[]) {
    refined.cases[0].steps[1] = { op: "click", locator };
    assert.throws(() => assertLocatorOnlyRefinement(original, refined, target, packet()), /requirement-grounded target/);
  }
  refined.cases[0].steps[1] = { op: "click", locator: { by: "role", role: "link", name: "Publish item", exact: true } };
  assert.doesNotThrow(() => assertLocatorOnlyRefinement(original, refined, target, packet()));
  // Guessed names can still be corrected when the requirement did not specify them.
  const unnamed = packet();
  unnamed.requirements[0].exactUiStrings = [];
  assert.doesNotThrow(() => assertLocatorOnlyRefinement(original, refined, target, unnamed));
});

test("Refinement cannot downgrade a named control to plain text (grader-style operability)", () => {
  // Modeled on the Keep-style grading contract: card actions must stay real
  // controls (card.getByRole('button', { name: /^Archive$/i })), a visible
  // "Archive" text node is not an operable Archive action.
  const keepPacket = packet('Archive a note from the note actions area and show an Undo notification.');
  keepPacket.requirements[0].exactUiStrings = ["Archive", "Undo"];
  const original: ProbePlan = { packetId: "packet-a", cases: [{ id: "archive-note", requirementIds: ["A"], purpose: "happy_path",
    expectationBasis: ["show an Undo notification"], steps: [
    { op: "goto", path: "/" },
    { op: "click", locator: { by: "role", role: "button", name: "Archive", exact: true } },
    { op: "expectVisible", locator: { by: "role", role: "button", name: "Undo", exact: true } },
  ] }] };
  const failedClick = [{ caseId: "archive-note", stepIndex: 1 }];

  const toText = structuredClone(original);
  toText.cases[0].steps[1] = { op: "click", locator: { by: "text", text: "Archive", exact: true } };
  assert.throws(() => assertLocatorOnlyRefinement(original, toText, failedClick, keepPacket), /downgrade.*plain text/);

  const toTextFallback = structuredClone(original);
  toTextFallback.cases[0].steps[1] = { op: "click", locator: { by: "text", text: "Archive", exact: true,
    fallbacks: [{ by: "text", text: "Archive note" }] } };
  assert.throws(() => assertLocatorOnlyRefinement(original, toTextFallback, failedClick, keepPacket), /downgrade.*plain text/);

  // Equivalent control renderings remain allowed: button -> link/menuitem with a named role candidate.
  const toLink = structuredClone(original);
  toLink.cases[0].steps[1] = { op: "click", locator: { by: "role", role: "link", name: "Archive", exact: true,
    fallbacks: [{ by: "role", role: "menuitem", name: "Archive", exact: true }] } };
  assert.doesNotThrow(() => assertLocatorOnlyRefinement(original, toLink, failedClick, keepPacket));

  // A field located by label may be refined to the same field's role form, not to bare text.
  const fieldPlan: ProbePlan = { packetId: "packet-a", cases: [{ id: "edit-note", requirementIds: ["A"], purpose: "happy_path",
    expectationBasis: ["show an Undo notification"], steps: [
    { op: "goto", path: "/" },
    { op: "fill", locator: { by: "label", text: "Note content", exact: true }, value: "Updated content" },
    { op: "expectVisible", locator: { by: "role", role: "button", name: "Undo", exact: true } },
  ] }] };
  const fieldToText = structuredClone(fieldPlan);
  fieldToText.cases[0].steps[1] = { op: "fill", locator: { by: "text", text: "Note content" }, value: "Updated content" };
  assert.throws(() => assertLocatorOnlyRefinement(fieldPlan, fieldToText, [{ caseId: "edit-note", stepIndex: 1 }]), /downgrade.*plain text/);
  const fieldToRole = structuredClone(fieldPlan);
  fieldToRole.cases[0].steps[1] = { op: "fill", locator: { by: "role", role: "textbox", name: "Note content", exact: true }, value: "Updated content" };
  assert.doesNotThrow(() => assertLocatorOnlyRefinement(fieldPlan, fieldToRole, [{ caseId: "edit-note", stepIndex: 1 }]));

  // Display-only targets (headings, status areas) assert visibility, so text is a legitimate refinement.
  const displayPlan = structuredClone(original);
  displayPlan.cases[0].steps[1] = { op: "expectVisible", locator: { by: "role", role: "heading", name: "Archived notes" } };
  const displayToText = structuredClone(displayPlan);
  displayToText.cases[0].steps[1] = { op: "expectVisible", locator: { by: "text", text: "Archived notes" } };
  assert.doesNotThrow(() => assertLocatorOnlyRefinement(displayPlan, displayToText, [{ caseId: "archive-note", stepIndex: 1 }], keepPacket));
});

test("Refinement keeps exact matching for requirement-declared names", () => {
  const keepPacket = packet('Archive a note from the note actions area and show an Undo notification.');
  keepPacket.requirements[0].exactUiStrings = ["Archive", "Undo"];
  const original: ProbePlan = { packetId: "packet-a", cases: [{ id: "archive-note", requirementIds: ["A"], purpose: "happy_path",
    expectationBasis: ["show an Undo notification"], steps: [
    { op: "goto", path: "/" },
    { op: "click", locator: { by: "role", role: "button", name: "Archive", exact: true } },
    { op: "expectVisible", locator: { by: "role", role: "button", name: "Undo", exact: true } },
  ] }] };
  const failedClick = [{ caseId: "archive-note", stepIndex: 1 }];

  // /^Archive$/i must not become a substring match: "Archive note" would pass a probe a grader fails.
  const droppedExact = structuredClone(original);
  droppedExact.cases[0].steps[1] = { op: "click", locator: { by: "role", role: "button", name: "Archive" } };
  assert.throws(() => assertLocatorOnlyRefinement(original, droppedExact, failedClick, keepPacket), /exact/);

  // Guessed (undeclared) names may still relax exactness, and exact candidates keep the match.
  const guessPacket = packet();
  guessPacket.requirements[0].exactUiStrings = [];
  assert.doesNotThrow(() => assertLocatorOnlyRefinement(original, droppedExact, failedClick, guessPacket));
  const keptExact = structuredClone(original);
  keptExact.cases[0].steps[1] = { op: "click", locator: { by: "role", role: "link", name: "Archive", exact: true } };
  assert.doesNotThrow(() => assertLocatorOnlyRefinement(original, keptExact, failedClick, keepPacket));
});

test("Grounded anchors keep declared names in original casing and ignore guesses", () => {
  assert.deepEqual(groundedLocatorAnchors(plan(), packet()), ["Publish"]);
  const unnamed = packet();
  unnamed.requirements[0].exactUiStrings = [];
  assert.deepEqual(groundedLocatorAnchors(plan(), unnamed), []);
});

test("State assertions round-trip through the wire schema and cannot be changed by refinement", () => {
  const original = plan();
  original.cases[0].steps.push(
    { op: "expectHidden", locator: { by: "role", role: "dialog" } },
    { op: "expectAttribute", locator: { by: "role", role: "button", name: "Toggle" }, attribute: "aria-expanded", value: "false" },
  );
  assert.deepEqual(parseProbePlan(toWireProbePlan(original), packet()), original);
  const changed = structuredClone(original);
  const last = changed.cases[0].steps.at(-1);
  if (last?.op !== "expectAttribute") assert.fail("expected state assertion");
  last.value = "true";
  assert.throws(() => assertLocatorOnlyRefinement(original, changed), /only locator fields/);
  for (const attribute of ["onclick", "innerHTML", "class", "data-result"]) {
    const invalid = toWireProbePlan({ ...original, cases: [{ ...original.cases[0], steps: [
      ...original.cases[0].steps.slice(0, -1),
      { ...last, attribute } as typeof last,
    ] }] });
    assert.throws(() => parseProbePlan(invalid), /allowed ARIA state/);
  }
});

test("Enabled-state assertions preserve their predicate and reject non-control candidates", () => {
  for (const op of ["expectDisabled", "expectEnabled"] as const) {
    const original = plan();
    original.cases[0].steps.push({ op, locator: { by: "role", role: "button", name: "Publish", exact: true } });
    assert.deepEqual(parseProbePlan(toWireProbePlan(original), packet()), original);
    const changed = structuredClone(original);
    changed.cases[0].steps[3] = { op: op === "expectDisabled" ? "expectEnabled" : "expectDisabled",
      locator: { by: "role", role: "button", name: "Publish", exact: true } };
    assert.throws(() => assertLocatorOnlyRefinement(original, changed), /only locator fields/);
    for (const locator of [
      { by: "text", text: "Publish", exact: true },
      { by: "role", role: "heading", name: "Publish" },
      { by: "role", role: "button", name: "Publish", fallbacks: [{ by: "text", text: "Publish" }] },
    ] satisfies ProbeLocator[]) {
      const invalid = structuredClone(original);
      invalid.cases[0].steps[3] = { op, locator };
      assert.throws(() => parseProbePlan(toWireProbePlan(invalid)), /interactive control, including fallbacks/);
    }
    original.cases[0].steps[3] = { op, locator: { by: "label", text: "Name", exact: true } };
    assert.doesNotThrow(() => parseProbePlan(toWireProbePlan(original)));
  }
});
