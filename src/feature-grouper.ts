import type { RequirementCatalog } from "./types.js";
import { DEFAULT_FEATURE_GROUP_THRESHOLDS, featureGroupingFromIds,
  type FeatureGrouping, type FeatureGroupThresholds } from "./scheduler.js";
import type { PlannerUsageListener } from "./planner-json-client.js";

export interface FeatureGroupingOptions {
  timeoutMs: number;
  onUsage?: PlannerUsageListener;
  signal?: AbortSignal;
  feedback?: { validationError: string; cutOffByModel: boolean };
}

export interface FeatureGrouper {
  /** Returns an untrusted proposal; the controller validates it against Catalog. */
  group(catalog: RequirementCatalog, options: FeatureGroupingOptions): Promise<unknown>;
}

export const FEATURE_GROUPING_SCHEMA = {
  type: "object", additionalProperties: false, required: ["groups"], properties: {
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
): FeatureGrouping {
  const root = record(value, ["groups"], "Feature grouping");
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
  return { ...featureGroupingFromIds(catalog, ids, thresholds), purposes };
}

function record(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result)) if (!keys.includes(key)) throw new Error(`${label} has unsupported field: ${key}`);
  return result;
}
