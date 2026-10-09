import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { withModulePipeline, pass, fail } from "./helpers/module-pipeline.js";
import { scenarioOutcomes } from "../src/judge/probe-coverage.js";

test("a later repair preserves an already-passed shared component sample from another module", async () => {
  await withModulePipeline(async fixture => {
    const tree = JSON.parse(await readFile(fixture.options.requirementsFile, "utf8"));
    tree.name = "Evolution Requirements for an anonymous workspace";
    for (const module of tree.children) for (const requirement of module.children) {
      requirement.description = "The account menu confirms actions in a dialog. Display the main workspace.";
    }
    await writeFile(fixture.options.requirementsFile, JSON.stringify(tree));
    let guardRunsAfterRepair = 0;
    fixture.deps.runner.run = async plan => {
      const component = plan.cases.some(probeCase => probeCase.steps.some(step => step.op === "expectClosedOverlaysEmpty"));
      const ids = plan.cases.flatMap(probeCase => probeCase.requirementIds);
      const repairing = fixture.builder.requests.some(request => request.mode === "repair") && fixture.git.restoredShas.length === 0;
      if (component && ids.includes("B") && repairing) {
        guardRunsAfterRepair += 1;
        const report = fail(plan);
        report.failures[0].stepIndex = plan.cases[0].steps.length - 1;
        report.failures[0].message = "Closed shared dialog still contains stale controls";
        return report;
      }
      if (!component && ids.includes("C") && !repairing) return fail(plan);
      return pass(plan);
    };
    const summary = await fixture.run();
    assert.ok(guardRunsAfterRepair >= 2, "the shared regression is independently reproduced");
    assert.equal(fixture.git.restoredShas.length, 1);
    assert.ok(summary.verifiedRequirementIds.includes("A"));
    assert.ok(summary.verifiedRequirementIds.includes("B"));
    assert.deepEqual(summary.failedRequirementIds, ["C"]);
    assert.equal(summary.status, "partial");
    assert.ok((await fixture.events()).some(event => event.type === "repair_batch_finished" && event.detail?.retained === false));
  });
});

test("a passed nested path of a partial requirement still exercises its global entry in the repair window", async () => {
  await withModulePipeline(async fixture => {
    const tree = JSON.parse(await readFile(fixture.options.requirementsFile, "utf8"));
    tree.name = "Evolution Requirements for an anonymous workspace";
    tree.children[0].children[0].description = 'The global search control has searchbox role and accessible name "Lookup". A result link named "Record" opens the record.';
    const item = tree.children[0].children[1];
    item.description = 'The record detail page displays heading "Record" and its item count. Seed data: record `Record`.';
    item.scenarios = [{ name: "View", steps: [{ keyword: "WHEN", content: "The visitor opens the record." },
      { keyword: "THEN", content: 'The page displays heading "Record" and its item count.' }] }];
    await writeFile(fixture.options.requirementsFile, JSON.stringify(tree));
    const search = { by: "role" as const, role: "searchbox", name: "Lookup", exact: true, scope: { by: "role" as const, role: "banner" } };
    const navigation = [
      { op: "goto" as const, path: "/" }, { op: "fill" as const, locator: search, value: "Record" },
      { op: "press" as const, locator: search, key: "Enter" as const },
      { op: "expectVisible" as const, locator: { by: "role" as const, role: "link", name: "Record", exact: true } },
    ];
    const normal = fixture.deps.planner.plan;
    fixture.deps.planner.plan = async (packet, feedback, options) => {
      if (packet.requirementIds.includes("A")) return { packetId: packet.id, cases: [{ id: "home-search", requirementIds: ["A"],
        purpose: "happy_path", expectationBasis: [packet.requirements[0].text], steps: navigation }] };
      if (!packet.requirementIds.includes("B")) return normal(packet, feedback, options);
      return { packetId: packet.id, coverageReview: "pending", cases: [{ id: "partial-detail", requirementIds: ["B"],
        purpose: "happy_path", expectationBasis: [packet.requirements[0].text], steps: [...navigation,
          { op: "click", locator: { by: "role", role: "link", name: "Record", exact: true } },
          { op: "expectVisible", locator: { by: "role", role: "heading", name: "Record", exact: true } },
          { op: "expectVisible", locator: { by: "role", role: "main" } }],
        outcomeChecks: scenarioOutcomes(packet.requirements).map((outcome, index) => ({
          scenarioId: outcome.scenarioId, stepIndex: outcome.stepIndex, clauseIndex: outcome.clauseIndex, assertionIndexes: [index + 5],
        })),
      }] };
    };
    let crossRouteRuns = 0;
    fixture.deps.runner.run = async plan => {
      const crossRoute = plan.cases.find(item => item.id.startsWith("compat-global-") && item.requirementIds.includes("B"));
      if (crossRoute) {
        crossRouteRuns++;
        if (!fixture.builder.requests.some(request => request.mode === "repair")) {
          const report = fail(plan);
          report.failures[0].caseId = crossRoute.id;
          report.failures[0].stepIndex = crossRoute.steps.length - 1;
          return report;
        }
      }
      return pass(plan);
    };
    const summary = await fixture.run();
    assert.ok(crossRouteRuns >= 4, JSON.stringify({ crossRouteRuns, summary,
      events: (await fixture.events()).filter(event => ["probe_planner_failed", "probe_preplan_failed", "repair_batch_finished", "module_boundary_audit_finished"].includes(event.type)) }));
    assert.equal(fixture.builder.requests.filter(request => request.mode === "repair").length, 1);
    assert.ok(summary.inconclusiveRequirementIds?.includes("B"));
    assert.ok(!summary.verifiedRequirementIds.includes("B"));
    assert.equal(fixture.git.restoredShas.length, 0);
  });
});

test("a later repair protects passed cases of an inconclusive requirement without promoting its coverage", async () => {
  await withModulePipeline(async fixture => {
    const tree = JSON.parse(await readFile(fixture.options.requirementsFile, "utf8"));
    tree.name = "Evolution Requirements for an anonymous workspace";
    const item = tree.children[0].children[1];
    item.description = 'The page displays heading "Record" and its item count. Seed data: record `Record`.';
    item.scenarios = [{ name: "View", steps: [{ keyword: "WHEN", content: "The visitor opens the page." },
      { keyword: "THEN", content: 'The page displays heading "Record" and its item count.' }] }];
    await writeFile(fixture.options.requirementsFile, JSON.stringify(tree));
    const normal = fixture.deps.planner.plan;
    fixture.deps.planner.plan = async (packet, feedback, options) => {
      if (!packet.requirementIds.includes("B")) return normal(packet, feedback, options);
      return { packetId: packet.id, coverageReview: "pending", cases: [{ id: "partial-B", requirementIds: ["B"],
        purpose: "happy_path", expectationBasis: [packet.requirements[0].text],
        steps: [{ op: "goto", path: "/" }, { op: "expectVisible", locator: { by: "role", role: "heading", name: "Record", exact: true } },
          { op: "expectVisible", locator: { by: "role", role: "main" } }],
        outcomeChecks: scenarioOutcomes(packet.requirements).map((outcome, index) => ({
          scenarioId: outcome.scenarioId, stepIndex: outcome.stepIndex, clauseIndex: outcome.clauseIndex, assertionIndexes: [index + 1],
        })),
      }] };
    };
    let guarded = 0;
    fixture.deps.runner.run = async plan => {
      const ids = plan.cases.flatMap(item => item.requirementIds);
      const repairing = fixture.builder.requests.some(request => request.mode === "repair") && fixture.git.restoredShas.length === 0;
      if (ids.includes("B") && repairing) { guarded++; return fail(plan); }
      if (ids.includes("C") && !repairing) return fail(plan);
      return pass(plan);
    };
    const summary = await fixture.run();
    assert.ok(guarded >= 2, "the previously passed partial path is checked and its regression reproduced");
    assert.equal(fixture.git.restoredShas.length, 1, JSON.stringify({ guarded, summary,
      events: (await fixture.events()).filter(event => ["probe_planner_failed", "probe_preplan_failed", "repair_batch_finished", "module_boundary_audit_finished", "repair_guard_checked"].includes(event.type)) }));
    assert.ok(!summary.verifiedRequirementIds.includes("B"));
    assert.ok(summary.inconclusiveRequirementIds?.includes("B"));
    assert.deepEqual(summary.failedRequirementIds, ["C"]);
  });
});
