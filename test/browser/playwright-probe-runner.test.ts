import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { PlaywrightProbeRunner } from "../../src/judge/playwright-probe-runner.js";
import type { ProbePlan } from "../../src/judge/probe-schema.js";
import { startFixtureServer } from "../helpers/fixture-server.js";

test("Playwright Probe Runner executes fill, click, reload, and assertions in Chromium", async () => {
  const server = await startFixtureServer();
  try {
    const report = await new PlaywrightProbeRunner().run(happyPlan(), {
      baseUrl: server.baseUrl,
      stepTimeoutMs: 2_000,
      caseTimeoutMs: 10_000,
    });

    assert.deepEqual(report, {
      packetId: "packet-profile",
      verdict: "pass",
      passedCases: ["save-profile", "refresh-profile"],
      failures: [],
    });
  } finally {
    await server.stop();
  }
});

test("Playwright Probe Runner executes press, doubleClick, and hover actions in Chromium", async () => {
  const server = await startFixtureServer();
  try {
    const plan: ProbePlan = {
      packetId: "packet-actions",
      cases: [
        {
          id: "keyboard-and-pointer",
          requirementIds: ["REQ-ACTIONS"],
          purpose: "happy_path",
          expectationBasis: ["fixture"],
          steps: [
            { op: "goto", path: "/" },
            {
              op: "fill",
              locator: { by: "label", text: "Profile name" },
              value: "Kim",
            },
            {
              op: "press",
              locator: { by: "label", text: "Profile name" },
              key: "Enter",
            },
            {
              op: "expectText",
              locator: { by: "role", role: "status" },
              text: "Saved",
              exact: true,
            },
            {
              op: "doubleClick",
              locator: { by: "role", role: "button", name: "Rename" },
            },
            {
              op: "expectText",
              locator: { by: "role", role: "status" },
              text: "Renamed",
              exact: true,
            },
            {
              op: "hover",
              locator: { by: "role", role: "button", name: "Hint" },
            },
            {
              op: "expectText",
              locator: { by: "role", role: "status" },
              text: "Hovered",
              exact: true,
            },
          ],
        },
      ],
    };

    const report = await new PlaywrightProbeRunner().run(plan, {
      baseUrl: server.baseUrl,
      stepTimeoutMs: 2_000,
      caseTimeoutMs: 10_000,
    });

    assert.equal(report.verdict, "pass");
    assert.deepEqual(report.passedCases, ["keyboard-and-pointer"]);
  } finally {
    await server.stop();
  }
});

test("Playwright Probe Runner executes file upload, clipboard setup, right click, and drag", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<label for="csv">CSV file</label><input id="csv" type="file" onchange="this.files[0].text().then(text => document.querySelector('[role=status]').textContent = this.files[0].name + ':' + text)">
      <div role="rowheader" aria-label="2" oncontextmenu="event.preventDefault(); document.querySelector('[role=menuitem]').hidden = false">2</div>
      <button role="menuitem" hidden onclick="document.querySelector('[role=status]').textContent = 'row added'">Insert 1 row above</button>
      <button onclick="navigator.clipboard.readText().then(text => document.querySelector('[role=status]').textContent = text)">Read clipboard</button>
      <div role="gridcell" aria-label="A1" draggable="true">A1</div>
      <div role="gridcell" aria-label="B2" ondragover="event.preventDefault()" ondrop="event.preventDefault(); document.querySelector('[role=status]').textContent = 'dragged'">B2</div>
      <output role="status"></output>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const run = (plan: ProbePlan) => new PlaywrightProbeRunner().run(plan, {
      baseUrl: `http://127.0.0.1:${address.port}`, stepTimeoutMs: 2_000, caseTimeoutMs: 15_000,
    });
    const plan: ProbePlan = { packetId: "sheet-actions", cases: [{ id: "actions", requirementIds: ["S"],
      purpose: "happy_path", expectationBasis: ["fixture"], steps: [
        { op: "goto", path: "/" },
        { op: "uploadFile", locator: { by: "label", text: "CSV file" }, fileName: "data.csv", content: "East,1200" },
        { op: "expectText", locator: { by: "role", role: "status" }, text: "data.csv:East,1200" },
        { op: "rightClick", locator: { by: "role", role: "rowheader", name: "2" } },
        { op: "click", locator: { by: "role", role: "menuitem", name: "Insert 1 row above" } },
        { op: "expectText", locator: { by: "role", role: "status" }, text: "row added" },
        { op: "setClipboardText", text: "North\t800" },
        { op: "click", locator: { by: "role", role: "button", name: "Read clipboard" } },
        { op: "expectText", locator: { by: "role", role: "status" }, text: "North\t800" },
        { op: "drag", from: { by: "role", role: "gridcell", name: "A1" },
          to: { by: "role", role: "gridcell", name: "B2" } },
        { op: "expectText", locator: { by: "role", role: "status" }, text: "dragged" },
      ] }] };
    assert.equal((await run(plan)).verdict, "pass");
    plan.cases[0].steps = [{ op: "goto", path: "/" },
      { op: "fill", locator: { by: "label", text: "CSV file" }, value: "fixtures/data.csv" }];
    const invalid = await run(plan);
    assert.equal(invalid.verdict, "inconclusive");
    assert.equal(invalid.failures[0].category, "runner");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("Playwright Probe Runner creates a fresh browser context for newContext", async () => {
  const server = await startFixtureServer();
  try {
    const plan: ProbePlan = {
      packetId: "packet-context",
      cases: [
        {
          id: "replace-context",
          requirementIds: ["REQ-CONTEXT"],
          purpose: "persistence",
          expectationBasis: ["fixture"],
          steps: [
            { op: "goto", path: "/" },
            { op: "newContext", actor: "second-user" },
            { op: "goto", path: "/" },
            {
              op: "expectVisible",
              locator: { by: "role", role: "button", name: "Save" },
            },
          ],
        },
      ],
    };

    const report = await new PlaywrightProbeRunner().run(plan, {
      baseUrl: server.baseUrl,
      stepTimeoutMs: 2_000,
      caseTimeoutMs: 10_000,
    });

    assert.equal(report.verdict, "pass");
  } finally {
    await server.stop();
  }
});

test("Playwright Probe Runner retains named contexts and switches back to the initial browser", async () => {
  const server = createServer((request, response) => {
    const identity = /(?:^|;\s*)identity=([^;]+)/.exec(request.headers.cookie ?? "")?.[1] ?? "none";
    response.setHeader("content-type", "text/html");
    response.end(`<button onclick="document.cookie='identity=first; path=/'; document.querySelector('[role=status]').textContent='first'">Set first</button>
      <output role="status">${identity}</output>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const plan: ProbePlan = { packetId: "named-contexts", cases: [{ id: "switch-back", requirementIds: ["A"],
      purpose: "permission", expectationBasis: ["fixture"], steps: [
        { op: "goto", path: "/" },
        { op: "click", locator: { by: "role", role: "button", name: "Set first" } },
        { op: "expectText", locator: { by: "role", role: "status" }, text: "first", exact: true },
        { op: "newContext", actor: "other" },
        { op: "goto", path: "/" },
        { op: "expectText", locator: { by: "role", role: "status" }, text: "none", exact: true },
        { op: "switchContext", actor: "default" },
        { op: "reload" },
        { op: "expectText", locator: { by: "role", role: "status" }, text: "first", exact: true },
      ] }] };
    const report = await new PlaywrightProbeRunner().run(plan, {
      baseUrl: `http://127.0.0.1:${address.port}`, stepTimeoutMs: 2_000, caseTimeoutMs: 10_000,
    });
    assert.equal(report.verdict, "pass");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("Playwright Probe Runner classifies a wrong assertion as fail", async () => {
  const server = await startFixtureServer();
  try {
    const plan = happyPlan();
    plan.cases = [
      {
        id: "wrong-value",
        requirementIds: ["REQ-PROFILE"],
        purpose: "happy_path",
        expectationBasis: ["fixture"],
        steps: [
          { op: "goto", path: "/" },
          {
            op: "expectValue",
            locator: { by: "label", text: "Profile name" },
            value: "Never saved",
          },
        ],
      },
    ];

    const report = await new PlaywrightProbeRunner().run(plan, {
      baseUrl: server.baseUrl,
      // This tests assertion classification, so navigation needs enough time
      // even when other Chromium test files run concurrently.
      stepTimeoutMs: 1_000,
      caseTimeoutMs: 5_000,
    });

    assert.equal(report.verdict, "fail");
    assert.equal(report.failures[0].category, "assertion");
    assert.equal(report.failures[0].stepIndex, 1);
  } finally {
    await server.stop();
  }
});

test("Playwright Probe Runner returns inconclusive with an aria snapshot for a missing locator", async () => {
  const server = await startFixtureServer();
  try {
    const plan = happyPlan();
    plan.cases = [
      {
        id: "missing-control",
        requirementIds: ["REQ-PROFILE"],
        purpose: "happy_path",
        expectationBasis: ["fixture"],
        steps: [
          { op: "goto", path: "/" },
          {
            op: "click",
            locator: { by: "role", role: "button", name: "Missing button" },
          },
        ],
      },
    ];

    const report = await new PlaywrightProbeRunner().run(plan, {
      baseUrl: server.baseUrl,
      // Navigation must not consume the whole case budget even when other
      // Chromium test files run concurrently; the click still classifies as a
      // locator miss within the same step timeout.
      stepTimeoutMs: 1_000,
      caseTimeoutMs: 5_000,
    });

    assert.equal(report.verdict, "inconclusive");
    assert.equal(report.failures[0].category, "locator");
    assert.match(report.failures[0].locatorSnapshot ?? "", /Profile name|Save/);
    assert.ok((report.failures[0].locatorSnapshot?.length ?? 0) <= 4_000);
  } finally {
    await server.stop();
  }
});

test("Playwright Probe Runner rejects navigation away from the configured origin", async () => {
  const server = await startFixtureServer();
  try {
    const plan: ProbePlan = {
      packetId: "packet-navigation",
      cases: [
        {
          id: "cross-origin",
          requirementIds: ["REQ-NAV"],
          purpose: "negative",
          expectationBasis: ["fixture"],
          steps: [{ op: "goto", path: "https://example.com" }],
        },
      ],
    };

    const report = await new PlaywrightProbeRunner().run(plan, {
      baseUrl: server.baseUrl,
      stepTimeoutMs: 100,
      caseTimeoutMs: 1_000,
    });

    assert.equal(report.verdict, "fail");
    assert.equal(report.failures[0].category, "navigation");
  } finally {
    await server.stop();
  }
});

function happyPlan(): ProbePlan {
  return {
    packetId: "packet-profile",
    cases: [
      {
        id: "save-profile",
        requirementIds: ["REQ-PROFILE"],
        purpose: "happy_path",
        expectationBasis: ["fixture"],
        steps: [
          { op: "goto", path: "/" },
          {
            op: "fill",
            locator: { by: "label", text: "Profile name" },
            value: "Ada",
          },
          {
            op: "click",
            locator: { by: "role", role: "button", name: "Save" },
          },
          {
            op: "expectText",
            locator: { by: "role", role: "status" },
            text: "Saved",
            exact: true,
          },
        ],
      },
      {
        id: "refresh-profile",
        requirementIds: ["REQ-PROFILE"],
        purpose: "persistence",
        expectationBasis: ["fixture"],
        steps: [
          { op: "goto", path: "/" },
          { op: "reload" },
          {
            op: "expectValue",
            locator: { by: "label", text: "Profile name" },
            value: "Ada",
          },
        ],
      },
    ],
  };
}
