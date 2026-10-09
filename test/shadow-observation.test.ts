import assert from "node:assert/strict";
import { test } from "node:test";

import { toBuilderShadowObservation } from "../src/builder/shadow-observation.js";
import type { ShadowReport } from "../src/types.js";

test("Shadow observation exposes only whitelisted fields and truncates free text", () => {
  const observation = toBuilderShadowObservation({
    packetId: "packet-a",
    verdict: "fail",
    passedCases: ["already-working"],
    failures: [
      {
        caseId: "missing-control",
        stepIndex: 2,
        category: "locator",
        message: `Could not find button\u0000${"x".repeat(2_000)}`,
        locatorSnapshot: `button Save\u0007${"y".repeat(5_000)}`,
      },
    ],
  });

  assert.deepEqual(observation.passedCaseIds, ["already-working"]);
  assert.equal(observation.failures[0].category, "locator");
  assert.doesNotMatch(observation.failures[0].message, /\u0000/);
  assert.ok(observation.failures[0].message.length <= 1_500);
  assert.ok((observation.failures[0].accessibilityExcerpt?.length ?? 0) <= 1_500);
  assert.equal(observation.applicationStartupFailed, false);
});

test("Application start failures are detected only by the structured caseId marker", () => {
  const observation = toBuilderShadowObservation({
    packetId: "packet-b",
    verdict: "fail",
    passedCases: [],
    failures: [
      {
        caseId: "<application>",
        stepIndex: -1,
        category: "runner",
        message: "Application exited before readiness with code 1",
      },
    ],
  });

  assert.equal(observation.applicationStartupFailed, true);
  assert.equal(observation.failures[0].caseId, "<application>");
});

test("Regular probe failures never mark the application as failed to start", () => {
  const reports: ShadowReport[] = [
    {
      packetId: "packet-c",
      verdict: "fail",
      passedCases: [],
      failures: [
        {
          caseId: "save-profile",
          stepIndex: 3,
          category: "assertion",
          message: "Expected Saved, received Error",
        },
      ],
    },
    {
      packetId: "packet-d",
      verdict: "inconclusive",
      passedCases: [],
      failures: [
        {
          caseId: "open-page",
          stepIndex: 0,
          category: "timeout",
          message: "Timed out waiting for the main region",
        },
      ],
    },
  ];

  for (const report of reports) {
    assert.equal(toBuilderShadowObservation(report).applicationStartupFailed, false);
  }
});

test("Observations without a locator snapshot omit the accessibility excerpt", () => {
  const observation = toBuilderShadowObservation({
    packetId: "packet-e",
    verdict: "fail",
    passedCases: [],
    failures: [
      {
        caseId: "save-profile",
        stepIndex: 1,
        category: "navigation",
        message: "Navigation to /settings failed",
      },
    ],
  });

  assert.equal(observation.failures[0].accessibilityExcerpt, undefined);
});
