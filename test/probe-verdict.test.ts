import assert from "node:assert/strict";
import { test } from "node:test";

import { deriveProbeVerdict } from "../src/judge/playwright-probe-runner.js";
import type { ProbeFailure } from "../src/types.js";

function failure(overrides: Partial<ProbeFailure> = {}): ProbeFailure {
  return {
    caseId: "case",
    stepIndex: 0,
    category: "locator",
    message: "locator missed",
    ...overrides,
  };
}

test("deriveProbeVerdict passes when nothing failed", () => {
  assert.equal(deriveProbeVerdict([]), "pass");
});

test("deriveProbeVerdict is inconclusive only for locator-only failures with a snapshot", () => {
  assert.equal(deriveProbeVerdict([failure({ locatorSnapshot: "- button" })]), "inconclusive");
  assert.equal(deriveProbeVerdict([failure()]), "fail");
  assert.equal(
    deriveProbeVerdict([
      failure({ locatorSnapshot: "- button" }),
      failure({ caseId: "case-2", locatorSnapshot: "- button" }),
    ]),
    "inconclusive",
  );
});

test("deriveProbeVerdict separates behavior failures from runner faults", () => {
  assert.equal(
    deriveProbeVerdict([failure({ category: "assertion", message: "wrong text" })]),
    "fail",
  );
  assert.equal(
    deriveProbeVerdict([
      failure({ locatorSnapshot: "- button" }),
      failure({ caseId: "case-2", category: "timeout", message: "case exceeded" }),
    ]),
    "fail",
  );
  assert.equal(
    deriveProbeVerdict([
      failure({ locatorSnapshot: "- button" }),
      failure({ caseId: "case-2", category: "runner", message: "browser crashed" }),
    ]),
    "inconclusive",
  );
  assert.equal(deriveProbeVerdict([
    failure({ category: "assertion", message: "wrong value" }),
    failure({ caseId: "case-2", category: "runner", message: "browser crashed" }),
  ]), "fail");
});

test("deriveProbeVerdict stays inconclusive when a refinement is still possible", () => {
  assert.equal(
    deriveProbeVerdict([
      failure({ locatorSnapshot: "- button" }),
      failure({ caseId: "case-2" }),
    ]),
    "inconclusive",
  );
});

test("A failed preparation case does not erase another case's business failure", () => {
  assert.equal(deriveProbeVerdict([failure({ category: "precondition" })]), "inconclusive");
  assert.equal(deriveProbeVerdict([
    failure({ category: "precondition" }),
    failure({ caseId: "prepared-business", category: "assertion" }),
  ]), "fail");
});
