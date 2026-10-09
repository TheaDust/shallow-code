import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { parseProbePlan, type ProbePlan } from "../../src/judge/probe-schema.js";
import { PlaywrightProbeRunner } from "../../src/judge/playwright-probe-runner.js";
import type { WorkPacket } from "../../src/types.js";
import { publicEntryPlan } from "../../src/judge/public-entry.js";

const description = 'The top global search uses a searchbox named "Lookup". ' +
  'The visitor starts at the home page in a fresh unauthenticated session. ' +
  'Visitors can search. ' +
  'Its results expose a link named "Shared area"; opening it displays a heading "Shared area". ' +
  'Users open the "Data" menu and choose the menuitem named "Activity log". ' +
  'The page displays a heading "Activity log".';

const packet: WorkPacket = { id: "public-entry", requirementIds: ["A"], attempt: 1, requirements: [{
  id: "A", name: "Public entry", text: description, declarationIndex: 0, folderPath: ["ROOT"], ancestors: [],
  dependencyIds: [], scenarios: [], references: [], exactUiStrings: ["Lookup", "Shared area", "Data", "Activity log"],
  seedDeclarations: [], product: { kind: "generic_web", rootId: "ROOT", rootName: "Product", description: "", seedData: [] },
}] };

// Deliberately omit scope: the parser must deterministically project the
// requirement's global landmark contract even when the planner forgets it.
const search = { by: "role" as const, role: "searchbox", name: "Lookup", exact: true };
const plan: ProbePlan = { packetId: packet.id, cases: [{ id: "search-and-menu", requirementIds: ["A"], purpose: "happy_path",
  expectationBasis: [description], setupStepCount: 7, steps: [
    { op: "goto", path: "/" }, { op: "expectVisible", locator: search },
    { op: "fill", locator: search, value: "Shared area" }, { op: "press", locator: search, key: "Enter" },
    { op: "expectVisible", locator: { by: "role", role: "link", name: "Shared area", exact: true } },
    { op: "click", locator: { by: "role", role: "link", name: "Shared area", exact: true } },
    { op: "expectVisible", locator: { by: "role", role: "heading", name: "Shared area", exact: true } },
    { op: "click", locator: { by: "role", role: "button", name: "Data", exact: true } },
    { op: "expectVisible", locator: { by: "role", role: "menu", name: "Data", exact: true } },
    { op: "click", locator: { by: "role", role: "menuitem", name: "Activity log", exact: true } },
    { op: "expectVisible", locator: { by: "role", role: "heading", name: "Activity log", exact: true } },
  ] }] };

for (const nestedHeader of [false, true]) {
  test(`Public entry checks the global banner before following results and menu, nestedHeader=${nestedHeader}`, async () => {
    const header = '<header><input type="search" aria-label="Lookup"></header>';
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(`${nestedHeader ? `<main>${header}<div id="results"></div></main>` : `${header}<main><div id="results"></div></main>`}
        <script>
          document.querySelector('input').addEventListener('keydown', event => {
            if (event.key !== 'Enter') return;
            document.querySelector('#results').innerHTML = '<a href="#">Shared area</a>';
            document.querySelector('#results a').addEventListener('click', event => {
              event.preventDefault();
              document.querySelector('main').innerHTML = '<h1>Shared area</h1><button id="data">Data</button>' +
                '<div role="menu" aria-label="Data" hidden><button role="menuitem">Activity log</button></div>';
              document.querySelector('#data').addEventListener('click', () => document.querySelector('[role="menu"]').hidden = false);
              document.querySelector('[role="menuitem"]').addEventListener('click', () => document.querySelector('main').innerHTML = '<h1>Activity log</h1>');
            });
          });
        </script>`);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const entry = publicEntryPlan(packet);
      assert.ok(entry);
      const structural = await new PlaywrightProbeRunner().run(entry, {
        baseUrl: `http://127.0.0.1:${address.port}`, stepTimeoutMs: 1_000, caseTimeoutMs: 5_000,
      });
      assert.equal(structural.verdict, nestedHeader ? "fail" : "pass");
      if (nestedHeader) {
        assert.equal(structural.failures[0].stepIndex, 1);
        assert.equal(structural.failures[0].category, "assertion");
      }
      const report = await new PlaywrightProbeRunner().run(parseProbePlan(plan, packet), {
        baseUrl: `http://127.0.0.1:${address.port}`, stepTimeoutMs: 1_000, caseTimeoutMs: 10_000,
      });
      if (nestedHeader) {
        assert.equal(report.verdict, "inconclusive");
        assert.equal(report.failures[0].stepIndex, 1);
        assert.equal(report.failures[0].category, "precondition");
        assert.match(report.failures[0].locatorSnapshot ?? "", /searchbox "Lookup"/);
      } else {
        assert.equal(report.verdict, "pass");
        assert.deepEqual(report.passedCases, ["search-and-menu"]);
      }
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}
