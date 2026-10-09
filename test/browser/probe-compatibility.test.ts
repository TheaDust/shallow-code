import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { PlaywrightProbeRunner } from "../../src/judge/playwright-probe-runner.js";
import { overlayLifecyclePlan } from "../../src/judge/compatibility-probes.js";
import { resultCompatibilityPlan } from "../../src/judge/compatibility-contracts.js";
import { toBuilderShadowObservation } from "../../src/builder/shadow-observation.js";
import type { ProbePlan, ProbeStep } from "../../src/judge/probe-schema.js";
import type { WorkPacket } from "../../src/types.js";

async function withPage(html: string, run: (url: string) => Promise<void>): Promise<void> {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html"); response.end(html);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    await run(`http://127.0.0.1:${address.port}`);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

function cases(entries: [string, ProbeStep[]][]): ProbePlan {
  return { packetId: "compatibility", cases: entries.map(([id, steps]) => ({
    id, requirementIds: ["A"], purpose: "happy_path", expectationBasis: ["fixture"],
    steps: [{ op: "goto", path: "/" }, ...steps],
  })) };
}

test("counts require one entity and retain the numeric expectation and observation in Builder feedback", async () => {
  await withPage('<main><section aria-label="Target record"><p>0 reactions</p></section><aside><p>1 reaction</p></aside></main>', async baseUrl => {
    const plan = cases([
      ["ambiguous", [{ op: "expectAccessibleCount", noun: "reaction", exact: 1 }]],
      ["correct-target", [{ op: "expectAccessibleCount", noun: "reaction", exact: 0,
        scope: { by: "role", role: "region", name: "Target record", exact: true } }]],
      ["wrong-target-count", [{ op: "expectAccessibleCount", noun: "reaction", exact: 1,
        scope: { by: "role", role: "region", name: "Target record", exact: true } }]],
    ]);
    const report = await new PlaywrightProbeRunner().run(plan, { baseUrl, stepTimeoutMs: 600, caseTimeoutMs: 4_000 });
    assert.deepEqual(report.passedCases, ["correct-target"]);
    assert.deepEqual(report.failures.map(failure => failure.category), ["locator", "assertion"]);
    const observation = toBuilderShadowObservation(report).failures.find(failure => failure.caseId === "wrong-target-count")!;
    assert.match(observation.message, /reaction.*exactly 1.*0 reactions/);
    assert.match(observation.accessibilityExcerpt!, /Target record/);
  });
});

test("derived count diagnostics distinguish a bare number from a visible complete count", async () => {
  const text = "The record detail displays the item type and count.";
  const packet: WorkPacket = { id: "compatibility", attempt: 1, requirementIds: ["A"], requirements: [{
    id: "A", name: "Counts", text, declarationIndex: 0, folderPath: ["ROOT"], dependencyIds: [], scenarios: [],
    ancestors: [], references: [], exactUiStrings: [], seedDeclarations: [],
    product: { rootId: "ROOT", rootName: "Anonymous", kind: "generic_web", description: "", seedData: [], evolution: true },
    scenarioContracts: [{ id: "count", name: "Read", steps: [{ keyword: "WHEN", content: "The visitor opens the record." },
      { keyword: "THEN", content: "The existing item count is visible." }] }],
  }] };
  const business = cases([["count", [{ op: "expectVisible", locator: { by: "role", role: "main" } }]]]);
  business.cases[0].outcomeChecks = [{ scenarioId: "count", stepIndex: 1, assertionIndexes: [1] }];
  const diagnostic = resultCompatibilityPlan(packet, business)!;
  for (const [count, verdict] of [["1", "fail"], ["1 item", "pass"]]) {
    await withPage(`<main><h1>Record</h1><span>${count}</span></main>`, async baseUrl => {
      const runner = new PlaywrightProbeRunner();
      assert.equal((await runner.run(business, { baseUrl, stepTimeoutMs: 600, caseTimeoutMs: 4000 })).verdict, "pass");
      assert.equal((await runner.run(diagnostic, { baseUrl, stepTimeoutMs: 600, caseTimeoutMs: 4000 })).verdict, verdict);
    });
  }
});

test("failed-form identity cannot be supplied by another list or a hidden form node", async () => {
  const locator = { by: "label", text: "Tag", exact: true } as const;
  const plan = cases([["context", [{ op: "expectValue", locator, value: "stable-1" },
    { op: "expectFormContext", locator, value: "stable-1" }]]]);
  for (const [content, verdict] of [
    ['<p hidden>stable-1</p>', "fail"], ['', "fail"], ['<p>stable-1</p>', "pass"],
  ]) await withPage(`<main><form><label>Tag<input value="stable-1"></label><p role="alert">Already exists</p>${content}</form>
    <section aria-label="Records"><a href="#/records/1">stable-1</a></section></main>`, async baseUrl => {
    const report = await new PlaywrightProbeRunner().run(plan, { baseUrl, stepTimeoutMs: 600, caseTimeoutMs: 4000 });
    assert.equal(report.verdict, verdict);
    if (verdict === "fail") assert.match(report.failures[0].message, /failed form/);
  });
  await withPage('<main><div role="form"><label>Tag<input value="stable-1"></label><p>stable-1</p></div></main>', async baseUrl => {
    const report = await new PlaywrightProbeRunner().run(plan, { baseUrl, stepTimeoutMs: 600, caseTimeoutMs: 4000 });
    assert.equal(report.verdict, "inconclusive", "a legitimate non-native form cannot authorize an application repair");
  });
});

test("a successful login staying at the hash root cannot masquerade as a nested-route checkpoint", async () => {
  await withPage('<main><a href="#/">Authenticated home</a><a href="#/records/1">Open record</a></main>', async baseUrl => {
    const plan = cases([
      ["still-home", [{ op: "click", locator: { by: "role", role: "link", name: "Authenticated home", exact: true } },
        { op: "expectAwayFromHome" }]],
      ["nested", [{ op: "click", locator: { by: "role", role: "link", name: "Open record", exact: true } },
        { op: "expectAwayFromHome" }]],
    ]);
    const report = await new PlaywrightProbeRunner().run(plan, { baseUrl, stepTimeoutMs: 600, caseTimeoutMs: 4_000 });
    assert.deepEqual(report.passedCases, ["nested"]);
    assert.equal(report.failures[0].category, "runner");
    assert.match(report.failures[0].message, /did not reach a route/);
  });
});

test("shared closed-dialog leakage is observed from a real readiness checkpoint without opening the dialog", async () => {
  const packet: WorkPacket = { id: "compatibility", attempt: 1, requirementIds: ["A"], requirements: [{
    id: "A", name: "Shared controls", text: "The account menu confirms actions in a dialog.",
    declarationIndex: 0, folderPath: ["ROOT"], dependencyIds: [], scenarios: [], ancestors: [], references: [], exactUiStrings: [], seedDeclarations: [],
    product: { rootId: "ROOT", rootName: "Anonymous", kind: "generic_web", description: "", seedData: [], evolution: true },
  }] };
  const business = cases([["ready", [{ op: "expectVisible", locator: { by: "role", role: "heading", name: "Record", exact: true } }]]]);
  const derived = overlayLifecyclePlan(packet, business); assert.ok(derived);
  for (const [name, body, expected] of [
    ["stale", '<p>Only the current session is signed out.</p><button>Confirm</button>', "fail"],
    ["upgraded", "", "pass"],
  ]) await withPage(`<main><h1>Record</h1></main><dialog>${body}</dialog>`, async baseUrl => {
    const report = await new PlaywrightProbeRunner().run(derived, { baseUrl, stepTimeoutMs: 600, caseTimeoutMs: 4_000 });
    assert.equal(report.verdict, expected, name);
  });
});

test("a deleted known fill can be checked without guessing the default cell background", async () => {
  await withPage(`<main><div role="grid"><div role="gridcell" aria-label="L4">28</div></div>
    <button onclick="document.querySelector('[role=gridcell]').style.backgroundColor='rgb(220,252,231)'">Fill</button>
    <button onclick="document.querySelector('[role=gridcell]').style.backgroundColor=''">Delete fill</button></main>`, async baseUrl => {
    const locator = { by: "role", role: "gridcell", name: "L4", exact: true } as const;
    const negative: ProbeStep = { op: "expectCss", locator, property: "background-color", notValue: "rgb(220, 252, 231)", immediate: true };
    const plan = cases([
      ["deleted", [{ op: "click", locator: { by: "role", role: "button", name: "Fill", exact: true } },
        { op: "expectCss", locator, property: "background-color", value: "rgb(220, 252, 231)" },
        { op: "click", locator: { by: "role", role: "button", name: "Delete fill", exact: true } }, negative]],
      ["stale-color", [{ op: "click", locator: { by: "role", role: "button", name: "Fill", exact: true } }, negative]],
    ]);
    const report = await new PlaywrightProbeRunner().run(plan, { baseUrl, stepTimeoutMs: 600, caseTimeoutMs: 4_000 });
    assert.deepEqual(report.passedCases, ["deleted"]);
    assert.equal(report.failures[0].category, "assertion");
  });
});
