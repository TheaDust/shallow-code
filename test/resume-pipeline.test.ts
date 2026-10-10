import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { fail, pass, testPlan, withModulePipeline } from "./helpers/module-pipeline.js";

test("Resume implements remaining requirements and independently rechecks restored dependencies", async () => {
  await withModulePipeline(async f => {
    f.options.resumedRequirementIds = ["A", "B"];
    const observed = new Set<string>();
    f.deps.runner.run = async plan => { plan.cases.flatMap(c => c.requirementIds).forEach(id => observed.add(id)); return pass(plan); };
    const summary = await f.run();
    assert.equal(summary.status, "delivered", JSON.stringify((await f.events()).filter(e => e.packetId === "packet-a")));
    assert.deepEqual(f.builder.requests.flatMap(r => "packet" in r ? r.packet.requirementIds : []), ["C"]);
    assert.deepEqual([...observed].sort(), ["A", "B", "C"]);
    assert.deepEqual(summary.verifiedRequirementIds.sort(), ["A", "B", "C"]);
    assert.equal((await f.events()).filter(e => e.type === "run_resumed").length, 1);
  });
});

test("Restored runnable implementations remain unverified when current browser evidence is inconclusive", async () => {
  await withModulePipeline(async f => {
    f.options.resumedRequirementIds = ["A", "B", "C"];
    f.deps.runner.run = async plan => fail(plan, "runner");
    const summary = await f.run();
    assert.equal(summary.status, "partial");
    assert.deepEqual(summary.verifiedRequirementIds, []);
    assert.equal(f.builder.requests.length, 0);
    assert.deepEqual(summary.implementedRequirementIds?.sort(), ["A", "B", "C"]);
  });
});

test("The delivery summary traces current scenario outcomes to executed cases", async () => {
  await withModulePipeline(async f => {
    const source = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    source.children[0].children[0].scenarios = [{ id: "S-A", name: "Visible workspace", steps: [{ keyword: "THEN", content: 'The heading "Workspace" is visible.' }] }];
    await writeFile(f.options.requirementsFile, JSON.stringify(source));
    f.options.resumedRequirementIds = ["A", "B", "C"];
    f.deps.planner.plan = async packet => {
      const plan = testPlan(packet);
      if (packet.requirementIds.includes("A")) {
        plan.cases[0].expectationBasis = ['The heading "Workspace" is visible.'];
        plan.cases[0].steps[1] = { op: "expectVisible", locator: { by: "role", role: "heading", name: "Workspace", exact: true } };
        plan.cases[0].outcomeChecks = [{ scenarioId: "S-A", stepIndex: 0, assertionIndexes: [1] }];
      }
      return plan;
    };
    const summary = await f.run();
    assert.equal(summary.status, "delivered", JSON.stringify((await f.events()).filter(e => e.packetId === "packet-a")));
    assert.deepEqual(summary.scenarioResults, [{ requirementId: "A", scenarioId: "S-A", name: "Visible workspace", status: "verified", caseIds: ["case-A"] }]);
  });
});

test("A declared browser entry reaches planning, plan validation and independent execution", async () => {
  await withModulePipeline(async f => {
    f.options.platformContract.browserPath = "/web#/home";
    f.options.resumedRequirementIds = ["A", "B", "C"];
    f.deps.planner.plan = async packet => {
      assert.equal(packet.browserEntry, "/web#/home");
      const plan = testPlan(packet);
      plan.cases[0].steps[0] = { op: "goto", path: packet.browserEntry! };
      return plan;
    };
    f.deps.runner.run = async (plan, options) => {
      assert.equal(options.browserPath, "/web#/home");
      assert.deepEqual(plan.cases[0].steps[0], { op: "goto", path: "/web#/home" });
      return pass(plan);
    };
    const summary = await f.run();
    assert.equal(summary.status, "delivered");
    assert.deepEqual(summary.verifiedRequirementIds, ["A", "B", "C"]);
  });
});
