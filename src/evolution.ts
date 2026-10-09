import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { progressPlansDirectory } from "./progress-journal.js";
import type { RequirementCatalog } from "./types.js";

/** Freeze historical identity only; checkpoints never supply a current SHA or verdict. */
export async function readHistoricalRequirementIds(progressDirectory: string) {
  const [plans, log] = await Promise.all([
    readHistoricalPlanIds(progressPlansDirectory(progressDirectory)),
    readFile(join(progressDirectory, "progress.log"), "utf8").catch(() => ""),
  ]);
  const checkpointIds = historicalCheckpointIds(log);
  const requirementIds = new Set([...plans.requirementIds, ...checkpointIds]);
  return {
    requirementIds, plans: plans.plans, ignoredPlans: plans.ignoredPlans,
    planRequirementCount: plans.requirementIds.size, checkpointRequirementCount: checkpointIds.size,
    checkpointSupplementCount: [...checkpointIds].filter(id => !plans.requirementIds.has(id)).length,
  };
}

function historicalCheckpointIds(log: string): Set<string> {
  const ids = new Set<string>();
  // Match a complete HumanRunFormatter checkpoint event, not embedded receipt text.
  const checkpoint = /^\[(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d \+(?:\d+s|\d+m[0-5]?\ds)\] 保存可运行检查点；[^；\r\n]+；需求 ([^；\r\n]*)；SHA [a-f0-9]{40}（功能验收状态单独记录） \[#[1-9]\d*\]$/;
  for (const line of log.split(/\r?\n/)) {
    const field = checkpoint.exec(line)?.[1];
    if (!field) continue;
    const checkpointIds = field.split("、");
    // Reject the whole field on empty IDs, whitespace or competing separators.
    if (checkpointIds.some(id => !id || /[\s,，;↵\u0000-\u001f\u007f]/u.test(id))) continue;
    for (const id of checkpointIds) ids.add(id);
  }
  return ids;
}

/** Historical plans establish ID provenance only, never a current plan or verdict. */
export async function readHistoricalPlanIds(directory: string): Promise<{
  requirementIds: Set<string>; plans: number; ignoredPlans: number;
}> {
  const result = { requirementIds: new Set<string>(), plans: 0, ignoredPlans: 0 };
  const files = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith(".json")) continue;
    try {
      const plan: unknown = JSON.parse(await readFile(join(directory, file.name), "utf8"));
      const ids = historicalRequirementIds(plan);
      if (!ids) { result.ignoredPlans++; continue; }
      for (const id of ids) result.requirementIds.add(id);
      result.plans++;
    } catch { result.ignoredPlans++; }
  }
  return result;
}

function historicalRequirementIds(value: unknown): string[] | undefined {
  if (!record(value) || typeof value.packetId !== "string" || !value.packetId.trim() ||
    !Array.isArray(value.cases) || value.cases.length === 0) return undefined;
  const ids: string[] = [];
  for (const item of value.cases) {
    if (!record(item) || !Array.isArray(item.requirementIds) || item.requirementIds.length === 0 ||
      !item.requirementIds.every((id: unknown) => typeof id === "string" && id.trim().length > 0)) return undefined;
    ids.push(...item.requirementIds);
  }
  return ids;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function selectEvolutionScope(catalog: RequirementCatalog, historicalIds: ReadonlySet<string>): {
  addedRequirementIds: string[]; changedRequirementIds: string[]; inheritedRequirementIds: string[];
} {
  const scope = { addedRequirementIds: [] as string[], changedRequirementIds: [] as string[], inheritedRequirementIds: [] as string[] };
  for (const requirement of catalog.requirements) {
    // Match the explicit, ordered section headings of the current Evolution format.
    if (/^[ \t]*Original Feature Description[ \t]*\r?\n[\s\S]*?^[ \t]*Modified Feature Description[ \t]*\r?\n/m.test(requirement.text)) {
      scope.changedRequirementIds.push(requirement.id);
    } else if (!historicalIds.has(requirement.id)) {
      scope.addedRequirementIds.push(requirement.id);
    } else {
      scope.inheritedRequirementIds.push(requirement.id);
    }
  }
  return scope;
}

/** Scheduling view only. Builder and Judge still receive the original current contracts. */
export function evolutionImplementationCatalog(
  catalog: RequirementCatalog, inheritedIds: ReadonlySet<string>,
): RequirementCatalog {
  if (inheritedIds.size === 0) return catalog;
  const byId = new Map(catalog.requirements.map(item => [item.id, item]));
  const requirements = catalog.requirements.filter(item => !inheritedIds.has(item.id)).map(item => {
    const dependencies = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visited.has(id)) return;
      visited.add(id);
      if (inheritedIds.has(id)) byId.get(id)?.dependencyIds.forEach(visit);
      else dependencies.add(id);
    };
    item.dependencyIds.forEach(visit);
    return { ...item, dependencyIds: [...dependencies] };
  });
  return { requirements, statusById: Object.fromEntries(requirements.map(item => [item.id, catalog.statusById[item.id]])) };
}
