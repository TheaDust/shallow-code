import assert from "node:assert/strict";
import { test } from "node:test";
import type { JSONReport } from "@playwright/test/reporter";
import { evaluateScenarios, scenarioArguments } from "../src/experiments/scenario-evaluation.js";
import { reportEntries } from "../src/experiments/protocol.js";

function report(index: number, status = "passed"): JSONReport {
  return { suites: [{ title: "fixture", specs: [{ file: "a.spec.ts", line: 4, column: 1,
    title: `case [${index}]`, tests: [{ projectName: "chromium", results: [{ status }] }] }] }], errors: [] } as unknown as JSONReport;
}
const catalog = [0, 1, 2].map(i => reportEntries(report(i))[0]);
const processResult = { exitCode: 0, timedOut: false, durationMs: 1 };

test("scenario selection escapes parameterized titles sharing one line", () => {
  assert.deepEqual(scenarioArguments(catalog[1]), ["a.spec.ts:4", "--grep", "case \\[1\\]$", "--project", "chromium"]);
});

test("business failures retain their score and the next case starts clean", async () => {
  let data = 0, starts = 0, stops = 0;
  const result = await evaluateScenarios({ catalog,
    start: async () => {
      data = 0;
      return { metadata: {}, candidate: { candidateId: "candidate", buildId: "build", inputDigest: "input",
        applicationDigest: "app", runtimeId: String(++starts) }, stop: async () => { stops++; } };
    },
    execute: async (_entry, i) => {
      assert.equal(data, 0); data++;
      return { report: report(i, i === 1 ? "failed" : "passed"), process: { ...processResult, exitCode: i === 1 ? 1 : 0 } };
    } });
  assert.equal(starts, 3); assert.equal(stops, 3);
  assert.deepEqual([result.score.passed, result.score.failed, result.score.notRun], [2, 1, 0]);
});

for (const failure of ["start", "cleanup", "snapshot", "runtime", "build", "selection", "timeout", "browser", "record"] as const) {
  test(`${failure} failure preserves completed cases and does not score remaining cases as business failures`, async () => {
    let starts = 0;
    const result = await evaluateScenarios({ catalog,
      start: async () => {
        const index = starts++;
        if (index === 1 && failure === "start") throw new Error("initialization failed");
        return { metadata: {}, candidate: { candidateId: "candidate", buildId: "build", inputDigest: "input",
          applicationDigest: index === 1 && failure === "build" ? "changed" : "app",
          runtimeId: index === 1 && failure === "runtime" ? "0" : String(index) },
          assertUnchanged: async () => { if (index === 1 && failure === "snapshot") throw new Error("snapshot changed"); },
          stop: async () => { if (index === 1 && failure === "cleanup") throw new Error("stop failed"); } };
      },
      record: async cases => { if (failure === "record" && cases[1].status === "completed") throw new Error("disk error"); },
      execute: async (_entry, i) => {
        const observed = report(i === 1 && failure === "selection" ? 0 : i);
        if (i === 1 && failure === "browser") {
          observed.suites[0].specs[0].tests[0].results[0].status = "failed";
          observed.suites[0].specs[0].tests[0].results[0].errors = [{ message: "Error: browserType.launch: spawn EPERM" }];
        }
        return { report: observed, process: { ...processResult, timedOut: i === 1 && failure === "timeout" } };
      } });
    assert.equal(starts, 2);
    assert.deepEqual([result.score.passed, result.score.failed, result.score.notRun], [1, 0, 2]);
    assert.equal(result.score.errors.length, 1);
    assert.equal(result.cases[1].status, "not_run");
  });
}
