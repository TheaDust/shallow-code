import type { RequirementCatalog } from "./types.js";
import { DEFAULT_FEATURE_GROUP_THRESHOLDS, featureGroupingFromIds,
  type FeatureGrouping, type FeatureGroupThresholds } from "./scheduler.js";
import type { UsageSummary } from "./model-usage.js";
import { scenarioStepPhases } from "./requirement-analysis.js";

export interface ScenarioPrerequisite {
  requirementId: string;
  scenarioId: string;
  stepIndex: number;
  prerequisiteId: string;
  prerequisiteQuote: string;
}

export type GrouperUsageListener = (usage: UsageSummary) => void | Promise<void>;

export interface FeatureGroupingOptions {
  timeoutMs: number;
  onUsage?: GrouperUsageListener;
  signal?: AbortSignal;
  feedback?: { validationError: string; cutOffByModel: boolean };
}

export interface FeatureGrouper {
  /** Returns an untrusted proposal; the controller validates it against Catalog. */
  group(catalog: RequirementCatalog, options: FeatureGroupingOptions): Promise<unknown>;
}

export const FEATURE_GROUPING_SCHEMA = {
  type: "object", additionalProperties: false, required: ["groups", "scenarioPrerequisites"], properties: {
    scenarioPrerequisites: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["requirementId", "scenarioId", "stepIndex", "prerequisiteId", "prerequisiteQuote"], properties: {
        requirementId: { type: "string" }, scenarioId: { type: "string" }, stepIndex: { type: "integer", minimum: 0 },
        prerequisiteId: { type: "string" }, prerequisiteQuote: { type: "string", minLength: 1 },
      } } },
    groups: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["requirementIds", "purpose"], properties: {
        requirementIds: { type: "array", minItems: 1, maxItems: DEFAULT_FEATURE_GROUP_THRESHOLDS.maxRequirements,
          items: { type: "string" } },
        purpose: { type: "string", minLength: 1, maxLength: 80 },
      } } },
  },
} as const;

export function parseFeatureGrouping(
  value: unknown,
  catalog: RequirementCatalog,
  thresholds: FeatureGroupThresholds = DEFAULT_FEATURE_GROUP_THRESHOLDS,
): FeatureGrouping & { scenarioPrerequisites: ScenarioPrerequisite[] } {
  const root = record(value, ["groups", "scenarioPrerequisites"], "Feature grouping");
  if (!Array.isArray(root.groups)) throw new Error("Feature grouping requires a groups array");
  const purposes: string[] = [];
  const ids = root.groups.map((value, index) => {
    const group = record(value, ["requirementIds", "purpose"], `Feature group ${index + 1}`);
    if (!Array.isArray(group.requirementIds) || !group.requirementIds.every(id => typeof id === "string")) {
      throw new Error(`Feature group ${index + 1} requires a string requirementIds array`);
    }
    if (typeof group.purpose !== "string" || !group.purpose.trim() || group.purpose.length > 80) {
      throw new Error(`Feature group ${index + 1} requires a purpose of 1..80 characters`);
    }
    purposes.push(group.purpose);
    return group.requirementIds as string[];
  });
  const grouping = featureGroupingFromIds(catalog, ids, thresholds);
  // Older recorded proposals contain groups only. New Pi proposals require the review field.
  const rawPrerequisites = root.scenarioPrerequisites === undefined ? [] : root.scenarioPrerequisites;
  if (!Array.isArray(rawPrerequisites)) throw new Error("scenarioPrerequisites must be an array");
  const positions = new Map(grouping.packets.flatMap(packet => packet.requirementIds).map((id, index) => [id, index]));
  const scenarioPrerequisites = rawPrerequisites.map(value => {
    const edge = record(value, ["requirementId", "scenarioId", "stepIndex", "prerequisiteId", "prerequisiteQuote"], "Scenario prerequisite");
    const requirement = catalog.requirements.find(item => item.id === edge.requirementId);
    const prerequisite = catalog.requirements.find(item => item.id === edge.prerequisiteId);
    if (!requirement || !prerequisite || requirement === prerequisite) throw new Error("Scenario prerequisite must link two distinct current requirements");
    const scenario = requirement.scenarioContracts?.find(item => item.id === edge.scenarioId);
    if (!scenario || !Number.isInteger(edge.stepIndex) || scenarioStepPhases(scenario)[edge.stepIndex as number] !== "given") {
      throw new Error("Scenario prerequisite must reference an original GIVEN step (including inherited AND/BUT)");
    }
    if (typeof edge.prerequisiteQuote !== "string" || !edge.prerequisiteQuote.trim() ||
      ![prerequisite.text, ...prerequisite.scenarios].some(text => text.includes(edge.prerequisiteQuote as string))) {
      throw new Error("Scenario prerequisite quote must be an exact excerpt from the prerequisite requirement");
    }
    if (positions.get(prerequisite.id)! >= positions.get(requirement.id)!) {
      throw new Error(`Scenario prerequisite ${prerequisite.id} must precede ${requirement.id} (${String(edge.scenarioId)} GIVEN step ${String(edge.stepIndex)})`);
    }
    return { requirementId: requirement.id, scenarioId: scenario.id, stepIndex: edge.stepIndex as number,
      prerequisiteId: prerequisite.id, prerequisiteQuote: edge.prerequisiteQuote };
  });
  return { ...grouping, purposes, scenarioPrerequisites };
}

function record(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result)) if (!keys.includes(key)) throw new Error(`${label} has unsupported field: ${key}`);
  return result;
}
