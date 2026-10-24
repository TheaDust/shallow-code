import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { loadRequirementCatalog } from "../src/catalog.js";
import { FEATURE_GROUPING_SCHEMA, parseFeatureGrouping } from "../src/feature-grouper.js";
import { validateGrouping } from "../src/feature-grouping-tools.js";
import { DEFAULT_FEATURE_GROUP_THRESHOLDS, featureGroupPackets } from "../src/scheduler.js";
import type { RequirementCatalog } from "../src/types.js";

const groups = (ids: string[][]) => ({ groups: ids.map(requirementIds => ({ requirementIds, purpose: "共同状态操作" })) });
const github = () => loadRequirementCatalog("data/official-competition/hackathon--github/requirements.yaml");
const sheet = () => loadRequirementCatalog("data/official-competition/hackathon--sheet/requirements.yaml");

function smallCatalog(items: Array<{ id: string; module?: string; dependencies?: string[]; text?: string }>): RequirementCatalog {
  return { requirements: items.map((item, index) => ({
    id: item.id, name: item.id, text: item.text ?? item.id,
    folderPath: ["ROOT", item.module ?? "M"], declarationIndex: index,
    dependencyIds: item.dependencies ?? [], scenarios: [`Scenario ${item.id}`],
    references: [], exactUiStrings: [], seedDeclarations: [], ancestors: [],
    product: { kind: "generic_web", rootId: "ROOT", rootName: "Example", description: "Example", seedData: [] },
  })), statusById: Object.fromEntries(items.map(item => [item.id, "todo"])) };
}

test("Observed runtime proposals preserve Catalog objects, scenarios and independent atomic coverage", async () => {
  for (const [app, count] of [["github", 17], ["sheet", 12]] as const) {
    const catalog = app === "github" ? await github() : await sheet();
    const proposal = JSON.parse(await readFile(`test/fixtures/feature-grouping/${app}.json`, "utf8"));
    const result = parseFeatureGrouping(proposal, catalog);
    assert.equal(result.packets.length, count);
    assert.equal(result.stats.requirements, catalog.requirements.length);
    for (const requirement of result.packets.flatMap(packet => packet.requirements)) {
      assert.equal(requirement, catalog.requirements.find(item => item.id === requirement.id));
    }
    assert.deepEqual(catalog.statusById, Object.fromEntries(catalog.requirements.map(item => [item.id, "todo"])));
    assert.equal(result.packets[0].requirements[0].text, catalog.requirements[0].text);
    assert.ok(result.purposes?.length);
    assert.equal(result.packets[0].requirements[0].scenarios.length, catalog.requirements[0].scenarios.length);
  }
});

test("Grouping rejects duplicate, missing, unknown, reversed and cross-module assignments", async () => {
  const catalog = await github();
  const baseline = featureGroupPackets(catalog).packets.map(packet => packet.requirementIds);
  for (const [ids, expected] of [
    [[...baseline, baseline[0]], /appears in more than one/],
    [baseline.slice(1), /do not cover every requirement/],
    [[...baseline, ["UNKNOWN"]], /Unknown/],
    [[baseline[0].slice().reverse(), ...baseline.slice(1)], /must precede/],
    [[[baseline[0][0], baseline[2][0]], ...baseline], /crosses ROOT modules/],
  ] as Array<[string[][], RegExp]>) assert.throws(() => parseFeatureGrouping(groups(ids), catalog), expected);
});

test("Grouping uses original capacity metrics and keeps a single oversized atomic intact", async () => {
  const catalog = await github();
  const baseline = featureGroupPackets(catalog).packets.map(packet => packet.requirementIds);
  assert.throws(() => parseFeatureGrouping(groups([[...baseline[0], ...baseline[1]], ...baseline.slice(2)]), catalog), /exceeds capacity/);
  const first = structuredClone(catalog.requirements[0]);
  first.text = "x".repeat(21000);
  first.scenarios = Array(13).fill("same scenario");
  const other = structuredClone(first);
  other.id = "SECOND";
  other.text = "small";
  other.scenarios = [];
  const input = { requirements: [first, other], statusById: { [first.id]: "todo" as const, SECOND: "todo" as const } };
  const single = parseFeatureGrouping(groups([[first.id], [other.id]]), input);
  assert.equal(single.packets[0].requirements[0].text.length, 21000);
  assert.equal(single.packets[0].requirements[0].scenarios.length, 13);
  assert.throws(() => parseFeatureGrouping(groups([[first.id, other.id]]), input), /exceeds capacity/);
});

test("The proposal schema permits explanatory purposes but cannot amend requirement contracts", async () => {
  const catalog = await github();
  const proposal = groups(featureGroupPackets(catalog).packets.map(packet => packet.requirementIds));
  assert.throws(() => parseFeatureGrouping({ ...proposal, requirements: [] }, catalog), /unsupported field/);
  proposal.groups[0].purpose = "模型认为记录不受影响";
  const parsed = parseFeatureGrouping(proposal, catalog);
  assert.equal(parsed.packets[0].requirements[0], catalog.requirements[0]);
  assert.throws(() => parseFeatureGrouping({ groups: [{ ...proposal.groups[0], text: "change behavior" }] }, catalog), /unsupported field/);
  assert.throws(() => parseFeatureGrouping({ groups: [{ requirementIds: [1], purpose: "purpose" }] }, catalog), /string requirementIds/);
  assert.throws(() => parseFeatureGrouping({ groups: [{ requirementIds: [], purpose: "purpose" }] }, catalog), /empty/);
  assert.throws(() => parseFeatureGrouping({ groups: [{ requirementIds: [catalog.requirements[0].id], purpose: " " }] }, catalog), /purpose/);
  assert.deepEqual(parseFeatureGrouping({ groups: [] }, { requirements: [], statusById: {} }).stats, featureGroupPackets({ requirements: [], statusById: {} }).stats);
});

test("Grouping tool reports structural boundaries without labeling dependency edges as regression risks", () => {
  const catalog = smallCatalog([
    { id: "A" }, { id: "B", dependencies: ["A"] },
    { id: "C", module: "N", dependencies: ["B"] }, { id: "D", dependencies: ["C"] },
  ]);
  catalog.requirements[0].externalDependencyIds = ["PRIOR-STAGE"];
  const before = structuredClone(catalog);
  const result = validateGrouping(catalog, groups([["A"], ["B"], ["C"], ["D"]]));
  assert.equal(result.valid, true);
  assert.deepEqual(result.crossGroupDependencies, [
    { dependencyId: "A", requirementId: "B", fromGroup: 1, toGroup: 2 },
    { dependencyId: "B", requirementId: "C", fromGroup: 2, toGroup: 3 },
    { dependencyId: "C", requirementId: "D", fromGroup: 3, toGroup: 4 },
  ]);
  assert.deepEqual(result.mergeableAdjacentGroups, [{ groups: [1, 2], requirementIds: ["A", "B"] }]);
  assert.deepEqual(result.moduleRevisits, [{ moduleId: "M", group: 4 }]);
  assert.equal(result.groups[0].scenarioCount, 1);
  assert.equal(result.groups[0].textChars, catalog.requirements[0].text.length + catalog.requirements[0].scenarios[0].length);
  assert.deepEqual(catalog, before);
});

test("Tool merge facts respect all original capacity limits, including oversized single atomics", () => {
  for (const limit of ["requirements", "scenarios", "text"]) {
    const catalog = smallCatalog((limit === "requirements" ? ["A", "B", "C", "D", "E"] : ["A", "B"]).map(id => ({ id })));
    const ids = limit === "requirements" ? [["A", "B", "C", "D"], ["E"]] : [["A"], ["B"]];
    if (limit === "scenarios") catalog.requirements[0].scenarios = Array(13).fill("same scenario");
    if (limit === "text") catalog.requirements[0].text = "x".repeat(20001);
    assert.deepEqual(validateGrouping(catalog, groups(ids)).mergeableAdjacentGroups, []);
  }
  assert.deepEqual(validateGrouping({ requirements: [], statusById: {} }, groups([])).groups, []);
});
