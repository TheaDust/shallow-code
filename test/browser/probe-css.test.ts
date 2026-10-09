import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { parseProbePlan, toWireProbePlan, type ProbePlan } from "../../src/judge/probe-schema.js";
import { PlaywrightProbeRunner } from "../../src/judge/playwright-probe-runner.js";

test("Immediate background assertions detect a pending commit instead of waiting it away", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<div role="gridcell" aria-label="F4" style="background-color:rgb(232,240,254)">Watch</div>
      <div role="gridcell" aria-label="F5" style="background-color:rgb(232,240,254)">Done</div>
      <button id="apply">Apply fill</button><button id="commit">Complete response</button>
      <script>
        let commit = () => {};
        document.querySelector('#apply').onclick = () => { commit = () => {
          document.querySelector('[aria-label=F4]').style.backgroundColor = 'rgb(254,249,195)';
        }; };
        document.querySelector('#commit').onclick = () => commit();
      </script>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const cell = (name: string) => ({ by: "role", role: "gridcell", name, exact: true } as const);
    const action = (name: string) => ({ op: "click", locator: { by: "role", role: "button", name, exact: true } } as const);
    const comparison = { op: "expectCss", locator: cell("F4"), property: "background-color",
      differentFrom: cell("F5"), immediate: true } as const;
    const exact = { op: "expectCss", locator: cell("F4"), property: "background-color",
      value: "rgb(254, 249, 195)", immediate: true } as const;
    const plan: ProbePlan = { packetId: "commit-window", cases: [
      { id: "pending-comparison", requirementIds: ["A"], purpose: "negative", expectationBasis: ["fixture"],
        steps: [{ op: "goto", path: "/" }, action("Apply fill"), comparison] },
      { id: "pending-exact-color", requirementIds: ["A"], purpose: "negative", expectationBasis: ["fixture"],
        steps: [{ op: "goto", path: "/" }, action("Apply fill"), exact] },
      { id: "committed", requirementIds: ["A"], purpose: "happy_path", expectationBasis: ["fixture"],
        steps: [{ op: "goto", path: "/" }, action("Apply fill"), action("Complete response"), comparison, exact] },
    ] };
    const report = await new PlaywrightProbeRunner().run(parseProbePlan(toWireProbePlan(plan)), {
      baseUrl: `http://127.0.0.1:${address.port}`, stepTimeoutMs: 1_000, caseTimeoutMs: 5_000,
    });
    assert.deepEqual(report.passedCases, ["committed"]);
    assert.deepEqual(report.failures.map(failure => [failure.caseId, failure.category]), [
      ["pending-comparison", "assertion"], ["pending-exact-color", "assertion"],
    ]);
    assert.ok(report.failures.every(failure => failure.message.includes("immediately")),
      JSON.stringify(report.failures.map(failure => ({ caseId: failure.caseId, message: failure.message }))));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

for (const delay of [0, 150, 500]) {
  test(`Computed style probes observe the commit and reload, delay=${delay}ms`, async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(`<div role="grid">
        <div role="gridcell" aria-label="F4" aria-selected="true">Watch</div>
        <div role="gridcell" aria-label="F5" aria-selected="true">Done</div>
        <div role="gridcell" aria-label="F6" aria-selected="true">Ready</div>
      </div><button id="save">Apply fill</button>
      <style>[role=gridcell][aria-selected=true] { background-color: rgb(232, 240, 254); }</style>
      <script>
        const render = () => {
          if (localStorage.getItem('saved')) document.querySelector('[aria-label=F4]').style.backgroundColor = 'rgb(254, 249, 195)';
        };
        render();
        document.querySelector('#save').onclick = () => setTimeout(() => { localStorage.setItem('saved', 'yes'); render(); }, ${delay});
      </script>`);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const cell = (name: string) => ({ by: "role", role: "gridcell", name, exact: true } as const);
      const comparison = { op: "expectCss", locator: cell("F4"), property: "background-color", differentFrom: cell("F5") } as const;
      const plan: ProbePlan = { packetId: "computed-fill", cases: [{
        id: "commit-and-reload", requirementIds: ["A"], purpose: "persistence", expectationBasis: ["fixture"], steps: [
          { op: "goto", path: "/" },
          { op: "click", locator: { by: "role", role: "button", name: "Apply fill", exact: true } },
          comparison,
          { op: "expectCss", locator: cell("F4"), property: "background-color", value: "rgb(254, 249, 195)" },
          { op: "expectAttribute", locator: cell("F4"), attribute: "aria-selected", value: "true" },
          { op: "reload" }, comparison,
        ],
      }, {
        id: "rules-do-not-prove-fill", requirementIds: ["A"], purpose: "negative", expectationBasis: ["fixture"], steps: [
          { op: "goto", path: "/" }, comparison,
        ],
      }, {
        id: "unchanged-cell-is-a-real-control", requirementIds: ["A"], purpose: "negative", expectationBasis: ["fixture"], steps: [
          { op: "goto", path: "/" },
          { op: "click", locator: { by: "role", role: "button", name: "Apply fill", exact: true } },
          { ...comparison, locator: cell("F5"), differentFrom: cell("F6") },
        ],
      }] };
      const report = await new PlaywrightProbeRunner().run(parseProbePlan(toWireProbePlan(plan)), {
        baseUrl: `http://127.0.0.1:${address.port}`, stepTimeoutMs: 1_500, caseTimeoutMs: 8_000,
      });
      assert.deepEqual(report.passedCases, ["commit-and-reload"]);
      assert.deepEqual(report.failures.map(failure => [failure.caseId, failure.category]), [
        ["rules-do-not-prove-fill", "assertion"], ["unchanged-cell-is-a-real-control", "assertion"],
      ]);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}
