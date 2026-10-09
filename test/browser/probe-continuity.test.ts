import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { PlaywrightProbeRunner } from "../../src/judge/playwright-probe-runner.js";
import { parseProbePlan, toWireProbePlan, type ProbePlan } from "../../src/judge/probe-schema.js";

for (const conflict of [false, true]) {
  test(`A bounded edit/archive/reopen chain detects shared-state conflicts missed by isolated operations: conflict=${conflict}`, async () => {
    const seed = () => ({ value: "Original", other: "Seed", archived: false });
    let state = seed();
    const server = createServer(async (request, response) => {
      if (request.method === "POST") {
        if (request.url === "/save") {
          let body = "";
          for await (const chunk of request) body += chunk;
          state.value = JSON.parse(body).value;
        } else if (request.url === "/archive") {
          state.archived = true;
          if (conflict && state.value !== "Original") state.other = "";
        } else if (request.url === "/reopen") state.archived = false;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(state));
        return;
      }
      response.setHeader("content-type", "text/html");
      response.end(`<main><label>Value<input id="value" value="${state.value}"></label>
        <button onclick="update('/save',{value:document.querySelector('#value').value})">Save</button>
        <button onclick="update('/archive',{})">Archive</button><button onclick="update('/reopen',{})">Reopen</button>
        <p role="status" aria-label="Current">${state.value}</p><p role="status" aria-label="Other">${state.other}</p>
        <p role="status" aria-label="State">${state.archived ? "Archived" : "Active"}</p></main>
        <script>async function update(path,body){const s=await fetch(path,{method:'POST',body:JSON.stringify(body)}).then(r=>r.json());
          document.querySelector('[aria-label=Current]').textContent=s.value;
          document.querySelector('[aria-label=Other]').textContent=s.other;
          document.querySelector('[aria-label=State]').textContent=s.archived?'Archived':'Active';}</script>`);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const status = (name: string) => ({ by: "role" as const, role: "status", name, exact: true });
      const button = (name: string) => ({ by: "role" as const, role: "button", name, exact: true });
      const setup: ProbePlan["cases"][number]["steps"] = [{ op: "goto", path: "/" },
        { op: "expectText", locator: status("Current"), text: "Original" }];
      const edit: ProbePlan["cases"][number]["steps"] = [
        { op: "fill", locator: { by: "label", text: "Value", exact: true }, value: "Changed" },
        { op: "click", locator: button("Save") }, { op: "expectText", locator: status("Current"), text: "Changed" }];
      const archive: ProbePlan["cases"][number]["steps"] = [
        { op: "click", locator: button("Archive") }, { op: "expectText", locator: status("State"), text: "Archived" },
        { op: "click", locator: button("Reopen") }, { op: "expectText", locator: status("State"), text: "Active" }];
      const plan: ProbePlan = { packetId: "continuity", cases: [
        { id: "isolated-edit", requirementIds: ["A"], purpose: "happy_path", expectationBasis: ["fixture"], setupStepCount: 2,
          steps: [...setup, ...edit] },
        { id: "isolated-archive", requirementIds: ["A"], purpose: "happy_path", expectationBasis: ["fixture"], setupStepCount: 2,
          steps: [...setup, ...archive, { op: "expectText", locator: status("Other"), text: "Seed" }] },
        { id: "continuous-edit-archive", requirementIds: ["A"], purpose: "persistence", expectationBasis: ["fixture"], setupStepCount: 2,
          steps: [...setup, ...edit, ...archive, { op: "reload" },
            { op: "expectText", locator: status("Current"), text: "Changed" },
            { op: "expectText", locator: status("Other"), text: "Seed" }] },
      ] };
      let resets = 0;
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const report = await new PlaywrightProbeRunner().run(parseProbePlan(toWireProbePlan(plan)), {
        baseUrl, stepTimeoutMs: 1_000, caseTimeoutMs: 10_000,
        prepareCase: async () => { resets++; state = seed(); return baseUrl; },
      });
      assert.equal(resets, 3);
      assert.ok(report.passedCases.includes("isolated-edit"));
      assert.ok(report.passedCases.includes("isolated-archive"));
      assert.equal(report.verdict, conflict ? "fail" : "pass");
      if (conflict) assert.deepEqual(report.failures.map(failure => [failure.caseId, failure.category]),
        [["continuous-edit-archive", "assertion"]]);
      else assert.equal(report.passedCases.length, 3);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
}
