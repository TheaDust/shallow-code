import type { AtomicRequirement, GroupingStats, RequirementCatalog, WorkPacket } from "./types.js";

/**
 * Deterministic feature-slice grouping (design doc 2026-09-15 §3.2):
 * atomic requirements are packed into bounded groups by walking declaration
 * order, seeding with the first schedulable item, then extending the group
 * with schedulable items from the same direct parent folder, then the same
 * ROOT subtree, preferring candidates that share dependency edges with the
 * current group. Groups close on size/scenario/text thresholds; a single
 * oversized item forms its own group. Dependencies never span packets out
 * of order: every dependency is scheduled earlier or appears earlier in the
 * same group.
 */
export interface FeatureGroupThresholds {
  maxRequirements: number;
  maxScenarios: number;
  maxTextChars: number;
}

export const DEFAULT_FEATURE_GROUP_THRESHOLDS: FeatureGroupThresholds = {
  maxRequirements: 4,
  maxScenarios: 12,
  maxTextChars: 20_000,
};

export interface FeatureGrouping {
  packets: WorkPacket[];
  stats: GroupingStats;
  /** Model explanations are diagnostics, never Builder contracts. */
  purposes?: string[];
}

export function requirementTextChars(requirement: AtomicRequirement): number {
  return requirement.text.length + requirement.scenarios.reduce((total, scenario) => total + scenario.length, 0);
}

interface SchedulableRequirement {
  requirement: AtomicRequirement;
  moduleId: string;
  parentId: string;
  textChars: number;
}

export function featureGroupPackets(
  catalog: RequirementCatalog,
  thresholds: FeatureGroupThresholds = DEFAULT_FEATURE_GROUP_THRESHOLDS,
): FeatureGrouping {
  const items: SchedulableRequirement[] = catalog.requirements.map(requirement => ({
    requirement,
    moduleId: requirement.folderPath[1] ?? requirement.id,
    parentId: requirement.folderPath[requirement.folderPath.length - 1] ?? requirement.id,
    textChars: requirementTextChars(requirement),
  }));
  const scheduled = new Set<string>();
  const packets: WorkPacket[] = [];

  const schedulable = (item: SchedulableRequirement): boolean =>
    !scheduled.has(item.requirement.id) &&
    item.requirement.dependencyIds.every(dependency => scheduled.has(dependency));

  while (scheduled.size < items.length) {
    const seed = items.find(schedulable);
    if (!seed) {
      const stuck = items.filter(item => !scheduled.has(item.requirement.id)).map(item => item.requirement.id);
      throw new Error(`No schedulable requirement remains (dependency cycle?): ${stuck.join(", ")}`);
    }
    const group: SchedulableRequirement[] = [seed];
    scheduled.add(seed.requirement.id);
    let scenarioCount = seed.requirement.scenarios.length;
    let textChars = seed.textChars;
    let closedByThreshold = group.length >= thresholds.maxRequirements
      || scenarioCount >= thresholds.maxScenarios
      || textChars >= thresholds.maxTextChars;

    while (!closedByThreshold) {
      const groupIds = new Set(group.map(member => member.requirement.id));
      const groupDependencies = new Set(group.flatMap(member => member.requirement.dependencyIds));
      const affinity = (candidate: SchedulableRequirement): number => {
        let score = 0;
        for (const dependency of candidate.requirement.dependencyIds) {
          if (groupIds.has(dependency)) score += 2;
          else if (groupDependencies.has(dependency)) score += 1;
        }
        return score;
      };
      const tier = (candidate: SchedulableRequirement): number =>
        candidate.parentId === seed.parentId ? 0 : candidate.moduleId === seed.moduleId ? 1 : 2;
      const candidates = items
        .filter(item => schedulable(item) && tier(item) < 2)
        .sort((left, right) =>
          tier(left) - tier(right)
          || affinity(right) - affinity(left)
          || left.requirement.declarationIndex - right.requirement.declarationIndex);
      let added = false;
      for (const candidate of candidates) {
        const nextScenarios = scenarioCount + candidate.requirement.scenarios.length;
        const nextChars = textChars + candidate.textChars;
        if (group.length + 1 > thresholds.maxRequirements
          || nextScenarios > thresholds.maxScenarios
          || nextChars > thresholds.maxTextChars) continue;
        group.push(candidate);
        scheduled.add(candidate.requirement.id);
        scenarioCount = nextScenarios;
        textChars = nextChars;
        added = true;
        break;
      }
      if (!added) break;
      closedByThreshold = group.length >= thresholds.maxRequirements
        || scenarioCount >= thresholds.maxScenarios
        || textChars >= thresholds.maxTextChars;
    }

    const index = packets.length;
    packets.push(makePacket(`feature-${slugify(seed.requirement.id)}-${index + 1}`, group.map(member => member.requirement)));
  }

  return featureGroupingFromIds(catalog, packets.map(packet => packet.requirementIds), thresholds);
}

/** Compile either grouping source from original Catalog objects and enforce the same bounds. */
export function featureGroupingFromIds(
  catalog: RequirementCatalog,
  groups: readonly (readonly string[])[],
  thresholds: FeatureGroupThresholds = DEFAULT_FEATURE_GROUP_THRESHOLDS,
): FeatureGrouping {
  const byId = new Map(catalog.requirements.map(requirement => [requirement.id, requirement]));
  let thresholdLimitedPackets = 0;
  let intraGroupEdges = 0;
  let totalEdges = 0;
  const packets = groups.map((ids, index) => {
    if (ids.length === 0) throw new Error(`Feature group ${index + 1} is empty`);
    const requirements = ids.map(id => {
      const requirement = byId.get(id);
      if (!requirement) throw new Error(`Unknown feature group requirement: ${id}`);
      return requirement;
    });
    const modules = new Set(requirements.map(requirement => requirement.folderPath[1] ?? requirement.id));
    if (modules.size > 1) throw new Error(`Feature group ${index + 1} crosses ROOT modules: `
      + requirements.map(requirement => `${requirement.id}=${requirement.folderPath[1] ?? requirement.id}`).join(", "));
    const scenarios = requirements.reduce((total, requirement) => total + requirement.scenarios.length, 0);
    const chars = requirements.reduce((total, requirement) => total + requirementTextChars(requirement), 0);
    if (requirements.length > thresholds.maxRequirements || (requirements.length > 1 &&
      (scenarios > thresholds.maxScenarios || chars > thresholds.maxTextChars))) {
      throw new Error(`Feature group ${index + 1} exceeds capacity: ${requirements.length} requirements, ${scenarios} scenarios, ${chars} characters`);
    }
    if (requirements.length >= thresholds.maxRequirements || scenarios >= thresholds.maxScenarios || chars >= thresholds.maxTextChars) thresholdLimitedPackets++;
    const groupIds = new Set(ids);
    for (const requirement of requirements) {
      for (const dependency of requirement.dependencyIds) {
        totalEdges++;
        if (groupIds.has(dependency)) intraGroupEdges++;
      }
    }
    return makePacket(`feature-${slugify(requirements[0].id)}-${index + 1}`, requirements);
  });

  // Program verification (§3.2 rule 6): unique coverage, dependency order, no edits.
  const positionOf = new Map<string, number>();
  let emitted = 0;
  for (const packet of packets) {
    for (const id of packet.requirementIds) {
      if (positionOf.has(id)) throw new Error(`Requirement ${id} appears in more than one feature group`);
      positionOf.set(id, emitted++);
    }
  }
  if (emitted !== catalog.requirements.length) {
    const missing = catalog.requirements.filter(item => !positionOf.has(item.id)).map(item => item.id);
    throw new Error(`Feature groups do not cover every requirement; missing: ${missing.join(", ")}`);
  }
  for (const requirement of catalog.requirements) {
    const at = positionOf.get(requirement.id)!;
    for (const dependency of requirement.dependencyIds) {
      const dependencyAt = positionOf.get(dependency);
      if (dependencyAt === undefined) throw new Error(`Dependency ${dependency} of ${requirement.id} was not scheduled`);
      if (dependencyAt >= at) throw new Error(`Dependency ${dependency} must precede ${requirement.id} (earlier group or earlier in the same group)`);
    }
  }

  return {
    packets,
    stats: {
      packets: packets.length,
      requirements: catalog.requirements.length,
      maxPacketSize: packets.reduce((max, packet) => Math.max(max, packet.requirements.length), 0),
      crossModulePackets: 0,
      cohesionRate: totalEdges === 0 ? 1 : intraGroupEdges / totalEdges,
      thresholdLimitedPackets,
    },
  };
}

/** Audit atomics independently, with textual prerequisites but no application source. */
export function auditPackets(catalog: RequirementCatalog): WorkPacket[] {
  // `slugify` is lossy (`A.1` and `A_1` collapse), so ids are de-duplicated to
  // keep requirement results, plan-cache entries, and evidence keyed apart.
  const usedIds = new Set<string>();
  return catalog.requirements.map(requirement => {
    const baseId = `packet-${slugify(requirement.id)}`;
    let id = baseId;
    for (let suffix = 2; usedIds.has(id); suffix += 1) id = `${baseId}-${suffix}`;
    usedIds.add(id);
    const dependencies = new Set<string>();
    const externalDependencies = new Set<string>();
    const visit = (item: AtomicRequirement): void => {
      for (const capability of item.externalDependencyIds ?? []) externalDependencies.add(capability);
      for (const capability of item.dependencyIds) {
        if (dependencies.has(capability)) continue;
        dependencies.add(capability);
        const dependency = catalog.requirements.find(candidate => candidate.id === capability);
        if (dependency) visit(dependency);
      }
    };
    visit(requirement);
    return { ...makePacket(id, [requirement]),
      prerequisites: catalog.requirements.filter(item => dependencies.has(item.id)),
      ...(externalDependencies.size > 0
        ? { externalPrerequisiteIds: [...externalDependencies] }
        : {}) };
  });
}

export function makePacket(id: string, requirements: AtomicRequirement[], attempt: 1 | 2 | 3 = 1): WorkPacket {
  return { id, requirements, requirementIds: requirements.map(item => item.id), attempt };
}

/** Folder (and ROOT) id -> ids of its ATOMIC descendants, in declaration order. */
export function folderDescendants(catalog: RequirementCatalog): Map<string, string[]> {
  const folders = new Map<string, string[]>();
  for (const requirement of catalog.requirements) {
    for (const folderId of requirement.folderPath) {
      folders.set(folderId, [...(folders.get(folderId) ?? []), requirement.id]);
    }
  }
  return folders;
}

function slugify(id: string): string { return id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
