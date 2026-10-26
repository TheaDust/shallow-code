import { parseFeatureGrouping } from "./feature-grouper.js";
import { DEFAULT_FEATURE_GROUP_THRESHOLDS, requirementModuleId, requirementTextChars } from "./scheduler.js";
import type { RequirementCatalog } from "./types.js";

/** Structural facts for the grouper; dependency edges do not establish semantic coupling. */
export function validateGrouping(catalog: RequirementCatalog, proposal: unknown) {
  const grouping = parseFeatureGrouping(proposal, catalog);
  const positions = new Map(grouping.packets.flatMap((packet, index) =>
    packet.requirementIds.map(id => [id, index + 1] as const)));
  const groups = grouping.packets.map((packet, index) => ({
    group: index + 1,
    moduleId: requirementModuleId(packet.requirements[0]),
    requirementIds: packet.requirementIds,
    scenarioCount: packet.requirements.reduce((sum, item) => sum + item.scenarios.length, 0),
    textChars: packet.requirements.reduce((sum, item) => sum + requirementTextChars(item), 0),
  }));
  const crossGroupDependencies = catalog.requirements.flatMap(requirement =>
    requirement.dependencyIds.filter(id => positions.get(id) !== positions.get(requirement.id))
      .map(dependencyId => ({ dependencyId, requirementId: requirement.id,
        fromGroup: positions.get(dependencyId)!, toGroup: positions.get(requirement.id)! })));
  // Adjacent concatenation preserves the already-validated dependency order.
  const mergeableAdjacentGroups = groups.slice(1).flatMap((right, index) => {
    const left = groups[index];
    const limits = DEFAULT_FEATURE_GROUP_THRESHOLDS;
    if (left.moduleId !== right.moduleId
      || left.requirementIds.length + right.requirementIds.length > limits.maxRequirements
      || left.scenarioCount + right.scenarioCount > limits.maxScenarios
      || left.textChars + right.textChars > limits.maxTextChars) return [];
    return [{ groups: [left.group, right.group], requirementIds: [...left.requirementIds, ...right.requirementIds] }];
  });
  const seenModules = new Set<string>();
  const moduleRevisits = groups.flatMap((group, index) => {
    if (groups[index - 1]?.moduleId === group.moduleId) return [];
    const revisit = seenModules.has(group.moduleId);
    seenModules.add(group.moduleId);
    return revisit ? [{ moduleId: group.moduleId, group: group.group }] : [];
  });
  return { valid: true as const, stats: grouping.stats, groups, crossGroupDependencies,
    scenarioPrerequisites: grouping.scenarioPrerequisites.map(edge => ({ ...edge,
      fromGroup: positions.get(edge.prerequisiteId)!, toGroup: positions.get(edge.requirementId)! })),
    mergeableAdjacentGroups, moduleRevisits };
}
