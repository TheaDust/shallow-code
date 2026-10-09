import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { PlaywrightProbeRunner } from "../../src/judge/playwright-probe-runner.js";
import type { ProbePlan } from "../../src/judge/probe-schema.js";

test("URL and aggregate accessible-count assertions observe public browser behavior", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<main><a href="#/items/feature-a">Open</a><div>1 reaction</div><span>reaction</span><span>2</span>
      <button id="stale">Mount stale dialog</button><dialog id="empty"></dialog></main>
      <script>document.querySelector('#stale').onclick = () => {
        document.querySelector('#empty').innerHTML = '<h2>Closed editor</h2><button>Save</button>';
      };</script>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const plan: ProbePlan = { packetId: "observable", cases: [{ id: "passes", requirementIds: ["A"],
      purpose: "happy_path", expectationBasis: ["fixture"], steps: [
        { op: "goto", path: "/" },
        { op: "click", locator: { by: "role", role: "link", name: "Open", exact: true } },
        { op: "expectUrlContains", value: "feature-a" },
        { op: "expectAccessibleCount", noun: "reaction", exact: 1 },
        { op: "expectClosedOverlaysEmpty" },
      ] }, { id: "split-text-does-not-pass", requirementIds: ["A"], purpose: "negative",
      expectationBasis: ["fixture"], steps: [
        { op: "goto", path: "/" }, { op: "expectAccessibleCount", noun: "reaction", exact: 2 },
      ] }, { id: "closed-dialog-content-fails", requirementIds: ["A"], purpose: "negative",
      expectationBasis: ["fixture"], steps: [
        { op: "goto", path: "/" },
        { op: "click", locator: { by: "role", role: "button", name: "Mount stale dialog", exact: true } },
        { op: "expectClosedOverlaysEmpty" },
      ] }] };
    const report = await new PlaywrightProbeRunner().run(plan, {
      baseUrl: `http://127.0.0.1:${address.port}`, stepTimeoutMs: 1_000, caseTimeoutMs: 5_000,
    });
    assert.deepEqual(report.passedCases, ["passes"]);
    assert.deepEqual(report.failures.map(item => [item.caseId, item.category]), [
      ["split-text-does-not-pass", "assertion"], ["closed-dialog-content-fails", "assertion"],
    ]);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
