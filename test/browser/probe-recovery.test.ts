import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";
import { auditPacket } from "../../src/judge/audit.js";
import { loadRequirementCatalog } from "../../src/catalog.js";
import { auditPackets } from "../../src/scheduler.js";
import { PlaywrightProbeRunner } from "../../src/judge/playwright-probe-runner.js";
import type { ProbePlan } from "../../src/judge/probe-schema.js";
import { RunStateStore } from "../../src/run-state.js";
import { FakeProbePlanner } from "../fakes/fake-probe-planner.js";
import { withModulePipeline, type PipelineFixture } from "../helpers/module-pipeline.js";

async function withRecoveryApp(description: string, html: string,
  check: (f: PipelineFixture, packet: ReturnType<typeof auditPackets>[number], state: RunStateStore) => Promise<void>,
): Promise<void> {
  await withModulePipeline(async f => {
    const catalog = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    catalog.children[0].children[0].description = description;
    await writeFile(f.options.requirementsFile, JSON.stringify(catalog));
    const packet = auditPackets(await loadRequirementCatalog(f.options.requirementsFile))[0];
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(html);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const baseUrl = `http://127.0.0.1:${address.port}`;
      f.deps.appLifecycle.start = async () => ({ baseUrl, stop: async () => {} });
      f.deps.runner = new PlaywrightProbeRunner();
      const state = new RunStateStore({ statusByRequirementId: { A: "todo" }, acceptedSha: "baseline",
        startedAtMs: 0, totalBudgetMs: 60_000 }, f.options.ledgerFile);
      await check(f, packet, state);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}

test("Preparation ambiguity recovers through a scoped locator before any diagnostic repair", async () => {
  const description = 'Open "Home" in "Primary", then click "Save" to display "Saved".';
  const html = '<main><section aria-label="Primary"><button onclick="document.querySelector(\'output\').textContent=\'Ready\'">Home</button></section>' +
    '<section aria-label="Secondary"><button>Home</button></section>' +
    '<button onclick="document.querySelector(\'output\').textContent=\'Saved\'">Save</button><output role="status">Initial</output></main>';
  await withRecoveryApp(description, html, async (f, packet, state) => {
    const original: ProbePlan = { packetId: packet.id, cases: [{ id: "prepare-save", requirementIds: ["A"],
      purpose: "happy_path", expectationBasis: [description], setupStepCount: 3, steps: [
        { op: "goto", path: "/" },
        { op: "click", locator: { by: "role", role: "button", name: "Home", exact: true } },
        { op: "expectText", locator: { by: "role", role: "status" }, text: "Ready" },
        { op: "click", locator: { by: "role", role: "button", name: "Save", exact: true } },
        { op: "expectText", locator: { by: "role", role: "status" }, text: "Saved" },
      ] }] };
    const corrected = structuredClone(original);
    const step = corrected.cases[0].steps[1];
    assert.ok(step.op === "click");
    step.locator.scope = { by: "role", role: "region", name: "Primary", exact: true };
    const planner = new FakeProbePlanner([corrected]);
    f.deps.planner = planner;
    const result = await auditPacket(packet, original, f.options, f.deps, state, () => 60_000);
    assert.equal(result.status, "verified");
    assert.equal(result.repairableProbeFailure, undefined);
    assert.equal(planner.refinements.length, 1);
    assert.equal(planner.refinements[0].failures[0].category, "precondition");
    assert.match(planner.refinements[0].failures[0].message, /strict mode violation/);
    assert.equal(planner.reviews.length, 0);
    assert.deepEqual(result.plan, corrected);
    assert.equal(f.builder.requests.length, 0);
  });
});

test("A guessed home entry role is refined without changing the same-named form submit role", async () => {
  const description = 'Visitors enter the access page from "Register", "Log in", or "Recover account" on the home page. ' +
    'The form named "Access" contains a textbox labeled "Identity" and a button named "Log in". ' +
    'Submitting the form displays a heading "Workspace".';
  const html = `<main><a href="#">Log in</a></main><script>
    const main = document.querySelector('main');
    main.querySelector('a').addEventListener('click', event => {
      event.preventDefault();
      main.innerHTML = '<form aria-label="Access"><label>Identity<input name="identity"></label><button>Log in</button></form>';
      main.querySelector('form').addEventListener('submit', event => {
        event.preventDefault();
        if (main.querySelector('input').value) main.innerHTML = '<h1>Workspace</h1>';
      });
    });
  </script>`;
  await withRecoveryApp(description, html, async (f, packet, state) => {
    const original: ProbePlan = { packetId: packet.id, cases: [{ id: "access", requirementIds: ["A"],
      purpose: "happy_path", expectationBasis: [description], setupStepCount: 3, steps: [
        { op: "goto", path: "/" },
        { op: "click", locator: { by: "role", role: "button", name: "Log in", exact: true } },
        { op: "expectVisible", locator: { by: "role", role: "form", name: "Access", exact: true } },
        { op: "fill", locator: { by: "label", text: "Identity", exact: true }, value: "tester" },
        { op: "click", locator: { by: "role", role: "button", name: "Log in", exact: true,
          scope: { by: "role", role: "form", name: "Access", exact: true } } },
        { op: "expectVisible", locator: { by: "role", role: "heading", name: "Workspace", exact: true } },
      ] }] };
    const refined = structuredClone(original);
    const entry = refined.cases[0].steps[1];
    assert.ok(entry.op === "click" && entry.locator.by === "role");
    entry.locator.role = "link";
    const planner = new FakeProbePlanner([refined]);
    f.deps.planner = planner;
    const result = await auditPacket(packet, original, f.options, f.deps, state, () => 60_000);
    assert.equal(result.status, "verified");
    assert.equal(result.repairableProbeFailure, undefined);
    assert.equal(planner.refinements.length, 1);
    assert.equal(planner.reviews.length, 0);
    assert.deepEqual(result.plan?.cases[0].steps[4], original.cases[0].steps[4]);
    assert.equal(f.builder.requests.length, 0);
  });
});

test("A locator refinement after search recovery preserves navigation and is freshly confirmed", async () => {
  const description = 'Open repository `docs` from a search result. Seed data: repository `docs`, owner `alice`. ' +
    'Opening it shows "alice/docs"; click "Settings" to display a heading "Settings".';
  const html = `<main><input type="search" aria-label="Search"><section id="results"></section></main><script>
    const main = document.querySelector('main');
    document.querySelector('input').addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      document.querySelector('#results').innerHTML = '<a href="#/alice/docs">docs</a>';
      document.querySelector('#results a').addEventListener('click', () => {
        main.innerHTML = '<h1>alice/docs</h1><a href="#/alice/docs/settings">Settings</a>';
        main.querySelector('a').addEventListener('click', () => { main.innerHTML = '<h1>Settings</h1>'; });
      });
    });
  </script>`;
  await withRecoveryApp(description, html, async (f, packet, state) => {
    const original: ProbePlan = { packetId: packet.id, cases: [{ id: "settings", requirementIds: ["A"],
      purpose: "happy_path", expectationBasis: [description], setupStepCount: 3, steps: [
        { op: "goto", path: "/" },
        { op: "click", locator: { by: "role", role: "link", name: "docs", exact: true } },
        { op: "expectVisible", locator: { by: "role", role: "heading", name: "alice/docs", exact: true } },
        { op: "click", locator: { by: "role", role: "button", name: "Settings", exact: true } },
        { op: "expectVisible", locator: { by: "role", role: "heading", name: "Settings", exact: true } },
      ] }] };
    const planner = new FakeProbePlanner([original]);
    planner.refineLocators = async (plan, failures) => {
      planner.refinements.push({ original: structuredClone(plan), failures: structuredClone(failures) });
      const refined = structuredClone(plan);
      const step = refined.cases[0].steps[5];
      assert.ok(step.op === "click" && step.locator.by === "role");
      step.locator.role = "link";
      return refined;
    };
    f.deps.planner = planner;
    const result = await auditPacket(packet, original, f.options, f.deps, state, () => 60_000);
    assert.equal(result.status, "verified");
    assert.equal(result.repairableProbeFailure, undefined);
    assert.equal(planner.refinements.length, 1);
    assert.equal(planner.reviews.length, 0);
    assert.equal(result.plan?.cases[0].setupStepCount, 5);
    assert.deepEqual(result.plan?.cases[0].steps.slice(1, 3).map(step => step.op), ["fill", "press"]);
    assert.deepEqual(result.plan?.cases[0].steps.at(-1), original.cases[0].steps.at(-1));
    assert.deepEqual((await f.events()).filter(event => event.type === "probe_finished").map(event => event.detail?.verdict),
      ["inconclusive", "inconclusive", "pass", "pass"]);
    assert.equal(f.builder.requests.length, 0);
  });
});
