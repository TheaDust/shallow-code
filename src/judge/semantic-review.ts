import type { WorkPacket } from "../types.js";
import { outcomeKey, preservesOutcomeCoverage } from "./probe-coverage.js";
import {
  assertQuotesGrounded,
  parseProbePlan,
  probePlanSha256,
  requirementEvidenceTexts,
  PROBE_PLAN_BODY,
  PROBE_PLAN_JSON_SCHEMA,
  type ProbePlan,
  type ProbeCase,
} from "./probe-schema.js";

export interface PlanCorrection {
  caseId: string;
  conflict: string;
  basis: string[];
}

export type PlanReview =
  | { status: "sound"; rationale: string }
  | { status: "corrected"; rationale: string; plan: ProbePlan; corrections: PlanCorrection[] };

export interface PreparationReviewTargets {
  preparationOnlyCaseIds: readonly string[];
  caseCorrectionIds: readonly string[];
}

/** Preparation may evolve while the tested behavior, input and outcome stay fixed. */
export function sameCaseBehavior(before: ProbeCase, after: ProbeCase): boolean {
  return before.id === after.id && before.purpose === after.purpose &&
    JSON.stringify(before.requirementIds) === JSON.stringify(after.requirementIds) &&
    JSON.stringify(before.steps.slice(before.setupStepCount ?? 0)) ===
      JSON.stringify(after.steps.slice(after.setupStepCount ?? 0));
}

export function isPreparationOnlyCorrection(before: ProbeCase, after: ProbeCase): boolean {
  return (before.setupStepCount ?? 0) > 0 && (after.setupStepCount ?? 0) > 0 && sameCaseBehavior(before, after);
}

const MAX_RATIONALE = 2_000;
const MAX_CONFLICT = 1_000;
const MAX_QUOTE = 2_000;
const MAX_CORRECTIONS = 12;
const MAX_BASIS_QUOTES = 3;

const REVIEW_CORRECTION_METADATA = {
  caseId: { type: "string", minLength: 1 },
  conflict: { type: "string", minLength: 1, maxLength: MAX_CONFLICT },
  basis: { type: "array", minItems: 1, maxItems: MAX_BASIS_QUOTES, items: { type: "string", minLength: 1 } },
} as const;

export const PROBE_REVIEW_JSON_SCHEMA = {
  $defs: PROBE_PLAN_JSON_SCHEMA.$defs,
  type: "object",
  additionalProperties: false,
  required: ["verdict", "rationale"],
  properties: {
    verdict: { type: "string", enum: ["sound", "corrected"] },
    rationale: { type: "string", minLength: 1, maxLength: MAX_RATIONALE },
    corrections: {
      type: ["array", "null"],
      maxItems: MAX_CORRECTIONS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["caseId", "conflict", "basis", "case"],
        properties: {
          ...REVIEW_CORRECTION_METADATA,
          case: PROBE_PLAN_BODY.properties.cases.items,
        },
      },
    },
  },
} as const;

/** Preparation recovery returns prefixes; other failed cases may carry case corrections. */
export function preparationReviewJsonSchema(includeCaseCorrections = false): unknown {
  // Target IDs stay in the user payload to preserve the shared system prefix.
  const variants: unknown[] = [{
    type: "object", additionalProperties: false,
    required: ["caseId", "conflict", "basis", "setupSteps"],
    properties: {
      ...REVIEW_CORRECTION_METADATA,
      setupSteps: { ...PROBE_PLAN_BODY.properties.cases.items.properties.steps, minItems: 1 },
    },
  }];
  if (includeCaseCorrections) variants.push({
    type: "object", additionalProperties: false,
    required: ["caseId", "conflict", "basis", "case"],
    properties: {
      ...REVIEW_CORRECTION_METADATA,
      case: PROBE_PLAN_BODY.properties.cases.items,
    },
  });
  return {
    $defs: PROBE_PLAN_JSON_SCHEMA.$defs,
    type: "object", additionalProperties: false,
    required: ["verdict", "rationale"],
    properties: {
      verdict: PROBE_REVIEW_JSON_SCHEMA.properties.verdict,
      rationale: PROBE_REVIEW_JSON_SCHEMA.properties.rationale,
      corrections: { type: ["array", "null"], maxItems: MAX_CORRECTIONS, items: { anyOf: variants } },
    },
  };
}

export function parsePlanReview(
  value: unknown,
  packet: Pick<WorkPacket, "id" | "requirementIds"> & Partial<Pick<WorkPacket, "requirements" | "prerequisites">>,
  original: ProbePlan,
  preparationTargets?: PreparationReviewTargets,
): PlanReview {
  const response = record(value, "PlanReview");
  // Current protocol returns only affected cases. Accept the previous full-plan
  // shape when reading a legacy response so an in-flight gateway request cannot
  // fail solely because the controller was upgraded while it was pending.
  const localTargets = preparationTargets ?? (!Object.hasOwn(response, "plan") ? {
    preparationOnlyCaseIds: [], caseCorrectionIds: original.cases.map(item => item.id),
  } : undefined);
  const review = localTargets ? mergeLocalReview(response, original, localTargets) : response;
  keys(review, ["verdict", "rationale", "corrections", "plan"], "PlanReview");
  const rationale = boundedText(review.rationale, "PlanReview.rationale", MAX_RATIONALE);
  if (review.verdict === "sound") {
    if (review.corrections != null || review.plan != null) {
      throw new Error("PlanReview verdict sound must not carry corrections or a plan");
    }
    return { status: "sound", rationale };
  }
  if (review.verdict !== "corrected") throw new Error("PlanReview.verdict must be sound or corrected");
  if (review.plan == null) throw new Error("PlanReview verdict corrected requires a corrected plan");
  const plan = parseProbePlan({ ...original, ...record(review.plan, "PlanReview.plan"),
    uncoveredOutcomes: original.uncoveredOutcomes, navigationRecovered: original.navigationRecovered }, packet);
  const omitted = new Set(original.uncoveredOutcomes?.map(outcomeKey));
  for (const before of original.cases) {
    const after = plan.cases.find(item => item.id === before.id);
    if (!after) continue;
    const businessBefore = before.steps.slice(before.setupStepCount ?? 0);
    const usedAssertions = new Set(before.outcomeChecks?.flatMap(check =>
      check.assertionIndexes.map(index => JSON.stringify(businessBefore.slice(0, index + 1)))));
    const businessAfter = after.steps.slice(after.setupStepCount ?? 0);
    for (const check of after.outcomeChecks ?? []) {
      if (omitted.has(outcomeKey(check)) && check.assertionIndexes.every(index =>
        usedAssertions.has(JSON.stringify(businessAfter.slice(0, index + 1))))) {
        throw new Error("PlanReview must supply a distinct result assertion before resolving an omitted outcome");
      }
    }
  }
  if (plan.uncoveredOutcomes) plan.uncoveredOutcomes = plan.uncoveredOutcomes.filter(omission =>
    !plan.cases.some(item => item.outcomeChecks?.some(check => outcomeKey(check) === outcomeKey(omission))));
  if (probePlanSha256(plan) === probePlanSha256(original)) {
    throw new Error("PlanReview corrected plan must differ from the reviewed plan");
  }
  const correctionValues = array(review.corrections, "PlanReview.corrections");
  if (correctionValues.length === 0) throw new Error("PlanReview corrected verdict requires corrections");
  if (correctionValues.length > MAX_CORRECTIONS) {
    throw new Error(`PlanReview allows at most ${MAX_CORRECTIONS} corrections`);
  }
  const originalIds = new Set(original.cases.map(item => item.id));
  const correctedIds = new Set(plan.cases.map(item => item.id));
  const seen = new Set<string>();
  const corrections = correctionValues.map((item, index) => {
    const location = `PlanReview.corrections[${index}]`;
    const correction = record(item, location);
    keys(correction, ["caseId", "conflict", "basis"], location);
    const caseId = boundedText(correction.caseId, `${location}.caseId`, MAX_QUOTE);
    if (!originalIds.has(caseId) || !correctedIds.has(caseId)) {
      throw new Error(`${location}.caseId must name a case of the reviewed and corrected plans`);
    }
    if (seen.has(caseId)) throw new Error(`${location}.caseId is duplicated: ${caseId}`);
    seen.add(caseId);
    const conflict = boundedText(correction.conflict, `${location}.conflict`, MAX_CONFLICT);
    const basisValues = array(correction.basis, `${location}.basis`);
    if (basisValues.length === 0 || basisValues.length > MAX_BASIS_QUOTES) {
      throw new Error(`${location}.basis must carry 1-${MAX_BASIS_QUOTES} quotes`);
    }
    const basis = basisValues.map((quote, quoteIndex) => boundedText(quote, `${location}.basis[${quoteIndex}]`, MAX_QUOTE));
    if (packet.requirements) {
      const correctedCase = plan.cases.find(item => item.id === caseId);
      const scoped = packet.requirements.filter(item => correctedCase?.requirementIds.includes(item.id));
      assertQuotesGrounded(basis, requirementEvidenceTexts(scoped, packet.prerequisites ?? []), `${location}.basis`);
    }
    return { caseId, conflict, basis };
  });
  if (original.cases.length !== plan.cases.length || plan.cases.some(item => !originalIds.has(item.id))) {
    throw new Error("PlanReview must preserve the reviewed case set");
  }
  for (const before of original.cases) {
    const after = plan.cases.find(item => item.id === before.id)!;
    if (!preservesOutcomeCoverage(before, after)) throw new Error("PlanReview must preserve scenario outcome coverage");
    if (before.purpose !== after.purpose || JSON.stringify(before.requirementIds) !== JSON.stringify(after.requirementIds)) {
      throw new Error("PlanReview must preserve each case's purpose and requirementIds");
    }
    if (JSON.stringify(before) !== JSON.stringify(after) && !seen.has(before.id)) {
      throw new Error("PlanReview must cite a correction for every changed case");
    }
  }
  return { status: "corrected", rationale, plan, corrections };
}

/** Rebuild the plan locally so the model returns only affected cases. */
function mergeLocalReview(review: Record<string, unknown>, original: ProbePlan,
  targets: PreparationReviewTargets): Record<string, unknown> {
  keys(review, ["verdict", "rationale", "corrections"], "PlanReview");
  if (review.verdict !== "corrected") return review;
  const cases = new Map<string, unknown>(original.cases.map(item => [item.id, item]));
  const seen = new Set<string>();
  const corrections = array(review.corrections, "PlanReview.corrections").map((value, index) => {
    const location = `PlanReview.corrections[${index}]`;
    const correction = record(value, location);
    const caseId = boundedText(correction.caseId, `${location}.caseId`, MAX_QUOTE);
    const before = original.cases.find(item => item.id === caseId);
    if (!before) throw new Error(`${location}.caseId must name a case of the reviewed plan`);
    if (seen.has(caseId)) throw new Error(`${location}.caseId is duplicated: ${caseId}`);
    seen.add(caseId);
    if (targets.preparationOnlyCaseIds.includes(caseId)) {
      keys(correction, ["caseId", "conflict", "basis", "setupSteps"], location);
      const setupSteps = array(correction.setupSteps, `${location}.setupSteps`);
      if (!setupSteps.length) throw new Error(`${location}.setupSteps must include an initial-state assertion`);
      if (!before.setupStepCount) throw new Error(`${location} requires an existing preparation boundary`);
      cases.set(caseId, { ...before, setupStepCount: setupSteps.length,
        steps: [...setupSteps, ...before.steps.slice(before.setupStepCount)] });
    } else {
      if (!targets.caseCorrectionIds.includes(caseId)) throw new Error(`${location}.caseId is not a failed case eligible for correction`);
      keys(correction, ["caseId", "conflict", "basis", "case"], location);
      const correctedCase = record(correction.case, `${location}.case`);
      if (correctedCase.id !== caseId) throw new Error(`${location}.case.id must match caseId`);
      if (correctedCase.assertion == null) throw new Error(`${location}.case requires a terminal assertion`);
      cases.set(caseId, correctedCase);
    }
    return { caseId, conflict: correction.conflict, basis: correction.basis };
  });
  return { ...review, corrections, plan: { ...original,
    cases: original.cases.map(item => cases.get(item.id)) } };
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

function boundedText(value: unknown, location: string, limit: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > limit) {
    throw new Error(`${location} must be a non-empty string up to ${limit} characters`);
  }
  return value;
}

function keys(value: Record<string, unknown>, allowed: string[], location: string): void {
  const extra = Object.keys(value).find(key => !allowed.includes(key));
  if (extra) throw new Error(`${location} contains unsupported field: ${extra}`);
}
