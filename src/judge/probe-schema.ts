import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import type { AtomicRequirement, ProbeFailure, WorkPacket } from "../types.js";
import { validateOutcomeChecks, validateResultAssertionIndexes, type OutcomeCheck, type UncoveredOutcome } from "./probe-coverage.js";
import { validateHeadingContract } from "./heading-contract.js";
import { validateFirstMatchInstructions } from "./first-match.js";
import { maskRequirementLiterals, requirementSentences } from "../requirement-text.js";

export type ProbeScope =
  | { by: "role"; role: string; name?: string; exact?: boolean; hasText?: string }
  | { by: "label" | "text"; text: string; exact?: boolean; hasText?: string };

export type ProbeLocator = (
  | { by: "role"; role: string; name?: string; exact?: boolean; fallbacks?: ProbeLocator[] }
  | { by: "label"; text: string; exact?: boolean; fallbacks?: ProbeLocator[] }
  | { by: "text"; text: string; exact?: boolean; fallbacks?: ProbeLocator[] }) & {
    scope?: ProbeScope;
    /** Verbatim instruction selecting the first matching named control. */
    firstMatch?: string;
  };

export const PRESS_KEYS = [
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "ControlOrMeta+C",
  "ControlOrMeta+X",
  "ControlOrMeta+V",
  "Shift+F10",
] as const;

export const STATE_ATTRIBUTES = ["aria-expanded", "aria-pressed", "aria-selected", "aria-checked"] as const;
export const CSS_PROPERTIES = ["background-color"] as const;

export type ProbePressKey = (typeof PRESS_KEYS)[number];

export type ProbeStep =
  | { op: "goto"; path: string }
  | { op: "click"; locator: ProbeLocator }
  | { op: "rightClick"; locator: ProbeLocator }
  | { op: "drag"; from: ProbeLocator; to: ProbeLocator }
  | { op: "doubleClick"; locator: ProbeLocator }
  | { op: "hover"; locator: ProbeLocator }
  | { op: "press"; locator: ProbeLocator; key: ProbePressKey }
  | { op: "fill"; locator: ProbeLocator; value: string }
  | { op: "uploadFile"; locator: ProbeLocator; fileName: string; content: string }
  | { op: "setClipboardText"; text: string }
  | { op: "select"; locator: ProbeLocator; value: string }
  | { op: "setChecked"; locator: ProbeLocator; checked: boolean }
  | { op: "expectVisible"; locator: ProbeLocator }
  | { op: "expectHidden"; locator: ProbeLocator }
  | { op: "expectDisabled" | "expectEnabled"; locator: ProbeLocator }
  | { op: "expectAttribute"; locator: ProbeLocator; attribute: (typeof STATE_ATTRIBUTES)[number]; value: "true" | "false" | "mixed" }
  | ({ op: "expectCss"; locator: ProbeLocator; property: (typeof CSS_PROPERTIES)[number]; immediate?: boolean } &
    ({ value: string; notValue?: never; differentFrom?: never } | { notValue: string; value?: never; differentFrom?: never }
      | { differentFrom: ProbeLocator; value?: never; notValue?: never }))
  | { op: "expectText"; locator: ProbeLocator; text: string; exact?: boolean; anyOf?: string[] }
  | { op: "expectDownload"; locator: ProbeLocator; fileNameSuffix: string; text: string }
  | { op: "expectValue"; locator: ProbeLocator; value: string }
  | { op: "expectCount"; locator: ProbeLocator; count: number }
  | { op: "expectUrlContains"; value: string }
  | ({ op: "expectAccessibleCount"; noun: string; scope?: ProbeScope } &
    ({ exact: number; minimum?: never } | { minimum: number; exact?: never }))
  /** Controller-owned compatibility assertion. It is never accepted from Planner JSON. */
  | { op: "expectClosedOverlaysEmpty" }
  | { op: "expectAwayFromHome" }
  | { op: "expectFormContext"; locator: ProbeLocator; value: string }
  | { op: "reload" }
  | { op: "newContext"; actor?: string }
  | { op: "switchContext"; actor: string };

export interface ProbeCase {
  id: string;
  requirementIds: string[];
  purpose: "happy_path" | "persistence" | "negative" | "permission";
  /** Verbatim requirement-evidence quotes supporting the expected outcome (1-3). */
  expectationBasis: string[];
  /** Prefix ending in an assertion that establishes the scenario's initial state. */
  setupStepCount?: number;
  steps: ProbeStep[];
  outcomeChecks?: OutcomeCheck[];
}

export interface ProbePlan {
  packetId: string;
  cases: ProbeCase[];
  uncoveredOutcomes?: UncoveredOutcome[];
  /** Controller evidence, persisted with the recovered plan. */
  navigationRecovered?: boolean;
  /** Controller-owned completeness review state; never sent to the planner. */
  coverageReview?: "verified" | "pending";
}

export function isControllerCompatibilityStep(step: ProbeStep): boolean {
  return step.op === "expectClosedOverlaysEmpty" || step.op === "expectAwayFromHome" || step.op === "expectFormContext";
}

const MAX_CASES = 12;
const MAX_SETUP_STEPS = 15;
const MAX_BUSINESS_STEPS = 30;
const MAX_STEPS = MAX_SETUP_STEPS + MAX_BUSINESS_STEPS;
export const PROBE_LIMITS = { cases: MAX_CASES, setupSteps: MAX_SETUP_STEPS, businessSteps: MAX_BUSINESS_STEPS, totalSteps: MAX_STEPS };
export function probeCaseLimit(requirements: readonly AtomicRequirement[] = []): number {
  return Math.min(MAX_CASES, Math.max(6, requirements.reduce((count, item) => count + (item.scenarioContracts?.length ?? 0), 0)));
}
const MAX_STRING = 2_000;
const MAX_FALLBACKS = 3;
const MAX_TEXT_ALTERNATIVES = 4;
const MAX_BASIS_QUOTES = 3;

/** Roles accepted by Playwright getByRole; "text" is a locator kind, not a role. */
const ARIA_ROLES = [
  "alert", "alertdialog", "application", "article", "banner", "blockquote", "button", "caption", "cell",
  "checkbox", "code", "columnheader", "combobox", "complementary", "contentinfo", "definition", "deletion",
  "dialog", "directory", "document", "emphasis", "feed", "figure", "form", "generic", "grid", "gridcell",
  "group", "heading", "img", "insertion", "link", "list", "listbox", "listitem", "log", "main", "marquee",
  "math", "meter", "menu", "menubar", "menuitem", "menuitemcheckbox", "menuitemradio", "navigation", "none",
  "note", "option", "paragraph", "presentation", "progressbar", "radio", "radiogroup", "region", "row",
  "rowgroup", "rowheader", "scrollbar", "search", "searchbox", "separator", "slider", "spinbutton", "status",
  "strong", "subscript", "superscript", "switch", "tab", "table", "tablist", "tabpanel", "term", "textbox",
  "time", "timer", "toolbar", "tooltip", "tree", "treegrid", "treeitem",
] as const satisfies readonly Parameters<Page["getByRole"]>[0][];
const ARIA_ROLE_SCHEMA = { type: "string", enum: ARIA_ROLES };

const STRING_SCHEMA = { type: "string", maxLength: 2_000 };
const NONEMPTY_STRING_SCHEMA = { ...STRING_SCHEMA, minLength: 1 };
const OPTIONAL_STRING_SCHEMA = { type: ["string", "null"], maxLength: 2_000 };
const OPTIONAL_BOOLEAN_SCHEMA = { type: ["boolean", "null"] };

function objectSchema(properties: Record<string, unknown>) {
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

function literalSchema(value: string) {
  return { type: "string", enum: [value] };
}

const SCOPE_SCHEMA = {
  anyOf: [
    objectSchema({ by: literalSchema("role"), role: ARIA_ROLE_SCHEMA,
      name: OPTIONAL_STRING_SCHEMA, exact: OPTIONAL_BOOLEAN_SCHEMA, hasText: OPTIONAL_STRING_SCHEMA }),
    ...["label", "text"].map(by => objectSchema({ by: literalSchema(by), text: NONEMPTY_STRING_SCHEMA,
      exact: OPTIONAL_BOOLEAN_SCHEMA, hasText: OPTIONAL_STRING_SCHEMA })),
    { type: "null" },
  ],
};
const SCOPE_REF = { $ref: "#/$defs/scope" };

const LOCATOR_FLAT_SCHEMA = {
  anyOf: [
    objectSchema({
      by: literalSchema("role"), role: ARIA_ROLE_SCHEMA,
      name: OPTIONAL_STRING_SCHEMA, exact: OPTIONAL_BOOLEAN_SCHEMA, scope: SCOPE_REF, firstMatch: OPTIONAL_STRING_SCHEMA,
    }),
    ...["label", "text"].map((by) => objectSchema({
      by: literalSchema(by), text: NONEMPTY_STRING_SCHEMA, exact: OPTIONAL_BOOLEAN_SCHEMA, scope: SCOPE_REF, firstMatch: OPTIONAL_STRING_SCHEMA,
    })),
  ],
};
const LOCATOR_SCHEMA = {
  anyOf: [
    objectSchema({
      by: literalSchema("role"), role: ARIA_ROLE_SCHEMA,
      name: OPTIONAL_STRING_SCHEMA, exact: OPTIONAL_BOOLEAN_SCHEMA, scope: SCOPE_REF, firstMatch: OPTIONAL_STRING_SCHEMA,
      fallbacks: { type: ["array", "null"], maxItems: MAX_FALLBACKS, items: { $ref: "#/$defs/locatorFlat" } },
    }),
    ...["label", "text"].map((by) => objectSchema({
      by: literalSchema(by), text: NONEMPTY_STRING_SCHEMA, exact: OPTIONAL_BOOLEAN_SCHEMA, scope: SCOPE_REF, firstMatch: OPTIONAL_STRING_SCHEMA,
      fallbacks: { type: ["array", "null"], maxItems: MAX_FALLBACKS, items: { $ref: "#/$defs/locatorFlat" } },
    })),
  ],
};
const LOCATOR_REF = { $ref: "#/$defs/locator" };
const STEP_SCHEMA = {
  anyOf: [
    objectSchema({ op: literalSchema("goto"), path: NONEMPTY_STRING_SCHEMA }),
    ...["click", "rightClick", "expectVisible", "expectHidden", "doubleClick", "hover"].map((op) => objectSchema({
      op: literalSchema(op), locator: LOCATOR_REF,
    })),
    ...["expectDisabled", "expectEnabled"].map(op => objectSchema({
      op: literalSchema(op), locator: { ...LOCATOR_REF,
        description: "Check an interactive control's enabled/disabled state. Every candidate must use an interactive role or label; text locators are not permitted." },
    })),
    objectSchema({ op: literalSchema("drag"), from: LOCATOR_REF, to: LOCATOR_REF }),
    objectSchema({ op: literalSchema("uploadFile"), locator: LOCATOR_REF,
      fileName: NONEMPTY_STRING_SCHEMA, content: STRING_SCHEMA }),
    objectSchema({ op: literalSchema("expectDownload"), locator: LOCATOR_REF,
      fileNameSuffix: NONEMPTY_STRING_SCHEMA, text: STRING_SCHEMA }),
    objectSchema({ op: literalSchema("setClipboardText"), text: STRING_SCHEMA }),
    objectSchema({ op: literalSchema("setChecked"), locator: LOCATOR_REF, checked: { type: "boolean" } }),
    objectSchema({ op: literalSchema("expectAttribute"), locator: LOCATOR_REF,
      attribute: { type: "string", enum: [...STATE_ATTRIBUTES] },
      value: { type: "string", enum: ["true", "false", "mixed"] } }),
    objectSchema({ op: literalSchema("expectCss"), locator: LOCATOR_REF,
      property: { type: "string", enum: [...CSS_PROPERTIES] }, value: NONEMPTY_STRING_SCHEMA, immediate: OPTIONAL_BOOLEAN_SCHEMA }),
    objectSchema({ op: literalSchema("expectCss"), locator: LOCATOR_REF,
      property: { type: "string", enum: [...CSS_PROPERTIES] }, notValue: NONEMPTY_STRING_SCHEMA, immediate: OPTIONAL_BOOLEAN_SCHEMA }),
    objectSchema({ op: literalSchema("expectCss"), locator: LOCATOR_REF,
      property: { type: "string", enum: [...CSS_PROPERTIES] }, differentFrom: LOCATOR_REF, immediate: OPTIONAL_BOOLEAN_SCHEMA }),
    ...["fill", "select", "expectValue"].map((op) => objectSchema({
      op: literalSchema(op), locator: LOCATOR_REF, value: STRING_SCHEMA,
    })),
    objectSchema({
      op: literalSchema("press"), locator: LOCATOR_REF,
      key: { type: "string", enum: [...PRESS_KEYS] },
    }),
    objectSchema({
      op: literalSchema("expectText"), locator: LOCATOR_REF,
      text: STRING_SCHEMA, exact: OPTIONAL_BOOLEAN_SCHEMA,
      anyOf: { type: ["array", "null"], maxItems: MAX_TEXT_ALTERNATIVES, items: STRING_SCHEMA },
    }),
    objectSchema({
      op: literalSchema("expectCount"), locator: LOCATOR_REF,
      count: { type: "integer", minimum: 0 },
    }),
    objectSchema({ op: literalSchema("expectUrlContains"), value: NONEMPTY_STRING_SCHEMA }),
    objectSchema({ op: literalSchema("expectAccessibleCount"), noun: NONEMPTY_STRING_SCHEMA,
      scope: SCOPE_REF, exact: { type: "integer", minimum: 0 } }),
    objectSchema({ op: literalSchema("expectAccessibleCount"), noun: NONEMPTY_STRING_SCHEMA,
      scope: SCOPE_REF, minimum: { type: "integer", minimum: 0 } }),
    objectSchema({ op: literalSchema("reload") }),
    objectSchema({ op: literalSchema("newContext"), actor: { ...OPTIONAL_STRING_SCHEMA, minLength: 1 } }),
    objectSchema({ op: literalSchema("switchContext"), actor: NONEMPTY_STRING_SCHEMA }),
  ],
};

const OUTCOME_REF_SCHEMA = { scenarioId: NONEMPTY_STRING_SCHEMA, stepIndex: { type: "integer", minimum: 0 },
  clauseIndex: { type: ["integer", "null"], minimum: 0 } };

export const PROBE_PLAN_BODY = {
  type: "object",
  additionalProperties: false,
  required: ["packetId", "uncoveredOutcomes", "cases"],
  properties: {
    packetId: { type: "string" },
    uncoveredOutcomes: { type: "array", maxItems: 200, items: objectSchema({ ...OUTCOME_REF_SCHEMA, reason: NONEMPTY_STRING_SCHEMA }) },
    cases: {
      type: "array",
      minItems: 1,
      maxItems: MAX_CASES,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "requirementIds", "purpose", "setupStepCount", "expectationBasis", "outcomeChecks", "assertion", "steps"],
        properties: {
          id: { type: "string" },
          requirementIds: { type: "array", minItems: 1, items: { type: "string" } },
          purpose: {
            type: "string",
            enum: ["happy_path", "persistence", "negative", "permission"],
          },
          setupStepCount: { type: ["integer", "null"], minimum: 0, maximum: MAX_SETUP_STEPS,
            description: "Number of initial preparation steps, including a final initial-state assertion. Preparation failures are inconclusive; do not include the behavior being tested or its result assertion." },
          expectationBasis: {
            type: "array",
            minItems: 1,
            maxItems: MAX_BASIS_QUOTES,
            description:
              "1-3 verbatim quotes copied from the requirement evidence (ROOT product description, requirement text, scenarios, ancestor descriptions, exactUiStrings, seed items, or prerequisites) that justify this case's expected outcome. Quotes are validated as literal substrings.",
            items: NONEMPTY_STRING_SCHEMA,
          },
          outcomeChecks: { type: "array", maxItems: 200, items: objectSchema({ ...OUTCOME_REF_SCHEMA,
            assertionIndexes: { type: "array", minItems: 1, maxItems: MAX_BUSINESS_STEPS,
              items: { type: "integer", minimum: 0, maximum: MAX_BUSINESS_STEPS - 1 } } }),
            description: "Map every supplied scenarioOutcome (including each clauseIndex of a compound THEN) to zero-based assertion positions after setupStepCount. Null clauseIndex is allowed only for a single-clause source step." },
          assertion: { anyOf: STEP_SCHEMA.anyOf.filter(schema => {
            const op = schema.properties.op as { enum: string[] };
            return op.enum[0].startsWith("expect");
          }) },
          steps: {
            type: "array",
            minItems: 0,
            maxItems: MAX_STEPS - 1,
            description:
              "Allowed Planner op values: goto, click, rightClick, drag, doubleClick, hover, press, fill, uploadFile, setClipboardText, select, setChecked, expectVisible, expectHidden, expectDisabled, expectEnabled, expectAttribute, expectCss, expectText, expectDownload, expectValue, expectCount, expectUrlContains, expectAccessibleCount, reload, newContext, switchContext. Controller-owned compatibility operations are not available to Planner output. expectUrlContains is allowed only for an explicit page address/URL result. expectAccessibleCount requires one unique visible phrase containing the number and requirement-derived noun; optional flat scope identifies its entity and is frozen during locator refinement. expectCss supports only background-color with exactly one of value, notValue or differentFrom; immediate controls one read versus polling. The initial browser context is named default. newContext with actor creates and selects a retained named context; switchContext selects a previously created actor or default without changing application data. setChecked sets a checkbox/radio to checked=true/false without toggling an already correct state. uploadFile takes inline fileName/content, never a filesystem path. expectDownload clicks its interactive locator and checks the browser download's fileNameSuffix and UTF-8 text; text comparison normalizes CRLF to LF and accepts a UTF-8 BOM, with a 64 KiB download limit. Do not click the download control separately. drag takes from/to locators. press also permits ControlOrMeta+C/X/V and Shift+F10. Locators use role, label, or text only, with at most 3 ordered fallbacks describing other accessible renderings of the same control; fallbacks must not nest. Locator strings and expected text are literal, not regular expressions.",
            items: STEP_SCHEMA,
          },
        },
      },
    },
  },
} as const;

export const PROBE_PLAN_JSON_SCHEMA = {
  $defs: { locator: LOCATOR_SCHEMA, locatorFlat: LOCATOR_FLAT_SCHEMA, scope: SCOPE_SCHEMA },
  ...PROBE_PLAN_BODY,
} as const;

export const PROBE_REFINEMENT_JSON_SCHEMA = {
  $defs: PROBE_PLAN_JSON_SCHEMA.$defs,
  ...objectSchema({
    patches: { type: "array", maxItems: MAX_CASES * MAX_STEPS, items: objectSchema({
      caseId: NONEMPTY_STRING_SCHEMA,
      stepIndex: { type: "integer", minimum: 0, maximum: MAX_STEPS - 1 },
      locator: LOCATOR_REF,
    }) },
  }),
} as const;

export class NoLocatorProgressError extends Error {}

/** Apply valid failed-step locator patches; unresolved steps keep their original locators. */
export function applyLocatorPatches(original: ProbePlan, failures: readonly Pick<ProbeFailure, "caseId" | "stepIndex">[],
  value: unknown): ProbePlan {
  const response = record(value, "ProbeRefinement");
  keys(response, ["patches"], "ProbeRefinement");
  const patches = array(response.patches, "ProbeRefinement.patches");
  if (patches.length > MAX_CASES * MAX_STEPS) throw new Error("ProbeRefinement has too many patches");
  if (patches.length === 0) throw new NoLocatorProgressError("Refinement has no new locator candidate");
  const targets = new Set(failures.map(item => `${item.caseId}\0${item.stepIndex}`));
  const seen = new Set<string>();
  const refined = structuredClone(original);
  for (const [index, value] of patches.entries()) {
    const location = `ProbeRefinement.patches[${index}]`;
    const patch = record(value, location);
    keys(patch, ["caseId", "stepIndex", "locator"], location);
    const caseId = text(patch.caseId, `${location}.caseId`);
    const stepIndex = patch.stepIndex;
    if (!Number.isSafeInteger(stepIndex) || (stepIndex as number) < 0 || (stepIndex as number) >= MAX_STEPS) {
      throw new Error(`${location}.stepIndex must be a valid zero-based index`);
    }
    const target = `${caseId}\0${stepIndex}`;
    if (!targets.has(target)) throw new Error(`${location} does not target a failed locator step`);
    if (seen.has(target)) throw new Error(`${location} duplicates a locator patch`);
    seen.add(target);
    const step = refined.cases.find(item => item.id === caseId)?.steps[stepIndex as number];
    if (!step || !("locator" in step)) throw new Error(`${location} target has no locator`);
    step.locator = parseLocator(patch.locator, `${location}.locator`);
  }
  const parsed = parseProbePlan(refined);
  assertLocatorOnlyRefinement(original, parsed, failures);
  return parsed;
}

export function parseProbePlan(
  value: unknown,
  packet?: Pick<WorkPacket, "id" | "requirementIds"> & Partial<Pick<WorkPacket, "requirements" | "prerequisites">>,
): ProbePlan {
  const received = record(value, "ProbePlan");
  // Some JSON-mode gateways add a root id echo. It carries no probe behavior;
  // discard only the exact packetId duplicate, then apply the strict schema.
  const plan = received.id === received.packetId && typeof received.packetId === "string"
    ? Object.fromEntries(Object.entries(received).filter(([key]) => key !== "id"))
    : received;
  keys(plan, ["packetId", "cases", "uncoveredOutcomes", "navigationRecovered", "coverageReview"], "ProbePlan");
  const packetId = text(plan.packetId, "ProbePlan.packetId");
  if (packet && packetId !== packet.id) {
    throw new Error(`ProbePlan packetId ${packetId} does not match ${packet.id}`);
  }
  const caseValues = array(plan.cases, "ProbePlan.cases");
  if (caseValues.length === 0) throw new Error("ProbePlan requires at least one case");
  const caseLimit = packet?.requirements ? probeCaseLimit(packet.requirements) : MAX_CASES;
  if (caseValues.length > caseLimit) {
    throw new Error(`ProbePlan allows at most ${caseLimit} cases`);
  }
  const seen = new Set<string>();
  const cases = caseValues.map((candidate, index) => {
    const parsed = parseCase(candidate, index, packet?.requirementIds);
    if (seen.has(parsed.id)) throw new Error(`Duplicate case id: ${parsed.id}`);
    seen.add(parsed.id);
    return parsed;
  });
  if (packet) {
    const covered = new Set(cases.flatMap((probeCase) => probeCase.requirementIds));
    const missing = packet.requirementIds.filter((id) => !covered.has(id));
    if (missing.length > 0) throw new Error(`ProbePlan does not cover requirements: ${missing.join(", ")}`);
  }
  if (packet?.requirements) {
    for (const probeCase of cases) {
      const scoped = packet.requirements.filter(item => probeCase.requirementIds.includes(item.id));
      const evidence = [...scoped, ...(packet.prerequisites ?? [])];
      validateScenarioActions(probeCase, evidence);
      validateFirstMatchInstructions(probeCase, scoped, packet.prerequisites ?? []);
      validateOutcomeChecks(probeCase, scoped);
      validateExpectationGrounding(probeCase, evidence);
      validateHeadingContract(probeCase, scoped);
      const exactUiStrings = evidence.flatMap(requirement => requirement.exactUiStrings);
      for (const [stepIndex, step] of probeCase.steps.entries()) {
        const locators = "locator" in step ? [step.locator,
          ...(step.op === "expectCss" && step.differentFrom ? [step.differentFrom] : [])]
          : step.op === "drag" ? [step.from, step.to]
            : step.op === "expectAccessibleCount" && step.scope ? [{ by: "role", role: "generic", scope: step.scope } as ProbeLocator] : [];
        for (const locator of locators) {
          enforceGlobalSearchBannerScope(locator, { requirements: scoped, prerequisites: packet.prerequisites },
            `ProbePlan case ${probeCase.id} step ${stepIndex}`);
          assertDeclaredLocatorRole(locator, { requirements: scoped, prerequisites: packet.prerequisites },
            step.op, false, `ProbePlan case ${probeCase.id} step ${stepIndex}`, isHomeEntryStep(probeCase, stepIndex));
        }
        if (step.op === "goto" && step.path !== "/") {
          // A guessed server path cannot reach a hash-routed page. Only public
          // requirement text can authorize a deep link; never infer it from a name.
          const declaredPaths = evidence.flatMap(item => [item.product.description, item.text, ...item.scenarios, ...item.ancestors.map(ancestor => ancestor.description)])
            .flatMap(value => [...value.replace(/!\[[^\]]*\]\([^)]*\)/g, "").matchAll(/(?<![\w./])(?:https?:\/\/[^\s/]+)?(\/[^\s<>"'`，。；、（）\[\]()]+)/g)]
              .map(match => match[1].replace(/[.,;:!?]+$/, "")));
          if (!declaredPaths.includes(step.path)) {
            throw new Error(`ProbePlan case ${probeCase.id} step ${stepIndex}: undeclared goto path ${step.path}; start at / and use visible navigation`);
          }
        }
        const textTargets = "locator" in step ? [step.locator,
          ...(step.op === "expectCss" && step.differentFrom ? [step.differentFrom] : [])] : [];
        for (const target of textTargets) {
          if (target.by !== "text") continue;
          const literal = target.text;
          const declared = exactUiStrings.some((value) => value.toLowerCase() === literal.toLowerCase());
          const entered = probeCase.steps.slice(0, stepIndex).some((previous) =>
            previous.op === "fill" && previous.value === literal);
          // Inline seed prose can describe state without declaring visible text; keep its role/label fallback.
          const seeded = packet.requirements.some((requirement) => requirement.product.seedData
            .some((category) => category.items.includes(literal)));
          if (!declared && !entered && !seeded &&
            !target.fallbacks?.some((fallback) => fallback.by === "role" || fallback.by === "label")) {
            throw new Error(`ProbePlan case ${probeCase.id} step ${stepIndex}: unanchored text locator requires a role or label fallback; prefer a structural role when no UI label is declared`);
          }
        }
      }
      assertQuotesGrounded(probeCase.expectationBasis,
        requirementEvidenceTexts(scoped, packet.prerequisites),
        `ProbePlan case ${probeCase.id}.expectationBasis`);
    }
  }
  const uncoveredOutcomes = plan.uncoveredOutcomes == null ? undefined : array(plan.uncoveredOutcomes, "ProbePlan.uncoveredOutcomes")
    .map((value, index) => {
      const location = `ProbePlan.uncoveredOutcomes[${index}]`;
      const item = record(value, location);
      keys(item, ["scenarioId", "stepIndex", "clauseIndex", "reason"], location);
      const reason = text(item.reason, location);
      if (/browser context/i.test(reason) &&
        /(?:cannot switch back|can only operate on the current context|unable to (?:return|switch))/i.test(reason)) {
        throw new Error(`${location}.reason cannot claim browser-context switching is unavailable; use named newContext and switchContext`);
      }
      return { scenarioId: text(item.scenarioId, location), stepIndex: nonnegativeInteger(item.stepIndex, location),
        ...(item.clauseIndex == null ? {} : { clauseIndex: nonnegativeInteger(item.clauseIndex, location) }), reason };
    });
  if (uncoveredOutcomes && uncoveredOutcomes.length > 200) throw new Error("ProbePlan has too many uncovered outcomes");
  const coverageReview = plan.coverageReview == null ? undefined : text(plan.coverageReview, "ProbePlan.coverageReview");
  if (coverageReview !== undefined && coverageReview !== "verified" && coverageReview !== "pending") {
    throw new Error("ProbePlan.coverageReview must be verified or pending");
  }
  return { packetId, cases, ...(uncoveredOutcomes ? { uncoveredOutcomes } : {}),
    ...(plan.navigationRecovered == null ? {} : { navigationRecovered: boolean(plan.navigationRecovered, "ProbePlan.navigationRecovered") }),
    ...(coverageReview === undefined ? {} : { coverageReview }) };
}

function nonnegativeInteger(value: unknown, location: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${location} must be a nonnegative integer`);
  return value as number;
}

/** Wire cases require a final assertion; internal execution keeps a single ordered step list. */
export function toWireProbePlan(plan: ProbePlan): unknown {
  const { navigationRecovered: _navigationRecovered, coverageReview: _coverageReview, ...wire } = plan;
  return { ...wire, cases: plan.cases.map(item => {
    const last = item.steps.at(-1);
    if (!last?.op.startsWith("expect")) throw new Error("Wire cases must end in an assertion");
    return { ...item, setupStepCount: item.setupStepCount ?? null, steps: item.steps.slice(0, -1), assertion: last };
  }) };
}

export function probePlanSha256(plan: ProbePlan): string {
  const { coverageReview: _coverageReview, ...behavior } = plan;
  return createHash("sha256").update(JSON.stringify(parseProbePlan(behavior))).digest("hex");
}

export function locatorCandidates(locator: ProbeLocator): ProbeLocator[] {
  const { fallbacks, ...primary } = locator;
  return [primary, ...(fallbacks ?? [])];
}

function locatorKey(locator: ProbeLocator): string {
  const value = locator.by === "role" ? locator.name : locator.text;
  const normalized = value?.replace(/\s+/g, " ").trim();
  return JSON.stringify([locator.by, locator.by === "role" ? locator.role : null,
    locator.exact ? normalized : normalized?.toLowerCase(), locator.exact === true, locator.firstMatch !== undefined,
    locator.scope ? [locatorKey(locator.scope as ProbeLocator), locator.scope.hasText] : null]);
}

export function assertLocatorOnlyRefinement(
  original: ProbePlan,
  refined: ProbePlan,
  failures: readonly Pick<ProbeFailure, "caseId" | "stepIndex">[] = [],
  packet?: Pick<WorkPacket, "requirements" | "prerequisites">,
): void {
  if (original.packetId !== refined.packetId || original.cases.length !== refined.cases.length) {
    throw new Error("Refinement may change only locator fields");
  }

  if (JSON.stringify(original.uncoveredOutcomes) !== JSON.stringify(refined.uncoveredOutcomes) ||
    original.navigationRecovered !== refined.navigationRecovered) throw new Error("Refinement may change only locator fields");
  for (let caseIndex = 0; caseIndex < original.cases.length; caseIndex += 1) {
    const beforeCase = original.cases[caseIndex];
    const afterCase = refined.cases[caseIndex];
    if (
      beforeCase.id !== afterCase.id ||
      beforeCase.purpose !== afterCase.purpose ||
      beforeCase.setupStepCount !== afterCase.setupStepCount ||
      JSON.stringify(beforeCase.requirementIds) !== JSON.stringify(afterCase.requirementIds) ||
      JSON.stringify(beforeCase.expectationBasis) !== JSON.stringify(afterCase.expectationBasis) ||
      JSON.stringify(beforeCase.outcomeChecks) !== JSON.stringify(afterCase.outcomeChecks) ||
      beforeCase.steps.length !== afterCase.steps.length
    ) {
      throw new Error("Refinement may change only locator fields");
    }

    for (let stepIndex = 0; stepIndex < beforeCase.steps.length; stepIndex += 1) {
      const before = beforeCase.steps[stepIndex];
      const after = afterCase.steps[stepIndex];
      if (before.op !== after.op) throw new Error("Refinement may change only locator fields");

      const beforeBehavior = { ...before, ...("locator" in before ? { locator: undefined } : {}) };
      const afterBehavior = { ...after, ...("locator" in after ? { locator: undefined } : {}) };
      if (JSON.stringify(beforeBehavior) !== JSON.stringify(afterBehavior)) {
        throw new Error("Refinement may change only locator fields");
      }
      if ("locator" in before && "locator" in after && JSON.stringify(before.locator) !== JSON.stringify(after.locator)) {
        const anchors = packet ? groundedLocatorNames(before.locator, packet) : [];
        if (anchors.length && locatorCandidates(after.locator).some(candidate => {
          const name = candidate.by === "role" ? candidate.name : candidate.text;
          return !name || !anchors.some(anchor => containsTargetName(name, anchor));
        })) {
          throw new Error("Refinement must preserve the requirement-grounded target name; an unrelated visible element is not a replacement");
        }
        assertRefinementKeepsStrength(before.locator, after.locator);
        if (packet) {
          const evidence = { ...packet, requirements: packet.requirements.filter(item => beforeCase.requirementIds.includes(item.id)) };
          const homeEntry = isHomeEntryStep(beforeCase, stepIndex);
          const roles = declaredLocatorRoles(before.locator, evidence, before.op, false, homeEntry);
          const wrongRole = roles.length ? locatorCandidates(after.locator).find(candidate =>
            !matchesDeclaredLocatorRole(candidate, roles)) : undefined;
          if (wrongRole) {
            throw new Error(`Refinement case ${beforeCase.id} step ${stepIndex}: Refinement must preserve the requirement-declared role: ${roles.join(" or ")}; locator=${JSON.stringify(wrongRole)}`);
          }
          assertDeclaredLocatorRole(after.locator, evidence, after.op, false, `Refinement case ${beforeCase.id} step ${stepIndex}`, homeEntry);
        }
        if (anchors.length && before.locator.exact === true &&
          locatorCandidates(after.locator).some(candidate => candidate.exact !== true)) {
          throw new Error("Refinement must keep exact matching for requirement-declared names; a grader anchors on the exact name");
        }
      }
    }
  }

  let improved = false;
  for (const failure of failures) {
    const before = original.cases.find((item) => item.id === failure.caseId)?.steps[failure.stepIndex];
    const after = refined.cases.find((item) => item.id === failure.caseId)?.steps[failure.stepIndex];
    if (!before || !after || !("locator" in before) || !("locator" in after)) {
      throw new Error(`Refinement failure target ${failure.caseId} step ${failure.stepIndex} has no locator`);
    }
    const exhausted = new Set(locatorCandidates(before.locator).map(locatorKey));
    if (locatorCandidates(after.locator).some((candidate) => !exhausted.has(locatorKey(candidate)))) improved = true;
  }
  if (failures.length > 0 && !improved) {
    const targets = failures.map(item => `${item.caseId} step ${item.stepIndex}`).join(", ");
    throw new NoLocatorProgressError(`Refinement must introduce a new locator candidate for at least one failed step (${targets}); unchanged, reordered, or equivalent candidates were already exhausted`);
  }
}

/**
 * Roles a grader treats as operable controls. A refinement may swap equivalent
 * renderings (button ↔ link ↔ menuitem) but must not downgrade a named control
 * to plain text — visible text is not an operable control, and such a downgrade
 * would let the probe pass on evidence a strict grader rejects. Display-only
 * roles (heading, status, dialog, …) may still be refined to text, since they
 * assert visibility rather than operability.
 */
const INTERACTIVE_ROLES = new Set([
  "button", "link", "menuitem", "tab", "checkbox", "radio", "option",
  "switch", "textbox", "searchbox", "combobox", "spinbutton", "slider",
]);

function assertRefinementKeepsStrength(before: ProbeLocator, after: ProbeLocator): void {
  const candidates = locatorCandidates(after);
  if (locatorCandidates(before).some(candidate => candidate.scope?.by === "role" && candidate.scope.role === "banner") &&
    candidates.some(candidate => candidate.scope?.by !== "role" || candidate.scope.role !== "banner" || candidate.scope.name)) {
    throw new Error("Refinement must preserve the banner scope of a declared global control");
  }
  if (candidates.some(candidate => candidate.firstMatch !== before.firstMatch)) {
    throw new Error("Refinement must preserve firstMatch selection; it cannot resolve ordinary ambiguity by selecting the first match");
  }
  if (before.by === "role" && before.name !== undefined && INTERACTIVE_ROLES.has(before.role) &&
    !candidates.some(candidate => candidate.by === "role")) {
    throw new Error(
      "Refinement must not downgrade a named interactive-role locator to plain text; keep a named role candidate for the same control (button/link/menuitem swaps are allowed)");
  }
  if (before.by === "role" && before.name !== undefined && INTERACTIVE_ROLES.has(before.role) &&
    candidates.some(candidate => candidate.by === "role" && !INTERACTIVE_ROLES.has(candidate.role))) {
    throw new Error("Refinement must preserve the interactive control role; a same-named container is a different target");
  }
  if (before.by === "label" &&
    !candidates.some(candidate => candidate.by === "label" || candidate.by === "role")) {
    throw new Error(
      "Refinement must not downgrade a label locator to plain text; keep a label or role candidate for the same control");
  }
}

function normalizeName(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function containsTargetName(value: string, anchor: string): boolean {
  // Normalize the anchor here too: callers may pass requirement text in original casing.
  const escaped = normalizeName(anchor).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // "Publish item" still names the action; "Unpublish" does not.
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "u").test(normalizeName(value));
}

/** Requirement-declared UI names, normalized for comparison. */
function declaredRequirementNames(packet: Pick<WorkPacket, "requirements" | "prerequisites">): Set<string> {
  return new Set([...packet.requirements, ...(packet.prerequisites ?? [])]
    .flatMap(item => item.exactUiStrings).map(normalizeName));
}

function candidateTargetName(candidate: ProbeLocator): string | undefined {
  return candidate.by === "role" ? candidate.name : candidate.text;
}

/**
 * A requirement-declared top global search is a page landmark contract, not just
 * a conveniently named input. Keep this invariant deterministic because an
 * unscoped searchbox still passes when a header is incorrectly nested in main,
 * while grader entry helpers address the control through the banner landmark.
 */
function enforceGlobalSearchBannerScope(locator: ProbeLocator,
  packet: Pick<WorkPacket, "requirements" | "prerequisites">, location: string): void {
  for (const candidate of [locator, ...(locator.fallbacks ?? [])]) {
    const name = candidateTargetName(candidate);
    if (!name) continue;
    const declaredRoles = declaredLocatorRoles(candidate, packet);
    const isSearchControl = candidate.by === "role" && ["search", "searchbox"].includes(candidate.role) ||
      declaredRoles.some(role => ["search", "searchbox"].includes(role));
    if (!isSearchControl) continue;
    const isDeclaredGlobalSearch = declaredGlobalSearchControls(packet).some(control =>
      normalizeName(control.name) === normalizeName(name));
    if (!isDeclaredGlobalSearch) continue;
    if (!candidate.scope) {
      candidate.scope = { by: "role", role: "banner" };
      continue;
    }
    if (candidate.scope.by !== "role" || candidate.scope.role !== "banner" || candidate.scope.name) {
      throw new Error(`${location}: requirement-declared global search must be scoped to the banner landmark`);
    }
  }
}

/** Explicit names and roles only; quoted data cannot declare a global control. */
export function declaredGlobalSearchControls(packet: Pick<WorkPacket, "requirements" | "prerequisites">):
  Array<{ name: string; role: "searchbox"; evidence: string }> {
  const controls = new Map<string, { name: string; role: "searchbox"; evidence: string }>();
  for (const text of requirementEvidenceTexts(packet.requirements, packet.prerequisites)) {
    for (const sentence of requirementSentences(text.replace(/\r?\n/g, " "))) {
      if (!/\bglobal(?:\s+[\w-]+){0,2}\s+search\b/i.test(maskRequirementLiterals(sentence))) continue;
      for (const literal of sentence.matchAll(/`([^`]+)`|"([^"\n]+)"|“([^”]+)”/g)) {
        const name = literal[1] ?? literal[2] ?? literal[3];
        const roles = declaredLocatorRoles({ by: "role", role: "searchbox", name }, packet, "fill");
        if (roles.length === 1 && roles[0] === "searchbox") {
          controls.set(normalizeName(name), { name, role: "searchbox", evidence: sentence });
        }
      }
    }
  }
  return [...controls.values()];
}

/** Explicit requirement labels anchor both refinement and missing-control diagnostics. */
export function groundedLocatorNames(locator: ProbeLocator, packet: Pick<WorkPacket, "requirements" | "prerequisites">): string[] {
  const declared = declaredRequirementNames(packet);
  return locatorCandidates(locator).flatMap(candidate => {
    const name = candidateTargetName(candidate);
    return name && declared.has(normalizeName(name)) ? [normalizeName(name)] : [];
  });
}

/**
 * Requirement-declared names the plan already relies on, in original casing.
 * Refinement must reuse them verbatim; names outside this list are planner guesses.
 */
export function groundedLocatorAnchors(plan: ProbePlan, packet: Pick<WorkPacket, "requirements" | "prerequisites">): string[] {
  const declared = declaredRequirementNames(packet);
  const seen = new Set<string>();
  const anchors: string[] = [];
  for (const probeCase of plan.cases) {
    for (const step of probeCase.steps) {
      if (!("locator" in step)) continue;
      for (const candidate of locatorCandidates(step.locator)) {
        const name = candidateTargetName(candidate);
        const normalized = name === undefined ? "" : normalizeName(name);
        if (name === undefined || !declared.has(normalized) || seen.has(normalized)) continue;
      seen.add(normalized);
      anchors.push(name);
      }
    }
  }
  return anchors;
}

/** Requirement, ancestor, scenario, exact-label and seed texts a basis quote may cite. */
export function requirementEvidenceTexts(
  requirements: readonly AtomicRequirement[],
  prerequisites: readonly AtomicRequirement[] = [],
): string[] {
  return [...requirements, ...prerequisites].flatMap(item => [
    item.product.description,
    item.text,
    ...item.scenarios,
    ...(item.scenarioContracts ?? []).flatMap(scenario => [scenario.name, ...scenario.steps.map(step => step.content)]),
    ...item.ancestors.map(ancestor => ancestor.description),
    ...item.exactUiStrings,
    ...item.product.seedData.flatMap(category => category.items),
  ]);
}

export function assertQuotesGrounded(quotes: readonly string[], evidence: readonly string[], location: string): void {
  const normalized = evidence.map(value => value.replace(/\s+/g, " ").trim().toLowerCase());
  for (const [index, quote] of quotes.entries()) {
    const needle = quote.replace(/\s+/g, " ").trim().toLowerCase();
    if (needle.length === 0 || !normalized.some(item => item.includes(needle))) {
      throw new Error(`${location}[${index}] must quote the requirement evidence verbatim: ${quote.slice(0, 80)}`);
    }
  }
}

function parseCase(
  value: unknown,
  index: number,
  allowedRequirementIds?: string[],
): ProbeCase {
  const location = `ProbePlan.cases[${index}]`;
  const candidate = record(value, location);
  keys(candidate, ["id", "requirementIds", "purpose", "steps", "assertion", "expectationBasis", "setupStepCount", "outcomeChecks"], location);
  const id = text(candidate.id, `${location}.id`);
  const requirementIds = array(candidate.requirementIds, `${location}.requirementIds`).map(
    (item, requirementIndex) =>
      text(item, `${location}.requirementIds[${requirementIndex}]`),
  );
  if (requirementIds.length === 0) {
    throw new Error(`${location}.requirementIds must not be empty`);
  }
  if (
    allowedRequirementIds &&
    requirementIds.some((requirementId) => !allowedRequirementIds.includes(requirementId))
  ) {
    throw new Error(`${location} references requirement outside packet`);
  }
  const purpose = candidate.purpose;
  if (
    purpose !== "happy_path" &&
    purpose !== "persistence" &&
    purpose !== "negative" &&
    purpose !== "permission"
  ) {
    throw new Error(`${location}.purpose is invalid`);
  }
  const basisValues = array(candidate.expectationBasis, `${location}.expectationBasis`);
  if (basisValues.length === 0) throw new Error(`${location}.expectationBasis must not be empty`);
  if (basisValues.length > MAX_BASIS_QUOTES) {
    throw new Error(`${location} allows at most ${MAX_BASIS_QUOTES} expectationBasis quotes`);
  }
  const expectationBasis = basisValues.map((item, basisIndex) =>
    text(item, `${location}.expectationBasis[${basisIndex}]`));
  const stepValues = [...array(candidate.steps, `${location}.steps`)];
  if (candidate.assertion !== undefined) {
    const assertion = parseStep(candidate.assertion, `${location}.assertion`);
    if (!assertion.op.startsWith("expect")) throw new Error(`${location}.assertion must be an assertion`);
    stepValues.push(assertion);
  }
  if (stepValues.length === 0) throw new Error(`${location} requires at least one step`);
  if (stepValues.length > MAX_STEPS) {
    throw new Error(`${location} allows at most ${MAX_STEPS} steps`);
  }
  if (stepValues.length - Number(candidate.setupStepCount ?? 0) > MAX_BUSINESS_STEPS) {
    throw new Error(`${location} allows at most ${MAX_BUSINESS_STEPS} steps after preparation`);
  }
  const steps = stepValues.map((step, stepIndex) =>
    parseStep(step, `${location}.steps[${stepIndex}]`),
  );
  validateContextReferences(steps, location);
  if (!steps.some((step) => step.op.startsWith("expect"))) {
    throw new Error(`${location} requires at least one assertion`);
  }
  const setupStepCount = candidate.setupStepCount ?? 0;
  if (!Number.isSafeInteger(setupStepCount) || (setupStepCount as number) < 0 || (setupStepCount as number) >= steps.length) {
    throw new Error(`${location}.setupStepCount must leave the tested behavior and its assertion outside preparation`);
  }
  if (setupStepCount && !steps[(setupStepCount as number) - 1].op.startsWith("expect")) {
    throw new Error(`${location}.setupStepCount must end preparation with an initial-state assertion`);
  }
  if (!steps.slice(setupStepCount as number).some(step => step.op.startsWith("expect"))) {
    throw new Error(`${location} requires a result assertion after preparation`);
  }
  if ((setupStepCount as number) > MAX_SETUP_STEPS) throw new Error(`${location} allows at most ${MAX_SETUP_STEPS} preparation steps`);
  if (steps.length - (setupStepCount as number) > MAX_BUSINESS_STEPS) throw new Error(`${location} allows at most ${MAX_BUSINESS_STEPS} steps after preparation`);
  const outcomeChecks = candidate.outcomeChecks == null ? undefined : array(candidate.outcomeChecks, `${location}.outcomeChecks`).map((value, index) => {
    const position = `${location}.outcomeChecks[${index}]`;
    const item = record(value, position);
    keys(item, ["scenarioId", "stepIndex", "clauseIndex", "assertionIndexes"], position);
    return { scenarioId: text(item.scenarioId, position), stepIndex: nonnegativeInteger(item.stepIndex, position),
      ...(item.clauseIndex == null ? {} : { clauseIndex: nonnegativeInteger(item.clauseIndex, position) }),
      assertionIndexes: array(item.assertionIndexes, `${position}.assertionIndexes`).map((value, assertionIndex) =>
        nonnegativeInteger(value, `${position}.assertionIndexes[${assertionIndex}]`)) };
  });
  if (outcomeChecks && outcomeChecks.length > 200) throw new Error(`${location} has too many outcome checks`);
  if (outcomeChecks?.some(item => item.assertionIndexes.length > MAX_BUSINESS_STEPS)) {
    throw new Error(`${location}.outcomeChecks allows at most ${MAX_BUSINESS_STEPS} assertion indexes per outcome`);
  }
  validateResultAssertionIndexes({ steps, setupStepCount: setupStepCount as number, outcomeChecks }, location);
  return { id, requirementIds, purpose, expectationBasis, steps,
    ...(outcomeChecks ? { outcomeChecks } : {}),
    ...(setupStepCount ? { setupStepCount: setupStepCount as number } : {}) };
}

/** Keep assertion-only DSL extensions tied to public requirement evidence. */
function validateExpectationGrounding(probeCase: ProbeCase, evidence: readonly AtomicRequirement[]): void {
  const texts = requirementEvidenceTexts(evidence);
  const joined = texts.join("\n");
  const normalized = joined.replace(/\s+/g, " ").toLowerCase();
  const behavior = evidence.flatMap(item => [item.product.description, item.text, ...item.scenarios,
    ...(item.scenarioContracts ?? []).flatMap(scenario => scenario.steps.map(step => step.content)),
    ...item.ancestors.map(ancestor => ancestor.description)]).join("\n");
  const hasAddressContract = /\b(?:page\s+)?(?:address|url)\b/i.test(maskRequirementLiterals(behavior));
  const entered = new Set(probeCase.steps.flatMap(step =>
    step.op === "fill" || step.op === "select" ? [step.value.toLowerCase()] : []));
  for (const [index, step] of probeCase.steps.entries()) {
    const location = `ProbePlan case ${probeCase.id} step ${index}`;
    if (step.op === "expectUrlContains") {
      const value = step.value.trim().toLowerCase();
      if (!hasAddressContract) throw new Error(`${location}: expectUrlContains requires an explicit page address/URL contract`);
      if (!value || !/[\p{L}\p{N}]/u.test(value) || (!normalized.includes(value) && !entered.has(value))) {
        throw new Error(`${location}: expectUrlContains value must come from requirement evidence or a prior scenario input`);
      }
    }
    if (step.op === "expectAccessibleCount") {
      const noun = step.noun.toLowerCase();
      const singular = noun.endsWith("s") ? noun.slice(0, -1) : noun;
      const declared = normalized.includes(noun) || normalized.includes(singular);
      const hasCountContract = /\b(?:count|number|total|decrements?|increments?|updated)\b/i.test(maskRequirementLiterals(joined));
      if (!declared || !hasCountContract) {
        throw new Error(`${location}: expectAccessibleCount requires a requirement-declared noun and count behavior`);
      }
    }
  }
}

/** Reject plans whose stated setup cannot reach the action being tested. */
function validateScenarioActions(probeCase: ProbeCase, evidence: readonly AtomicRequirement[]): void {
  const description = evidence.flatMap(item => [item.text, ...item.scenarios]).join(" ");
  const fileLabels = [...description.matchAll(/file control labeled\s*[“"']([^”"']+)[”"']/gi)]
    .map(match => match[1].toLowerCase());
  const spreadsheet = evidence.some(item => item.product.kind === "spreadsheet");
  let contextMenuOpen = false;
  let clipboardReady = false;
  for (const [index, step] of probeCase.steps.entries()) {
    const location = `ProbePlan case ${probeCase.id} step ${index}`;
    if (step.op === "goto" || step.op === "reload" || step.op === "newContext" || step.op === "switchContext") contextMenuOpen = false;
    if (step.op === "newContext" || step.op === "switchContext") clipboardReady = false;
    if (step.op === "rightClick" || (step.op === "press" && step.key === "Shift+F10")) contextMenuOpen = true;
    if (step.op === "setClipboardText" || (step.op === "press" &&
      (step.key === "ControlOrMeta+C" || step.key === "ControlOrMeta+X"))) clipboardReady = true;
    if (step.op === "fill" && fileLabels.length > 0 && locatorCandidates(step.locator).some(candidate => {
      const name = candidate.by === "role" ? candidate.name : candidate.by === "label" ? candidate.text : undefined;
      return name !== undefined && fileLabels.includes(name.toLowerCase());
    })) {
      throw new Error(`${location}: file control requires uploadFile, not fill`);
    }
    if (step.op === "press" && step.key === "ControlOrMeta+V" && !clipboardReady) {
      throw new Error(`${location}: paste requires clipboard setup or a prior copy/cut action`);
    }
    if (step.op !== "click" || !spreadsheet) continue;
    const menuCandidate = locatorCandidates(step.locator).find(candidate =>
      candidate.by === "role" && candidate.role === "menuitem");
    const name = menuCandidate?.by === "role" ? menuCandidate.name : undefined;
    const contextAction = name === "Paste" || name === "Copy" || name === "Cut" ||
      name === "Insert 1 row above" || name === "Insert 1 row below" || name === "Delete row" ||
      name === "Insert 1 column left" || name === "Insert 1 column right" || name === "Delete column";
    if (!contextAction) continue;
    if (!contextMenuOpen) throw new Error(`${location}: ${name} menuitem requires rightClick on its target`);
    if (name === "Paste" && !clipboardReady) {
      throw new Error(`${location}: Paste requires clipboard setup or a prior copy/cut action`);
    }
    if (name === "Copy" || name === "Cut") clipboardReady = true;
    contextMenuOpen = false;
  }
}

/** Context switches may only address the initial context or an earlier named context. */
function validateContextReferences(steps: readonly ProbeStep[], location: string): void {
  const actors = new Set(["default"]);
  for (const [index, step] of steps.entries()) {
    if (step.op === "newContext" && step.actor) {
      if (actors.has(step.actor)) throw new Error(`${location}.steps[${index}] duplicates browser context actor ${step.actor}`);
      actors.add(step.actor);
    }
    if (step.op === "switchContext" && !actors.has(step.actor)) {
      throw new Error(`${location}.steps[${index}] references unknown browser context actor ${step.actor}`);
    }
  }
}

function parseStep(value: unknown, location: string): ProbeStep {
  const step = record(value, location);
  const op = text(step.op, `${location}.op`);
  switch (op) {
    case "goto": {
      keys(step, ["op", "path"], location);
      const path = text(step.path, `${location}.path`);
      if (
        !path.startsWith("/") ||
        path.startsWith("//") ||
        /[\\\u0000-\u0020\u007f]/.test(path) ||
        /(^|\/)\.\.(\/|$)/.test(path) ||
        /^[a-z][a-z0-9+.-]*:/i.test(path)
      ) {
        throw new Error(`${location} ProbePlan goto path must stay on the app origin`);
      }
      return { op, path };
    }
    case "click":
    case "rightClick":
    case "doubleClick":
    case "hover":
    case "expectHidden":
    case "expectVisible": {
      keys(step, ["op", "locator"], location);
      return { op, locator: parseLocator(step.locator, `${location}.locator`) };
    }
    case "expectDisabled":
    case "expectEnabled": {
      keys(step, ["op", "locator"], location);
      const locator = parseLocator(step.locator, `${location}.locator`);
      if (locatorCandidates(locator).some(candidate => candidate.by !== "label" &&
        (candidate.by !== "role" || !INTERACTIVE_ROLES.has(candidate.role)))) {
        throw new Error(`${location}: ${op} requires role or label locators for an interactive control, including fallbacks`);
      }
      return { op, locator };
    }
    case "drag": {
      keys(step, ["op", "from", "to"], location);
      return { op, from: parseLocator(step.from, `${location}.from`),
        to: parseLocator(step.to, `${location}.to`) };
    }
    case "uploadFile": {
      keys(step, ["op", "locator", "fileName", "content"], location);
      const fileName = text(step.fileName, `${location}.fileName`);
      if (fileName.length > 200 || fileName === "." || fileName === ".." || /[\\/\u0000-\u001f\u007f]/.test(fileName)) {
        throw new Error(`${location}.fileName must be a plain file name`);
      }
      const content = dataText(step.content, `${location}.content`);
      return { op, locator: parseLocator(step.locator, `${location}.locator`), fileName, content };
    }
    case "setClipboardText": {
      keys(step, ["op", "text"], location);
      const clipboardText = dataText(step.text, `${location}.text`);
      return { op, text: clipboardText };
    }
    case "expectAttribute": {
      keys(step, ["op", "locator", "attribute", "value"], location);
      const attribute = step.attribute;
      const value = step.value;
      if (!STATE_ATTRIBUTES.includes(attribute as (typeof STATE_ATTRIBUTES)[number]) ||
        (value !== "true" && value !== "false" && value !== "mixed")) {
        throw new Error(`${location}: expectAttribute requires an allowed ARIA state and true/false/mixed value`);
      }
      return { op, locator: parseLocator(step.locator, `${location}.locator`),
        attribute: attribute as (typeof STATE_ATTRIBUTES)[number], value };
    }
    case "expectCss": {
      keys(step, ["op", "locator", "property", "value", "notValue", "differentFrom", "immediate"], location);
      if (!CSS_PROPERTIES.includes(step.property as (typeof CSS_PROPERTIES)[number])) {
        throw new Error(`${location}: expectCss only supports background-color`);
      }
      const base = { op, locator: parseLocator(step.locator, `${location}.locator`),
        property: step.property as (typeof CSS_PROPERTIES)[number],
        ...(step.immediate == null ? {} : { immediate: boolean(step.immediate, `${location}.immediate`) }) } as const;
      if ([step.value, step.notValue, step.differentFrom].filter(value => value != null).length !== 1) {
        throw new Error(`${location}: expectCss requires exactly one of value, notValue or differentFrom`);
      }
      return step.value != null ? { ...base, value: text(step.value, `${location}.value`) }
        : step.notValue != null ? { ...base, notValue: text(step.notValue, `${location}.notValue`) }
          : { ...base, differentFrom: parseLocator(step.differentFrom, `${location}.differentFrom`) };
    }
    case "setChecked": {
      keys(step, ["op", "locator", "checked"], location);
      if (typeof step.checked !== "boolean") throw new Error(`${location}.checked must be boolean`);
      const locator = parseLocator(step.locator, `${location}.locator`);
      if (locatorCandidates(locator).some(candidate => candidate.by !== "label" &&
        (candidate.by !== "role" || !["checkbox", "radio"].includes(candidate.role)))) {
        throw new Error(`${location}: setChecked requires checkbox/radio roles or labels, including fallbacks`);
      }
      return { op, locator, checked: step.checked };
    }
    case "press": {
      keys(step, ["op", "locator", "key"], location);
      const key = step.key;
      if (typeof key !== "string" || !PRESS_KEYS.includes(key as ProbePressKey)) {
        throw new Error(`${location}.key must be one of: ${PRESS_KEYS.join(", ")}`);
      }
      return {
        op,
        locator: parseLocator(step.locator, `${location}.locator`),
        key: key as ProbePressKey,
      };
    }
    case "fill":
    case "select":
    case "expectValue": {
      keys(step, ["op", "locator", "value"], location);
      return {
        op,
        locator: parseLocator(step.locator, `${location}.locator`),
        value: dataText(step.value, `${location}.value`),
      };
    }
    case "expectText": {
      keys(step, ["op", "locator", "text", "exact", "anyOf"], location);
      let anyOf: string[] | undefined;
      if (step.anyOf != null) {
        const values = array(step.anyOf, `${location}.anyOf`);
        if (values.length > MAX_TEXT_ALTERNATIVES) {
          throw new Error(`${location} allows at most ${MAX_TEXT_ALTERNATIVES} anyOf candidates`);
        }
        anyOf = values.map((item, index) => dataText(item, `${location}.anyOf[${index}]`));
      }
      return {
        op,
        locator: parseLocator(step.locator, `${location}.locator`),
        text: dataText(step.text, `${location}.text`),
        ...(step.exact == null ? {} : { exact: boolean(step.exact, `${location}.exact`) }),
        ...(anyOf?.length ? { anyOf } : {}),
      };
    }
    case "expectCount": {
      keys(step, ["op", "locator", "count"], location);
      const count = step.count;
      if (!Number.isSafeInteger(count) || (count as number) < 0) {
        throw new Error(`${location}.count must be a non-negative integer`);
      }
      return {
        op,
        locator: parseLocator(step.locator, `${location}.locator`),
        count: count as number,
      };
    }
    case "expectUrlContains": {
      keys(step, ["op", "value"], location);
      return { op, value: dataText(step.value, `${location}.value`) };
    }
    case "expectAccessibleCount": {
      keys(step, ["op", "noun", "exact", "minimum", "scope"], location);
      if ((step.exact != null) === (step.minimum != null)) {
        throw new Error(`${location}: expectAccessibleCount requires exactly one of exact or minimum`);
      }
      const noun = text(step.noun, `${location}.noun`).trim();
      if (!noun || /\d/.test(noun)) throw new Error(`${location}.noun must be a requirement-derived count noun without a number`);
      const field = step.exact != null ? "exact" : "minimum";
      const count = step[field];
      if (!Number.isSafeInteger(count) || (count as number) < 0) {
        throw new Error(`${location}.${field} must be a non-negative integer`);
      }
      const scope = step.scope == null ? {} : { scope: parseScope(step.scope, `${location}.scope`) };
      return field === "exact" ? { op, noun, exact: count as number, ...scope } : { op, noun, minimum: count as number, ...scope };
    }
    case "expectFormContext": {
      keys(step, ["op", "locator", "value"], location);
      return { op, locator: parseLocator(step.locator, `${location}.locator`), value: dataText(step.value, `${location}.value`) };
    }
    case "expectAwayFromHome":
    case "expectClosedOverlaysEmpty": {
      keys(step, ["op"], location);
      return { op };
    }
    case "expectDownload": {
      keys(step, ["op", "locator", "fileNameSuffix", "text"], location);
      const locator = parseLocator(step.locator, `${location}.locator`);
      if (locatorCandidates(locator).some(candidate => candidate.by !== "label" &&
        (candidate.by !== "role" || !INTERACTIVE_ROLES.has(candidate.role)))) {
        throw new Error(`${location}: expectDownload requires role or label locators for an interactive control, including fallbacks`);
      }
      return { op, locator, fileNameSuffix: text(step.fileNameSuffix, `${location}.fileNameSuffix`),
        text: dataText(step.text, `${location}.text`) };
    }
    case "reload":
      keys(step, ["op"], location);
      return { op };
    case "newContext":
      keys(step, ["op", "actor"], location);
      return {
        op,
        ...(step.actor == null ? {} : { actor: text(step.actor, `${location}.actor`) }),
      };
    case "switchContext":
      keys(step, ["op", "actor"], location);
      return { op, actor: text(step.actor, `${location}.actor`) };
    default:
      throw new Error(`${location} ProbePlan operation is not allowed: ${op}`);
  }
}

function parseLocator(value: unknown, location: string, allowFallbacks = true): ProbeLocator {
  const locator = record(value, location);
  const by = text(locator.by, `${location}.by`);
  let base: ProbeLocator;
  if (by === "role") {
    keys(locator, ["by", "role", "name", "exact", "fallbacks", "scope", "firstMatch"], location);
    const role = text(locator.role, `${location}.role`);
    if (!(ARIA_ROLES as readonly string[]).includes(role)) {
      throw new Error(`${location}.role must be a valid ARIA role; use by:text for body text, not role ${role}`);
    }
    base = {
      by,
      role,
      ...(locator.name == null ? {} : { name: dataText(locator.name, `${location}.name`) }),
      ...(locator.exact == null
        ? {}
        : { exact: boolean(locator.exact, `${location}.exact`) }),
    };
  } else if (by === "label" || by === "text") {
    keys(locator, ["by", "text", "exact", "fallbacks", "scope", "firstMatch"], location);
    base = {
      by,
      text: text(locator.text, `${location}.text`),
      ...(locator.exact == null
        ? {}
        : { exact: boolean(locator.exact, `${location}.exact`) }),
    };
  } else {
    throw new Error(`${location} ProbePlan locator must use role, label, or text`);
  }
  if (locator.firstMatch != null) {
    const name = base.by === "role" ? base.name : base.text;
    if (!name || base.exact !== true || base.by === "text" || (base.by === "role" && !INTERACTIVE_ROLES.has(base.role))) {
      throw new Error(`${location}.firstMatch requires an exact named interactive role or label`);
    }
    base = { ...base, firstMatch: text(locator.firstMatch, `${location}.firstMatch`) };
  }
  if (locator.scope != null) {
    base = { ...base, scope: parseScope(locator.scope, `${location}.scope`) };
  }
  if (locator.fallbacks == null) return base;
  if (!allowFallbacks) throw new Error(`${location} fallbacks must not be nested`);
  const fallbackValues = array(locator.fallbacks, `${location}.fallbacks`);
  if (fallbackValues.length > MAX_FALLBACKS) {
    throw new Error(`${location} allows at most ${MAX_FALLBACKS} fallbacks`);
  }
  if (fallbackValues.length === 0) return base;
  const fallbacks = fallbackValues.map((item, index) =>
    parseLocator(item, `${location}.fallbacks[${index}]`, false),
  );
  if (fallbacks.some(item => item.firstMatch !== base.firstMatch)) {
    throw new Error(`${location} fallbacks must preserve firstMatch selection`);
  }
  return { ...base, fallbacks };
}

function parseScope(value: unknown, location: string): ProbeScope {
  const { hasText, ...target } = record(value, location);
  if ("scope" in target || "fallbacks" in target || "firstMatch" in target) throw new Error(`${location} must be flat`);
  const parsed = parseLocator(target, location, false);
  return { ...parsed, ...(hasText == null ? {} : { hasText: text(hasText, `${location}.hasText`) }) };
}

const CONTROL_OPERATIONS = new Set<ProbeStep["op"]>([
  "click", "rightClick", "doubleClick", "hover", "press", "fill", "select", "setChecked", "uploadFile", "drag", "expectDownload",
]);

/** Identify the initial home-page entry, before navigation or form input. */
export function isHomeEntryStep(probeCase: Pick<ProbeCase, "steps">, stepIndex: number): boolean {
  for (let index = stepIndex - 1; index >= 0; index--) {
    const step = probeCase.steps[index];
    if (step.op === "goto") return step.path === "/";
    if (!step.op.startsWith("expect") && step.op !== "reload") return false;
  }
  return false;
}

function canonicalRolePhrase(value: string): string {
  return value.replace(/\bnavigation\s+link\b/gi, "link").replace(/\bmenu\s+item\b/gi, "menuitem")
    .replace(/\bconfirmation\s+button\b/gi, "button");
}

/** Bind each role to its named referent; a popup's role does not define its same-named trigger. */
export function declaredLocatorRoles(locator: ProbeLocator, packet: Pick<WorkPacket, "requirements" | "prerequisites">,
  operation?: ProbeStep["op"], scopeRole = false, homeEntry?: boolean): string[] {
  const name = candidateTargetName(locator);
  if (!name) return [];
  const role = `(?:${ARIA_ROLES.join("|")})`;
  const roleList = `${role}(?:\\s+or\\s+${role})*`;
  const before = new RegExp(`\\b(${roleList})(?:\\s+role)?\\s+(?:(?:containing|(?:is\\s+)?named|(?:(?:whose|with)\\s+(?:the\\s+)?)?accessible\\s+name(?:\\s+(?:is|matches))?|and\\s+accessible\\s+name)\\s+)?(?:\\s*(?:#+\\s+)?(?:or|and)\\s*)*$`, "i");
  const after = new RegExp(`^\\s*(${roleList})\\b`, "i");
  const scoped = new RegExp(`\\b(?:in|within|inside)\\s+(?:the\\s+)?(?:${role}\\s+(?:named\\s+)?)?(?:\"([^\"\\n]+)\"|“([^”]+)”|\x60([^\x60]+)\x60)`, "gi");
  const scopeName = locator.scope && candidateTargetName(locator.scope as ProbeLocator);
  const homeScope = !locator.scope || locator.scope.by === "role" && !locator.scope.name &&
    ["main", "banner", "navigation"].includes(locator.scope.role);
  const roles = new Set<string>();
  let untypedTrigger = false;
  let untypedHomeEntry = false;
  for (const text of requirementEvidenceTexts(packet.requirements, packet.prerequisites)) {
    for (const sentence of requirementSentences(text.replace(/\r?\n/g, " "))) {
      const containers = [...sentence.matchAll(scoped)].map(match => match[1] ?? match[2] ?? match[3]);
      const matchesScope = !containers.length || !!scopeName && containers.some(value => normalizeName(value) === normalizeName(scopeName));
      for (const literal of sentence.matchAll(/`([^`]+)`|"([^"\n]+)"|“([^”]+)”/g)) {
        if (normalizeName(literal[1] ?? literal[2] ?? literal[3]) !== normalizeName(name)) continue;
        // A quoted ARIA keyword followed by `role` is syntax, not a UI name.
        // Preserve it before masking names such as the button and its dialog.
        const rolePrefix = sentence.slice(0, literal.index).replace(
          new RegExp(`(?:\x60(${role})\x60|"(${role})"|“(${role})”)\\s+role\\b`, "gi"),
          (_match, backtick: string, quoted: string, curly: string) => `${backtick ?? quoted ?? curly} role`);
        const prefix = canonicalRolePhrase(maskRequirementLiterals(rolePrefix));
        const rawSuffix = sentence.slice(literal.index! + literal[0].length);
        const suffix = canonicalRolePhrase(maskRequirementLiterals(rawSuffix));
        // In `a "Style" option named "Red fill"`, option binds Red fill. It
        // does not turn the separately named Style field into an option.
        const roleNamesFollowingLiteral = /^\s*option\s+named\s+(?:`|"|“)/i.test(rawSuffix);
        const binding = before.exec(prefix)?.[1] ?? (roleNamesFollowingLiteral ? undefined : after.exec(suffix)?.[1]);
        const boundRoles = binding?.toLowerCase().split(/\s+or\s+/) ?? [];
        const popup = boundRoles.length > 0 && boundRoles.every(role => ["menu", "dialog", "alertdialog", "listbox"].includes(role));
        if ((!binding || popup) && (!scopeName || matchesScope) && /\b(?:clicks?|chooses?|activates?|press(?:es)?|opens?)\s+(?:(?:the|a|an)\s+)?$/i.test(prefix)) {
          untypedTrigger = true;
        }
        // An untyped home-page entry is separate from its same-named form submit.
        // Keep explicitly scoped controls and button-role refinements strict.
        if (!binding && homeScope &&
          /\b(?:enter|enters|access|accesses|reach|reaches)\b[^;.!?]*\b(?:page|screen|view|workspace)\s+(?:from|via|through)\s+(?:[#\s,]|\band\b|\bor\b)*$/i.test(prefix) &&
          /\bon\s+(?:the\s+)?(?:home page|homepage)\b/i.test(suffix)) untypedHomeEntry = true;
        if (matchesScope) for (const value of boundRoles) roles.add(value);
      }
    }
  }
  const namedControl = locator.by !== "role" || INTERACTIVE_ROLES.has(locator.role);
  const containerRoles = [...roles].filter(role => !INTERACTIVE_ROLES.has(role));
  const headingOnly = containerRoles.length > 0 && containerRoles.every(role => role === "heading");
  // A page heading and an observed same-named list/region are separate
  // referents. Heading evidence must constrain a heading target, but must not
  // be projected onto a container used only as a refinement scope.
  if (scopeRole && locator.by === "role" && locator.role !== "heading" && headingOnly) return [];
  if (!namedControl && (scopeRole || operation?.startsWith("expect") && containerRoles.length)) return containerRoles;
  const controlQuery = operation && CONTROL_OPERATIONS.has(operation) ||
    operation?.startsWith("expect") && locator.by === "role" && INTERACTIVE_ROLES.has(locator.role);
  if (controlQuery) {
    if (untypedHomeEntry && locator.by === "role" && ["link", "button"].includes(locator.role) &&
      (homeEntry ?? locator.role === "link") && !roles.has("link")) return [];
    const controls = [...roles].filter(role => INTERACTIVE_ROLES.has(role));
    // A display-only heading does not declare the role of a same-named entry.
    // Explicit interactive roles still constrain every candidate and fallback.
    if (controls.length || untypedTrigger || namedControl && headingOnly) return controls;
  }
  return [...roles];
}

/** Labeled form controls retain the DSL's native label-query semantics. */
export function matchesDeclaredLocatorRole(locator: ProbeLocator, roles: readonly string[]): boolean {
  if (locator.by === "role") return roles.includes(locator.role);
  return locator.by === "label" && roles.every(role =>
    ["textbox", "searchbox", "combobox", "spinbutton", "checkbox", "radio", "switch", "slider"].includes(role));
}

function assertDeclaredLocatorRole(locator: ProbeLocator, packet: Pick<WorkPacket, "requirements" | "prerequisites">,
  operation?: ProbeStep["op"], scopeRole = false, location?: string, homeEntry?: boolean): void {
  const roles = declaredLocatorRoles(locator, packet, operation, scopeRole, homeEntry);
  const candidates = locatorCandidates(locator);
  const wrongRole = roles.length ? candidates.find(candidate => !matchesDeclaredLocatorRole(candidate, roles)) : undefined;
  if (wrongRole) {
    throw new Error(`${location ? `${location}: ` : ""}Locator must preserve the requirement-declared role: ${roles.join(" or ")}; locator=${JSON.stringify(wrongRole)}`);
  }
  if (!roles.length && operation && candidates.some(candidate => candidate.by === "role" && !INTERACTIVE_ROLES.has(candidate.role)) &&
    declaredLocatorRoles(locator, packet).some(role => !INTERACTIVE_ROLES.has(role))) {
    throw new Error(`${location ? `${location}: ` : ""}Locator fallbacks must refer to the trigger control, not its same-named popup`);
  }
  for (const candidate of candidates) {
    if (candidate.scope) assertDeclaredLocatorRole(candidate.scope as ProbeLocator, packet, undefined, true,
      location ? `${location}.scope` : undefined);
  }
}

function record(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${location} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, location: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${location} must be an array`);
  return value;
}

function text(value: unknown, location: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_STRING) {
    throw new Error(`${location} must be a non-empty string up to ${MAX_STRING} characters`);
  }
  return value;
}

function dataText(value: unknown, location: string): string {
  if (typeof value !== "string" || value.length > MAX_STRING) {
    throw new Error(`${location} must be a string up to ${MAX_STRING} characters`);
  }
  return value;
}

function boolean(value: unknown, location: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${location} must be a boolean`);
  return value;
}

function keys(
  value: Record<string, unknown>,
  allowed: string[],
  location: string,
): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra) throw new Error(`${location} contains unsupported ProbePlan field: ${extra}`);
}
