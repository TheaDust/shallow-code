import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import { test } from "node:test";
import { auditPacket, type AuditPolicy } from "../src/judge/audit.js";
import { loadRequirementCatalog } from "../src/catalog.js";
import { auditPackets } from "../src/scheduler.js";
import { RunStateStore } from "../src/run-state.js";
import { ExecutionFault } from "../src/execution-fault.js";
import { GatewayRequestError } from "../src/gateway-failure.js";
import { PlaywrightProbeRunner } from "../src/judge/playwright-probe-runner.js";
import { ProbePlannerError, type ProbePlannerFeedback } from "../src/judge/llm-probe-planner.js";
import { probePlanSha256, type ProbePlan } from "../src/judge/probe-schema.js";
import { rootSearchNavigationPlan } from "../src/judge/navigation-recovery.js";
import { FakeProbePlanner } from "./fakes/fake-probe-planner.js";
import { withModulePipeline, type PipelineFixture, fail, pass, testPlan } from "./helpers/module-pipeline.js";

async function audit(f: PipelineFixture, remaining: () => number = () => 60_000, policy?: AuditPolicy) {
  const packet = auditPackets(await loadRequirementCatalog(f.options.requirementsFile))[0];
  const state = new RunStateStore({ statusByRequirementId: { A: "todo" }, acceptedSha: "checkpoint",
    startedAtMs: 0, totalBudgetMs: 60_000 }, f.options.ledgerFile, f.deps.logSink);
  return auditPacket(packet, undefined, f.options, f.deps, state, remaining, policy);
}
function homePlan(role = "tab", basis = "Display the main workspace."): ProbePlan {
  return { packetId: "packet-a", cases: [{ id: "case-A", requirementIds: ["A"], purpose: "happy_path",
    expectationBasis: [basis],
    steps: [{ op: "goto", path: "/" }, { op: "expectVisible", locator: { by: "role", role, name: role === "button" ? "home" : "Home",
      ...(role === "button" ? { exact: true } : {}) } }] }] };
}

for (const mode of ["required", "transient", "guessed", "no-navigation"] as const) {
  test(`Missing controls remain inconclusive and only repeated grounded actions allow diagnosis: ${mode}`, async () => {
    await withModulePipeline(async f => {
      const catalog = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
      catalog.children[0].children[0].description = 'Open "Items" and click "Publish".';
      await writeFile(f.options.requirementsFile, JSON.stringify(catalog));
      const plan: ProbePlan = { packetId: "packet-a", cases: [{ id: "publish", requirementIds: ["A"], purpose: "happy_path",
        expectationBasis: ['Open "Items" and click "Publish".'], steps: [
        { op: "goto", path: "/" },
        ...(mode === "no-navigation" ? [] : [{ op: "click" as const, locator: { by: "role" as const, role: "button", name: "Items" } }]),
        { op: "click", locator: { by: "role", role: "button", name: mode === "guessed" ? "Unknown" : "Publish" } },
        { op: "expectVisible", locator: { by: "role", role: "status" } },
      ] }] };
      const planner = new FakeProbePlanner([plan]);
      f.deps.planner = planner;
      planner.refineLocators = async original => original;
      let runs = 0;
      f.deps.runner.run = async current => {
        if (++runs === 2 && mode === "transient") return pass(current);
        const report = fail(current, "locator");
        report.failures[0].stepIndex = mode === "no-navigation" ? 1 : 2;
        return report;
      };
      const result = await audit(f);
      assert.equal(result.status, mode === "transient" ? "verified" : "inconclusive");
      assert.equal(result.repairableProbeFailure === true, mode === "required");
      assert.equal(runs, mode === "required" || mode === "transient" ? 2 : 1);
      assert.equal(f.builder.requests.length, 0);
      assert.equal(planner.reviews.length, 1);
    });
  });
}

for (const first of ["unchanged", "ambiguous"] as const) {
  test(`Locator ambiguity ${first === "unchanged" ? "stops" : "recovers"} after ${first} refinement in Chromium, keeping evidence private`, async () => {
    await withModulePipeline(async f => {
      const server = createServer((_request, response) => { response.setHeader("content-type", "text/html");
        response.end('<nav><button><span class="private-sidebar">home</span></button></nav><main><ul><li>home</li></ul></main>'); });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") assert.fail("missing port");
      const original = homePlan();
      const ambiguous = homePlan("link");
      for (const plan of [original, ambiguous]) {
        const step = plan.cases[0].steps[1];
        if ("locator" in step) step.locator.fallbacks = [{ by: "text", text: "Home" }];
      }
      const planner = new FakeProbePlanner([original, first === "unchanged" ? original : ambiguous, homePlan("button")]);
      f.deps.planner = planner;
      f.deps.runner = new PlaywrightProbeRunner();
      f.deps.appLifecycle.start = async () => ({ baseUrl: `http://127.0.0.1:${address.port}`, stop: async () => {} });
      const logs: string[] = [];
      f.deps.logSink = { write: line => { logs.push(line); } };
      try {
        assert.equal((await audit(f)).status, first === "unchanged" ? "inconclusive" : "verified");
        assert.equal(planner.refinements.length, first === "unchanged" ? 1 : 2);
        const evidenceDir = join(dirname(f.options.ledgerFile), "evidence");
        const evidence = JSON.parse(await readFile(join(evidenceDir, (await readdir(evidenceDir))[0]), "utf8"));
        assert.equal(evidence.planSha256, probePlanSha256(original));
        assert.equal(evidence.failures[0].locatorAttempts.length, 2);
        assert.doesNotMatch(logs.join(""), /private-sidebar|locatorSnapshot|locatorAttempts|"steps"/);
        assert.equal(f.builder.requests.length, 0);
        assert.deepEqual(f.git.restoredShas, []);
      } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    });
  });
}

test("Audit forwards requirement-declared anchor names to locator refinement", async () => {
  await withModulePipeline(async f => {
    const catalog = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    catalog.children[0].children[0].description = 'Show "Home" in the workspace.';
    await writeFile(f.options.requirementsFile, JSON.stringify(catalog));
    const planner = new FakeProbePlanner([homePlan("tab", 'Show "Home" in the workspace.'),
      homePlan("button", 'Show "Home" in the workspace.')]);
    f.deps.planner = planner;
    let runs = 0;
    f.deps.runner.run = async plan => { runs += 1; return runs === 1 ? fail(plan, "locator") : pass(plan); };
    assert.equal((await audit(f)).status, "verified");
    assert.deepEqual(planner.refinements[0].anchoredNames, ["Home"]);
  });
});

test("Unchanged, mutated behavior, and fatal refinements never rerun invalid plans", async () => {
  for (const invalid of ["unchanged", "behavior", "fatal"] as const) {
    await withModulePipeline(async f => {
      let runs = 0;
      let refinements = 0;
      f.deps.planner = new FakeProbePlanner([homePlan()]);
      f.deps.planner.refineLocators = async original => {
        refinements++;
        if (invalid === "fatal") throw new ProbePlannerError("transport", "HTTP 401", { httpStatus: 401 });
        if (invalid === "behavior") original.cases[0].steps.pop();
        return original;
      };
      f.deps.runner.run = async plan => { runs++; return fail(plan, "locator"); };
      assert.equal((await audit(f)).status, "inconclusive");
      assert.equal(runs, 1);
      assert.equal(refinements, 1);
      assert.deepEqual(f.git.restoredShas, []);
    });
  }
});

for (const expiration of ["before", "during", "after"] as const) {
  test(`Locator recovery respects phase deadline ${expiration} refinement`, async () => {
    await withModulePipeline(async f => {
      let left = 60_000;
      let runs = 0;
      let refinements = 0;
      f.deps.planner = new FakeProbePlanner([homePlan()]);
      f.deps.planner.refineLocators = async () => { refinements++; if (expiration === "during") left = 0; return homePlan("button"); };
      f.deps.runner.run = async plan => { runs++; if (expiration === "before" || (expiration === "after" && runs === 2)) left = 0; return fail(plan, "locator"); };
      assert.equal((await audit(f, () => left)).status, "inconclusive");
      assert.equal(refinements, expiration === "before" ? 0 : 1);
      assert.equal(runs, expiration === "after" ? 2 : 1);
    });
  });
}

test("Mixed locator/assertion failures refine locators before confirming business failures", async () => {
  await withModulePipeline(async f => {
    const original = homePlan();
    original.cases.push({ ...original.cases[0], id: "business" });
    const refined = structuredClone(original);
    const step = refined.cases[0].steps[1];
    if (step.op === "expectVisible") step.locator = { by: "role", role: "button", name: "Home" };
    const planner = new FakeProbePlanner([original, refined]);
    f.deps.planner = planner;
    let runs = 0;
    f.deps.runner.run = async plan => {
      runs++;
      const report = fail(plan);
      report.failures[0].caseId = "business";
      if (runs === 1) report.failures.push(fail(plan, "locator").failures[0]);
      return report;
    };
    assert.equal((await audit(f)).status, "failed");
    assert.equal(runs, 3);
    assert.equal(planner.refinements[0].failures.length, 1);
    assert.equal(planner.refinements[0].failures[0].category, "locator");
  });
});

test("Detection-only audits skip locator refinement but still run the probes", async () => {
  await withModulePipeline(async f => {
    let runs = 0;
    let refinements = 0;
    const planner = new FakeProbePlanner([homePlan()]);
    f.deps.planner = planner;
    planner.refineLocators = async original => { refinements++; return homePlan("button"); };
    f.deps.runner.run = async plan => { runs++; return fail(plan, "locator"); };
    assert.equal((await audit(f, () => 60_000, { refineLocators: false })).status, "inconclusive");
    assert.equal(runs, 1);
    assert.equal(refinements, 0);
    assert.equal(planner.reviews.length, 0);
    assert.deepEqual(f.git.restoredShas, []);
  });
});

test("A missing seeded link can be reached through visible search and must pass again on a fresh app", async () => {
  await withModulePipeline(async f => {
    const catalog = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    catalog.children[0].children[0].description = "Seed data: repository `acme-docs`. A search result opens the repository. Opening the repository shows Issues.";
    await writeFile(f.options.requirementsFile, JSON.stringify(catalog));
    const plan: ProbePlan = { packetId: "packet-a", cases: [{ id: "issues", requirementIds: ["A"], purpose: "happy_path",
      expectationBasis: ["Opening the repository shows Issues."], steps: [
        { op: "goto", path: "/" },
        { op: "click", locator: { by: "role", role: "link", name: "acme-docs", exact: true } },
        { op: "expectVisible", locator: { by: "role", role: "link", name: "Issues", exact: true } },
      ] }] };
    f.deps.planner = new FakeProbePlanner([plan]);
    let launches = 0;
    const originalStart = f.deps.appLifecycle.start.bind(f.deps.appLifecycle);
    f.deps.appLifecycle.start = async (...args) => { launches++; return originalStart(...args); };
    let runs = 0;
    f.deps.runner.run = async current => {
      runs++;
      if (runs === 1) {
        const report = fail(current, "locator");
        report.failures[0].locatorSnapshot = '- searchbox "Search"\n- link "Sign in"';
        return report;
      }
      assert.deepEqual(current.cases[0].steps.slice(1, 3), [
        { op: "fill", locator: { by: "role", role: "searchbox", name: "Search", exact: true }, value: "acme-docs" },
        { op: "press", locator: { by: "role", role: "searchbox", name: "Search", exact: true }, key: "Enter" },
      ]);
      assert.deepEqual(current.cases[0].steps.slice(3), plan.cases[0].steps.slice(1));
      return pass(current);
    };
    const result = await audit(f);
    assert.equal(result.status, "verified");
    assert.equal(runs, 3);
    assert.equal(launches, 2);
    assert.equal((await f.events()).filter(event => event.type === "probe_navigation_attempted").length, 1);
  });
});

test("The same plan, failed step, and page snapshot do not repeat a no-progress refinement", async () => {
  await withModulePipeline(async f => {
    let refinements = 0;
    let probes = 0;
    let snapshot = '- main "Workspace"';
    f.deps.planner.plan = async () => homePlan();
    f.deps.planner.refineLocators = async original => { refinements++; return original; };
    f.deps.runner.run = async plan => {
      probes++;
      const report = fail(plan, "locator");
      report.failures[0].locatorSnapshot = snapshot;
      return report;
    };
    const policy: AuditPolicy = { refineLocators: true, noProgressRefinements: new Set<string>() };
    assert.equal((await audit(f, () => 60_000, policy)).status, "inconclusive");
    assert.equal((await audit(f, () => 60_000, policy)).status, "inconclusive");
    assert.equal(probes, 2);
    assert.equal(refinements, 1);
    assert.equal(policy.noProgressRefinements?.size, 2);
    snapshot = '- main "Updated Workspace"';
    assert.equal((await audit(f, () => 60_000, policy)).status, "inconclusive");
    assert.equal(refinements, 2);
  });
});

test("A partial locator refinement preserves the newly passing case", async () => {
  await withModulePipeline(async f => {
    const original = homePlan();
    original.cases = [
      { ...structuredClone(original.cases[0]), id: "primary" },
      { ...structuredClone(original.cases[0]), id: "secondary" },
    ];
    const refined = structuredClone(original);
    refined.cases[0].steps[1] = { op: "expectVisible",
      locator: { by: "role", role: "button", name: "Home", exact: true } };
    const planner = new FakeProbePlanner([original, refined, refined]);
    f.deps.planner = planner;
    let runs = 0;
    const failure = (caseId: string) => ({ caseId, stepIndex: 1, category: "locator" as const,
      message: "missing locator", locatorSnapshot: '- button "Home"' });
    f.deps.runner.run = async plan => {
      runs++;
      return { packetId: plan.packetId, verdict: "inconclusive" as const,
        passedCases: runs === 1 ? [] : ["primary"],
        failures: runs === 1 ? [failure("primary"), failure("secondary")] : [failure("secondary")] };
    };
    const result = await audit(f);
    assert.equal(result.status, "inconclusive");
    assert.deepEqual(result.report?.passedCases, ["primary"]);
    assert.deepEqual(result.plan?.cases[0].steps[1], refined.cases[0].steps[1]);
    assert.deepEqual(result.plan?.cases[1].steps[1], original.cases[1].steps[1]);
    assert.equal(runs, 2);
    assert.equal(planner.refinements.length, 2);
  });
});

test("Partial search navigation keeps the improved plan and evidence for the next audit", async () => {
  await withModulePipeline(async f => {
    const catalog = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    catalog.children[0].children[0].description = "Seed data: repository `acme-docs`. A search result opens the repository. Opening it shows Issues.";
    await writeFile(f.options.requirementsFile, JSON.stringify(catalog));
    const plan: ProbePlan = { packetId: "packet-a", cases: ["list", "detail"].map(id => ({
      id, requirementIds: ["A"], purpose: "happy_path" as const,
      expectationBasis: ["Opening it shows Issues."], steps: [
        { op: "goto" as const, path: "/" },
        { op: "click" as const, locator: { by: "role" as const, role: "link", name: "acme-docs", exact: true } },
        { op: "expectVisible" as const, locator: { by: "role" as const, role: "link", name: "Issues" } },
      ],
    })) };
    f.deps.planner = new FakeProbePlanner([plan]);
    f.deps.runner.run = async current => current.cases[0].steps.length === 3 ? {
      packetId: current.packetId, verdict: "inconclusive", passedCases: [],
      failures: current.cases.map(item => ({ caseId: item.id, stepIndex: 1,
        category: "locator" as const, message: "missing home link", locatorSnapshot: '- searchbox "Search"' })),
    } : {
      packetId: current.packetId, verdict: "inconclusive", passedCases: ["list"],
      failures: [{ caseId: "detail", stepIndex: 4, category: "locator", message: "missing detail control",
        locatorSnapshot: '- link "Issues"' }],
    };
    const result = await audit(f, () => 60_000, { refineLocators: false });
    assert.equal(result.status, "inconclusive");
    assert.deepEqual(result.report?.passedCases, ["list"]);
    assert.equal(result.plan?.cases[0].steps.length, 5);
    const attempted = (await f.events()).find(event => event.type === "probe_navigation_attempted");
    assert.equal(attempted?.detail?.improved, true);
    assert.equal(attempted?.detail?.recovered, false);
  });
});

test("Chromium recovers a seeded repository entry through the visible searchbox", async () => {
  await withModulePipeline(async f => {
    const catalog = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    catalog.children[0].children[0].description = "Seed data: repository `acme-docs`. A search result opens the repository. Opening the repository shows Issues.";
    await writeFile(f.options.requirementsFile, JSON.stringify(catalog));
    const plan: ProbePlan = { packetId: "packet-a", cases: [{ id: "issues", requirementIds: ["A"], purpose: "happy_path",
      expectationBasis: ["Opening the repository shows Issues."], steps: [
        { op: "goto", path: "/" },
        { op: "click", locator: { by: "role", role: "link", name: "acme-docs", exact: true } },
        { op: "expectVisible", locator: { by: "role", role: "link", name: "Issues", exact: true } },
      ] }] };
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      response.setHeader("content-type", "text/html");
      response.end(url.pathname === "/repo" ? '<a href="/issues">Issues</a>'
        : `<form action="/"><input type="search" aria-label="Search" name="q"></form>${url.searchParams.get("q") === "acme-docs" ? '<a href="/repo">acme-docs</a>' : ""}`);
    });
    await new Promise<void>(resolvePromise => server.listen(0, "127.0.0.1", resolvePromise));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      f.deps.planner = new FakeProbePlanner([plan]);
      f.deps.runner = new PlaywrightProbeRunner();
      f.deps.appLifecycle.start = async () => ({ baseUrl: `http://127.0.0.1:${address.port}`, stop: async () => {} });
      const result = await audit(f);
      assert.equal(result.status, "verified");
      assert.equal(result.plan?.cases[0].steps.length, plan.cases[0].steps.length + 2);
    } finally {
      await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
    }
  });
});

test("Search navigation is unavailable without a seeded target or a unique visible searchbox", async () => {
  await withModulePipeline(async f => {
    const packet = auditPackets(await loadRequirementCatalog(f.options.requirementsFile))[0];
    const plan: ProbePlan = { packetId: packet.id, cases: [{ id: "entry", requirementIds: ["A"], purpose: "happy_path",
      expectationBasis: ["Display the main workspace."], steps: [
        { op: "goto", path: "/" }, { op: "click", locator: { by: "role", role: "link", name: "acme-docs" } },
        { op: "expectVisible", locator: { by: "role", role: "main" } },
      ] }] };
    const report = fail(plan, "locator");
    report.failures[0].locatorSnapshot = '- searchbox "Search"';
    assert.equal(rootSearchNavigationPlan(packet, plan, report), undefined);
    packet.requirements[0].seedDeclarations = ["Seed data: repository `acme-docs`."];
    packet.requirements[0].text = "A search result opens the repository.";
    report.failures[0].locatorSnapshot = '- searchbox "Search"\n- searchbox "Search code"';
    assert.equal(rootSearchNavigationPlan(packet, plan, report), undefined);
  });
});

test("Seed navigation after sign-in scopes same-name results to the declared owner", async () => {
  await withModulePipeline(async f => {
    const packet = auditPackets(await loadRequirementCatalog(f.options.requirementsFile))[0];
    packet.requirements[0].text = "The search opens a public repository. Opening it shows Issues.";
    packet.requirements[0].seedDeclarations = ["Seed data: repository `docs`, owner `alice`."];
    packet.requirements[0].scenarios = ["Seed data: repository `docs`, owner `alice`."];
    const original: ProbePlan = { packetId: packet.id, cases: [{ id: "entry", requirementIds: ["A"], purpose: "happy_path",
      expectationBasis: ["Opening it shows Issues."], steps: [
        { op: "goto", path: "/" }, { op: "click", locator: { by: "role", role: "button", name: "Sign in" } },
        { op: "click", locator: { by: "role", role: "link", name: "docs", exact: true } },
        { op: "expectVisible", locator: { by: "role", role: "link", name: "Issues", exact: true } },
      ] }] };
    const absent = { packetId: packet.id, verdict: "inconclusive" as const, passedCases: [], failures: [{
      caseId: "entry", stepIndex: 2, category: "locator" as const, message: "missing", locatorSnapshot: '- searchbox "Search"',
    }] };
    const searched = rootSearchNavigationPlan(packet, original, absent)!;
    assert.equal(searched.cases[0].steps[2].op, "fill");
    assert.deepEqual(searched.cases[0].steps.at(-1), original.cases[0].steps.at(-1));
    const ambiguous = { ...absent, failures: [{ ...absent.failures[0], stepIndex: 4,
      locatorSnapshot: '- list:\n  - listitem:\n    - link "docs":\n      - /url: "/alice/docs"\n    - paragraph: alice/docs\n  - listitem:\n    - link "docs":\n      - /url: "/org/docs"\n    - paragraph: org/docs',
    }] };
    const scoped = rootSearchNavigationPlan(packet, searched, ambiguous)!;
    const click = scoped.cases[0].steps[4];
    assert.ok(click.op === "click");
    assert.deepEqual(click.locator.scope, { by: "role", role: "listitem", hasText: "alice/docs" });
    packet.requirements[0].scenarios = [];
    packet.requirements[0].seedDeclarations = ["Seed data: repository `docs`."];
    packet.requirements[0].seedDeclarations.push("Seed data: repository `other`, owner `alice`.");
    assert.equal(rootSearchNavigationPlan(packet, searched, ambiguous), undefined);
  });
});

test("Seed identity scopes both a visibility assertion and its click inside nested result containers", async () => {
  await withModulePipeline(async f => {
    const packet = auditPackets(await loadRequirementCatalog(f.options.requirementsFile))[0];
    packet.requirements[0].text = "Opening the repository shows Issues.";
    packet.requirements[0].seedDeclarations = ["Seed data: repository `docs`, owner `alice`."];
    const original: ProbePlan = { packetId: packet.id, cases: [{ id: "entry", requirementIds: ["A"], purpose: "happy_path",
      expectationBasis: ["Opening the repository shows Issues."], steps: [
        { op: "goto", path: "/" },
        { op: "expectVisible", locator: { by: "role", role: "link", name: "docs", exact: true } },
        { op: "click", locator: { by: "role", role: "link", name: "docs", exact: true,
          fallbacks: [{ by: "role", role: "link", name: "docs", exact: true }] } },
        { op: "expectVisible", locator: { by: "role", role: "link", name: "Issues", exact: true } },
      ] }] };
    const result = (identity: string) => `  - listitem:\n    - article:\n      - link "docs"\n      - paragraph: ${identity}`;
    const report = { packetId: packet.id, verdict: "inconclusive" as const, passedCases: [], failures: [{
      caseId: "entry", stepIndex: 1, category: "locator" as const, message: "strict mode violation",
      locatorSnapshot: `- list:\n${result("alice/docs")}\n${result("org/docs")}`,
    }] };
    const recovered = rootSearchNavigationPlan(packet, original, report)!;
    assert.ok(recovered);
    const scope = { by: "role", role: "article", hasText: "alice/docs" };
    for (const step of recovered.cases[0].steps.slice(1, 3)) {
      assert.ok(step.op === "expectVisible" || step.op === "click");
      assert.deepEqual(step.locator.scope, scope);
      assert.equal(step.locator.by === "role" && step.locator.name, "docs");
      assert.equal(step.locator.exact, true);
    }
    const click = recovered.cases[0].steps[2];
    assert.ok(click.op === "click");
    assert.deepEqual(click.locator.fallbacks?.[0].scope, scope);
    assert.deepEqual(recovered.cases[0].steps.at(-1), original.cases[0].steps.at(-1));
    report.failures[0].locatorSnapshot = `- list:\n${result("alice/docs")}\n${result("alice/docs")}`;
    assert.equal(rootSearchNavigationPlan(packet, original, report), undefined, "distinct same-identity results remain ambiguous");
  });
});

test("Search navigation accepts any seed-declared object kind and quote style", async () => {
  await withModulePipeline(async f => {
    const catalog = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    catalog.children[0].children[0].description =
      'Seed data: workbook "Q3 Sales". A search result opens the workbook. Opening the workbook shows Sheet1.';
    await writeFile(f.options.requirementsFile, JSON.stringify(catalog));
    const packet = auditPackets(await loadRequirementCatalog(f.options.requirementsFile))[0];
    const plan: ProbePlan = { packetId: packet.id, cases: [{ id: "entry", requirementIds: ["A"], purpose: "happy_path",
      expectationBasis: ["Opening the workbook shows Sheet1."], steps: [
        { op: "goto", path: "/" },
        { op: "click", locator: { by: "role", role: "link", name: "Q3 Sales", exact: true } },
        { op: "expectVisible", locator: { by: "role", role: "link", name: "Sheet1", exact: true } },
      ] }] };
    const report = { packetId: packet.id, verdict: "inconclusive" as const, passedCases: [], failures: [{
      caseId: "entry", stepIndex: 1, category: "locator" as const, message: "missing home link",
      locatorSnapshot: '- searchbox "Search"',
    }] };
    const recovered = rootSearchNavigationPlan(packet, plan, report)!;
    assert.deepEqual(recovered.cases[0].steps.slice(1, 3), [
      { op: "fill", locator: { by: "role", role: "searchbox", name: "Search", exact: true }, value: "Q3 Sales" },
      { op: "press", locator: { by: "role", role: "searchbox", name: "Search", exact: true }, key: "Enter" },
    ]);
    assert.deepEqual(recovered.cases[0].steps[3], plan.cases[0].steps[1]);
  });
});

test("Seed identity scopes same-name results using double-quoted declaration names", async () => {
  await withModulePipeline(async f => {
    const packet = auditPackets(await loadRequirementCatalog(f.options.requirementsFile))[0];
    packet.requirements[0].text = "Opening the note shows its body.";
    packet.requirements[0].seedDeclarations = ['Seed data: note "docs", owner "alice".'];
    const original: ProbePlan = { packetId: packet.id, cases: [{ id: "entry", requirementIds: ["A"], purpose: "happy_path",
      expectationBasis: ["Opening the note shows its body."], steps: [
        { op: "goto", path: "/" },
        { op: "expectVisible", locator: { by: "role", role: "link", name: "docs", exact: true } },
        { op: "click", locator: { by: "role", role: "link", name: "docs", exact: true } },
        { op: "expectVisible", locator: { by: "role", role: "main" } },
      ] }] };
    const report = { packetId: packet.id, verdict: "inconclusive" as const, passedCases: [], failures: [{
      caseId: "entry", stepIndex: 1, category: "locator" as const, message: "strict mode violation",
      locatorSnapshot: '- list:\n  - listitem:\n    - link "docs"\n    - paragraph: alice/docs\n' +
        '  - listitem:\n    - link "docs"\n    - paragraph: org/docs',
    }] };
    const recovered = rootSearchNavigationPlan(packet, original, report)!;
    const scope = { by: "role", role: "listitem", hasText: "alice/docs" };
    for (const step of recovered.cases[0].steps.slice(1, 3)) {
      assert.ok(step.op === "expectVisible" || step.op === "click");
      assert.deepEqual(step.locator, { by: "role", role: "link", name: "docs", exact: true, scope });
    }
  });
});

test("A snapshot identity repeating only the target name adds no disambiguation scope", async () => {
  await withModulePipeline(async f => {
    const packet = auditPackets(await loadRequirementCatalog(f.options.requirementsFile))[0];
    packet.requirements[0].seedDeclarations = ["Seed data: repository `docs`, owner `alice`."];
    const plan: ProbePlan = { packetId: packet.id, cases: [{ id: "entry", requirementIds: ["A"], purpose: "happy_path",
      expectationBasis: ["Opening it shows Issues."], steps: [
        { op: "goto", path: "/" },
        { op: "click", locator: { by: "role", role: "link", name: "docs", exact: true } },
        { op: "expectVisible", locator: { by: "role", role: "main" } },
      ] }] };
    const report = { packetId: packet.id, verdict: "inconclusive" as const, passedCases: [], failures: [{
      caseId: "entry", stepIndex: 1, category: "locator" as const, message: "strict mode violation",
      locatorSnapshot: '- listitem:\n  - link "docs"\n  - paragraph: docs',
    }] };
    assert.equal(rootSearchNavigationPlan(packet, plan, report), undefined);
  });
});

test("A declared seed target without a requirement-authorized search entry stays dark", async () => {
  await withModulePipeline(async f => {
    const catalog = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    catalog.children[0].children[0].description =
      'Seed data: workbook "Q3 Sales". The user clicks the visible Q3 Sales workbook entry. Opening it shows Sheet1.';
    await writeFile(f.options.requirementsFile, JSON.stringify(catalog));
    const packet = auditPackets(await loadRequirementCatalog(f.options.requirementsFile))[0];
    const plan: ProbePlan = { packetId: packet.id, cases: [{ id: "entry", requirementIds: ["A"], purpose: "happy_path",
      expectationBasis: ["Opening it shows Sheet1."], steps: [
        { op: "goto", path: "/" },
        { op: "click", locator: { by: "role", role: "link", name: "Q3 Sales", exact: true } },
        { op: "expectVisible", locator: { by: "role", role: "link", name: "Sheet1", exact: true } },
      ] }] };
    const report = { packetId: packet.id, verdict: "inconclusive" as const, passedCases: [], failures: [{
      caseId: "entry", stepIndex: 1, category: "locator" as const, message: "missing home link",
      locatorSnapshot: '- searchbox "Search"',
    }] };
    assert.equal(rootSearchNavigationPlan(packet, plan, report), undefined);
  });
});

for (const scenario of [
  { name: "a branch value cannot act as the owner", declarations: ['Seed data: note "docs", owner "alice", branch "main".'], identity: "main/docs" },
  { name: "a substring in another object's identity is not the target", declarations: ['Seed data: note "docs", owner "alice".', 'Seed data: note "mydocs", owner "bob".'], identity: "bob/mydocs" },
  { name: "an owner of another object in the same declaration is not the target owner", declarations: ['Seed data: note "docs", owner "alice"; note "other", owner "bob".'], identity: "bob/docs" },
  { name: "conflicting owners do not select the only visible identity", declarations: ['Seed data: note "docs", owner "alice".', 'Seed data: note "docs", owner "bob".'], identity: "bob/docs" },
]) {
  test(`Seed identity rejects ${scenario.name}`, async () => {
    await withModulePipeline(async f => {
      const packet = auditPackets(await loadRequirementCatalog(f.options.requirementsFile))[0];
      packet.requirements[0].text = "Opening the note shows its body.";
      packet.requirements[0].seedDeclarations = scenario.declarations;
      const plan: ProbePlan = { packetId: packet.id, cases: [{ id: "entry", requirementIds: ["A"], purpose: "happy_path",
        expectationBasis: ["Opening the note shows its body."], steps: [
          { op: "goto", path: "/" },
          { op: "click", locator: { by: "role", role: "link", name: "docs", exact: true } },
          { op: "expectVisible", locator: { by: "role", role: "main" } },
        ] }] };
      const report = { packetId: packet.id, verdict: "inconclusive" as const, passedCases: [], failures: [{
        caseId: "entry", stepIndex: 1, category: "locator" as const, message: "strict mode violation",
        locatorSnapshot: `- listitem:\n  - link "docs"\n  - paragraph: ${scenario.identity}`,
      }] };
      assert.equal(rootSearchNavigationPlan(packet, plan, report), undefined);
    });
  });
}

test("A gateway-interrupted review remains retryable and is classified separately from an invalid review", async () => {
  await withModulePipeline(async f => {
    let calls = 0;
    f.deps.runner.run = async plan => fail(plan);
    f.deps.planner.reviewPlan = async () => {
      if (++calls === 1) throw new GatewayRequestError({ kind: "unavailable", retryable: true, status: 503 });
      return { status: "sound", rationale: "The original outcome is requirement-backed" };
    };
    const policy = { refineLocators: true, noProgressRefinements: new Set<string>() };
    const interrupted = await audit(f, () => 60_000, policy);
    assert.equal(interrupted.status, "inconclusive");
    assert.equal(interrupted.failureKind, "gateway");
    assert.equal((await audit(f, () => 60_000, policy)).status, "failed");
    assert.equal(calls, 2);
  });
});

test("A planning feedback retry interrupted by the gateway retains the gateway classification", async () => {
  await withModulePipeline(async f => {
    let calls = 0;
    f.deps.planner.plan = async () => {
      if (++calls === 1) throw new ProbePlannerError("schema", "invalid plan", { cause: new Error("missing assertion") });
      throw new GatewayRequestError({ kind: "unavailable", retryable: true, status: 503 });
    };
    const result = await audit(f);
    assert.equal(result.status, "inconclusive");
    assert.equal(result.failureKind, "gateway");
    assert.equal(calls, 2);
  });
});

for (const description of [
  'Seed data: workbook "Q3 Sales", branch "feature-search". The home page must show the workbook link.',
  'Seed data: workbook "Q3 Sales", query "search result opens the workbook".',
  'Seed data: workbook "Q3 Sales", query "missing. A search result opens the workbook".',
  'Seed data: workbook "Q3 Sales". The user opens the workbook by direct address.',
  'Seed data: workbook "Q3 Sales". A search result opens a note.',
  'Seed data: workbook "Q3 Sales". A search result opens workbook "Other".',
  'Seed data: workbook "Q3 Sales". The home page must show a link "Q3 Sales". A search result opens the workbook.',
]) {
  test(`Search navigation requires the target's search entry: ${description}`, async () => {
    await withModulePipeline(async f => {
      const packet = auditPackets(await loadRequirementCatalog(f.options.requirementsFile))[0];
      packet.requirements[0].text = `${description} Opening it shows Sheet1.`;
      packet.requirements[0].seedDeclarations = ['Seed data: workbook "Q3 Sales", branch "feature-search".'];
      const plan: ProbePlan = { packetId: packet.id, cases: [{ id: "entry", requirementIds: ["A"], purpose: "happy_path",
        expectationBasis: ["Opening it shows Sheet1."], steps: [
          { op: "goto", path: "/" },
          { op: "click", locator: { by: "role", role: "link", name: "Q3 Sales", exact: true } },
          { op: "expectVisible", locator: { by: "role", role: "link", name: "Sheet1", exact: true } },
        ] }] };
      const report = { packetId: packet.id, verdict: "inconclusive" as const, passedCases: [], failures: [{
        caseId: "entry", stepIndex: 1, category: "locator" as const, message: "missing home link",
        locatorSnapshot: '- searchbox "Search"',
      }] };
      assert.equal(rootSearchNavigationPlan(packet, plan, report), undefined);
    });
  });
}

test("Another case's search entry cannot authorize navigation for this case", async () => {
  await withModulePipeline(async f => {
    const packets = auditPackets(await loadRequirementCatalog(f.options.requirementsFile));
    const packet = packets[0];
    packet.requirements[0].text = "Opening the workbook shows Sheet1.";
    packet.requirements[0].seedDeclarations = ['Seed data: workbook "Q3 Sales".'];
    const other = packets[1].requirements[0];
    other.text = "A search result opens the workbook.";
    other.seedDeclarations = ['Seed data: workbook "Other".'];
    packet.requirements.push(other);
    packet.requirementIds.push(other.id);
    const plan: ProbePlan = { packetId: packet.id, cases: [
      { id: "entry", requirementIds: ["A"], purpose: "happy_path", expectationBasis: ["Opening the workbook shows Sheet1."], steps: [
        { op: "goto", path: "/" }, { op: "click", locator: { by: "role", role: "link", name: "Q3 Sales", exact: true } },
        { op: "expectVisible", locator: { by: "role", role: "link", name: "Sheet1", exact: true } },
      ] },
      { id: "other", requirementIds: [other.id], purpose: "happy_path", expectationBasis: [other.text], steps: [
        { op: "goto", path: "/" }, { op: "expectVisible", locator: { by: "role", role: "main" } },
      ] },
    ] };
    const report = { packetId: packet.id, verdict: "inconclusive" as const, passedCases: ["other"], failures: [{
      caseId: "entry", stepIndex: 1, category: "locator" as const, message: "missing home link", locatorSnapshot: '- searchbox "Search"',
    }] };
    assert.equal(rootSearchNavigationPlan(packet, plan, report), undefined);
  });
});

for (const sentence of ['The user opens workbook "Q3 Sales" from search results.',
  'A visitor has a search result, a workbook-list item, or a direct address for the workbook.']) {
  test(`Search navigation accepts an explicit target entry: ${sentence}`, async () => {
    await withModulePipeline(async f => {
      const packet = auditPackets(await loadRequirementCatalog(f.options.requirementsFile))[0];
      packet.requirements[0].text = `${sentence} Opening it shows Sheet1.`;
      packet.requirements[0].seedDeclarations = ['Seed data: workbook "Q3 Sales".'];
      const plan: ProbePlan = { packetId: packet.id, cases: [{ id: "entry", requirementIds: ["A"], purpose: "happy_path",
        expectationBasis: ["Opening it shows Sheet1."], steps: [
          { op: "goto", path: "/" }, { op: "click", locator: { by: "role", role: "link", name: "Q3 Sales", exact: true } },
          { op: "expectVisible", locator: { by: "role", role: "link", name: "Sheet1", exact: true } },
        ] }] };
      const report = { packetId: packet.id, verdict: "inconclusive" as const, passedCases: [], failures: [{
        caseId: "entry", stepIndex: 1, category: "locator" as const, message: "missing home link", locatorSnapshot: '- searchbox "Search"',
      }] };
      const recovered = rootSearchNavigationPlan(packet, plan, report)!;
      assert.ok(recovered);
      assert.deepEqual(recovered.cases[0].steps.slice(1, 3).map(step => step.op), ["fill", "press"]);
      assert.deepEqual(recovered.cases[0].steps.slice(3), plan.cases[0].steps.slice(1));
    });
  });
}

test("Detection-only auditing resolves declared seed identity in Chromium and confirms it on a fresh application", async () => {
  await withModulePipeline(async f => {
    const catalog = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    catalog.children[0].children[0].description = "Seed data: repository `docs`, owner `alice`. Opening the repository shows Issues.";
    await writeFile(f.options.requirementsFile, JSON.stringify(catalog));
    const packet = auditPackets(await loadRequirementCatalog(f.options.requirementsFile))[0];
    const plan: ProbePlan = { packetId: packet.id, cases: [{ id: "entry", requirementIds: ["A"], purpose: "happy_path",
      expectationBasis: ["Opening the repository shows Issues."], steps: [
        { op: "goto", path: "/" },
        { op: "expectVisible", locator: { by: "role", role: "link", name: "docs", exact: true } },
        { op: "click", locator: { by: "role", role: "link", name: "docs", exact: true } },
        { op: "expectVisible", locator: { by: "role", role: "link", name: "Issues", exact: true } },
      ] }] };
    const server = createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(req.url === "/alice/docs" ? '<main><a href="/issues">Issues</a></main>' :
        '<main><ul><li><article><a href="/alice/docs">docs</a><p>alice/docs</p></article></li>' +
        '<li><article><a href="/org/docs">docs</a><p>org/docs</p></article></li></ul></main>');
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const runner = new PlaywrightProbeRunner();
    let starts = 0;
    f.deps.appLifecycle.start = async () => { starts++; return {
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, stop: async () => {},
    }; };
    f.deps.runner = runner;
    try {
      const state = new RunStateStore({ statusByRequirementId: { A: "todo" }, acceptedSha: "checkpoint",
        startedAtMs: 0, totalBudgetMs: 30_000 }, f.options.ledgerFile);
      const result = await auditPacket(packet, plan, f.options, f.deps, state, () => 30_000, { refineLocators: false });
      assert.equal(result.status, "verified");
      assert.equal(starts, 3, "initial run, recovered run, and fresh confirmation");
      assert.equal((await f.events()).filter(event => event.type === "probe_navigation_attempted").length, 1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

test("A failed preparation checkpoint can be corrected before the target behavior is graded", async () => {
  await withModulePipeline(async f => {
    let runs = 0;
    f.deps.runner.run = async plan => ++runs === 1 ? { packetId: plan.packetId, verdict: "inconclusive", passedCases: [],
      failures: [{ caseId: plan.cases[0].id, stepIndex: 1, category: "precondition", message: "initial state mismatch" }] } : pass(plan);
    f.deps.planner.reviewPlan = async (_packet, original) => ({ status: "corrected", rationale: "The initial state needs preparation",
      corrections: [{ caseId: original.cases[0].id, conflict: "missing preparation", basis: ["Display the main workspace."] }],
      plan: { ...original, cases: original.cases.map(item => ({ ...item, steps: [item.steps[0],
        { op: "click", locator: { by: "role", role: "button", name: "Prepare" } }, ...item.steps.slice(1)] })) } });
    assert.equal((await audit(f)).status, "verified");
    assert.ok((await f.events()).some(event => event.type === "probe_review_started"));
    assert.equal(f.builder.requests.length, 0);
  });
});

test("A reviewed preparation gap stays inconclusive and becomes a diagnostic repair target after fresh confirmation", async () => {
  await withModulePipeline(async f => {
    const catalog = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    catalog.children[0].children[0].description += ' The "Home" tab is the required entry.';
    await writeFile(f.options.requirementsFile, JSON.stringify(catalog));
    f.deps.planner.plan = async () => {
      const plan = homePlan();
      plan.cases[0].setupStepCount = 2;
      plan.cases[0].steps.push({ op: "expectVisible", locator: { by: "role", role: "main" } });
      return plan;
    };
    let runs = 0;
    f.deps.runner.run = async plan => { runs++; return { packetId: plan.packetId, verdict: "inconclusive", passedCases: [],
      failures: [{ caseId: plan.cases[0].id, stepIndex: 1, category: "precondition", message: "required seed missing" }] }; };
    const result = await audit(f);
    assert.equal(result.status, "inconclusive");
    assert.equal(result.repairableProbeFailure, true);
    assert.equal(runs, 2);
  });
});

for (const explicitRole of [false, true]) {
  test(`A same-named control with another role requires role evidence before preparation repair: explicit=${explicitRole}`, async () => {
    await withModulePipeline(async f => {
      const tree = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
      const basis = explicitRole ? 'Open the link named "Account menu".' : 'Open "Account menu".';
      tree.children[0].children[0].description = basis;
      await writeFile(f.options.requirementsFile, JSON.stringify(tree));
      const original = homePlan("link", basis);
      original.cases[0].steps[1] = { op: "click", locator: { by: "role", role: "link", name: "Account menu", exact: true } };
      original.cases[0].steps.push({ op: "expectVisible", locator: { by: "role", role: "main" } });
      original.cases[0].setupStepCount = 3;
      original.cases[0].steps.push({ op: "expectVisible", locator: { by: "role", role: "main" } });
      const planner = new FakeProbePlanner([original]);
      f.deps.planner = planner;
      planner.refineLocators = async plan => plan;
      f.deps.runner.run = async current => ({ packetId: current.packetId, verdict: "inconclusive", passedCases: [], failures: [{
        caseId: "case-A", stepIndex: 1, category: "precondition", message: "link not found",
        locatorSnapshot: '- main:\n  - button "Account menu"',
        locatorAttempts: [{ locator: { by: "role", role: "link", name: "Account menu", exact: true }, message: "missing", matchCount: 0 }],
      }] });
      const result = await audit(f);
      assert.equal(result.status, "inconclusive");
      assert.equal(result.repairableProbeFailure, explicitRole ? true : undefined);
    });
  });
}

for (const display of ['- heading "reader-user" [level=1]', '- text: reader-user']) {
  for (const explicitRole of [false, true]) {
    test(`A displayed identity does not authorize a guessed preparation button: ${display}, explicit=${explicitRole}`, async () => {
      await withModulePipeline(async f => {
        const tree = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
        const basis = explicitRole ? 'Show the button named "reader-user" after signing in.'
          : 'Show the current username "reader-user" after signing in.';
        tree.children[0].children[0].description = basis;
        await writeFile(f.options.requirementsFile, JSON.stringify(tree));
        const original = homePlan("button", basis);
        original.cases[0].steps[1] = { op: "expectVisible", locator: { by: "role", role: "button", name: "reader-user", exact: true } };
        original.cases[0].setupStepCount = 2;
        original.cases[0].steps.push({ op: "expectVisible", locator: { by: "role", role: "main" } });
        const planner = new FakeProbePlanner([original]);
        f.deps.planner = planner;
        let runs = 0;
        f.deps.runner.run = async plan => { runs++; return { packetId: plan.packetId, verdict: "inconclusive", passedCases: [], failures: [{
          caseId: "case-A", stepIndex: 1, category: "precondition", message: "button not found",
          locatorSnapshot: `- main:\n  ${display}`,
          locatorAttempts: [{ locator: { by: "role", role: "button", name: "reader-user", exact: true }, message: "missing", matchCount: 0 }],
        }] }; };
        const result = await audit(f);
        assert.equal(result.status, "inconclusive");
        assert.equal(result.repairableProbeFailure, explicitRole ? true : undefined);
        assert.equal(planner.reviews.length, explicitRole ? 1 : 2);
        assert.equal(runs, explicitRole ? 2 : 1);
        assert.equal(f.builder.requests.length, 0);
      });
    });
  }
}

for (const operation of ["click", "expectVisible"] as const) {
  test(`An untyped missing preparation entry remains repairable: ${operation}`, async () => {
    await withModulePipeline(async f => {
      const tree = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
      const basis = 'Open "Items" before using the workspace.';
      tree.children[0].children[0].description = basis;
      await writeFile(f.options.requirementsFile, JSON.stringify(tree));
      const original = homePlan("button", basis);
      original.cases[0].steps[1] = { op: operation, locator: { by: "role", role: "button", name: "Items", exact: true } };
      if (operation === "click") original.cases[0].steps.push({ op: "expectVisible", locator: { by: "role", role: "main" } });
      original.cases[0].setupStepCount = original.cases[0].steps.length;
      original.cases[0].steps.push({ op: "expectVisible", locator: { by: "role", role: "main" } });
      const planner = new FakeProbePlanner([original]);
      f.deps.planner = planner;
      let runs = 0;
      f.deps.runner.run = async plan => { runs++; return { packetId: plan.packetId, verdict: "inconclusive", passedCases: [], failures: [{
        caseId: "case-A", stepIndex: 1, category: "precondition", message: "entry not found",
        // A displayed name cannot replace an actual required action; the
        // assertion case has no same-named display evidence at all.
        locatorSnapshot: operation === "click" ? '- heading "Items" [level=1]' : '- text: Items archive',
      }] }; };
      const result = await audit(f);
      assert.equal(result.status, "inconclusive");
      assert.equal(result.repairableProbeFailure, true);
      assert.equal(runs, 2);
      assert.equal(planner.reviews.length, 1);
    });
  });
}

test("A displayed name does not suppress a preparation state failure on the observed control", async () => {
  await withModulePipeline(async f => {
    const tree = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    const basis = 'Use "Publish" before opening the workspace.';
    tree.children[0].children[0].description = basis;
    await writeFile(f.options.requirementsFile, JSON.stringify(tree));
    const original = homePlan("button", basis);
    original.cases[0].steps[1] = { op: "expectEnabled", locator: { by: "role", role: "button", name: "Publish", exact: true } };
    original.cases[0].setupStepCount = 2;
    original.cases[0].steps.push({ op: "expectVisible", locator: { by: "role", role: "main" } });
    const planner = new FakeProbePlanner([original]);
    f.deps.planner = planner;
    let runs = 0;
    f.deps.runner.run = async plan => { runs++; return { packetId: plan.packetId, verdict: "inconclusive", passedCases: [], failures: [{
      caseId: "case-A", stepIndex: 1, category: "precondition", message: "button is disabled",
      locatorSnapshot: '- heading "Publish" [level=1]\n- button "Publish" [disabled]',
    }] }; };
    assert.equal((await audit(f)).repairableProbeFailure, true);
    assert.equal(runs, 2);
    assert.equal(planner.reviews.length, 1);
  });
});

test("A displayed identity corrects a guessed preparation button within the existing two review calls", async () => {
  await withModulePipeline(async f => {
    const tree = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    const basis = 'Show the current username "reader-user" after signing in.';
    tree.children[0].children[0].description = basis;
    await writeFile(f.options.requirementsFile, JSON.stringify(tree));
    const original = homePlan("button", basis);
    original.cases[0].steps[1] = { op: "expectVisible", locator: { by: "role", role: "button", name: "reader-user", exact: true } };
    original.cases[0].setupStepCount = 2;
    original.cases[0].steps.push({ op: "expectVisible", locator: { by: "role", role: "main" } });
    const planner = new FakeProbePlanner([original]);
    f.deps.planner = planner;
    let reviews = 0, runs = 0;
    planner.reviewPlan = async (_packet, plan, _failures, feedback?: ProbePlannerFeedback) => {
      if (++reviews === 1) return { status: "sound", rationale: "Mistakenly assumed an identity button" };
      assert.match(feedback?.validationError ?? "", /requirement-grounded targets/);
      const corrected = structuredClone(plan);
      corrected.cases[0].steps[1] = { op: "expectVisible", locator: { by: "text", text: "reader-user", exact: true } };
      return { status: "corrected", rationale: "Check the displayed identity", plan: corrected,
        corrections: [{ caseId: "case-A", conflict: "The identity is displayed rather than an interactive button", basis: [basis] }] };
    };
    f.deps.runner.run = async plan => {
      runs++;
      const step = plan.cases[0].steps[1];
      return "locator" in step && step.locator.by === "text" ? pass(plan)
        : { packetId: plan.packetId, verdict: "inconclusive", passedCases: [], failures: [{ caseId: "case-A", stepIndex: 1,
          category: "precondition", message: "button not found", locatorSnapshot: '- generic: "reader-user"' }] };
    };
    const result = await audit(f);
    assert.equal(result.status, "verified");
    assert.equal(reviews, 2);
    assert.equal(runs, 2);
    assert.deepEqual(result.plan?.cases[0].steps.slice(2), original.cases[0].steps.slice(2));
    assert.equal(f.builder.requests.length, 0);
  });
});

test("A guessed preparation role recovers to the observed control without Builder repair", async () => {
  await withModulePipeline(async f => {
    const tree = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    const basis = 'Open "Account menu".';
    tree.children[0].children[0].description = basis;
    await writeFile(f.options.requirementsFile, JSON.stringify(tree));
    const original = homePlan("link", basis);
    original.cases[0].steps[1] = { op: "click", locator: { by: "role", role: "link", name: "Account menu", exact: true } };
    original.cases[0].steps.push({ op: "expectVisible", locator: { by: "role", role: "main" } });
    original.cases[0].setupStepCount = 3;
    original.cases[0].steps.push({ op: "expectVisible", locator: { by: "role", role: "main" } });
    const corrected = structuredClone(original);
    corrected.cases[0].steps[1] = { op: "click", locator: { by: "role", role: "button", name: "Account menu", exact: true } };
    const planner = new FakeProbePlanner([original, corrected]);
    f.deps.planner = planner;
    f.deps.runner.run = async current => {
      const step = current.cases[0].steps[1];
      if ("locator" in step && step.locator.by === "role" && step.locator.role === "button") return pass(current);
      return { packetId: current.packetId, verdict: "inconclusive", passedCases: [], failures: [{ caseId: "case-A", stepIndex: 1,
        category: "precondition", message: "link not found", locatorSnapshot: '- button "Account menu"',
        locatorAttempts: [{ locator: { by: "role", role: "link", name: "Account menu", exact: true }, message: "missing", matchCount: 0 }] }] };
    };
    assert.equal((await audit(f)).status, "verified");
    assert.equal(planner.refinements.length, 1);
    assert.equal(planner.reviews.length, 0);
    assert.equal(f.builder.requests.length, 0);
  });
});

test("An independent preparation failure does not suppress a reviewed and reproduced business failure", async () => {
  await withModulePipeline(async f => {
    const original = homePlan();
    original.cases.push({ ...structuredClone(original.cases[0]), id: "prepared-business" });
    f.deps.planner = new FakeProbePlanner([original]);
    let runs = 0;
    f.deps.runner.run = async plan => { runs++; return { packetId: plan.packetId, verdict: "fail", passedCases: [], failures: [
      { caseId: original.cases[0].id, stepIndex: 1, category: "precondition", message: "initial state mismatch" },
      { caseId: "prepared-business", stepIndex: 1, category: "assertion", message: "saved value missing" },
    ] }; };
    const result = await audit(f);
    assert.equal(result.status, "failed");
    assert.deepEqual(result.report?.failures.map(item => item.caseId), ["prepared-business"]);
    assert.equal(runs, 2);
  });
});

for (const assumption of ["target", "scope", "unnamed-container"] as const) {
  test(`A sound model verdict cannot authorize a guessed preparation ${assumption}`, async () => {
    await withModulePipeline(async f => {
      const catalog = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
      catalog.children[0].children[0].description += ' The "Home" tab is the required entry.';
      await writeFile(f.options.requirementsFile, JSON.stringify(catalog));
      const plan = homePlan();
      const step = plan.cases[0].steps[1];
      assert.ok("locator" in step);
      if (assumption === "target") step.locator = { by: "role", role: "button", name: "Invented entry", exact: true };
      else if (assumption === "scope") step.locator.scope = { by: "role", role: "region", name: "Invented region", exact: true };
      else step.locator = { by: "role", role: "main" };
      plan.cases[0].setupStepCount = 2;
      plan.cases[0].steps.push({ op: "expectVisible", locator: { by: "role", role: "main" } });
      const planner = new FakeProbePlanner([plan]);
      f.deps.planner = planner;
      let runs = 0, reviews = 0;
      f.deps.planner.reviewPlan = async (_packet, _original, _failures, feedback) => {
        if (++reviews === 2) assert.match(feedback?.validationError ?? "", /requirement-grounded targets/);
        return { status: "sound", rationale: "The model incorrectly approves its assumption" };
      };
      f.deps.runner.run = async current => { runs++; return { packetId: current.packetId, verdict: "inconclusive", passedCases: [],
        failures: [{ caseId: current.cases[0].id, stepIndex: 1, category: "precondition", message: "The guessed entry is missing" }] }; };
      const result = await audit(f);
      assert.equal(result.status, "inconclusive");
      assert.equal(result.repairableProbeFailure, undefined);
      assert.equal(reviews, 2);
      assert.equal(runs, 1);
      assert.equal(f.builder.requests.length, 0);
    });
  });
}

test("A guessed preparation failure cannot hide an independent grounded preparation gap", async () => {
  await withModulePipeline(async f => {
    const catalog = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    catalog.children[0].children[0].description += ' The "Home" tab is the required entry.';
    await writeFile(f.options.requirementsFile, JSON.stringify(catalog));
    const plan = homePlan();
    plan.cases[0].setupStepCount = 2;
    plan.cases[0].steps.push({ op: "expectVisible", locator: { by: "role", role: "main" } });
    const guessed = structuredClone(plan.cases[0]);
    guessed.id = "guessed";
    guessed.steps[1] = { op: "expectVisible", locator: { by: "role", role: "button", name: "Invented menu" } };
    plan.cases.push(guessed);
    f.deps.planner = new FakeProbePlanner([plan]);
    f.deps.runner.run = async current => ({ packetId: current.packetId, verdict: "inconclusive", passedCases: [],
      failures: current.cases.map(item => ({ caseId: item.id, stepIndex: 1, category: "precondition", message: "Required entry missing" })) });
    const result = await audit(f);
    assert.equal(result.status, "inconclusive");
    assert.equal(result.repairableProbeFailure, true);
    assert.deepEqual(result.report?.failures.map(item => item.caseId), ["case-A"]);
  });
});

test("A guessed preparation prefix can recover within the existing two calls", async () => {
  await withModulePipeline(async f => {
    const catalog = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    catalog.children[0].children[0].description += ' Open "Home" before using "Save".';
    await writeFile(f.options.requirementsFile, JSON.stringify(catalog));
    const original = homePlan("button");
    original.cases[0].steps[1] = { op: "expectVisible", locator: { by: "role", role: "button", name: "Guessed account menu" } };
    original.cases[0].setupStepCount = 2;
    original.cases[0].steps.push({ op: "click", locator: { by: "role", role: "button", name: "Save" } },
      { op: "expectVisible", locator: { by: "role", role: "main" } });
    const planner = new FakeProbePlanner([original]);
    f.deps.planner = planner;
    let reviews = 0;
    f.deps.planner.reviewPlan = async (_packet, plan, _failures, feedback) => {
      if (++reviews === 1) return { status: "sound", rationale: "Mistakenly assumed the menu name" };
      assert.match(feedback?.validationError ?? "", /requirement-grounded targets/);
      const corrected = structuredClone(plan);
      corrected.cases[0].steps[1] = { op: "expectVisible", locator: { by: "role", role: "tab", name: "Home" } };
      return { status: "corrected", rationale: "Use the declared entry", plan: corrected,
        corrections: [{ caseId: "case-A", conflict: "The menu name is not declared", basis: ['Open "Home" before using "Save".'] }] };
    };
    f.deps.runner.run = async plan => {
      const target = plan.cases[0].steps[1];
      return "locator" in target && target.locator.by === "role" && target.locator.name === "Home" ? pass(plan)
        : { packetId: plan.packetId, verdict: "inconclusive", passedCases: [], failures: [{
          caseId: "case-A", stepIndex: 1, category: "precondition", message: "Guessed menu is missing" }] };
    };
    const result = await audit(f);
    assert.equal(result.status, "verified");
    assert.equal(reviews, 2);
    assert.deepEqual(result.plan?.cases[0].steps.slice(2), original.cases[0].steps.slice(2));
    assert.equal(f.builder.requests.length, 0);
  });
});

for (const reviewRetry of [false, true]) {
  test(`Business review keeps its own quota after two locator refinements${reviewRetry ? " with validation feedback" : ""}`, async () => {
    await withModulePipeline(async f => {
      const original = homePlan();
      original.cases.push({ ...structuredClone(original.cases[0]), id: "business" });
      const planner = new FakeProbePlanner([original]);
      f.deps.planner = planner;
      let refinements = 0, reviews = 0, runs = 0;
      planner.refineLocators = async plan => {
        const changed = structuredClone(plan);
        const step = changed.cases[0].steps[1];
        assert.ok("locator" in step && step.locator.by === "role");
        step.locator.role = ++refinements === 1 ? "link" : "button";
        return changed;
      };
      planner.reviewPlan = async (_packet, _plan, _failures, feedback?: ProbePlannerFeedback) => {
        reviews++;
        if (reviewRetry && reviews === 1) throw new Error("Review validation failed");
        if (reviewRetry) assert.match(feedback?.validationError ?? "", /Review validation failed/);
        return { status: "sound", rationale: "The business expectation is grounded independently of the ambiguous locator" };
      };
      f.deps.runner.run = async plan => {
        runs++;
        return { packetId: plan.packetId, verdict: "fail", passedCases: [], failures: [
          { caseId: original.cases[0].id, stepIndex: 1, category: "locator", message: "strict mode violation",
            locatorSnapshot: '- link "Home"\n- button "Home"' },
          { caseId: "business", stepIndex: 1, category: "assertion", message: "required result missing" },
        ] };
      };
      const result = await audit(f);
      assert.equal(result.status, "failed");
      assert.deepEqual(result.report?.failures.map(item => item.caseId), ["business"]);
      assert.equal(refinements, 2);
      assert.equal(reviews, reviewRetry ? 2 : 1);
      assert.equal(runs, 4);
      assert.equal(f.builder.requests.length, 0);
    });
  });
}

test("Locator-only failures do not gain extra reviews after exhausting their recovery quota", async () => {
  await withModulePipeline(async f => {
    const original = homePlan();
    const planner = new FakeProbePlanner([original]);
    f.deps.planner = planner;
    let refinements = 0;
    planner.refineLocators = async plan => {
      const changed = structuredClone(plan);
      const step = changed.cases[0].steps[1];
      assert.ok("locator" in step && step.locator.by === "role");
      step.locator.role = ++refinements === 1 ? "link" : "button";
      return changed;
    };
    f.deps.runner.run = async plan => {
      const report = fail(plan, "locator");
      report.failures[0].message = "strict mode violation";
      return report;
    };
    const result = await audit(f);
    assert.equal(result.status, "inconclusive");
    assert.equal(result.repairableProbeFailure, undefined);
    assert.equal(refinements, 2);
    assert.equal(planner.reviews.length, 0);
    assert.equal(f.builder.requests.length, 0);
  });
});

for (const ambiguitySource of ["message", "candidate", "count"] as const) {
  test(`An unresolved preparation ambiguity in the ${ambiguitySource} cannot authorize diagnostic repair`, async () => {
    await withModulePipeline(async f => {
      const original = homePlan();
      original.cases[0].setupStepCount = 2;
      original.cases[0].steps.push({ op: "expectVisible", locator: { by: "role", role: "main" } });
      const planner = new FakeProbePlanner([original]);
      f.deps.planner = planner;
      let refinements = 0, runs = 0;
      planner.refineLocators = async plan => { refinements++; return plan; };
      f.deps.runner.run = async plan => {
        runs++;
        return { packetId: plan.packetId, verdict: "inconclusive", passedCases: [], failures: [{
          caseId: original.cases[0].id, stepIndex: 1, category: "precondition",
          message: ambiguitySource === "message" ? "strict mode violation" : "last candidate missing",
          locatorSnapshot: '- tab "Home"\n- tab "Home"',
          ...(ambiguitySource !== "message" ? { locatorAttempts: [{
            locator: { by: "role" as const, role: "tab", name: "Home" },
            message: ambiguitySource === "candidate" ? "strict mode violation" : "candidate wait timed out",
            ...(ambiguitySource === "count" ? { matchCount: 2 } : {}),
          }] } : {}),
        }] };
      };
      const result = await audit(f);
      assert.equal(result.status, "inconclusive");
      assert.equal(result.repairableProbeFailure, undefined);
      assert.equal(refinements, 1);
      assert.equal(planner.reviews.length, 1);
      assert.equal(runs, 1);
      assert.equal(f.builder.requests.length, 0);
    });
  });
}

test("An identical reviewed preparation gap is freshly confirmed without repeating the Planner call", async () => {
  await withModulePipeline(async f => {
    const catalog = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    catalog.children[0].children[0].description += ' The "Home" tab is the required entry.';
    await writeFile(f.options.requirementsFile, JSON.stringify(catalog));
    f.deps.planner.plan = async () => {
      const plan = homePlan();
      plan.cases[0].setupStepCount = 2;
      plan.cases[0].steps.push({ op: "expectVisible", locator: { by: "role", role: "main" } });
      return plan;
    };
    let reviews = 0, runs = 0;
    f.deps.planner.reviewPlan = async () => { reviews++; return { status: "sound", rationale: "Required initial seed is missing" }; };
    f.deps.runner.run = async plan => { runs++; return { packetId: plan.packetId, verdict: "inconclusive", passedCases: [],
      failures: [{ caseId: plan.cases[0].id, stepIndex: 1, category: "precondition", message: "seed missing" }] }; };
    const policy = { refineLocators: true, noProgressRefinements: new Set<string>() };
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal((await audit(f, () => 60_000, policy)).repairableProbeFailure, true);
    }
    assert.equal(reviews, 1);
    assert.equal(runs, 4);
  });
});

test("Browser retry is bounded and does not consume a Builder call", async () => {
  for (const recover of [true, false]) await withModulePipeline(async f => {
    let runs = 0;
    f.deps.runner.run = async plan => {
      if (++runs === 1 || !recover) throw new ExecutionFault("browser", "browser_disconnected", true);
      return pass(plan);
    };
    assert.equal((await audit(f)).status, recover ? "verified" : "inconclusive");
    assert.equal(runs, 2);
    assert.equal(f.builder.requests.length, 0);
  });
});

test("Planner invalid output gets scoped validation feedback and the remaining timeout", async () => {
  await withModulePipeline(async f => {
    let calls = 0;
    f.deps.planner.plan = async (packet, feedback, options) => {
      calls++;
      assert.equal(options?.timeoutMs, 1234);
      if (calls === 1) throw new ProbePlannerError("schema", "invalid", { cause: new Error("missing assertion") });
      assert.equal(feedback?.validationError, "missing assertion");
      return testPlan(packet);
    };
    assert.equal((await audit(f, () => 1234)).status, "verified");
    assert.equal(calls, 2);
  });
});

test("A model-length-truncated plan gets one compact retry", async () => {
  await withModulePipeline(async f => {
    let calls = 0;
    f.deps.planner.plan = async (packet, feedback) => {
      calls++;
      if (calls === 1) throw new ProbePlannerError("response", "Probe planner response body failed",
        { cause: new SyntaxError("Probe planner stream was cut off by the model") });
      assert.equal(feedback?.validationError, "Probe planner stream was cut off by the model");
      return testPlan(packet);
    };
    assert.equal((await audit(f)).status, "verified");
    assert.equal(calls, 2);
    assert.equal((await f.events()).filter(event => event.type === "probe_planner_retry").length, 1);
  });
});
