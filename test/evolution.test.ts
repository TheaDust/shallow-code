import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { loadRequirementCatalog } from "../src/catalog.js";
import { evolutionImplementationCatalog, readHistoricalPlanIds, readHistoricalRequirementIds, selectEvolutionScope } from "../src/evolution.js";
import { HumanRunFormatter } from "../src/human-log.js";
import { ProgressJournal } from "../src/progress-journal.js";
import { featureGroupPackets, featureGroupingFromIds } from "../src/scheduler.js";
import { withModulePipeline } from "./helpers/module-pipeline.js";
import { withTempDir } from "./helpers/temp-dir.js";

const modified = "Original Feature Description\n\nDisplay the old workspace.\n\nModified Feature Description\n\nDisplay the updated workspace.";

function checkpointLine(requirementIds: string[], reason = "feature-history"): string {
  const line = new HumanRunFormatter().format(JSON.stringify({ at: "2026-10-07T00:00:00Z", type: "checkpoint_saved",
    sequence: 22, acceptedSha: "a".repeat(40), detail: { requirementIds, reason } }));
  assert.ok(line);
  return line;
}

test("Historical checkpoints supplement plan identity, deduplicate exact IDs and freeze both sources", async () => {
  await withTempDir("shallow-history-sources-", async directory => {
    const journal = new ProgressJournal(directory);
    const plans = join(journal.directory, "plans");
    await mkdir(plans, { recursive: true });
    await writeFile(join(plans, "old.json"), JSON.stringify({ packetId: "old", cases: [{ requirementIds: ["PLAN", "BOTH"] }] }));
    await writeFile(join(plans, "broken.json"), '{"packetId":');
    journal.appendLine(checkpointLine(["BOTH", "A.1", "A_1", "历史:1"]));
    journal.appendLine(checkpointLine(["A.1", "A.1"]));
    journal.appendLine(checkpointLine([], "interrupted feature-history"));
    const history = await readHistoricalRequirementIds(journal.directory);
    assert.deepEqual([...history.requirementIds].sort(), ["A.1", "A_1", "BOTH", "PLAN", "历史:1"]);
    assert.equal(history.plans, 1);
    assert.equal(history.ignoredPlans, 1);
    assert.equal(history.planRequirementCount, 2);
    assert.equal(history.checkpointRequirementCount, 4);
    assert.equal(history.checkpointSupplementCount, 3);
    journal.appendLine(checkpointLine(["CURRENT"]));
    await writeFile(join(plans, "current.json"), JSON.stringify({ packetId: "current", cases: [{ requirementIds: ["CURRENT"] }] }));
    assert.equal(history.requirementIds.has("CURRENT"), false);
    assert.equal(history.checkpointRequirementCount, 4);
  });
});

test("Only complete controller checkpoints with unambiguous requirement fields supply historical IDs", async () => {
  await withTempDir("shallow-invalid-checkpoints-", async directory => {
    const valid = checkpointLine(["CURRENT"]);
    const receipt = new HumanRunFormatter().format(JSON.stringify({ at: "2026-10-07T00:00:00Z", type: "builder_finished",
      sequence: 23, detail: { outcome: "completed", summary: `All requirements passed.\n${valid}\n${valid}` } }));
    assert.ok(receipt);
    const malformed = [
      receipt, `Builder receipt: ${valid}`, ` ${valid}`,
      valid.replace(/^\[[^\]]+\]/, "[not-a-controller-time]"),
      valid.replace("保存可运行检查点", "独立验收通过"),
      valid.replace("a".repeat(40), "a".repeat(39)), valid.replace("a".repeat(40), "a".repeat(41)),
      valid.slice(0, valid.indexOf("（功能")), valid.slice(0, -1),
      valid.replace("feature-history", "feature-history；额外字段"),
      ...["CURRENT、", "、CURRENT", "CURRENT、、OTHER", "CURRENT,OTHER", "CURRENT，OTHER", " CURRENT", "CURRENT OTHER", "CURRENT；OTHER"]
        .map(field => valid.replace("需求 CURRENT", `需求 ${field}`)),
      checkpointLine([], "packet-current"),
    ];
    await writeFile(join(directory, "progress.log"), malformed.join("\r\n"));
    assert.equal((await readHistoricalRequirementIds(directory)).requirementIds.size, 0);
    // This is the actual inherited format, including elapsed minutes and an event sequence.
    await writeFile(join(directory, "progress.log"),
      "[14:43:28 +43m14s] 保存可运行检查点；feature-history；需求 A.1、A_1；SHA 95651b2270ee070756c6150b4dce40d6967a3d4e（功能验收状态单独记录） [#22]\r\n");
    assert.deepEqual([...(await readHistoricalRequirementIds(directory)).requirementIds], ["A.1", "A_1"]);
  });
});

test("Historical identity retains either readable source when the other is missing or unreadable", async () => {
  await withTempDir("shallow-partial-history-", async directory => {
    const missing = await readHistoricalRequirementIds(join(directory, "missing"));
    assert.equal(missing.requirementIds.size, 0);
    const journal = new ProgressJournal(directory);
    journal.appendLine(checkpointLine(["CHECKPOINT"]));
    const checkpointOnly = await readHistoricalRequirementIds(journal.directory);
    assert.deepEqual([...checkpointOnly.requirementIds], ["CHECKPOINT"]);
    assert.equal(checkpointOnly.plans, 0);
    assert.equal(checkpointOnly.checkpointSupplementCount, 1);
    const progress = join(directory, "plan-only");
    await mkdir(join(progress, "plans"), { recursive: true });
    await writeFile(join(progress, "plans", "old.json"), JSON.stringify({ packetId: "old", cases: [{ requirementIds: ["PLAN"] }] }));
    for (const unreadable of [false, true]) {
      if (unreadable) await mkdir(join(progress, "progress.log"));
      const planOnly = await readHistoricalRequirementIds(progress);
      assert.deepEqual([...planOnly.requirementIds], ["PLAN"]);
      assert.equal(planOnly.checkpointRequirementCount, 0);
      assert.equal(planOnly.checkpointSupplementCount, 0);
    }
  });
});

test("Historical plan identity comes from case IDs, ignores broken files and remains frozen", async () => {
  await withTempDir("shallow-historical-ids-", async directory => {
    await writeFile(join(directory, "unrelated-file-name.json"), JSON.stringify({ packetId: "old-packet", coverageReview: "verified",
      cases: [{ requirementIds: ["A.1", "A_1"] }, { requirementIds: ["A.1"] }] }));
    await writeFile(join(directory, "truncated.json"), '{"packetId":');
    await writeFile(join(directory, "bad-identity.json"), JSON.stringify({ packetId: "old", cases: [{ requirementIds: ["B", 12] }] }));
    await writeFile(join(directory, "empty.json"), JSON.stringify({ packetId: "old", cases: [] }));
    await writeFile(join(directory, "not-a-plan.txt"), "ignored");
    await mkdir(join(directory, "nested.json"));
    const history = await readHistoricalPlanIds(directory);
    assert.deepEqual([...history.requirementIds].sort(), ["A.1", "A_1"]);
    assert.equal(history.plans, 1);
    assert.equal(history.ignoredPlans, 3);
    await writeFile(join(directory, "new-plan.json"), JSON.stringify({ packetId: "new", cases: [{ requirementIds: ["NEW"] }] }));
    assert.equal(history.requirementIds.has("NEW"), false);
  });
});

test("Missing historical plans provide no grounds to skip a requirement", async () => {
  await withTempDir("shallow-no-historical-ids-", async directory => {
    const history = await readHistoricalPlanIds(join(directory, "missing"));
    assert.equal(history.requirementIds.size, 0);
    assert.equal(history.plans, 0);
  });
});

test("Explicit ordered change headings take precedence over historical IDs", async () => {
  await withModulePipeline(async f => {
    const catalog = await loadRequirementCatalog(f.options.requirementsFile);
    catalog.requirements[0].text = modified;
    catalog.requirements[1].text = "Mention Original Feature Description and Modified Feature Description as ordinary prose.";
    const history = new Set(["A", "B", "REMOVED"]);
    assert.deepEqual(selectEvolutionScope(catalog, history), {
      addedRequirementIds: ["C"], changedRequirementIds: ["A"], inheritedRequirementIds: ["B"],
    });
    catalog.requirements[2].text = modified.replaceAll("\n", "\r\n");
    assert.deepEqual(selectEvolutionScope(catalog, history).changedRequirementIds, ["A", "C"]);
    catalog.requirements[0].text = "Modified Feature Description\nnew\nOriginal Feature Description\nold";
    assert.deepEqual(selectEvolutionScope(catalog, history).inheritedRequirementIds, ["A", "B"]);
  });
});

test("Scheduling bypasses inherited nodes while preserving dependencies on pending changes", async () => {
  await withModulePipeline(async f => {
    const catalog = await loadRequirementCatalog(f.options.requirementsFile);
    const before = structuredClone(catalog);
    const scoped = evolutionImplementationCatalog(catalog, new Set(["B"]));
    assert.deepEqual(scoped.requirements.map(item => [item.id, item.dependencyIds]), [["A", []], ["C", ["A"]]]);
    assert.deepEqual(featureGroupPackets(scoped).packets.map(item => item.requirementIds), [["A"], ["C"]]);
    assert.throws(() => featureGroupingFromIds(scoped, [["C"], ["A"]]), /must precede/);
    assert.deepEqual(catalog, before);
    assert.equal(scoped.requirements[1].text, catalog.requirements[2].text);
    assert.equal(scoped.requirements[1].scenarios, catalog.requirements[2].scenarios);
    assert.equal(evolutionImplementationCatalog(catalog, new Set()), catalog);
    assert.equal(evolutionImplementationCatalog(catalog, new Set(["A", "B", "C"])).requirements.length, 0);
  });
});

test("Both final requirement trees select five added and five modified atomics with complete initial ID history", async () => {
  for (const [product, total, inheritedCount] of [["github", 52, 42], ["sheet", 10, 0]] as const) {
    const previous = await loadRequirementCatalog(`data/official-competition/hackathon--${product}/requirements.yaml`);
    const current = await loadRequirementCatalog(`data/final/hackathon-evolution--${product}/requirements.yaml`, { inheritedApplication: true });
    const scope = selectEvolutionScope(current, new Set(previous.requirements.map(item => item.id)));
    assert.equal(scope.addedRequirementIds.length, 5);
    assert.equal(scope.changedRequirementIds.length, 5);
    assert.equal(scope.inheritedRequirementIds.length, inheritedCount);
    const scoped = evolutionImplementationCatalog(current, new Set(scope.inheritedRequirementIds));
    assert.equal(scoped.requirements.length, 10);
    assert.equal(featureGroupPackets(scoped).stats.requirements, 10);
    assert.equal(current.requirements.length, total);
  }
});
