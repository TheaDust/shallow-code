import assert from "node:assert/strict";
import { test } from "node:test";
import { maskRequirementLiterals, requirementLiterals, requirementOutcomeClauses, requirementSentences } from "../src/requirement-text.js";
import { requirementScenarioFacts, scenarioPhaseIndex, scenarioStepPhases } from "../src/requirement-analysis.js";
import { probeCoverageGaps, scenarioOutcomes } from "../src/judge/probe-coverage.js";
import { loadRequirementCatalog } from "../src/catalog.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { withTempDir } from "./helpers/temp-dir.js";
import type { ProbeCase } from "../src/judge/probe-schema.js";
import type { AtomicRequirement } from "../src/types.js";

function requirement(): AtomicRequirement {
  return { id: "cancel", name: "取消预约", text: "取消预约并释放名额。", declarationIndex: 0, folderPath: ["ROOT"],
    dependencyIds: [], scenarios: [], references: [], exactUiStrings: [], seedDeclarations: [], ancestors: [],
    product: { kind: "generic_web", rootId: "ROOT", rootName: "预约", description: "", seedData: [] },
    scenarioContracts: [{ id: "cancel-own", name: "取消自己的预约", steps: [
      { keyword: "GIVEN", content: "用户已登录。" }, { keyword: "AND", content: "预约「早班」存在。" },
      { keyword: "WHEN", content: "取消预约。" }, { keyword: "THEN", content: "预约显示「已取消；可以重订」。并且名额释放。" },
      { keyword: "BUT", content: "其他用户的预约不变。" },
    ] }, { id: "cancel-again", name: "重复取消", steps: [
      { keyword: "GIVEN", content: "用户已登录。" }, { keyword: "WHEN", content: "取消预约。" },
      { keyword: "THEN", content: "取消预约。" },
    ] }] };
}

test("Scenario facts retain every source and deduplicate only identical excerpts in the same phase", () => {
  const input = requirement();
  const before = structuredClone(input);
  assert.deepEqual(scenarioPhaseIndex(input)[0].phases, ["given", "given", "when", "then", "then"]);
  const facts = requirementScenarioFacts(input);
  assert.deepEqual(facts.find(fact => fact.content === "用户已登录。")?.sources,
    [{ scenarioId: "cancel-own", stepIndex: 0 }, { scenarioId: "cancel-again", stepIndex: 0 }]);
  assert.equal(facts.filter(fact => fact.content === "取消预约。").length, 2);
  for (const fact of facts) for (const source of fact.sources) {
    assert.equal(input.scenarioContracts!.find(scenario => scenario.id === source.scenarioId)!.steps[source.stepIndex].content, fact.content);
  }
  assert.deepEqual(input, before);
});

test("Unknown and unanchored scenario steps remain unassigned", () => {
  assert.deepEqual(scenarioStepPhases({ id: "s", name: "s", steps: [
    { keyword: "AND", content: "unknown" }, { keyword: "GIVEN", content: "given" },
    { keyword: "OTHER", content: "unknown" }, { keyword: "BUT", content: "unknown" },
  ] }), ["unassigned", "given", "unassigned", "unassigned"]);
});

test("Literal scanning preserves escaped quotes, apostrophes, code spans and source offsets", () => {
  const text = 'It\'s "A\\"; B" and 「甲。乙」, ‘值；一’ and ``x`y; z``.';
  const literals = requirementLiterals(text);
  assert.deepEqual(literals.map(value => value.value), ['A\\"; B', "甲。乙", "值；一", "x`y; z"]);
  const masked = maskRequirementLiterals(text);
  assert.equal(masked.length, text.length);
  for (const literal of literals) assert.equal(masked.slice(literal.start, literal.end), "#".repeat(literal.end - literal.start));
  assert.deepEqual(requirementSentences(text), [text]);
});

test("Chinese outcomes retain quoted punctuation and each explicit result's source identity", () => {
  const input = requirement();
  const outcomes = scenarioOutcomes([input]).filter(outcome => outcome.scenarioId === "cancel-own");
  assert.deepEqual(outcomes.map(({ stepIndex, clauseIndex, text }) => ({ stepIndex, clauseIndex, text })), [
    { stepIndex: 3, clauseIndex: 0, text: "预约显示「已取消；可以重订」。" },
    { stepIndex: 3, clauseIndex: 1, text: "名额释放。" },
    { stepIndex: 4, clauseIndex: undefined, text: "其他用户的预约不变。" },
  ]);
  assert.deepEqual(requirementOutcomeClauses('Show "A and B; C" or "D"; retain the value.'),
    ['Show "A and B; C" or "D"', "retain the value."]);
});

test("Chinese persistence requires the mapped assertion to execute after reload", () => {
  const input = requirement();
  input.scenarioContracts = [{ id: "persist", name: "刷新保留", steps: [
    { keyword: "THEN", content: "刷新后显示「已取消」。" },
  ] }];
  const probeCase: ProbeCase = { id: "persist", requirementIds: [input.id], purpose: "persistence", expectationBasis: [],
    steps: [{ op: "expectText", locator: { by: "text", text: "已取消", exact: true }, text: "已取消" },
      { op: "reload" }, { op: "expectText", locator: { by: "text", text: "已取消", exact: true }, text: "已取消" }],
    outcomeChecks: [{ scenarioId: "persist", stepIndex: 0, assertionIndexes: [0] }] };
  const plan = { packetId: "persist", cases: [probeCase], uncoveredOutcomes: [] };
  assert.match(probeCoverageGaps(plan, [input])[0].reason, /after a reload/);
  probeCase.outcomeChecks![0].assertionIndexes = [2];
  assert.deepEqual(probeCoverageGaps(plan, [input]), []);
});

test("Catalog preserves Chinese initial declarations and quoted values with internal punctuation", async () => {
  await withTempDir("shallow-chinese-contract-", async directory => {
    const file = join(directory, "requirements.yaml");
    await writeFile(file, stringify({ id: "ROOT", name: "预约", type: "ROOT", children: [{ id: "cancel", name: "取消", type: "ATOMIC",
      description: "初始数据：预约「早班；一号」已存在。", scenarios: [{ id: "cancel-own", name: "取消", steps: [
        { keyword: "GIVEN", content: "预约「早班；一号」已存在。" }, { keyword: "WHEN", content: "取消预约。" },
        { keyword: "THEN", content: "显示「已取消」。" },
      ] }] }] }), "utf8");
    const { requirements: [input] } = await loadRequirementCatalog(file);
    assert.ok(input.exactUiStrings.includes("早班；一号"));
    assert.ok(input.exactUiStrings.includes("已取消"));
    assert.ok(input.seedDeclarations.includes("初始数据： 预约「早班；一号」已存在。"));
    assert.equal(requirementScenarioFacts(input)[0].phase, "given");
  });
});
