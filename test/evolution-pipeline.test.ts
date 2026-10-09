import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { compileBuilderPrompt } from "../src/builder/prompt.js";
import { ArcEventSink } from "../src/arc-protocol.js";
import { loadRequirementCatalog } from "../src/catalog.js";
import { HumanRunFormatter } from "../src/human-log.js";
import { PlanCache } from "../src/judge/plan-cache.js";
import { ProgressJournal } from "../src/progress-journal.js";
import { auditPackets } from "../src/scheduler.js";
import { fail, pass, testPlan, withModulePipeline, type PipelineFixture } from "./helpers/module-pipeline.js";

const modified = "Original Feature Description\n\nDisplay the original workspace.\n\nModified Feature Description\n\nDisplay the updated workspace.";

async function writeHistory(f: PipelineFixture, ids: string[]): Promise<PlanCache> {
  f.options.stageStartingPoint = "inherited_application";
  f.options.progressDir = join(f.options.outputDir, "shallow-progress");
  const cache = new PlanCache(join(dirname(f.options.outputDir), "previous-run"), join(f.options.progressDir, "plans"));
  const catalog = await loadRequirementCatalog(f.options.requirementsFile);
  for (const packet of auditPackets(catalog).filter(item => ids.includes(item.requirementIds[0]))) {
    const plan = testPlan(packet);
    plan.cases[0].id = `historical-${packet.requirementIds[0]}`;
    plan.coverageReview = "verified";
    await cache.write(packet.id, plan);
  }
  return cache;
}

function appendCheckpoint(journal: ProgressJournal, requirementIds: string[]): void {
  const line = new HumanRunFormatter().format(JSON.stringify({ at: "2026-10-07T00:00:00Z", type: "checkpoint_saved",
    sequence: 22, acceptedSha: "a".repeat(40), detail: { requirementIds, reason: "feature-history" } }));
  assert.ok(line);
  journal.appendLine(line);
}

test("Checkpoint-only inherited IDs respect the audit switch and startup freeze while explicit changes remain targets", async () => {
  for (const auditInheritedRequirements of [false, true]) {
    await withModulePipeline(async f => {
      const source = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
      source.children[0].children[0].description = modified;
      await writeFile(f.options.requirementsFile, JSON.stringify(source));
      const historical = await writeHistory(f, ["A"]);
      const journal = new ProgressJournal(f.options.outputDir);
      appendCheckpoint(journal, ["A", "B", "REMOVED"]);
      f.options.auditInheritedRequirements = auditInheritedRequirements;
      let appendedCurrent = false;
      const formatter = new HumanRunFormatter();
      f.deps.logSink = { write: chunk => {
        // Even the first current event must happen after both historical sources are frozen.
        if (!appendedCurrent) { appendCheckpoint(journal, ["C"]); appendedCurrent = true; }
        const line = formatter.format(chunk);
        if (line) journal.appendLine(line);
      } };
      f.deps.grouper = { group: async catalog => {
        assert.deepEqual(catalog.requirements.map(item => item.id), ["A", "C"]);
        const current = await loadRequirementCatalog(f.options.requirementsFile);
        const packet = auditPackets(current).find(item => item.requirementIds[0] === "C")!;
        await historical.write(packet.id, testPlan(packet));
        return { groups: [{ requirementIds: ["A"], purpose: "Update workspace" }, { requirementIds: ["C"], purpose: "New workspace" }] };
      } };
      const planned = new Set<string>();
      f.deps.planner.plan = async packet => { packet.requirementIds.forEach(id => planned.add(id)); return testPlan(packet); };
      const result = await f.run();
      assert.equal(result.status, "delivered");
      assert.deepEqual(f.builder.requests.flatMap(request => "packet" in request ? request.packet.requirementIds : []), ["A", "C"]);
      assert.deepEqual([...planned].sort(), auditInheritedRequirements ? ["A", "B", "C"] : ["A", "C"]);
      assert.deepEqual(result.verifiedRequirementIds.sort(), [...planned].sort());
      assert.deepEqual(result.skippedRequirementIds ?? [], auditInheritedRequirements ? [] : ["B"]);
      const scope = (await f.events()).find(event => event.type === "evolution_scope_selected")!;
      assert.equal(scope.detail?.historicalPlans, 1);
      assert.equal(scope.detail?.historicalPlanRequirementCount, 1);
      assert.equal(scope.detail?.historicalCheckpointRequirementCount, 3);
      assert.equal(scope.detail?.historicalCheckpointSupplementCount, 2);
      assert.equal(scope.detail?.historicalRequirementCount, 3);
      assert.deepEqual(scope.detail?.changedRequirementIds, ["A"]);
      assert.deepEqual(scope.detail?.addedRequirementIds, ["C"]);
      assert.deepEqual(scope.detail?.inheritedRequirementIds, ["B"]);
    });
  }
});

test("Only the new atomic reaches initial Builder; both inherited atomics are freshly audited", async () => {
  await withModulePipeline(async f => {
    const source = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    source.children[0].children[0].description = "Inherited contract A must not appear in initial Builder.";
    source.children[0].children[1].description = "Inherited contract B must not appear in initial Builder.";
    source.children[1].children[0].description = "Display the new workspace.";
    await writeFile(f.options.requirementsFile, JSON.stringify(source));
    const historical = await writeHistory(f, ["A", "B"]);
    const planned: string[] = [];
    const executed: string[] = [];
    f.deps.grouper = { group: async catalog => {
      assert.deepEqual(catalog.requirements.map(item => item.id), ["C"]);
      assert.deepEqual(catalog.requirements[0].dependencyIds, []);
      // A later write to the product mirror must not change the startup ID snapshot.
      const current = await loadRequirementCatalog(f.options.requirementsFile);
      const packet = auditPackets(current).find(item => item.requirementIds[0] === "C")!;
      await historical.write(packet.id, testPlan(packet));
      return { groups: [{ requirementIds: ["C"], purpose: "New workspace" }] };
    } };
    f.deps.planner.plan = async packet => { planned.push(...packet.requirementIds); return testPlan(packet); };
    f.deps.runner.run = async plan => { executed.push(...plan.cases.map(item => item.id)); return pass(plan); };
    const result = await f.run();
    assert.equal(result.status, "delivered");
    assert.deepEqual(result.verifiedRequirementIds, ["A", "B", "C"]);
    assert.deepEqual(planned.sort(), ["A", "B", "C"]);
    assert.ok(executed.every(id => !id.startsWith("historical-")));
    assert.equal(f.builder.requests.length, 1);
    const request = f.builder.requests[0];
    assert.ok(request.mode === "implement");
    assert.deepEqual(request.packet.requirementIds, ["C"]);
    assert.deepEqual(request.packet.requirements[0].dependencyIds, ["B"]);
    assert.deepEqual(request.projectContext.satisfiedDependencies, [{ id: "B", name: "B" }]);
    const prompt = compileBuilderPrompt(request).taskPrompt;
    assert.doesNotMatch(prompt, /Inherited contract/);
    assert.match(prompt, /筛选初次实现范围/);
    assert.match(prompt, /Display the new workspace/);
    const events = await f.events();
    const scope = events.find(event => event.type === "evolution_scope_selected");
    assert.deepEqual(scope?.detail?.inheritedRequirementIds, ["A", "B"]);
    assert.equal(events.filter(event => event.type === "module_boundary_audit_finished").length, 2);
    assert.ok(events.some(event => event.type === "dependency_gate_provisional" && event.detail?.dependencyIds.includes("B")));
  });
});

test("Pending changes remain ordered through inherited dependencies and Builder receives original contracts", async () => {
  await withModulePipeline(async f => {
    const source = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    source.children[0].children[0].description = modified;
    await writeFile(f.options.requirementsFile, JSON.stringify(source));
    await writeHistory(f, ["A", "B"]);
    let groupingCalls = 0;
    const planned: string[] = [];
    f.deps.grouper = { group: async catalog => {
      assert.deepEqual(catalog.requirements.map(item => [item.id, item.dependencyIds]), [["A", []], ["C", ["A"]]]);
      return { groups: (++groupingCalls === 1 ? [["C"], ["A"]] : [["A"], ["C"]])
        .map(requirementIds => ({ requirementIds, purpose: "Ordered change" })) };
    } };
    f.deps.planner.plan = async packet => {
      if (packet.requirementIds[0] === "C") {
        assert.ok(f.builder.requests.some(request => request.mode === "implement" && request.packet.requirementIds.includes("A")));
        assert.deepEqual(packet.prerequisites?.map(item => item.id), ["A", "B"]);
      }
      planned.push(...packet.requirementIds);
      return testPlan(packet);
    };
    const result = await f.run();
    assert.equal(groupingCalls, 2);
    assert.equal(result.status, "delivered");
    assert.deepEqual(planned.sort(), ["A", "B", "C"]);
    assert.deepEqual(f.builder.requests.map(request => "packet" in request ? request.packet.requirementIds : []), [["A"], ["C"]]);
    const changed = f.builder.requests[0];
    assert.ok(changed.mode === "implement");
    assert.equal(changed.packet.requirements[0].text, modified);
    assert.match(compileBuilderPrompt(changed).taskPrompt, /Original Feature Description[\s\S]*Modified Feature Description/);
    const next = f.builder.requests[1];
    assert.ok(next.mode === "implement");
    assert.deepEqual(next.packet.requirements[0].dependencyIds, ["B"]);
    assert.equal((await f.events()).filter(event => event.type === "dependency_gate_blocked").length, 0);
  });
});

test("An entirely inherited application has no initial Builder or grouping call but audits every module", async () => {
  await withModulePipeline(async f => {
    await writeHistory(f, ["A", "B", "C"]);
    f.deps.grouper = { group: async () => { throw new Error("should not group an empty implementation scope"); } };
    const planned: string[] = [];
    f.deps.planner.plan = async packet => { planned.push(...packet.requirementIds); return testPlan(packet); };
    const result = await f.run();
    assert.equal(result.status, "delivered");
    assert.equal(f.builder.requests.length, 0);
    assert.deepEqual(planned.sort(), ["A", "B", "C"]);
    const events = await f.events();
    assert.equal(events.filter(event => event.type === "module_boundary_audit_finished").length, 2);
    const accepted = events.find(event => event.type === "checkpoint_saved" && event.detail?.reason === "inherited application");
    assert.ok(accepted?.type === "checkpoint_saved");
    assert.deepEqual(accepted?.detail?.requirementIds, ["A", "B", "C"]);
    assert.equal(events.filter(event => event.type === "audit_result").length, 3);
  });
});

test("An inherited failure gets a local repair instead of being promoted from historical metadata", async () => {
  await withModulePipeline(async f => {
    await writeHistory(f, ["A", "B", "C"]);
    let repaired = false;
    const originalRun = f.builder.run.bind(f.builder);
    f.deps.builder = { close: () => f.builder.close(), run: async (request, options) => {
      assert.equal(request.mode, "repair");
      if (request.mode !== "repair") throw new Error("expected a repair");
      assert.deepEqual(request.packet.requirementIds, ["A"]);
      repaired = true;
      return originalRun(request, options);
    } };
    f.deps.runner.run = async plan => !repaired && plan.cases[0].requirementIds.includes("A") ? fail(plan) : pass(plan);
    const result = await f.run();
    assert.equal(result.status, "delivered");
    assert.equal(f.builder.requests.length, 1);
    assert.deepEqual(result.verifiedRequirementIds, ["A", "B", "C"]);
    assert.ok((await f.events()).some(event => event.type === "repair_batch_finished" && event.detail?.retained));
  });
});

test("An unrunnable inherited application goes through full initial implementation", async () => {
  await withModulePipeline(async f => {
    await writeHistory(f, ["A", "B", "C"]);
    let starts = 0;
    f.deps.appLifecycle.start = async () => {
      if (++starts === 1) throw new Error("injected build is broken");
      return { baseUrl: f.options.platformContract.baseUrl, stop: async () => {} };
    };
    const result = await f.run();
    assert.equal(result.status, "delivered");
    assert.deepEqual(f.builder.requests.flatMap(request => "packet" in request ? request.packet.requirementIds : []), ["A", "B", "C"]);
    const scope = (await f.events()).find(event => event.type === "evolution_scope_selected");
    assert.deepEqual(scope?.detail?.inheritedRequirementIds, []);
    assert.match(scope?.detail?.reason ?? "", /恢复全量实现/);
  });
});

test("Inherited audits wait for later-module changes and retain a boundary repair opportunity", async () => {
  await withModulePipeline(async f => {
    await writeFile(f.options.requirementsFile, JSON.stringify({ id: "ROOT", name: "Product", type: "FOLDER", children: [
      { id: "FIRST", name: "First", type: "FOLDER", children: [
        { id: "NEW", name: "New", type: "ATOMIC", description: "Display the new workspace." },
        { id: "OLD", name: "Old", type: "ATOMIC", dependencies: ["CHANGED"], description: "Display the inherited workspace." },
      ] },
      { id: "SECOND", name: "Second", type: "FOLDER", children: [
        { id: "CHANGED", name: "Changed", type: "ATOMIC", description: modified },
      ] },
    ] }));
    await writeHistory(f, ["OLD", "CHANGED"]);
    let repaired = false;
    const originalRun = f.builder.run.bind(f.builder);
    f.deps.builder = { close: () => f.builder.close(), run: async (request, options) => {
      if (request.mode === "repair") {
        assert.deepEqual(request.packet.requirementIds, ["OLD"]);
        repaired = true;
      }
      return originalRun(request, options);
    } };
    f.deps.planner.plan = async packet => {
      if (packet.requirementIds[0] === "OLD") assert.ok(f.builder.requests.some(request =>
        request.mode === "implement" && request.packet.requirementIds.includes("CHANGED")));
      return testPlan(packet);
    };
    f.deps.runner.run = async plan => !repaired && plan.cases[0].requirementIds.includes("OLD") ? fail(plan) : pass(plan);
    const result = await f.run();
    assert.equal(result.status, "delivered");
    assert.deepEqual(f.builder.requests.map(request => "packet" in request ? [request.mode, request.packet.requirementIds] : []),
      [["implement", ["NEW"]], ["implement", ["CHANGED"]], ["repair", ["OLD"]]]);
  });
});

test("A failed pending change blocks downstream inherited audits and Builder work", async () => {
  await withModulePipeline(async f => {
    const source = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    source.children[0].children[0].description = modified;
    await writeFile(f.options.requirementsFile, JSON.stringify(source));
    await writeHistory(f, ["A", "B"]);
    f.git.applicationChanged = false;
    const originalRun = f.builder.run.bind(f.builder);
    f.deps.builder = { close: () => f.builder.close(), run: async (request, options) => ({
      ...await originalRun(request, options), outcome: "failed", summary: "No completed change",
    }) };
    const planned: string[] = [];
    f.deps.planner.plan = async packet => { planned.push(...packet.requirementIds); return testPlan(packet); };
    const result = await f.run();
    assert.equal(result.status, "partial");
    assert.deepEqual(result.blockedRequirementIds, ["A", "B", "C"]);
    assert.deepEqual(result.verifiedRequirementIds, []);
    assert.deepEqual(planned, ["A"]);
    assert.deepEqual(f.builder.requests.map(request => "packet" in request ? request.packet.requirementIds : []), [["A"]]);
  });
});

test("Deferred inherited repairs protect every verified case in their own module", async () => {
  await withModulePipeline(async f => {
    await writeFile(f.options.requirementsFile, JSON.stringify({ id: "ROOT", name: "Product", type: "FOLDER", children: [
      { id: "FIRST", name: "First", type: "FOLDER", children: [
        { id: "NEW", name: "New", type: "ATOMIC", description: "Display the new workspace and reject invalid input with an alert." },
        { id: "OLD", name: "Old", type: "ATOMIC", dependencies: ["CHANGED"], description: "Display the inherited workspace." },
      ] },
      { id: "SECOND", name: "Second", type: "FOLDER", children: [
        { id: "CHANGED", name: "Changed", type: "ATOMIC", description: modified },
      ] },
    ] }));
    await writeHistory(f, ["OLD", "CHANGED"]);
    f.deps.planner.plan = async packet => {
      const plan = testPlan(packet);
      if (packet.requirementIds[0] === "NEW") plan.cases.push({ ...plan.cases[0], id: "new-negative", purpose: "negative",
        steps: [{ op: "goto", path: "/" }, { op: "expectVisible", locator: { by: "role", role: "alert" } }] });
      return plan;
    };
    f.deps.runner.run = async plan => {
      const repaired = f.builder.requests.some(request => request.mode === "repair") && f.git.restoredShas.length === 0;
      if (!repaired && plan.cases[0].requirementIds.includes("OLD")) return fail(plan);
      const negative = plan.cases.find(item => item.id === "new-negative");
      if (repaired && negative) return { packetId: plan.packetId, verdict: "fail", passedCases: plan.cases.filter(item => item !== negative).map(item => item.id),
        failures: [{ caseId: negative.id, stepIndex: 1, category: "assertion", message: "Previously verified validation regressed" }] };
      return pass(plan);
    };
    const result = await f.run();
    assert.equal(f.git.restoredShas.length, 1);
    assert.deepEqual(result.verifiedRequirementIds, ["NEW", "CHANGED"]);
    assert.deepEqual(result.failedRequirementIds, ["OLD"]);
    assert.ok((await f.events()).some(event => event.type === "repair_batch_finished" && event.detail?.retained === false));
  });
});

test("A repair that regresses another freshly verified inherited atomic is restored", async () => {
  await withModulePipeline(async f => {
    await writeHistory(f, ["A", "B", "C"]);
    f.deps.runner.run = async plan => {
      const changed = f.builder.requests.length > 0 && f.git.restoredShas.length === 0;
      if ((plan.cases[0].requirementIds.includes("A") && !changed) ||
        (plan.cases[0].requirementIds.includes("B") && changed)) return fail(plan);
      return pass(plan);
    };
    const result = await f.run();
    assert.equal(result.status, "partial");
    assert.deepEqual(result.failedRequirementIds, ["A"]);
    assert.deepEqual(result.verifiedRequirementIds, ["B", "C"]);
    assert.equal(f.git.restoredShas.length, 1);
    assert.ok((await f.events()).some(event => event.type === "repair_batch_finished" && event.detail?.retained === false));
  });
});

test("Both real final trees keep the complete Judge scope while initial Builder sees ten atomics", async () => {
  for (const [product, total] of [["github", 52], ["sheet", 10]] as const) {
    await withModulePipeline(async f => {
      const previous = await loadRequirementCatalog(`data/official-competition/hackathon--${product}/requirements.yaml`);
      f.options.requirementsFile = `data/final/hackathon-evolution--${product}/requirements.yaml`;
      await writeHistory(f, previous.requirements.map(item => item.id));
      const planned = new Set<string>();
      f.deps.planner.plan = async packet => {
        packet.requirementIds.forEach(id => planned.add(id));
        throw new Error("Offline scope test has no model-generated probes");
      };
      f.deps.runner.run = async () => { throw new Error("An offline planning failure must not run a probe"); };
      const result = await f.run();
      const requests = f.builder.requests.filter(request => request.mode === "implement");
      assert.equal(requests.flatMap(request => request.packet.requirementIds).length, 10);
      assert.equal(new Set(requests.flatMap(request => request.packet.requirementIds)).size, 10);
      for (const request of requests) assert.doesNotMatch(compileBuilderPrompt(request).taskPrompt, /\{\{[A-Z_]+\}\}/);
      assert.equal(planned.size, total);
      assert.equal(result.implementedRequirementIds?.length, total);
      assert.equal(result.verifiedRequirementIds.length, 0);
      assert.equal(result.status, "partial");
    });
  }
});

test("Historical plans do not filter blank, unknown or ordinary progressive-stage implementation", async () => {
  for (const mode of ["blank_template", "unknown", "progressive"] as const) {
    await withModulePipeline(async f => {
      await writeHistory(f, ["A", "B", "C"]);
      appendCheckpoint(new ProgressJournal(f.options.outputDir), ["A", "B", "C"]);
      if (mode === "progressive") {
        const source = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
        source.name = "Product — Stage 2";
        await writeFile(f.options.requirementsFile, JSON.stringify(source));
      } else f.options.stageStartingPoint = mode;
      const result = await f.run();
      assert.equal(result.status, "delivered");
      assert.deepEqual(f.builder.requests.flatMap(request => "packet" in request ? request.packet.requirementIds : []), ["A", "B", "C"]);
      assert.ok(!(await f.events()).some(event => event.type === "evolution_scope_selected"));
    });
  }
});

test("Competition mode audits only changed and new targets, preserving full prerequisite evidence and truthful ARC states", async () => {
  await withModulePipeline(async f => {
    const source = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    source.children[0].children[0].description = modified;
    await writeFile(f.options.requirementsFile, JSON.stringify(source));
    await writeHistory(f, ["A", "B"]);
    delete f.options.auditInheritedRequirements;
    const arc = new ArcEventSink(f.options.outputDir);
    await arc.init();
    f.deps.arcEvents = arc;
    const planned: string[] = [];
    const executed: string[] = [];
    f.deps.planner.plan = async packet => {
      planned.push(...packet.requirementIds);
      assert.ok(!packet.requirementIds.includes("B"));
      if (packet.requirementIds[0] === "C") {
        assert.deepEqual(packet.prerequisites?.map(item => item.id), ["A", "B"]);
        assert.equal(packet.prerequisites?.find(item => item.id === "B")?.text, source.children[0].children[1].description);
      }
      return testPlan(packet);
    };
    f.deps.runner.run = async plan => {
      executed.push(...plan.cases.flatMap(item => item.requirementIds));
      assert.ok(plan.cases.every(item => !item.requirementIds.includes("B")));
      return pass(plan);
    };
    const result = await f.run();
    assert.equal(result.status, "delivered");
    assert.deepEqual(result.auditRequirementIds, ["A", "C"]);
    assert.deepEqual(result.skippedRequirementIds, ["B"]);
    assert.deepEqual(result.implementedRequirementIds, ["A", "C"]);
    assert.deepEqual(result.verifiedRequirementIds, ["A", "C"]);
    assert.deepEqual(result.pendingRequirementIds, []);
    assert.deepEqual(planned.sort(), ["A", "C"]);
    assert.ok(executed.includes("A") && executed.includes("C"));
    for (const request of f.builder.requests) {
      assert.ok(request.mode === "implement");
      const prompt = compileBuilderPrompt(request).taskPrompt;
      assert.match(prompt, /本轮模块边界验收和最终交付只覆盖新增/);
      assert.doesNotMatch(prompt, /本轮模块边界验收和最终交付覆盖当前需求树，包括沿用项/);
    }
    const requirements = JSON.parse(await readFile(join(f.options.outputDir, ".arc", "traceability", "requirements.json"), "utf8"));
    assert.equal(requirements.B.description, source.children[0].children[1].description);
    const arcEvents = (await readFile(join(f.options.outputDir, ".arc", "runner-events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.ok(!arcEvents.some(event => event.type === "requirement_state" && event.node_id === "B" && event.phase === "test"));
    assert.ok(!arcEvents.some(event => event.type === "requirement_state" && ["FIRST", "ROOT"].includes(event.node_id) && event.phase === "test"));
    assert.ok(arcEvents.some(event => event.type === "requirement_state" && event.node_id === "SECOND" && event.phase === "test" && event.status === "passed"));
    const finished = (await f.events()).find(event => event.type === "pipeline_finished");
    assert.deepEqual(finished?.detail?.skippedRequirementIds, ["B"]);
    assert.deepEqual(finished?.detail?.pendingRequirementIds, []);
  });
});

test("Competition mode creates no audit or repair for a purely inherited application", async () => {
  await withModulePipeline(async f => {
    await writeHistory(f, ["A", "B", "C"]);
    f.options.auditInheritedRequirements = false;
    f.deps.planner.plan = async () => { throw new Error("No inherited target may be planned"); };
    f.deps.runner.run = async () => { throw new Error("No inherited target may be executed"); };
    let verifiedRuntime = false;
    f.deps.finalVerifier.verify = async () => { verifiedRuntime = true; return { ok: true, stage: "complete", message: "Runtime still checked" }; };
    const result = await f.run();
    assert.equal(result.status, "delivered");
    assert.equal(verifiedRuntime, true);
    assert.equal(f.builder.requests.length, 0);
    assert.deepEqual(result.auditRequirementIds, []);
    assert.deepEqual(result.verifiedRequirementIds, []);
    assert.deepEqual(result.implementedRequirementIds, []);
    assert.deepEqual(result.skippedRequirementIds, ["A", "B", "C"]);
    assert.deepEqual(result.pendingRequirementIds, []);
    const events = await f.events();
    assert.ok(!events.some(event => event.type === "module_boundary_audit_finished" || event.type === "probe_planning" || event.type === "repair_batch_started"));
  });
});

test("Competition mode cannot deliver a failed current requirement by excluding inherited targets", async () => {
  await withModulePipeline(async f => {
    await writeHistory(f, ["A", "B"]);
    f.options.auditInheritedRequirements = false;
    f.deps.runner.run = async plan => { assert.deepEqual(plan.cases[0].requirementIds, ["C"]); return fail(plan); };
    const result = await f.run();
    assert.equal(result.status, "partial");
    assert.deepEqual(result.failedRequirementIds, ["C"]);
    assert.deepEqual(result.verifiedRequirementIds, []);
    assert.deepEqual(result.skippedRequirementIds, ["A", "B"]);
    assert.ok(f.builder.requests.every(request => "packet" in request && request.packet.requirementIds.every(id => id === "C")));
  });
});

test("Competition mode revalidates only the selected requirements after a delivery repair", async () => {
  await withModulePipeline(async f => {
    await writeHistory(f, ["A", "B"]);
    f.options.auditInheritedRequirements = false;
    let runtimeChecks = 0;
    f.deps.finalVerifier.verify = async () => ++runtimeChecks === 1
      ? { ok: false, stage: "build", message: "Runtime needs repair" }
      : { ok: true, stage: "complete", message: "Runtime repaired" };
    let planned = 0;
    let executions = 0;
    f.deps.planner.plan = async packet => { assert.deepEqual(packet.requirementIds, ["C"]); planned++; return testPlan(packet); };
    f.deps.runner.run = async plan => { assert.deepEqual(plan.cases[0].requirementIds, ["C"]); executions++; return pass(plan); };
    const result = await f.run();
    assert.equal(result.status, "delivered");
    assert.equal(planned, 1);
    assert.equal(executions, 3);
    assert.deepEqual(f.builder.requests.map(request => request.mode), ["implement", "delivery_repair"]);
    assert.deepEqual(result.verifiedRequirementIds, ["C"]);
    assert.deepEqual(result.skippedRequirementIds, ["A", "B"]);
  });
});

test("Competition mode without historical identity still develops and audits the whole selected tree", async () => {
  await withModulePipeline(async f => {
    f.options.stageStartingPoint = "inherited_application";
    f.options.auditInheritedRequirements = false;
    const planned: string[] = [];
    f.deps.planner.plan = async packet => { planned.push(...packet.requirementIds); return testPlan(packet); };
    const result = await f.run();
    assert.equal(result.status, "delivered");
    assert.deepEqual(planned.sort(), ["A", "B", "C"]);
    assert.deepEqual(result.verifiedRequirementIds, ["A", "B", "C"]);
    assert.equal(result.skippedRequirementIds, undefined);
  });
});

test("The competition audit scope stays selective when an unrunnable baseline requires full implementation", async () => {
  await withModulePipeline(async f => {
    await writeHistory(f, ["A", "B"]);
    f.options.auditInheritedRequirements = false;
    let starts = 0;
    f.deps.appLifecycle.start = async () => {
      if (++starts === 1) throw new Error("Injected build needs repair");
      return { baseUrl: f.options.platformContract.baseUrl, stop: async () => {} };
    };
    const planned: string[] = [];
    f.deps.planner.plan = async packet => { planned.push(...packet.requirementIds); return testPlan(packet); };
    const result = await f.run();
    assert.equal(result.status, "delivered");
    assert.deepEqual(planned, ["C"]);
    assert.deepEqual(result.verifiedRequirementIds, ["C"]);
    assert.deepEqual(result.auditRequirementIds, ["C"]);
    assert.deepEqual(result.skippedRequirementIds, ["A", "B"]);
    assert.deepEqual(result.implementedRequirementIds, ["C"]);
  });
});

test("Both real final trees reduce Planner targets to ten atomics in competition mode", async () => {
  for (const product of ["github", "sheet"] as const) {
    await withModulePipeline(async f => {
      const previous = await loadRequirementCatalog(`data/official-competition/hackathon--${product}/requirements.yaml`);
      f.options.requirementsFile = `data/final/hackathon-evolution--${product}/requirements.yaml`;
      await writeHistory(f, previous.requirements.map(item => item.id));
      f.options.auditInheritedRequirements = false;
      const planned = new Set<string>();
      f.deps.planner.plan = async packet => { packet.requirementIds.forEach(id => planned.add(id)); throw new Error("Offline scope check"); };
      const result = await f.run();
      assert.equal(planned.size, 10);
      assert.equal(result.implementedRequirementIds?.length, 10);
      assert.equal(result.verifiedRequirementIds.length, 0);
      assert.equal(result.inconclusiveRequirementIds?.length, 10);
      assert.equal(result.missingPlanRequirementIds?.length, 10);
      assert.equal(result.status, "partial");
      if (product === "github") {
        assert.equal(result.skippedRequirementIds?.length, 42);
        assert.equal(result.auditRequirementIds?.length, 10);
      }
    });
  }
});
