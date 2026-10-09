import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { scenarioOutcomes } from "../src/judge/probe-coverage.js";
import { withModulePipeline, pass, fail } from "./helpers/module-pipeline.js";

for (const kind of ["own-improvement", "sibling-improvement"] as const) test(`partial coverage stays honest during ${kind}`, async () => {
  await withModulePipeline(async f => {
    const tree = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    tree.name = "Evolution Requirements for an anonymous workspace";
    const item = tree.children[0].children[1];
    item.description = 'The global navigation exposes the record. A heading named "Record" is visible. The button named "Save" displays heading named "Saved" and the item count.';
    item.scenarios = [{ name: "Save", steps: [{ keyword: "GIVEN", content: "The record is editable." },
      { keyword: "WHEN", content: 'The visitor clicks "Save".' },
      { keyword: "THEN", content: 'The page displays heading "Saved" and its item count.' }] }];
    tree.children.push({ id: "THIRD", name: "Third", type: "FOLDER", dependencies: [], children: [
      { id: "D", name: "D", type: "ATOMIC", dependencies: ["B"], description: "Display the main workspace." },
    ] });
    await writeFile(f.options.requirementsFile, JSON.stringify(tree));
    const normal = f.deps.planner.plan;
    f.deps.planner.plan = async (packet, feedback, options) => {
      if (!packet.requirementIds.includes("B")) return normal(packet, feedback, options);
      return { packetId: packet.id, coverageReview: "pending", cases: [{ id: "saved-B", requirementIds: ["B"],
        purpose: "happy_path", expectationBasis: [packet.requirements[0].text], setupStepCount: 2,
        steps: [{ op: "goto", path: "/" }, { op: "expectVisible", locator: { by: "role", role: "heading", name: "Record", exact: true } },
          { op: "click", locator: { by: "role", role: "button", name: "Save", exact: true } },
          { op: "expectVisible", locator: { by: "role", role: "heading", name: "Saved", exact: true } },
          { op: "expectVisible", locator: { by: "role", role: "main" } }],
        outcomeChecks: scenarioOutcomes(packet.requirements).map((outcome, index) => ({
          scenarioId: outcome.scenarioId, stepIndex: outcome.stepIndex, clauseIndex: outcome.clauseIndex, assertionIndexes: [index + 1],
        })),
      }] };
    };
    f.deps.runner.run = async plan => {
      const ids = plan.cases.flatMap(item => item.requirementIds);
      const repaired = f.builder.requests.some(request => request.mode === "repair");
      if (!repaired && ids.includes(kind === "own-improvement" ? "B" : "C")) {
        const report = fail(plan);
        if (ids.includes("B")) report.failures[0].stepIndex = 3;
        return report;
      }
      return pass(plan);
    };
    const summary = await f.run();
    assert.equal(f.git.restoredShas.length, 0, "a newly passing partial case must be independently confirmable");
    assert.equal(f.builder.requests.filter(request => request.mode === "repair").length, 1);
    assert.ok(summary.inconclusiveRequirementIds?.includes("B"));
    assert.ok(!summary.verifiedRequirementIds.includes("B"));
    const events = await f.events();
    assert.ok(events.some(event => event.type === "repair_batch_finished" && event.detail?.retained));
    const third = events.find(event => event.type === "module_boundary_audit_finished" && event.detail?.moduleId === "THIRD");
    assert.ok(third?.type === "module_boundary_audit_finished");
    assert.ok(third.detail);
    assert.ok(!third.detail.packetIds.includes("packet-b"), "a successful sibling sample must not promote its prerequisite to fully verified");
  });
});
