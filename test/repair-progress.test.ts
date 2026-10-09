import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuditResult } from "../src/judge/audit.js";
import { repairCaseProgress } from "../src/judge/repair-progress.js";

function gap(): AuditResult {
  return { status: "inconclusive", repairableProbeFailure: true, plan: { packetId: "packet", cases: [{
    id: "save", requirementIds: ["A"], purpose: "happy_path", expectationBasis: ["Save the value"], steps: [
      { op: "goto", path: "/" }, { op: "click", locator: { by: "role", role: "button", name: "Save" } },
      { op: "expectText", locator: { by: "role", role: "status" }, text: "Saved" },
    ],
  }] }, report: { packetId: "packet", verdict: "inconclusive", passedCases: [], failures: [
    { caseId: "save", stepIndex: 1, category: "locator", message: "Save missing" },
  ] } };
}

test("A freshly repeated later failure proves the reviewed required control gap was resolved", () => {
  const before = gap(), after = structuredClone(before);
  after.status = "failed";
  after.repairableProbeFailure = undefined;
  after.report!.failures = [{ caseId: "save", stepIndex: 2, category: "assertion", message: "Saved missing" }];
  assert.deepEqual(repairCaseProgress(before, after), { passed: [], resolvedGaps: ["save"] });
  after.status = "inconclusive";
  assert.deepEqual(repairCaseProgress(before, after), { passed: [], resolvedGaps: [] });
});

test("A passing case with a weakened outcome does not count as repair progress", () => {
  const before = gap(), after = structuredClone(before);
  after.report!.passedCases = ["save"];
  after.report!.failures = [];
  assert.deepEqual(repairCaseProgress(before, after).passed, ["save"]);
  after.plan!.cases[0].steps[2] = { op: "expectVisible", locator: { by: "role", role: "main" } };
  assert.deepEqual(repairCaseProgress(before, after), { passed: [], resolvedGaps: [] });
});
