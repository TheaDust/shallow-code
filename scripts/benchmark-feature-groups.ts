import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { loadRequirementCatalog } from "../src/catalog.js";
import { normalizeArcRequirements } from "../src/experiments/requirements.js";
import { featureGroupPackets, requirementModuleId, requirementTextChars, type FeatureGroupThresholds } from "../src/scheduler.js";

// Offline capacity experiment: no model calls or official test inspection.
const [benchRoot, outputDir] = process.argv.slice(2);
if (!benchRoot || !outputDir) throw new Error("Usage: node --import tsx scripts/benchmark-feature-groups.ts <arc-bench directory> <output directory>");
const output = resolve(outputDir);
await mkdir(output, { recursive: true });
const catalogs = [];
for (const entry of (await readdir(benchRoot, { withFileTypes: true })).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
  const source = await readFile(join(benchRoot, entry.name, "requirements/requirements.yaml"), "utf8");
  const normalized = normalizeArcRequirements(source);
  const file = join(output, `${entry.name}.yaml`);
  await writeFile(file, normalized.yaml);
  catalogs.push({ task: entry.name, sourceSha256: createHash("sha256").update(source).digest("hex"),
    catalog: await loadRequirementCatalog(file) });
}
const candidates = [];
for (const maxRequirements of [4, 5, 6, 7, 8, 10, 12]) {
  for (const maxScenarios of [8, 10, 12, 16, 20]) {
    for (const maxTextChars of [20_000, 25_000, 30_000, 40_000, 60_000]) {
      candidates.push({ maxRequirements, maxScenarios, maxTextChars });
    }
  }
}
const results = candidates.map((limits: FeatureGroupThresholds) => {
  const tasks = catalogs.map(({ task, catalog }) => {
    const grouping = featureGroupPackets(catalog, limits);
    const positions = new Map(grouping.packets.flatMap((packet, index) => packet.requirementIds.map(id => [id, index])));
    const groups = grouping.packets.map(packet => ({
      ids: packet.requirementIds,
      scenarios: packet.requirements.reduce((sum, req) => sum + req.scenarios.length, 0),
      textChars: packet.requirements.reduce((sum, req) => sum + requirementTextChars(req), 0),
    }));
    const moduleIds = [...new Set(catalog.requirements.map(requirementModuleId))];
    const modules = moduleIds.map(id => {
      const requirements = catalog.requirements.filter(req => requirementModuleId(req) === id);
      return { id, name: requirements[0].ancestors.find(ancestor => ancestor.id === id)?.name ?? id,
        requirements: requirements.length,
        scenarios: requirements.reduce((sum, req) => sum + req.scenarios.length, 0),
        packets: new Set(requirements.map(req => positions.get(req.id))).size };
    });
    return { task, requirements: catalog.requirements.length,
      scenarios: catalog.requirements.reduce((sum, req) => sum + req.scenarios.length, 0),
      modules: modules.length, moduleBreakdown: modules,
      splitModules: modules.filter(module => module.packets > 1).length,
      singleRequirementPackets: groups.filter(group => group.ids.length === 1).length,
      smallPackets: groups.filter(group => group.ids.length <= 2).length,
      packets: groups.length, maxRequirements: grouping.stats.maxPacketSize,
      maxScenarios: Math.max(...groups.map(group => group.scenarios)),
      maxTextChars: Math.max(...groups.map(group => group.textChars)),
      crossGroupDependencies: catalog.requirements.reduce((sum, req) => sum + req.dependencyIds.filter(id => positions.get(id) !== positions.get(req.id)).length, 0),
      groups };
  });
  return { limits, packets: tasks.reduce((sum, task) => sum + task.packets, 0),
    crossGroupDependencies: tasks.reduce((sum, task) => sum + task.crossGroupDependencies, 0), tasks };
});
await writeFile(join(output, "results.json"), JSON.stringify({
  method: "Deterministic reference grouping; capacity and declared dependencies only, not LLM quality or measured runtime",
  sources: catalogs.map(({ task, sourceSha256 }) => ({ task, sourceSha256 })), results }, null, 2) + "\n");
console.log(JSON.stringify(results.filter(({ limits }) =>
  (limits.maxRequirements === 4 && limits.maxScenarios === 12 && limits.maxTextChars === 20_000)
  || (limits.maxRequirements !== 4 && [12, 16].includes(limits.maxScenarios) && [30_000, 40_000, 60_000].includes(limits.maxTextChars)))
  .map(result => ({ limits: result.limits, packets: result.packets, dependencies: result.crossGroupDependencies,
    tasks: Object.fromEntries(result.tasks.map(task => [task.task, task.packets])) })), null, 2));
