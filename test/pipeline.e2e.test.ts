import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";

test("Partial case improvements are confirmed and retained across the existing two repair rounds", async () => {
  await withModulePipeline(async f => {
    f.deps.planner.plan = async packet => {
      const plan = testPlan(packet);
      if (packet.id === "packet-a") plan.cases.push(
        { ...structuredClone(plan.cases[0]), id: "second-A" }, { ...structuredClone(plan.cases[0]), id: "existing-A" });
      return plan;
    };
    f.deps.runner.run = async plan => {
      const rounds = f.builder.requests.filter(request => request.mode === "repair").length;
      const ready = (id: string) => plan.packetId !== "packet-a" || id === "existing-A" ||
        (id === "case-A" && rounds >= 1) || (id === "second-A" && rounds >= 2);
      const failures = plan.cases.filter(item => !ready(item.id)).map(item => ({
        caseId: item.id, stepIndex: 1, category: "assertion" as const, message: "required result missing",
      }));
      return { packetId: plan.packetId, verdict: failures.length ? "fail" : "pass",
        passedCases: plan.cases.filter(item => ready(item.id)).map(item => item.id), failures };
    };
    const summary = await f.run();
    const repairs = f.builder.requests.filter(request => request.mode === "repair");
    assert.equal(repairs.length, 2);
    assert.ok(repairs[1].mode === "repair");
    assert.deepEqual(repairs[1].shadowObservation.passedCaseIds.sort(), ["case-A", "existing-A"]);
    const retained = (await f.events()).filter(event => event.type === "repair_batch_finished");
    assert.ok(retained.every(event => event.detail?.retained));
    assert.equal(retained[0].detail?.improvedCases, 1);
    assert.equal(summary.status, "delivered");
    assert.equal(f.git.restoredShas.length, 0);
  });
});

test("A partial repair cannot lose a passed case inside an otherwise failing requirement", async () => {
  await withModulePipeline(async f => {
    f.deps.planner.plan = async packet => {
      const plan = testPlan(packet);
      if (packet.id === "packet-a") plan.cases.push({ ...structuredClone(plan.cases[0]), id: "existing-A" });
      return plan;
    };
    f.deps.runner.run = async plan => {
      if (plan.packetId !== "packet-a") return pass(plan);
      const repaired = f.builder.requests.some(request => request.mode === "repair");
      const failures = plan.cases.filter(item => repaired ? item.id === "existing-A" : item.id === "case-A")
        .map(item => ({ caseId: item.id, stepIndex: 1, category: "assertion" as const, message: "required result missing" }));
      return { packetId: plan.packetId, verdict: failures.length ? "fail" : "pass",
        passedCases: plan.cases.filter(item => !failures.some(failure => failure.caseId === item.id)).map(item => item.id), failures };
    };
    await f.run();
    const result = (await f.events()).find(event => event.type === "repair_batch_finished");
    assert.equal(result?.detail?.retained, false);
    assert.match(String(result?.detail?.reason), /previously verified behavior was lost/);
    assert.equal(f.git.restoredShas.length, 1);
    assert.equal(f.builder.requests.filter(request => request.mode === "repair").length, 1);
  });
});

test("A later module rechecks cached verified prerequisites and repairs their regression before final audit", async () => {
  await withModulePipeline(async f => {
    f.deps.runner.run = async plan => {
      const laterBuilt = f.builder.requests.some(request => request.mode === "implement" && request.packet.requirementIds.includes("C"));
      const repaired = f.builder.requests.some(request => request.mode === "repair");
      return plan.packetId === "packet-a" && laterBuilt && !repaired ? fail(plan) : pass(plan);
    };
    const summary = await f.run();
    const repair = f.builder.requests.find(request => request.mode === "repair");
    assert.ok(repair?.mode === "repair");
    assert.deepEqual(repair.packet.requirementIds, ["A"]);
    const boundary = (await f.events()).find(event => event.type === "module_boundary_audit_finished" && event.detail?.moduleId === "SECOND");
    assert.ok(boundary?.type === "module_boundary_audit_finished");
    assert.deepEqual(boundary?.detail?.packetIds, ["packet-a", "packet-b", "packet-c"]);
    assert.equal(summary.status, "delivered");
  });
});
import { ExecutionFault } from "../src/execution-fault.js";
import { ProbePlannerError } from "../src/judge/llm-probe-planner.js";
import { PlaywrightProbeRunner } from "../src/judge/playwright-probe-runner.js";
import { GitCliOps } from "../src/git-ops.js";
import { FakeBuilder } from "./fakes/fake-builder.js";
import { startFixtureServer } from "./helpers/fixture-server.js";
import { withModulePipeline, fail, pass, testPlan } from "./helpers/module-pipeline.js";

for (const missing of [false, true]) {
  test(`Public entry executes and repairs without a business plan, missing=${missing}`, async () => {
    await withModulePipeline(async f => {
      const tree = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
      tree.children[0].children[1].description = 'The visitor starts at the home page. Visitors can search. The top global search uses a searchbox named "Lookup".';
      await writeFile(f.options.requirementsFile, JSON.stringify(tree));
      let plans = 0;
      let plansAtRepair = 0;
      const build = f.builder.run.bind(f.builder);
      f.builder.run = async (request, options) => {
        if (request.mode === "repair") plansAtRepair = plans;
        return build(request, options);
      };
      f.deps.planner.plan = async packet => {
        if (packet.id === "packet-b") { plans++; throw new Error("business plan unavailable"); }
        return testPlan(packet);
      };
      f.deps.planner.reviewPlan = async () => { assert.fail("entry must not call semantic review"); };
      f.deps.planner.refineLocators = async () => { assert.fail("entry must not call refinement"); };
      f.deps.runner.run = async plan => {
        const entry = plan.cases[0].id === "public-entry-contract";
        const repaired = f.builder.requests.some(request => request.mode === "repair");
        return entry && missing && !repaired ? fail(plan) : pass(plan);
      };
      const summary = await f.run();
      const repairs = f.builder.requests.filter(request => request.mode === "repair");
      assert.equal(repairs.length, missing ? 1 : 0);
      if (missing) {
        assert.ok(repairs[0].mode === "repair");
        assert.deepEqual(repairs[0].packet.requirementIds, ["B"]);
        assert.equal(plans, plansAtRepair, "structural repair must not replan unavailable business cases");
      }
      assert.ok(plans <= 3, "retain the existing bounded planning attempts");
      assert.equal(summary.status, "partial");
      assert.ok(!summary.verifiedRequirementIds.includes("B"));
      assert.ok(summary.missingPlanRequirementIds?.includes("B"));
      assert.equal(f.git.restoredShas.length, 0);
      const entries = (await f.events()).filter(event => event.type === "public_entry_checked");
      assert.ok(entries.some(event => event.detail?.status === "passed"));
      assert.equal(entries.some(event => event.detail?.status === "failed"), missing);
      assert.ok(!(await readdir(join(dirname(f.options.ledgerFile), "plans"))).some(name => name.startsWith("packet-b-")));
    });
  });
}

test("A repair protects a passing public entry whose complete business plan is missing", async () => {
  await withModulePipeline(async f => {
    const tree = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    tree.children[0].children[1].description = 'The visitor starts at the home page. Visitors can search. The top global search uses a searchbox named "Lookup".';
    await writeFile(f.options.requirementsFile, JSON.stringify(tree));
    f.deps.planner.plan = async packet => {
      if (packet.id === "packet-b") throw new Error("business plan unavailable");
      return testPlan(packet);
    };
    f.deps.runner.run = async plan => {
      const repairing = f.builder.requests.some(request => request.mode === "repair") && !f.git.restoredShas.length;
      return plan.cases[0].id === "public-entry-contract" ? repairing ? fail(plan) : pass(plan)
        : plan.packetId === "packet-c" && !repairing ? fail(plan) : pass(plan);
    };
    const summary = await f.run();
    assert.equal(f.git.restoredShas.length, 1);
    assert.ok(!summary.verifiedRequirementIds.includes("B"));
    assert.equal((await f.events()).find(event => event.type === "repair_batch_finished")?.detail?.retained, false);
  });
});

test("Unresolved final entry checks do not erase reproduced business failures", async () => {
  await withModulePipeline(async f => {
    const tree = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    tree.children[0].children[1].description = 'The visitor starts at the home page. Visitors can search. The top global search uses a searchbox named "Lookup".';
    await writeFile(f.options.requirementsFile, JSON.stringify(tree));
    let detecting = false;
    f.deps.logSink = { write: line => {
      const event = JSON.parse(line);
      if (event.type === "module_boundary_audit_finished" && event.detail?.moduleId === "SECOND") detecting = true;
    } };
    const run = f.builder.run.bind(f.builder);
    f.builder.run = async (request, options) => {
      const result = await run(request, options);
      return request.mode === "repair" ? { ...result, outcome: "failed", summary: "fixture repair refused" } : result;
    };
    f.deps.runner.run = async plan => {
      if (plan.cases[0].id === "public-entry-contract") return detecting ? {
        packetId: plan.packetId, verdict: "inconclusive", passedCases: [],
        failures: [{ caseId: plan.cases[0].id, stepIndex: 0, category: "runner", message: "entry execution unavailable" }],
      } : pass(plan);
      return plan.packetId === "packet-b" ? fail(plan) : pass(plan);
    };
    const summary = await f.run();
    assert.ok(summary.failedRequirementIds?.includes("B"));
    assert.ok(!summary.inconclusiveRequirementIds?.includes("B"));
  });
});

test("A transient non-target preparation guard is retried before retaining the confirmed repair", async () => {
  await withModulePipeline(async f => {
    let guardFailures = 0;
    f.deps.runner.run = async plan => {
      const repaired = f.builder.requests.some(request => request.mode === "repair");
      if (plan.packetId === "packet-a") return repaired ? pass(plan) : fail(plan);
      if (plan.packetId === "packet-b" && repaired && guardFailures++ === 0) return {
        packetId: plan.packetId, verdict: "inconclusive", passedCases: [], failures: [{ caseId: plan.cases[0].id,
          stepIndex: 1, category: "precondition", message: "initial control was temporarily unavailable" }],
      };
      return pass(plan);
    };
    const summary = await f.run();
    assert.equal(summary.status, "delivered");
    assert.equal(f.git.restoredShas.length, 0);
    assert.equal(f.builder.requests.filter(request => request.mode === "repair").length, 1);
    const guard = (await f.events()).find(event => event.type === "repair_guard_checked" && event.packetId === "packet-b");
    assert.ok(guard?.type === "repair_guard_checked");
    assert.equal(guard.detail?.status, "passed");
    assert.equal(guard.detail?.retried, true);
  });
});

test("An unresolved ordinary guard cannot erase a confirmed improvement or keep its old verified status", async () => {
  await withModulePipeline(async f => {
    const tree = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    tree.data = [{ category: "accounts", items: ["alice"] }];
    await writeFile(f.options.requirementsFile, JSON.stringify(tree));
    const checkedTargets: string[] = [];
    f.deps.runner.run = async plan => {
      const repaired = f.builder.requests.some(request => request.mode === "repair");
      if (plan.packetId === "packet-a") {
        if (repaired) checkedTargets.push(plan.packetId);
        return repaired ? pass(plan) : fail(plan);
      }
      if (plan.packetId === "packet-b" && repaired) return { packetId: plan.packetId, verdict: "inconclusive", passedCases: [],
        failures: [{ caseId: plan.cases[0].id, stepIndex: 1, category: "runner", message: "browser disconnected" }] };
      return pass(plan);
    };
    const summary = await f.run();
    assert.equal(f.git.restoredShas.length, 0);
    assert.ok(checkedTargets.length > 0);
    assert.deepEqual(summary.verifiedRequirementIds, ["A", "C"]);
    assert.deepEqual(summary.inconclusiveByKind?.execution, ["B"]);
    assert.equal(summary.status, "partial");
    assert.ok((await f.events()).some(event => event.type === "repair_batch_finished" && event.detail?.retained));
  });
});

test("A reproduced requirement-grounded preparation regression still rejects the repair", async () => {
  await withModulePipeline(async f => {
    const tree = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    tree.children[0].children[1].description = 'Open workspace "Shared". Seed data: workspace `Shared`.';
    await writeFile(f.options.requirementsFile, JSON.stringify(tree));
    f.deps.planner.plan = async packet => {
      const plan = testPlan(packet);
      if (packet.id === "packet-b") {
        plan.cases[0].setupStepCount = 2;
        plan.cases[0].steps.splice(1, 0, { op: "expectVisible", locator: { by: "role", role: "link", name: "Shared", exact: true } });
      }
      return plan;
    };
    f.deps.runner.run = async plan => {
      const repaired = f.builder.requests.some(request => request.mode === "repair") && f.git.restoredShas.length === 0;
      if (plan.packetId === "packet-a") return repaired ? pass(plan) : fail(plan);
      if (plan.packetId === "packet-b" && repaired) return { packetId: plan.packetId, verdict: "inconclusive", passedCases: [],
        failures: [{ caseId: plan.cases[0].id, stepIndex: 1, category: "precondition", message: "Shared workspace entry is missing" }] };
      return pass(plan);
    };
    await f.run();
    assert.equal(f.git.restoredShas.length, 1);
    const guard = (await f.events()).find(event => event.type === "repair_guard_checked" && event.packetId === "packet-b");
    assert.ok(guard?.type === "repair_guard_checked");
    assert.equal(guard.detail?.status, "regressed");
    assert.equal(guard.detail?.critical, true);
    assert.equal(guard.detail?.retried, false);
  });
});

test("An unrelated sampled module guard follows the same uncertainty policy as a local guard", async () => {
  await withModulePipeline(async f => {
    const tree = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    tree.data = [{ category: "accounts", items: ["alice"] }];
    tree.children[1].children[0].dependencies = [];
    await writeFile(f.options.requirementsFile, JSON.stringify(tree));
    f.deps.runner.run = async plan => {
      const repaired = f.builder.requests.some(request => request.mode === "repair");
      if (plan.packetId === "packet-c") return repaired ? pass(plan) : fail(plan);
      if (plan.packetId === "packet-a" && repaired) return { packetId: plan.packetId, verdict: "inconclusive", passedCases: [],
        failures: [{ caseId: plan.cases[0].id, stepIndex: 1, category: "runner", message: "browser disconnected" }] };
      return pass(plan);
    };
    const summary = await f.run();
    assert.equal(f.git.restoredShas.length, 0);
    assert.equal(summary.status, "partial");
    assert.deepEqual(summary.verifiedRequirementIds, ["B", "C"]);
    assert.deepEqual(summary.inconclusiveByKind?.execution, ["A"]);
    const guard = (await f.events()).find(event => event.type === "repair_guard_checked" && event.packetId === "packet-a");
    assert.ok(guard?.type === "repair_guard_checked");
    assert.equal(guard.detail?.critical, false);
    assert.equal(guard.detail?.status, "unresolved");
  });
});

for (const losesSeed of [false, true]) {
  test(`Cached seeded entries without dependency edges are protected at the next boundary: loss=${losesSeed}`, async () => {
    await withModulePipeline(async f => {
      const tree = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
      tree.children[0].children[0].description = "Display the main workspace. Seed data: workspace `Shared workspace`.";
      tree.children[1].children[0].dependencies = [];
      await writeFile(f.options.requirementsFile, JSON.stringify(tree));
      const planned: string[] = [];
      const checks: Array<{ packetId: string; cases: number; later: boolean }> = [];
      f.deps.planner.plan = async packet => {
        planned.push(packet.id);
        const plan = testPlan(packet);
        if (packet.id === "packet-a") {
          plan.cases[0].setupStepCount = 2;
          plan.cases[0].steps.splice(1, 0, { op: "expectVisible", locator: { by: "role", role: "heading", name: "Shared workspace", exact: true } });
          plan.cases.push({ ...structuredClone(plan.cases[0]), id: "persisted-A", purpose: "persistence" });
        }
        return plan;
      };
      f.deps.runner.run = async plan => {
        const later = f.builder.requests.some(request => request.mode === "implement" && request.packet.requirementIds.includes("C"));
        const repaired = f.builder.requests.some(request => request.mode === "repair");
        checks.push({ packetId: plan.packetId, cases: plan.cases.length, later });
        if (losesSeed && plan.packetId === "packet-a" && later && !repaired) {
          return { packetId: plan.packetId, verdict: "fail", passedCases: [], failures: plan.cases.map(item => ({
            caseId: item.id, stepIndex: 2, category: "assertion", message: "Shared workspace no longer exists",
          })) };
        }
        return pass(plan);
      };
      const summary = await f.run();
      const boundary = (await f.events()).find(event => event.type === "module_boundary_audit_finished" && event.detail?.moduleId === "SECOND");
      assert.ok(boundary?.type === "module_boundary_audit_finished");
      assert.deepEqual(boundary.detail?.regressionPacketIds, ["packet-a"]);
      assert.equal(checks.filter(item => item.packetId === "packet-a" && item.later && item.cases === 1).length,
        losesSeed ? 2 : 1, "a sampled failure is confirmed on fresh data before escalation");
      assert.equal(checks.filter(item => item.packetId === "packet-a").at(-1)?.cases, 2, "final audit keeps both original A cases");
      assert.deepEqual(planned.sort(), ["packet-a", "packet-b", "packet-c"]);
      const repairs = f.builder.requests.filter(request => request.mode === "repair");
      assert.equal(repairs.length, losesSeed ? 1 : 0);
      if (losesSeed) {
        assert.ok(repairs[0].mode === "repair");
        assert.deepEqual(repairs[0].packet.requirementIds, ["A"]);
      }
      assert.equal(summary.status, "delivered");
    });
  });
}

for (const entryRegresses of [false, true]) {
  test(`Boundary sampling prefers a declared global entry without seed prose, regression=${entryRegresses}`, async () => {
    await withModulePipeline(async f => {
      const tree = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
      tree.children[0].children[0].description = 'Display the main workspace. Seed data: workspace `global navigation`.';
      tree.children[0].children[1].description = 'Global repository search uses a searchbox named "Lookup" and displays its results.';
      tree.children[1].children[0].dependencies = [];
      await writeFile(f.options.requirementsFile, JSON.stringify(tree));
      const planned: string[] = [];
      const checks: Array<{ packetId: string; cases: number; later: boolean; repaired: boolean }> = [];
      f.deps.planner.plan = async packet => {
        planned.push(packet.id);
        const plan = testPlan(packet);
        if (packet.id === "packet-b") {
          plan.cases[0].steps.splice(1, 0,
            { op: "fill", locator: { by: "role", role: "searchbox", name: "Lookup", exact: true,
              scope: { by: "role", role: "banner" } }, value: "Shared area" },
            { op: "press", locator: { by: "role", role: "searchbox", name: "Lookup", exact: true,
              scope: { by: "role", role: "banner" } }, key: "Enter" });
          plan.cases.push({ ...structuredClone(plan.cases[0]), id: "persisted-B", purpose: "persistence" });
        }
        return plan;
      };
      f.deps.runner.run = async plan => {
        const later = f.builder.requests.some(request => request.mode === "implement" && request.packet.requirementIds.includes("C"));
        const repaired = f.builder.requests.some(request => request.mode === "repair");
        checks.push({ packetId: plan.packetId, cases: plan.cases.length, later, repaired });
        return entryRegresses && plan.packetId === "packet-b" && later && !repaired ? {
          packetId: plan.packetId, verdict: "fail", passedCases: [], failures: plan.cases.map(item => ({
            caseId: item.id, stepIndex: 3, category: "assertion", message: "Global search results are missing",
          })),
        } : pass(plan);
      };
      const summary = await f.run();
      const boundary = (await f.events()).find(event => event.type === "module_boundary_audit_finished" && event.detail?.moduleId === "SECOND");
      assert.ok(boundary?.type === "module_boundary_audit_finished");
      assert.deepEqual(boundary.detail?.regressionPacketIds, ["packet-b"]);
      assert.ok(checks.some(check => check.packetId === "packet-b" && check.later && !check.repaired && check.cases === 1));
      assert.equal(checks.filter(check => check.packetId === "packet-b").at(-1)?.cases, 2);
      assert.deepEqual(planned.sort(), ["packet-a", "packet-b", "packet-c"]);
      const repairs = f.builder.requests.filter(request => request.mode === "repair");
      assert.equal(repairs.length, entryRegresses ? 1 : 0);
      if (entryRegresses) {
        assert.ok(repairs[0].mode === "repair");
        assert.deepEqual(repairs[0].packet.requirementIds, ["B"]);
      }
      assert.equal(summary.status, "delivered");
    });
  });
}

test("Boundary repairs also protect sampled seeded entries outside their dependency scope", async () => {
  await withModulePipeline(async f => {
    const tree = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    tree.children[0].children[0].description = "Display the main workspace. Seed data: workspace `Shared workspace`.";
    tree.children[1].children[0].dependencies = [];
    await writeFile(f.options.requirementsFile, JSON.stringify(tree));
    f.deps.runner.run = async plan => {
      const repairing = f.builder.requests.some(request => request.mode === "repair");
      const notRestored = f.git.restoredShas.length === 0;
      return (plan.packetId === "packet-c" && (!repairing || !notRestored)) ||
        (plan.packetId === "packet-a" && repairing && notRestored) ? fail(plan) : pass(plan);
    };
    const summary = await f.run();
    const repair = (await f.events()).find(event => event.type === "repair_batch_finished");
    assert.equal(repair?.detail?.retained, false);
    assert.match(String(repair?.detail?.reason), /previously verified behavior/);
    assert.equal(f.git.restoredShas.length, 1);
    assert.deepEqual(summary.verifiedRequirementIds, ["A", "B"]);
    assert.deepEqual(summary.failedRequirementIds, ["C"]);
  });
});

test("A passing prerequisite cannot hide a sibling control regression during another module's repair", async () => {
  await withModulePipeline(async f => {
    const tree = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    tree.children[0].children[1].dependencies = [];
    tree.children[0].children[1].description = 'The page contains one button named "Account menu".';
    tree.children[1].children[0].dependencies = ["A"];
    await writeFile(f.options.requirementsFile, JSON.stringify(tree));
    const planned: string[] = [];
    const checks: Array<{ packet: string; cases: number; repaired: boolean }> = [];
    f.deps.planner.plan = async packet => {
      planned.push(packet.id);
      const plan = testPlan(packet);
      if (packet.id === "packet-b") {
        plan.cases[0].steps.splice(1, 0, { op: "click", locator: { by: "role", role: "button", name: "Account menu", exact: true } });
        plan.cases[0].setupStepCount = 3;
        plan.cases[0].steps.push({ op: "expectVisible", locator: { by: "role", role: "main" } });
        plan.cases.push({ ...structuredClone(plan.cases[0]), id: "persisted-B", purpose: "persistence" });
      }
      return plan;
    };
    f.deps.runner.run = async plan => {
      const repaired = f.builder.requests.some(request => request.mode === "repair") && !f.git.restoredShas.length;
      checks.push({ packet: plan.packetId, cases: plan.cases.length, repaired });
      if (plan.packetId === "packet-c") return repaired ? pass(plan) : fail(plan);
      if (plan.packetId === "packet-b" && repaired) return { packetId: plan.packetId, verdict: "inconclusive", passedCases: [],
        failures: [{ caseId: plan.cases[0].id, stepIndex: 1, category: "precondition", message: "button was replaced by a link",
          locatorSnapshot: '- link "Account menu"', locatorAttempts: [{ locator: { by: "role", role: "button", name: "Account menu" }, message: "missing", matchCount: 0 }] }] };
      return pass(plan);
    };
    const summary = await f.run();
    assert.equal(f.git.restoredShas.length, 1);
    assert.deepEqual(summary.verifiedRequirementIds, ["A", "B"]);
    assert.ok(checks.some(check => check.packet === "packet-a" && check.repaired));
    assert.ok(checks.some(check => check.packet === "packet-b" && check.repaired && check.cases === 1));
    assert.equal(checks.filter(check => check.packet === "packet-b").at(-1)?.cases, 2);
    assert.deepEqual(planned.sort(), ["packet-a", "packet-b", "packet-c"]);
  });
});

test("An accepted target repair persists its recovered plan to the cache and product mirror", async () => {
  await withModulePipeline(async f => {
    f.options.progressDir = join(f.options.outputDir, "shallow-progress");
    let refined = false;
    f.deps.planner.refineLocators = async original => {
      const plan = structuredClone(original);
      plan.cases[0].steps[1] = { op: "expectVisible", locator: { by: "role", role: "main", name: "Repaired workspace" } };
      refined = true;
      return plan;
    };
    f.deps.runner.run = async plan => {
      if (plan.packetId !== "packet-c") return pass(plan);
      const repaired = f.builder.requests.some(request => request.mode === "repair");
      if (!repaired) return fail(plan);
      return refined ? pass(plan) : fail(plan, "locator");
    };
    const summary = await f.run();
    assert.equal(summary.status, "delivered");
    assert.ok(refined);
    for (const directory of [join(dirname(f.options.ledgerFile), "plans"), join(f.options.outputDir, "shallow-progress", "plans")]) {
      const file = (await readdir(directory)).find(name => name.startsWith("packet-c-"));
      assert.ok(file);
      const plan = JSON.parse(await readFile(join(directory, file), "utf8"));
      assert.equal(plan.cases[0].steps[1].locator.name, "Repaired workspace");
    }
  });
});

test("Pipeline checks module paths before the full atomic audit and keeps verification separate", async () => {
  await withModulePipeline(async f => {
    const calls: string[] = [];
    f.deps.planner.plan = async (packet, _feedback, _options) => {
      calls.push(packet.id);
      const { testPlan } = await import("./helpers/module-pipeline.js");
      return testPlan(packet);
    };
    const summary = await f.run();
    assert.equal(summary.status, "delivered");
    assert.deepEqual(f.builder.requests.map(item => "packet" in item ? item.packet.requirementIds : []), [["A", "B"], ["C"]]);
    // Parallel plan generation runs during implementation; module boundary audit reads from cache (no additional planner calls).
    // Consolidated audit also reads from cache.
    assert.deepEqual(calls, ["packet-a", "packet-b", "packet-c"]);
    assert.deepEqual(summary.implementedRequirementIds, ["A", "B", "C"]);
    assert.deepEqual(summary.verifiedRequirementIds, ["A", "B", "C"]);
    assert.deepEqual(f.git.restoredShas, []);
    // Every implementation packet runs in a fresh session.
    assert.ok(f.builder.runOptions[0]?.sessionKey);
    assert.notEqual(f.builder.runOptions[0]?.sessionKey, f.builder.runOptions[1]?.sessionKey);
    assert.equal(f.builder.closeCount, 1);
    const events = await f.events();
    assert.equal(events.filter(item => item.type === "checkpoint_saved").length, 2);
    // 3 consolidated audit_result events (module boundary audit updates results internally, no separate events).
    assert.equal(events.filter(item => item.type === "audit_result").length, 3);
    assert.ok(events.some(item => item.type === "module_boundary_audit_finished"));
  });
});

for (const fault of ["schema", "auth", "locator", "browser"] as const) {
  test(`Judge ${fault} fault retains implemented features and permits downstream work`, async () => {
    await withModulePipeline(async f => {
      if (fault === "schema" || fault === "auth") f.deps.planner.plan = async () => {
        throw new ProbePlannerError(fault === "schema" ? "schema" : "transport", "judge failed", { httpStatus: fault === "auth" ? 401 : undefined });
      };
      else f.deps.runner.run = async plan => {
        if (fault === "browser") throw new ExecutionFault("browser", "browser_disconnected", true);
        return fail(plan, "locator");
      };
      const summary = await f.run();
      assert.equal(summary.status, "partial");
      assert.deepEqual(summary.inconclusiveRequirementIds, ["A", "B", "C"]);
      assert.deepEqual(summary.blockedRequirementIds, []);
      assert.deepEqual(summary.implementedRequirementIds, ["A", "B", "C"]);
      assert.deepEqual(summary.verifiedRequirementIds, []);
      assert.deepEqual(f.git.restoredShas, []);
      assert.equal(summary.acceptedSha, "second");
      assert.equal(f.builder.requests.length, 2);
      const gate = (await f.events()).find(item => item.type === "dependency_gate_provisional");
      assert.deepEqual(gate?.detail?.dependencyIds, ["A", "B"]);
    });
  });
}

test("Audit replays a business failure in a fresh application before requesting consolidated repair", async () => {
  await withModulePipeline(async f => {
    const calls = new Map<string, number>();
    f.deps.runner.run = async plan => {
      if (plan.packetId.startsWith("feedback-")) return pass(plan);
      calls.set(plan.packetId, (calls.get(plan.packetId) ?? 0) + 1);
      const repairing = f.builder.requests.some(item => item.mode === "repair");
      return !repairing && plan.packetId !== "packet-c" ? fail(plan) : pass(plan);
    };
    const summary = await f.run();
    const repair = f.builder.requests.find(item => item.mode === "repair");
    assert.ok(repair && repair.mode === "repair");
    assert.deepEqual(repair.packet.requirementIds, ["A", "B"]);
    assert.equal(repair.shadowObservation.failures.length, 2);
    assert.equal(f.builder.runOptions[f.builder.requests.findIndex(item => item.mode === "repair")]?.sessionKey, undefined);
    // The next module reuses the cached prerequisite probes before the final audit.
    assert.equal(calls.get("packet-a"), 5);
    assert.equal(calls.get("packet-b"), 5);
    assert.equal(calls.get("packet-c"), 2);
    assert.equal(summary.status, "delivered");
  });
});

test("A non-reproducible foundation failure leaves downstream implementation eligible", async () => {
  await withModulePipeline(async f => {
    const seen = new Set<string>();
    f.deps.runner.run = async plan => { if (seen.has(plan.packetId)) return pass(plan); seen.add(plan.packetId); return fail(plan); };
    const summary = await f.run();
    assert.deepEqual(summary.verifiedRequirementIds, ["A", "B", "C"]);
    assert.deepEqual(summary.blockedRequirementIds, []);
    assert.equal(f.builder.requests.length, 2);
    assert.deepEqual(f.git.restoredShas, []);
  });
});

test("Module audit runs a ready plan while another background validation retry is pending", async () => {
  await withModulePipeline(async f => {
    let releaseRetry!: () => void;
    const pendingRetry = new Promise<void>(resolve => { releaseRetry = resolve; });
    const guard = setTimeout(releaseRetry, 2_000);
    const probes: string[] = [];
    const planning: string[] = [];
    f.deps.planner.plan = async (packet, feedback) => {
      planning.push(`${packet.id}:${feedback ? "retry" : "first"}`);
      if (packet.id === "packet-a" && !feedback) {
        throw new ProbePlannerError("schema", "invalid plan", { cause: new Error("missing locator fallback") });
      }
      if (packet.id === "packet-a") await pendingRetry;
      return testPlan(packet);
    };
    f.deps.runner.run = async plan => {
      probes.push(plan.packetId);
      if (plan.packetId === "packet-b") releaseRetry();
      return pass(plan);
    };
    try {
      assert.equal((await f.run()).status, "delivered");
    } finally { clearTimeout(guard); }
    assert.deepEqual(planning, ["packet-a:first", "packet-b:first", "packet-a:retry", "packet-c:first"]);
    assert.equal(probes[0], "packet-b");
    assert.equal(probes[1], "packet-a");
    assert.ok(!(await f.events()).some(event => event.type === "probe_preplan_failed"));
  });
});

test("A failed background feedback retry gets only one more boundary planning attempt", async () => {
  await withModulePipeline(async f => {
    let firstModuleCalls = 0;
    let callsAtBoundary = 0;
    f.deps.planner.plan = async packet => {
      if (packet.id === "packet-a") {
        firstModuleCalls++;
        throw new ProbePlannerError("schema", "invalid plan", { cause: new Error("missing locator fallback") });
      }
      return testPlan(packet);
    };
    f.deps.logSink = { write: line => {
      const event = JSON.parse(line);
      if (event.type === "module_boundary_audit_finished" && event.detail?.moduleId === "FIRST") {
        callsAtBoundary = firstModuleCalls;
      }
    } };
    const summary = await f.run();
    assert.equal(callsAtBoundary, 3);
    assert.deepEqual(summary.inconclusiveRequirementIds, ["A"]);
  });
});

test("An independently passed happy path remains inconclusive while downstream implementation proceeds", async () => {
  await withModulePipeline(async f => {
    f.deps.planner.plan = async packet => {
      const plan = testPlan(packet);
      if (packet.requirementIds[0] !== "C") {
        plan.cases[0].steps.splice(1, 0,
          { op: "click", locator: { by: "role", role: "button", name: "Open workspace" } });
        plan.cases[0].steps[2] = { op: "expectVisible", locator: { by: "role", role: "status", name: "Workspace ready" } };
        plan.cases.push({ id: `edge-${packet.requirementIds[0]}`, requirementIds: packet.requirementIds,
          purpose: "negative", expectationBasis: [packet.requirements[0].text], steps: [
            { op: "goto", path: "/" },
            { op: "click", locator: { by: "role", role: "button", name: "Missing detail" } },
            { op: "expectVisible", locator: { by: "role", role: "main" } },
          ] });
      }
      return plan;
    };
    f.deps.runner.run = async plan => plan.packetId === "packet-c" ? pass(plan) : {
      packetId: plan.packetId, verdict: "inconclusive", passedCases: [plan.cases[0].id],
      failures: [{ caseId: plan.cases[1].id, stepIndex: 1, category: "locator",
        message: "missing edge control", locatorSnapshot: '- main "Workspace"' }],
    };
    const summary = await f.run();
    assert.deepEqual(summary.implementedRequirementIds, ["A", "B", "C"]);
    assert.deepEqual(summary.blockedRequirementIds, []);
    assert.deepEqual(summary.verifiedRequirementIds, ["C"]);
    assert.equal(f.builder.requests.length, 2);
    const gate = (await f.events()).find(item => item.type === "dependency_gate_provisional");
    assert.deepEqual(gate?.detail?.dependencyIds, ["A", "B"]);
  });
});

for (const regression of [true, false]) {
  test(`Unhelpful repair restores the runnable checkpoint: regression=${regression}`, async () => {
    await withModulePipeline(async f => {
      f.deps.runner.run = async plan => {
        const repairing = f.builder.requests.some(item => item.mode === "repair");
        const failed = plan.packetId === "packet-a" ? !(repairing && regression) : repairing && regression;
        return failed ? fail(plan) : pass(plan);
      };
      const summary = await f.run();
      // Module boundary audit uses the repair rounds on the first module;
      // the final audit is detection-only and never launches more repairs.
      if (regression) {
        // Boundary repair causes regression in packet-b; C can still be built
        // on the retained runnable checkpoint.
        assert.deepEqual(summary.verifiedRequirementIds, ["A"]);
        assert.deepEqual(summary.failedRequirementIds, ["B", "C"]);
        assert.deepEqual(summary.blockedRequirementIds, []);
        assert.ok(summary.implementedRequirementIds?.includes("C"));
        assert.equal(summary.status, "partial");
      } else {
        // packet-a always fails regardless of repair state.
        assert.deepEqual(summary.verifiedRequirementIds, ["B", "C"]);
        assert.deepEqual(summary.failedRequirementIds, ["A"]);
        assert.deepEqual(summary.blockedRequirementIds, []);
        assert.equal(summary.status, "partial");
      }
    });
  });
}

test("A module boundary repair that breaks a verified path is discarded instead of kept", async () => {
  await withModulePipeline(async f => {
    f.deps.runner.run = async plan => {
      if (plan.packetId === "packet-c") return pass(plan);
      const repairing = f.builder.requests.some(item => item.mode === "repair");
      const target = plan.packetId === "packet-a";
      // The repair fixes A but regresses the verified B.
      return repairing === target ? pass(plan) : fail(plan);
    };
    const summary = await f.run();
    const events = await f.events();
    const batches = events.filter(item => item.type === "repair_batch_finished");
    assert.equal(batches[0]?.detail?.retained, false);
    assert.match(String(batches[0]?.detail?.reason), /previously verified behavior was lost/);
    // The regressing boundary repair is never checkpointed; the dependent
    // module can still use the previous runnable checkpoint.
    assert.equal(events.filter(item => item.type === "checkpoint_saved").length, 2);
    assert.deepEqual(summary.verifiedRequirementIds, ["A", "C"]);
    assert.deepEqual(summary.failedRequirementIds, ["B"]);
    assert.deepEqual(summary.blockedRequirementIds, []);
    assert.equal(summary.status, "partial");
  });
});

test("A boundary repair that drifts a verified packet's locators keeps the refined plan for the final audit", async () => {
  await withModulePipeline(async f => {
    const refined: string[] = [];
    f.deps.planner.refineLocators = async original => {
      refined.push(original.packetId);
      return {
        ...structuredClone(original),
        cases: original.cases.map(item => ({
          ...item,
          steps: item.steps.map(step => "locator" in step && step.locator.by === "role" && step.locator.name === undefined
            ? { ...step, locator: { ...step.locator, name: "Workspace" } }
            : step),
        })),
      };
    };
    f.deps.runner.run = async plan => {
      if (plan.packetId === "packet-c") return pass(plan);
      const repaired = f.builder.requests.some(item => item.mode === "repair");
      if (plan.packetId === "packet-a") return repaired ? pass(plan) : fail(plan);
      // packet-b: the plain locator resolves before the repair; the repair renames
      // the control, so afterwards only the refined (named) locator resolves.
      const step = plan.cases[0].steps[1];
      const named = "locator" in step && step.locator.by === "role" && step.locator.name !== undefined;
      return repaired === named ? pass(plan) : fail(plan, named ? "assertion" : "locator");
    };
    const summary = await f.run();
    // The verified packet's recheck needed a locator refinement to survive the repair.
    assert.deepEqual(refined, ["packet-b"]);
    // Detection-only final audits cannot refine again, so the refined plan must have
    // been kept: B stays verified instead of dropping to inconclusive.
    assert.deepEqual(summary.verifiedRequirementIds, ["A", "B", "C"]);
    assert.equal(summary.status, "delivered");
  });
});

test("Judge events carry the build attempt that produced the audited code", async () => {
  await withModulePipeline(async f => {
    const summary = await f.run();
    assert.equal(summary.status, "delivered");
    const judge = (await f.events()).filter(item => item.type === "probe_started" || item.type === "probe_finished");
    assert.ok(judge.length > 0);
    assert.ok(judge.every(item => item.attempt === 1));
  });
});

test("Per-module boundary repair quota: each module gets independent repair rounds", async () => {
  await withModulePipeline(async f => {
    f.options.totalBudgetMs = 0;
    // Track repair attempts per packet to verify quota resets per module.
    const repairAttempts = new Map<string, number>();
    f.deps.runner.run = async plan => {
      if (plan.packetId.startsWith("feedback-")) return pass(plan);
      // Count repair attempts for each packet.
      const key = plan.packetId;
      const count = (repairAttempts.get(key) ?? 0) + 1;
      repairAttempts.set(key, count);
      const repairCount = f.builder.requests.filter(request => request.mode === "repair").length;
      // FIRST becomes sound after its repair. SECOND then fails independently
      // until its own repair proves the per-module quota reset.
      return plan.packetId === "packet-c"
        ? repairCount >= 2 ? pass(plan) : fail(plan)
        : repairCount >= 1 ? pass(plan) : fail(plan);
    };
    const summary = await f.run();
    const repairs = f.builder.requests.filter(r => r.mode === "repair");
    // FIRST module and SECOND module each consume one independent repair.
    // Final audit only re-checks; it launches no repairs of its own.
    // Total: 2 implement + 1 FIRST repair + 1 SECOND repair = 4 requests
    assert.equal(repairs.length, 2);
    assert.equal(f.builder.requests.length, 4);
    // All requirements verified after per-module boundary repairs.
    assert.deepEqual(summary.verifiedRequirementIds, ["A", "B", "C"]);
    assert.deepEqual(summary.failedRequirementIds, []);
    // Verify that A and B got repair attempts in FIRST module,
    // and C got repair attempts in SECOND module (proving quota reset).
    assert.ok((repairAttempts.get("packet-a") ?? 0) >= 3);
    assert.ok((repairAttempts.get("packet-b") ?? 0) >= 3);
    assert.ok((repairAttempts.get("packet-c") ?? 0) >= 3);
  });
});

test("Broken foundation startup blocks its dependent packet without opening a new session", async () => {
  await withModulePipeline(async f => {
    let starts = 0;
    f.deps.appLifecycle.start = async () => {
      if (++starts <= 2) throw new Error("broken build");
      return { baseUrl: f.options.platformContract.baseUrl, stop: async () => {} };
    };
    const summary = await f.run();
    assert.deepEqual(summary.blockedRequirementIds, ["A", "B", "C"]);
    assert.deepEqual(summary.verifiedRequirementIds, []);
    assert.deepEqual(f.git.restoredShas, ["initial"]);
    assert.equal(f.builder.runOptions[0]?.sessionKey, f.builder.runOptions[1]?.sessionKey);
    assert.equal(f.builder.runOptions.length, 2);
  });
});

test("A failed Builder receipt is rescued when the written application is runnable", async () => {
  await withModulePipeline(async f => {
    const builder = new FakeBuilder(["failed", "completed"]);
    f.deps.builder = builder;
    const summary = await f.run();
    assert.deepEqual(summary.blockedRequirementIds, []);
    assert.deepEqual(summary.implementedRequirementIds, ["A", "B", "C"]);
    assert.deepEqual(summary.verifiedRequirementIds, ["A", "B", "C"]);
    assert.deepEqual(f.git.restoredShas, []);
    // initial + attempt snapshot for the rescued packet + two checkpoints.
    assert.equal(f.git.captureMessages.length, 4);
    // Implementation packets always run in fresh sessions.
    assert.ok(builder.runOptions[0]?.sessionKey);
    assert.notEqual(builder.runOptions[0]?.sessionKey, builder.runOptions[1]?.sessionKey);
    const events = await f.events();
    const rescued = events.filter(item => item.type === "module_rescued");
    assert.equal(rescued.length, 1);
    assert.deepEqual(rescued[0].detail?.requirementIds, ["A", "B"]);
  });
});

test("A failed Builder receipt with unrunnable code stays blocked and restores the checkpoint", async () => {
  await withModulePipeline(async f => {
    f.deps.builder = new FakeBuilder(["failed", "completed"]);
    let starts = 0;
    f.deps.appLifecycle.start = async () => {
      if (++starts === 1) throw new Error("broken build");
      return { baseUrl: f.options.platformContract.baseUrl, stop: async () => {} };
    };
    const summary = await f.run();
    assert.deepEqual(summary.blockedRequirementIds, ["A", "B", "C"]);
    assert.deepEqual(summary.implementedRequirementIds, []);
    assert.deepEqual(f.git.restoredShas, ["initial"]);
  });
});

test("Implementation phase reserves time for audit and delivery instead of starting more modules", async () => {
  await withModulePipeline(async f => {
    let time = 0;
    f.deps.clock = { nowMs: () => time };
    const start = f.deps.appLifecycle.start;
    f.deps.appLifecycle.start = async (...args) => { time = 36_001; return start(...args); };
    const summary = await f.run();
    assert.equal(f.builder.requests.length, 1);
    assert.equal(f.builder.runOptions[0]?.timeoutMs, 36_000);
    assert.deepEqual(summary.verifiedRequirementIds, ["A", "B"]);
    assert.equal(summary.status, "partial");
  });
});

test("Expired audit does not call Planner and preserves unverified code", async () => {
  await withModulePipeline(async f => {
    let time = 0;
    f.deps.clock = { nowMs: () => time };
    f.deps.appLifecycle.start = async () => { time = 50_000; return { baseUrl: f.options.platformContract.baseUrl, stop: async () => {} }; };
    f.deps.planner.plan = async () => { assert.fail("Planner must not run after audit deadline"); };
    const summary = await f.run();
    assert.deepEqual(summary.inconclusiveRequirementIds, ["A", "B"]);
    assert.deepEqual(f.git.restoredShas, []);
  });
});

test("Delivery repair has one attempt and invalidates stale feature passes when source changes", async () => {
  await withModulePipeline(async f => {
    let time = 0;
    f.deps.clock = { nowMs: () => time };
    let checks = 0;
    f.deps.finalVerifier.verify = async () => {
      checks++;
      if (checks === 1) return { ok: false, stage: "build", message: "broken" };
      time = 60_001;
      return { ok: true, stage: "complete", message: "repaired" };
    };
    const summary = await f.run();
    assert.equal(f.builder.requests.filter(item => item.mode === "delivery_repair").length, 1);
    assert.deepEqual(summary.verifiedRequirementIds, []);
    assert.deepEqual(summary.inconclusiveRequirementIds, ["A", "B", "C"]);
    assert.equal(summary.status, "partial");
  });
});

test("A failed delivery repair attempt is not verified; the next round can still succeed", async () => {
  await withModulePipeline(async f => {
    const builder = new FakeBuilder(["completed", "completed", "failed", "completed"]);
    f.deps.builder = builder;
    let checks = 0;
    f.deps.finalVerifier.verify = async () => {
      checks++;
      return checks === 1 ? { ok: false, stage: "build", message: "broken" } : { ok: true, stage: "complete", message: "repaired" };
    };
    const summary = await f.run();
    assert.equal(builder.requests.filter(item => item.mode === "delivery_repair").length, 2);
    // Verification covers the initial failure and the completed round only: a repair
    // the Builder did not complete is restored without wasting a verification on it.
    assert.equal(checks, 2);
    assert.equal(summary.status, "delivered");
  });
});

test("Unlimited delivery stops after three repair rounds and one browser infrastructure retry", async () => {
  await withModulePipeline(async f => {
    f.options.totalBudgetMs = 0;
    let checks = 0;
    f.deps.finalVerifier.verify = async () => { checks++; return { ok: false, stage: "build", message: "broken" }; };
    assert.equal((await f.run()).status, "failed");
    // Initial verification, one per completed repair round, one post-restore confirmation.
    assert.equal(checks, 5);
    const repairs = f.builder.requests.filter(item => item.mode === "delivery_repair");
    assert.equal(repairs.length, 3);
    // Each delivery repair call may take up to the 30-minute ceiling.
    const firstRepair = f.builder.requests.findIndex(item => item.mode === "delivery_repair");
    assert.equal(f.builder.runOptions[firstRepair]?.timeoutMs, 1_800_000);
    // Every failed round restores the accepted state before the next attempt.
    assert.deepEqual(f.git.restoredShas, ["second", "second", "second"]);
  });
  await withModulePipeline(async f => {
    f.options.totalBudgetMs = 0;
    let checks = 0;
    f.deps.finalVerifier.verify = async () => { checks++; throw new ExecutionFault("browser", "browser_disconnected", true); };
    await assert.rejects(f.run(), ExecutionFault);
    assert.equal(checks, 2);
    assert.equal(f.builder.closeCount, 1);
    assert.deepEqual(f.git.restoredShas, ["second"]);
  });
});

for (const result of ["improved", "unchanged", "regressed"] as const) {
  test(`Boundary diagnosis of a missing declared action retains only verified improvements: ${result}`, async () => {
    await withModulePipeline(async f => {
      const catalog = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
      catalog.children[0].children[0].description = 'Open "Items" and click "Publish".';
      await writeFile(f.options.requirementsFile, JSON.stringify(catalog));
      f.deps.planner.plan = async packet => {
        const plan = testPlan(packet);
        if (packet.id === "packet-a") plan.cases[0].steps.splice(1, 0,
          { op: "click", locator: { by: "role", role: "button", name: "Items" } },
          { op: "click", locator: { by: "role", role: "button", name: "Publish" } });
        return plan;
      };
      f.deps.runner.run = async plan => {
        const repaired = f.builder.requests.some(request => request.mode === "repair") && f.git.restoredShas.length === 0;
        if (plan.packetId === "packet-b" && repaired && result === "regressed") return fail(plan);
        if (plan.packetId !== "packet-a" || (repaired && result !== "unchanged")) return pass(plan);
        const report = fail(plan, "locator");
        report.failures[0].stepIndex = 2;
        return report;
      };
      const summary = await f.run();
      const repairs = f.builder.requests.filter(request => request.mode === "repair");
      assert.equal(repairs.length, 1);
      const repair = repairs[0];
      assert.ok(repair.mode === "repair");
      assert.deepEqual(repair.packet.requirementIds, ["A"]);
      assert.equal(repair.shadowObservation.failures[0].category, "locator");
      const event = (await f.events()).find(event => event.type === "repair_batch_finished");
      assert.ok(event?.type === "repair_batch_finished");
      assert.equal(event.detail?.retained, result === "improved");
      assert.equal(f.git.restoredShas.length, result === "improved" ? 0 : 1);
      if (result === "improved") assert.equal(summary.status, "delivered");
      if (result === "unchanged") assert.ok(summary.inconclusiveRequirementIds?.includes("A"));
    });
  });
}

test("Real Chromium verifies the fixture after all module builds", async () => {
  await withModulePipeline(async f => {
    f.deps.runner = new PlaywrightProbeRunner();
    f.deps.appLifecycle.start = async outputDir => {
      const server = await startFixtureServer(outputDir);
      return { baseUrl: server.baseUrl, stop: server.stop };
    };
    assert.equal((await f.run()).status, "delivered");
  });
});

test("Real Git retains application files when Planner fails", async () => {
  await withModulePipeline(async f => {
    f.deps.git = await GitCliOps.open(f.options.outputDir);
    f.deps.planner.plan = async () => { throw new Error("invalid plan"); };
    const summary = await f.run();
    assert.equal(summary.status, "partial");
    assert.match(await readFile(join(f.options.outputDir, "server.mjs"), "utf8"), /createServer/);
  });
});

test("Real Git discards a regression repair and restores original application files", async () => {
  await withModulePipeline(async f => {
    f.deps.git = await GitCliOps.open(f.options.outputDir);
    const original = f.builder.run.bind(f.builder);
    f.deps.builder.run = async (request, options) => {
      const result = await original(request, options);
      await writeFile(join(request.outputDir, "revision.txt"), request.mode);
      return result;
    };
    f.deps.runner.run = async plan => plan.packetId === "packet-a" ? fail(plan) : pass(plan);
    await f.run();
    assert.equal(await readFile(join(f.options.outputDir, "revision.txt"), "utf8"), "implement");
  });
});

test("Real Git keeps a blocked module's rejected attempt reachable in history", async () => {
  await withModulePipeline(async f => {
    f.deps.git = await GitCliOps.open(f.options.outputDir);
    let starts = 0;
    f.deps.appLifecycle.start = async () => {
      if (++starts <= 2) throw new Error("broken build");
      return { baseUrl: f.options.platformContract.baseUrl, stop: async () => {} };
    };
    const summary = await f.run();
    assert.deepEqual(summary.blockedRequirementIds, ["A", "B", "C"]);
    assert.deepEqual(summary.implementedRequirementIds, []);
    const log = (await import("node:child_process")).execFileSync;
    const subjects = log("git", ["log", "--format=%s"], { cwd: f.options.outputDir }).toString();
    assert.match(subjects, /attempt/);
    const attemptSha = log("git", ["log", "--format=%H", "--grep=shallow: attempt", "-1"], { cwd: f.options.outputDir }).toString().trim();
    assert.match(log("git", ["show", `${attemptSha}:server.mjs`], { cwd: f.options.outputDir }).toString(), /createServer/);
    await assert.rejects(readFile(join(f.options.outputDir, "server.mjs"), "utf8"), /ENOENT/);
  });
});

test("ARC/log failures do not change checkpoints and private Judge data stays outside Builder input", async () => {
  await withModulePipeline(async f => {
    f.deps.logSink = { write() { throw new Error("sink failed"); } };
    f.deps.arcEvents = { runnerState: async () => { throw new Error("ARC unavailable"); },
      requirementState: async () => {}, commitHistorySignal: async () => {}, storeRequirementTree: async () => {} };
    const summary = await f.run();
    assert.equal(summary.status, "delivered");
    assert.doesNotMatch(JSON.stringify(f.builder.requests), /probePlan|locatorSnapshot|acceptedSha|phase budget/);
    assert.ok((await f.events()).some(item => item.type === "arc_projection_failed"));
  });
});

test("Folder nodes receive derived design/implement/test states for the platform requirement denominator", async () => {
  await withModulePipeline(async f => {
    const states: Array<{ id: string; phase: string; status: string }> = [];
    f.deps.arcEvents = {
      runnerState: async () => {},
      requirementState: async (id, phase, status) => { states.push({ id, phase, status }); },
      commitHistorySignal: async () => {},
      storeRequirementTree: async () => {},
    };
    const summary = await f.run();
    assert.equal(summary.status, "delivered");
    const sequence = (id: string) => states.filter(item => item.id === id).map(item => `${item.phase}:${item.status}`);
    assert.deepEqual(sequence("A"),
      ["design:running", "design:completed", "implement:running", "implement:completed", "test:passed"]);
    for (const folder of ["FIRST", "SECOND", "ROOT"]) {
      assert.deepEqual(sequence(folder),
        ["design:running", "design:completed", "implement:running", "implement:completed", "test:passed"], folder);
    }
  });
});

test("Folder rollup reflects blocked and failed descendants", async () => {
  await withModulePipeline(async f => {
    const states: Array<{ id: string; phase: string; status: string }> = [];
    f.deps.arcEvents = {
      runnerState: async () => {},
      requirementState: async (id, phase, status) => { states.push({ id, phase, status }); },
      commitHistorySignal: async () => {},
      storeRequirementTree: async () => {},
    };
    f.deps.builder = new FakeBuilder(["completed", "failed"]);
    f.deps.runner.run = async plan => plan.packetId === "packet-b" ? fail(plan) : pass(plan);
    const summary = await f.run();
    assert.equal(summary.status, "partial");
    const sequence = (id: string) => states.filter(item => item.id === id).map(item => `${item.phase}:${item.status}`);
    // FIRST: A implemented+verified, B implemented but failed audit -> implement completed, test failed.
    assert.deepEqual(sequence("FIRST"),
      ["design:running", "design:completed", "implement:running", "implement:completed", "test:failed"]);
    // SECOND: C uses B's runnable checkpoint and passes its own audit.
    assert.deepEqual(sequence("SECOND"),
      ["design:running", "design:completed", "implement:running", "implement:completed", "test:passed"]);
    // ROOT aggregates the whole tree; B's failed audit keeps its test failed.
    assert.deepEqual(sequence("ROOT"),
      ["design:running", "design:completed", "implement:running", "implement:completed", "test:failed"]);
  });
});
