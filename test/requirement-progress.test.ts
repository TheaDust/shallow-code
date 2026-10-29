import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { loadRequirementCatalog } from "../src/catalog.js";
import { pendingImplementationCatalog, readHistoricalPlanIds, readHistoricalRequirementIds, requirementDigest, saveRequirementDigests } from "../src/requirement-progress.js";
import { HumanRunFormatter } from "../src/human-log.js";
import { ProgressJournal } from "../src/progress-journal.js";
import { featureGroupPackets, featureGroupingFromIds } from "../src/scheduler.js";
import { withModulePipeline } from "./helpers/module-pipeline.js";
import { withTempDir } from "./helpers/temp-dir.js";


test("Incremental identity detects changed descriptions and ancestors with stable requirement IDs", async () => {
  await withModulePipeline(async f => {
    const catalog = await loadRequirementCatalog(f.options.requirementsFile);
    const old = Object.fromEntries(catalog.requirements.map(r => [r.id, requirementDigest(r)]));
    const directory = join(f.options.outputDir, "shallow-progress");
    await saveRequirementDigests(directory, old, ["A", "B", "C"]);
    const history = await readHistoricalRequirementIds(directory);
    assert.deepEqual([...history.requirementIds], ["A", "B", "C"]);
    const changed = structuredClone(catalog);
    changed.requirements[0].text = "Display the updated workspace.";
    assert.notEqual(requirementDigest(changed.requirements[0]), old.A);
    assert.equal(requirementDigest(changed.requirements[1]), old.B);
    changed.requirements[1].ancestors[0].description = "Use the updated folder contract.";
    assert.notEqual(requirementDigest(changed.requirements[1]), old.B);
    // Stage labels alone do not change a behavior contract.
    const staged = structuredClone(catalog.requirements[2]);
    staged.product.rootName += " - Stage 2";
    assert.equal(requirementDigest(staged), old.C);
    assert.equal(requirementDigest(staged, { "reference.png": "new" }), old.C);
    const rootChanged = structuredClone(staged);
    rootChanged.product.description = "Updated root behavior contract.";
    assert.notEqual(requirementDigest(rootChanged), old.C);
    staged.references = ["reference.png"];
    assert.notEqual(requirementDigest(staged, { "reference.png": "new" }), requirementDigest(staged, { "reference.png": "old" }));
    const guided = structuredClone(catalog.requirements[0]);
    guided.guidance = ["整体采用深色主题。"];
    assert.notEqual(requirementDigest(guided), old.A);
    const productGuided = structuredClone(catalog.requirements[1]);
    productGuided.product.guidance = ["全局保持简洁。"];
    assert.notEqual(requirementDigest(productGuided), old.B);
  });
});

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

test("Scheduling bypasses inherited nodes while preserving dependencies on pending changes", async () => {
  await withModulePipeline(async f => {
    const catalog = await loadRequirementCatalog(f.options.requirementsFile);
    const before = structuredClone(catalog);
    const scoped = pendingImplementationCatalog(catalog, new Set(["B"]));
    assert.deepEqual(scoped.requirements.map(item => [item.id, item.dependencyIds]), [["A", []], ["C", ["A"]]]);
    assert.deepEqual(featureGroupPackets(scoped).packets.map(item => item.requirementIds), [["A"], ["C"]]);
    assert.throws(() => featureGroupingFromIds(scoped, [["C"], ["A"]]), /must precede/);
    assert.deepEqual(catalog, before);
    assert.equal(scoped.requirements[1].text, catalog.requirements[2].text);
    assert.equal(scoped.requirements[1].scenarios, catalog.requirements[2].scenarios);
    assert.equal(pendingImplementationCatalog(catalog, new Set()), catalog);
    assert.equal(pendingImplementationCatalog(catalog, new Set(["A", "B", "C"])).requirements.length, 0);
  });
});

test("Change-description headings are ordinary contract text and unchanged digests remain reusable", async () => {
  await withModulePipeline(async f => {
    const catalog = await loadRequirementCatalog(f.options.requirementsFile);
    catalog.requirements[0].text = "Original Feature Description\nOld behavior.\nModified Feature Description\nNew behavior.";
    const saved = requirementDigest(catalog.requirements[0]);
    assert.equal(requirementDigest(structuredClone(catalog.requirements[0])), saved);
    catalog.requirements[0].text += " Include another behavior.";
    assert.notEqual(requirementDigest(catalog.requirements[0]), saved);
  });
});
