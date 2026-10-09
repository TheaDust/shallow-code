import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { PlaywrightProbeRunner } from "../../src/judge/playwright-probe-runner.js";
import { parseProbePlan, toWireProbePlan, type ProbePlan } from "../../src/judge/probe-schema.js";

test("Checked probes use native and ARIA state, and setChecked is idempotent", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<label>Header row<input type="checkbox" checked></label>
      <label>Mixed<input id="mixed" type="checkbox"></label>
      <div role="checkbox" aria-label="Custom" aria-checked="false" onclick="this.setAttribute('aria-checked', String(this.getAttribute('aria-checked') !== 'true'))">Custom</div>
      <select size="2"><option selected>First</option><option>Second</option></select>
      <script>document.getElementById('mixed').indeterminate=true</script>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") assert.fail("missing address");
    const checkbox = (name: string) => ({ by: "role" as const, role: "checkbox", name, exact: true });
    const plan: ProbePlan = { packetId: "native-state", cases: [{
      id: "native-and-custom", requirementIds: ["A"], purpose: "happy_path", expectationBasis: ["fixture"], steps: [
        { op: "goto", path: "/" },
        { op: "setChecked", locator: checkbox("Header row"), checked: true },
        { op: "setChecked", locator: checkbox("Header row"), checked: true },
        { op: "expectAttribute", locator: checkbox("Header row"), attribute: "aria-checked", value: "true" },
        { op: "setChecked", locator: checkbox("Header row"), checked: false },
        { op: "expectAttribute", locator: checkbox("Header row"), attribute: "aria-checked", value: "false" },
        { op: "setChecked", locator: checkbox("Custom"), checked: true },
        { op: "expectAttribute", locator: checkbox("Custom"), attribute: "aria-checked", value: "true" },
        { op: "expectAttribute", locator: checkbox("Mixed"), attribute: "aria-checked", value: "mixed" },
        { op: "expectAttribute", locator: { by: "role", role: "option", name: "First" }, attribute: "aria-selected", value: "true" },
      ],
    }, {
      id: "wrong-native-state", requirementIds: ["A"], purpose: "negative", expectationBasis: ["fixture"], steps: [
        { op: "goto", path: "/" },
        { op: "expectAttribute", locator: checkbox("Header row"), attribute: "aria-checked", value: "false" },
      ],
    }, {
      id: "mixed-is-not-unchecked", requirementIds: ["A"], purpose: "negative", expectationBasis: ["fixture"], steps: [
        { op: "goto", path: "/" },
        { op: "expectAttribute", locator: checkbox("Mixed"), attribute: "aria-checked", value: "false" },
      ],
    }] };
    const report = await new PlaywrightProbeRunner().run(parseProbePlan(toWireProbePlan(plan)), {
      baseUrl: `http://127.0.0.1:${address.port}`, stepTimeoutMs: 500, caseTimeoutMs: 10_000,
    });
    assert.deepEqual(report.passedCases, ["native-and-custom"]);
    assert.deepEqual(report.failures.map(item => [item.caseId, item.category]), [
      ["wrong-native-state", "assertion"], ["mixed-is-not-unchecked", "assertion"],
    ]);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("Failure snapshots retain a scoped dialog after a large grid and omit password values", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<main><div role="grid">${Array.from({ length: 250 }, (_, i) => `<div role="row"><span role="gridcell">Cell ${i}</span></div>`).join("")}</div></main>
      <div role="dialog" aria-label="Sort range"><label>Sort by<select><option>Sales</option></select></label>
      <label>Password<input type="password" value="secret-fixture-value"></label><button>Apply</button><p>${"Details ".repeat(500)}</p></div>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") assert.fail("missing address");
    const report = await new PlaywrightProbeRunner().run({ packetId: "large-grid", cases: [{
      id: "missing-label", requirementIds: ["A"], purpose: "happy_path", expectationBasis: ["fixture"], steps: [
        { op: "goto", path: "/" },
        { op: "select", locator: { by: "label", text: "Sort by", exact: true,
          scope: { by: "role", role: "dialog", name: "Sort range", exact: true } }, value: "Sales" },
      ],
    }] }, { baseUrl: `http://127.0.0.1:${address.port}`, stepTimeoutMs: 500, caseTimeoutMs: 5_000 });
    assert.equal(report.failures[0]?.category, "locator");
    const snapshot = report.failures[0].locatorSnapshot ?? "";
    assert.match(snapshot, /dialog "Sort range"/);
    assert.match(snapshot, /combobox "Sort by"/);
    assert.match(snapshot, /button "Apply"/);
    assert.equal(snapshot.match(/dialog "Sort range"/g)?.length, 1);
    assert.ok(snapshot.length <= 4_000);
    assert.doesNotMatch(snapshot, /secret-fixture-value/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("State probes reject no-op toggles and visible fallbacks in Chromium", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<button aria-expanded="true" onclick="${request.url === "/broken" ? "" : "this.setAttribute('aria-expanded', String(this.getAttribute('aria-expanded') !== 'true')); document.querySelector('aside').hidden = this.getAttribute('aria-expanded') === 'false'"}">Toggle</button><aside>Tools</aside>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") assert.fail("missing address");
    // These tests check state and failure categories, not sub-second browser latency.
    const run = (plan: ProbePlan) => new PlaywrightProbeRunner().run(plan, {
      baseUrl: `http://127.0.0.1:${address.port}`, stepTimeoutMs: 1_000, caseTimeoutMs: 5_000,
    });
    const plan: ProbePlan = { packetId: "state", cases: [{ id: "toggle", requirementIds: ["A"], purpose: "happy_path",
      expectationBasis: ["fixture"], steps: [
      { op: "goto", path: "/" },
      { op: "click", locator: { by: "role", role: "button", name: "Toggle" } },
      { op: "expectAttribute", locator: { by: "role", role: "button", name: "Toggle" }, attribute: "aria-expanded", value: "false" },
      { op: "expectHidden", locator: { by: "role", role: "complementary" } },
      { op: "click", locator: { by: "role", role: "button", name: "Toggle" } },
      { op: "expectAttribute", locator: { by: "role", role: "button", name: "Toggle" }, attribute: "aria-expanded", value: "true" },
      { op: "expectVisible", locator: { by: "role", role: "complementary" } },
    ] }] };
    assert.equal((await run(plan)).verdict, "pass");
    plan.cases[0].steps[0] = { op: "goto", path: "/broken" };
    const broken = await run(plan);
    assert.equal(broken.verdict, "fail");
    assert.equal(broken.failures[0].category, "assertion");
    assert.equal(broken.failures[0].stepIndex, 2);
    plan.cases[0].steps = [{ op: "goto", path: "/" }, { op: "expectHidden", locator: {
      by: "role", role: "dialog", fallbacks: [{ by: "role", role: "complementary" }],
    } }];
    assert.equal((await run(plan)).verdict, "fail");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("Enabled-state probes verify undo transitions, inherited disabling and ARIA in Chromium", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<button id="redo" disabled>Redo</button>
      <button onclick="document.getElementById('redo').disabled=false">Undo</button>
      <input aria-label="Editor" oninput="document.getElementById('redo').disabled=true">
      <fieldset disabled><button>Inherited block</button></fieldset>
      <div role="button" aria-disabled="true">ARIA action</div>
      <button style="opacity:.3;pointer-events:none">Fake disabled</button>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") assert.fail("missing address");
    const control = (name: string) => ({ by: "role" as const, role: "button", name, exact: true });
    const plan: ProbePlan = { packetId: "enabled-state", cases: [{
      id: "undo-new-edit", requirementIds: ["A"], purpose: "happy_path", expectationBasis: ["fixture"], steps: [
        { op: "goto", path: "/" },
        { op: "expectVisible", locator: control("Redo") },
        { op: "expectDisabled", locator: control("Redo") },
        { op: "expectDisabled", locator: control("Inherited block") },
        { op: "expectDisabled", locator: control("ARIA action") },
        { op: "click", locator: control("Undo") },
        { op: "expectEnabled", locator: control("Redo") },
        { op: "fill", locator: { by: "label", text: "Editor", exact: true }, value: "new edit" },
        { op: "expectDisabled", locator: control("Redo") },
      ],
    }, ...[
      ["visual-only", "expectDisabled", "Fake disabled"],
      ["inherited-enabled", "expectEnabled", "Inherited block"],
      ["aria-enabled", "expectEnabled", "ARIA action"],
      ["missing-control", "expectDisabled", "Missing action"],
    ].map(([id, op, name]) => ({ id, requirementIds: ["A"], purpose: "negative" as const, expectationBasis: ["fixture"],
      steps: [{ op: "goto" as const, path: "/" },
        { op: op as "expectDisabled" | "expectEnabled", locator: control(name) }],
    }))] };
    const report = await new PlaywrightProbeRunner().run(parseProbePlan(toWireProbePlan(plan)), {
      baseUrl: `http://127.0.0.1:${address.port}`, stepTimeoutMs: 1_000, caseTimeoutMs: 5_000,
    });
    assert.deepEqual(report.passedCases, ["undo-new-edit"]);
    assert.equal(report.failures.length, 4);
    assert.ok(report.failures.every(failure => failure.category === "assertion" && failure.stepIndex === 1));
    assert.equal(report.verdict, "fail");
    assert.match(report.failures[0].locatorSnapshot ?? "", /Fake disabled/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("Visible fallback actions skip hidden text while hidden file inputs remain uploadable", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<span hidden>Save</span><button aria-label="Save" onclick="document.getElementById('result').textContent='Saved'">✓</button>
      <label for="csv">CSV file</label><input hidden id="csv" type="file" onchange="document.getElementById('result').textContent='Uploaded '+this.files[0].name">
      <p id="result" role="status"></p>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") assert.fail("missing address");
    const plan: ProbePlan = { packetId: "visible-candidate", cases: [{
      id: "visible-action", requirementIds: ["A"], purpose: "happy_path", expectationBasis: ["fixture"], steps: [
        { op: "goto", path: "/" },
        { op: "click", locator: { by: "text", text: "Save", exact: true,
          fallbacks: [{ by: "role", role: "button", name: "Save", exact: true }] } },
        { op: "expectText", locator: { by: "role", role: "status" }, text: "Saved" },
      ],
    }, {
      id: "hidden-upload", requirementIds: ["A"], purpose: "happy_path", expectationBasis: ["fixture"], steps: [
        { op: "goto", path: "/" },
        { op: "uploadFile", locator: { by: "label", text: "CSV file", exact: true }, fileName: "records.csv", content: "Name\nAlice" },
        { op: "expectText", locator: { by: "role", role: "status" }, text: "Uploaded records.csv" },
      ],
    }, {
      id: "hidden-only", requirementIds: ["A"], purpose: "negative", expectationBasis: ["fixture"], steps: [
        { op: "goto", path: "/" },
        { op: "click", locator: { by: "text", text: "Save", exact: true } },
        { op: "expectText", locator: { by: "role", role: "status" }, text: "Saved" },
      ],
    }] };
    const report = await new PlaywrightProbeRunner().run(parseProbePlan(toWireProbePlan(plan)), {
      baseUrl: `http://127.0.0.1:${address.port}`, stepTimeoutMs: 1_000, caseTimeoutMs: 5_000,
    });
    assert.deepEqual(report.passedCases, ["visible-action", "hidden-upload"]);
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0].caseId, "hidden-only");
    assert.equal(report.failures[0].category, "locator");
    assert.equal(report.verdict, "inconclusive");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
