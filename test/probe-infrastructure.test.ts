import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { ExecutionFault } from "../src/execution-fault.js";
import { PlaywrightProbeRunner } from "../src/judge/playwright-probe-runner.js";
import type { ProbePlan } from "../src/judge/probe-schema.js";
import { startFixtureServer } from "./helpers/fixture-server.js";

const plan: ProbePlan = { packetId: "packet", cases: [{ id: "case", requirementIds: ["req"], purpose: "happy_path",
  expectationBasis: ["fixture"],
  steps: [{ op: "goto", path: "/" }, { op: "expectVisible", locator: { by: "role", role: "main" } }],
}] };
const options = { baseUrl: "http://127.0.0.1:1", stepTimeoutMs: 100, caseTimeoutMs: 1000 };

test("Runner reports a disconnected Chromium as retryable infrastructure, not product failure", async () => {
  const runner = new PlaywrightProbeRunner(async () => {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return browser;
  });
  await assert.rejects(runner.run(plan, options), (error: unknown) => {
    assert.ok(error instanceof ExecutionFault);
    assert.equal(error.code, "browser_disconnected");
    assert.equal(error.retryable, true);
    return true;
  });
});

test("Runner startup failure is a terminal execution fault", async () => {
  const runner = new PlaywrightProbeRunner(async () => { throw new Error("browser executable missing"); });
  await assert.rejects(runner.run(plan, options), (error: unknown) => {
    assert.ok(error instanceof ExecutionFault);
    assert.equal(error.code, "browser_launch");
    assert.equal(error.retryable, false);
    return true;
  });
});

test("An earlier product assertion remains a failure when Chromium later disconnects", async (t) => {
  const server = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  const original = browser.newContext.bind(browser);
  let contexts = 0;
  t.mock.method(browser, "newContext", async (...args: Parameters<typeof original>) => {
    contexts += 1;
    if (contexts === 2) await browser.close();
    return original(...args);
  });
  try {
    const report = await new PlaywrightProbeRunner(async () => browser).run({
      packetId: "packet", cases: [
        { ...plan.cases[0], steps: [{ op: "goto", path: "/" },
          { op: "expectValue", locator: { by: "label", text: "Profile name" }, value: "wrong-value" }] },
        { ...plan.cases[0], id: "second" },
      ],
    }, { ...options, baseUrl: server.baseUrl, stepTimeoutMs: 300, caseTimeoutMs: 3000 });
    assert.equal(report.verdict, "fail");
    assert.equal(report.failures[0].category, "assertion");
    assert.equal(report.failures[1].category, "runner");
  } finally {
    await browser.close();
    await server.stop();
  }
});

test("Locator fallbacks rescue missed primaries; hits keep assertion failures strict", async () => {
  const server = await startFixtureServer();
  try {
    const report = await new PlaywrightProbeRunner().run({
      packetId: "packet", cases: [
        {
          id: "fallback-click", requirementIds: ["req"], purpose: "happy_path", expectationBasis: ["fixture"], steps: [
            { op: "goto", path: "/" },
            {
              op: "click",
              locator: { by: "role", role: "tab", name: "Save", fallbacks: [{ by: "role", role: "button", name: "Save" }] },
            },
            { op: "expectText", locator: { by: "role", role: "status" }, text: "Saved" },
          ],
        },
        {
          id: "any-of-feedback", requirementIds: ["req"], purpose: "happy_path", expectationBasis: ["fixture"], steps: [
            { op: "goto", path: "/" },
            { op: "hover", locator: { by: "role", role: "button", name: "Hint" } },
            { op: "expectText", locator: { by: "role", role: "status" }, text: "Saved", anyOf: ["Hovered"] },
          ],
        },
        {
          id: "assert-after-fallback", requirementIds: ["req"], purpose: "happy_path", expectationBasis: ["fixture"], steps: [
            { op: "goto", path: "/" },
            {
              op: "expectText",
              locator: { by: "role", role: "alert", fallbacks: [{ by: "role", role: "status" }] },
              text: "Wrong",
            },
          ],
        },
      ],
    }, { baseUrl: server.baseUrl, stepTimeoutMs: 1_000, caseTimeoutMs: 10_000 });
    assert.deepEqual(report.failures.filter((failure) => failure.caseId !== "assert-after-fallback"), []);
    const assertion = report.failures.find((failure) => failure.caseId === "assert-after-fallback");
    assert.equal(assertion?.category, "assertion");
  } finally {
    await server.stop();
  }
});

test("All assertion targets missing preserves attempts and becomes an unmet expectation for review", async () => {
  const server = await startFixtureServer();
  try {
    const report = await new PlaywrightProbeRunner().run({
      packetId: "packet", cases: [
        {
          id: "all-miss", requirementIds: ["req"], purpose: "happy_path", expectationBasis: ["fixture"], steps: [
            { op: "goto", path: "/" },
            {
              op: "expectVisible",
              locator: { by: "role", role: "tab", name: "Missing", fallbacks: [{ by: "role", role: "menuitem", name: "Missing" }] },
            },
          ],
        },
      ],
    }, { baseUrl: server.baseUrl, stepTimeoutMs: 1_000, caseTimeoutMs: 10_000 });
    assert.equal(report.verdict, "fail");
    assert.equal(report.failures[0].category, "assertion");
    assert.equal(report.failures[0].locatorAttempts?.length, 2);
    assert.ok(report.failures[0].locatorSnapshot);
  } finally {
    await server.stop();
  }
});
