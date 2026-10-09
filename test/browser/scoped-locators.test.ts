import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { PlaywrightProbeRunner } from "../../src/judge/playwright-probe-runner.js";

test("Label-based selection excludes a same-named region and still rejects two matching selects", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    const select = '<label for="branch">Default branch</label><select id="branch"><option>main</option><option>release</option></select>';
    response.end(`<main><section aria-label="Default branch">${select}</section>${
      request.url === "/ambiguous" ? select.replaceAll('"branch"', '"second-branch"') : ""}</main>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") assert.fail("missing address");
    const run = (path: string) => new PlaywrightProbeRunner().run({ packetId: "select", cases: [{
      id: "choose", requirementIds: ["A"], purpose: "happy_path", expectationBasis: ["fixture"], steps: [
        { op: "goto", path },
        { op: "select", locator: { by: "label", text: "Default branch", exact: true }, value: "release" },
        { op: "expectValue", locator: { by: "label", text: "Default branch", exact: true }, value: "release" },
      ],
    }] }, { baseUrl: `http://127.0.0.1:${address.port}`, stepTimeoutMs: 500, caseTimeoutMs: 5_000 });
    assert.equal((await run("/")).verdict, "pass");
    const ambiguous = await run("/ambiguous");
    assert.equal(ambiguous.verdict, "inconclusive");
    assert.equal(ambiguous.failures[0].locatorAttempts?.[0].matchCount, 2);
    assert.match(ambiguous.failures[0].message, /strict mode violation/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("Select probes follow the combobox's listbox relation across scopes and keep option ambiguity", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<section aria-label="Rule editor"><label for="rule">Rule type</label>
      <input id="rule" role="combobox" readonly value="Number range" aria-expanded="false"
        ${request.url === "/unrelated" ? "" : 'aria-controls="rules:choices"'}
        onclick="this.setAttribute('aria-expanded','true'); document.getElementById('rules').hidden=false">
      </section>
      <div id="rules" hidden><div id="rules:choices" role="listbox">
        <button role="option" onclick="rule.value=this.textContent; rule.setAttribute('aria-expanded','false'); rules.hidden=true">Number range</button>
        ${request.url === "/missing-option" ? "" : '<button role="option" onclick="rule.value=this.textContent; rule.setAttribute(\'aria-expanded\',\'false\'); rules.hidden=true">Dropdown</button>'}
        ${request.url === "/ambiguous" ? '<button role="option">Dropdown</button>' : ""}
      </div></div>
      <section aria-label="Other editor"><label for="other">Rule type</label>
        <input id="other" role="combobox" readonly value="Number range" aria-controls="other-rules">
        <div id="other-rules" role="listbox"><button role="option">Dropdown</button></div>
      </section>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") assert.fail("missing address");
    const run = (path: string) => new PlaywrightProbeRunner().run({ packetId: "aria-combobox", cases: [{
      id: "choose", requirementIds: ["A"], purpose: "happy_path" as const, expectationBasis: ["fixture"], steps: [
        { op: "goto" as const, path },
        { op: "select" as const, locator: { by: "label" as const, text: "Rule type", exact: true,
          scope: { by: "role" as const, role: "region", name: "Rule editor", exact: true } }, value: "Dropdown" },
        { op: "expectValue" as const, locator: { by: "label" as const, text: "Rule type", exact: true,
          scope: { by: "role" as const, role: "region", name: "Rule editor", exact: true } }, value: "Dropdown" },
      ],
    }] }, {
      baseUrl: `http://127.0.0.1:${address.port}`, stepTimeoutMs: 500, caseTimeoutMs: 5_000,
    });
    const report = await run("/");
    assert.equal(report.verdict, "pass", JSON.stringify(report.failures));
    const ambiguous = await run("/ambiguous");
    assert.equal(ambiguous.verdict, "inconclusive");
    assert.equal(ambiguous.failures[0].category, "locator");
    assert.match(ambiguous.failures[0].message, /strict mode violation/);
    const unrelated = await run("/unrelated");
    assert.equal(unrelated.verdict, "inconclusive");
    assert.equal(unrelated.failures[0].stepIndex, 1);
    assert.match(unrelated.failures[0].message, /aria-controls/);
    const missingOption = await run("/missing-option");
    assert.equal(missingOption.verdict, "fail");
    assert.equal(missingOption.failures[0].stepIndex, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

import { parseProbePlan } from "../../src/judge/probe-schema.js";
import type { WorkPacket } from "../../src/types.js";

test("A declared first control selects the first visible match while ordinary duplicates stay ambiguous", async () => {
  const quote = 'Click the first "Add comment" button.';
  const packet: WorkPacket = { id: "first-control", requirementIds: ["A"], attempt: 1, requirements: [{
    id: "A", name: "Comment", text: quote, folderPath: ["ROOT"], declarationIndex: 0, ancestors: [], dependencyIds: [],
    scenarios: [], references: [], exactUiStrings: ["Add comment"], seedDeclarations: [],
    product: { rootId: "ROOT", rootName: "App", description: "", kind: "generic_web", seedData: [] },
  }] };
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<main><button hidden>Add comment</button>
      <button onclick="document.querySelector('[role=status]').textContent='First line'">Add comment</button>
      <button onclick="document.querySelector('[role=status]').textContent='Second line'">Add comment</button>
      <div role="status"></div></main>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const raw = { packetId: packet.id, cases: [{ id: "comment", requirementIds: ["A"], purpose: "happy_path",
      expectationBasis: [quote], steps: [{ op: "goto", path: "/" }, { op: "click", locator: {
        by: "role", role: "button", name: "Add comment", exact: true, firstMatch: quote,
      } }], assertion: { op: "expectText", locator: { by: "role", role: "status" }, text: "First line" } }] };
    const options = { baseUrl: `http://127.0.0.1:${address.port}`, stepTimeoutMs: 500, caseTimeoutMs: 5_000 };
    const runner = new PlaywrightProbeRunner();
    assert.equal((await runner.run(parseProbePlan(raw, packet), options)).verdict, "pass");
    const ordinary = structuredClone(raw);
    delete (ordinary.cases[0].steps[1] as { locator: { firstMatch?: string } }).locator.firstMatch;
    const report = await runner.run(parseProbePlan(ordinary, packet), options);
    assert.equal(report.verdict, "inconclusive");
    assert.equal(report.failures[0].locatorAttempts?.[0].matchCount, 2);
    assert.match(report.failures[0].message, /strict mode violation/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("Ambiguous targets retain their URL, match count and object containers after a large unrelated view", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<main><div role="grid">${Array.from({ length: 250 }, (_, i) => `<div role="row"><span role="gridcell">Cell ${i}</span></div>`).join("")}</div></main>
      <section role="region" aria-label="Repository"><p>alice/docs</p><button>Search</button></section>
      <section role="region" aria-label="Organization"><p>Acme Demo</p><button>Search</button>
        <label>Password<input type="password" value="private-fixture-value"></label><p>private-fixture-value</p>
        <span hidden>INTERNAL_INVISIBLE</span><script>const internalOnly="SOURCE_NOT_OBSERVABLE";</script></section>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const plan = parseProbePlan({ packetId: "ambiguous", cases: [{ id: "search", requirementIds: ["A"], purpose: "happy_path",
      expectationBasis: ["fixture"], steps: [{ op: "goto", path: "/nested#/files?token=private-url-value" },
        { op: "click", locator: { by: "role", role: "button", name: "Search", exact: true } }],
      assertion: { op: "expectVisible", locator: { by: "role", role: "main" } } }] });
    const report = await new PlaywrightProbeRunner().run(plan, { baseUrl: `http://127.0.0.1:${address.port}`,
      stepTimeoutMs: 1_000, caseTimeoutMs: 5_000 });
    const failure = report.failures[0];
    assert.equal(failure.category, "locator");
    assert.equal(failure.locatorAttempts?.[0].matchCount, 2);
    assert.match(failure.pageUrl ?? "", /nested#\/files/);
    assert.doesNotMatch(failure.pageUrl ?? "", /private-url-value/);
    assert.match(failure.locatorSnapshot ?? "", /alice\/docs/);
    assert.match(failure.locatorSnapshot ?? "", /Acme Demo/);
    assert.match(failure.locatorSnapshot ?? "", /Repository/);
    assert.match(failure.locatorSnapshot ?? "", /Organization/);
    assert.doesNotMatch(failure.locatorSnapshot ?? "", /private-fixture-value/);
    assert.doesNotMatch(failure.locatorSnapshot ?? "", /SOURCE_NOT_OBSERVABLE|INTERNAL_INVISIBLE/);
    assert.ok((failure.locatorSnapshot?.length ?? 0) <= 4_000);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("Scoped accessible locators select the correct repeated card and count multiple matches", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<main><article><h2>Alpha note</h2><button onclick="document.querySelector('[role=status]').textContent='Alpha selected'">More</button></article>
      <article><h2>Beta note</h2><button onclick="document.querySelector('[role=status]').textContent='Beta selected'">More</button></article><div role="status"></div></main>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") assert.fail("missing port");
  try {
    const plan = parseProbePlan({ packetId: "cards", cases: [{ id: "select-beta", requirementIds: ["req"], purpose: "happy_path",
      expectationBasis: ["fixture"], steps: [{ op: "goto", path: "/" },
        { op: "expectCount", locator: { by: "role", role: "button", name: "More" }, count: 2 },
        { op: "click", locator: { by: "role", role: "button", name: "More", scope: { by: "role", role: "article", hasText: "Beta note" } } }],
      assertion: { op: "expectText", locator: { by: "role", role: "status" }, text: "Beta selected" } }] });
    const report = await new PlaywrightProbeRunner().run(plan, { baseUrl: `http://127.0.0.1:${address.port}`, stepTimeoutMs: 1000, caseTimeoutMs: 5000 });
    assert.equal(report.verdict, "pass", JSON.stringify(report.failures));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
