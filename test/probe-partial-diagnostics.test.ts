import assert from "node:assert/strict";
import { test } from "node:test";
import { auditPacket } from "../src/judge/audit.js";
import { LlmProbePlanner } from "../src/judge/llm-probe-planner.js";
import { PlanCache } from "../src/judge/plan-cache.js";
import { assertCoverageAccountedFor, probeCoverageGaps } from "../src/judge/probe-coverage.js";
import type { ProbePlan } from "../src/judge/probe-schema.js";
import { parseProbePlan, PROBE_PLAN_JSON_SCHEMA } from "../src/judge/probe-schema.js";
import { RunStateStore } from "../src/run-state.js";
import type { WorkPacket } from "../src/types.js";
import { withModulePipeline, fail, pass } from "./helpers/module-pipeline.js";
import { withTempDir } from "./helpers/temp-dir.js";

function fixture(): { packet: WorkPacket; plan: ProbePlan } {
  const text = 'The page displays heading "Record" and its item count.';
  return {
    packet: { id: "partial", attempt: 1, requirementIds: ["A"], requirements: [{
      id: "A", name: "Record", text, declarationIndex: 0, folderPath: ["ROOT", "AREA"],
      dependencyIds: [], scenarios: [], references: [], exactUiStrings: ["Record"], seedDeclarations: [], ancestors: [],
      scenarioContracts: [{ id: "s", name: "Open", steps: [
        { keyword: "WHEN", content: "The visitor opens the page." }, { keyword: "THEN", content: text },
      ] }], product: { rootId: "ROOT", rootName: "Anonymous", kind: "generic_web", description: "", seedData: [], evolution: true },
    }] },
    plan: { packetId: "partial", cases: [{ id: "record", requirementIds: ["A"], purpose: "happy_path",
      expectationBasis: [text], steps: [{ op: "goto", path: "/" },
        { op: "expectVisible", locator: { by: "role", role: "heading", name: "Record", exact: true } },
        { op: "expectVisible", locator: { by: "role", role: "main" } }],
      outcomeChecks: [{ scenarioId: "s", stepIndex: 1, clauseIndex: 0, assertionIndexes: [1] },
        { scenarioId: "s", stepIndex: 1, clauseIndex: 1, assertionIndexes: [2] }],
    }] },
  };
}

test("a model's accounted but weak count evidence remains executable and cannot claim completeness", async () => {
  const { packet, plan } = fixture();
  let requests = 0;
  const planner = new LlmProbePlanner({ baseUrl: "https://gateway.invalid/v1", apiKey: "test", model: "fixture", timeoutMs: 5000 },
    async () => {
      const body = requests++ === 0 ? plan : { verdict: "sound", rationale: "fixture" };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) } }] }),
        { headers: { "Content-Type": "application/json" } });
    });
  const result = await planner.plan(packet);
  assert.equal(requests, 2, "one initial plan and its existing completeness review");
  assert.equal(result.coverageReview, "pending");
  assert.deepEqual(result.cases, plan.cases);
  assert.throws(() => assertCoverageAccountedFor(result, packet.requirements), /count-bearing/);
});

test("failed-form DOM inspection stays behind the controller firewall", async () => {
  const { packet, plan } = fixture();
  assert.ok(!JSON.stringify(PROBE_PLAN_JSON_SCHEMA).includes("expectFormContext"));
  const injected = structuredClone(plan);
  injected.cases[0].steps.push({ op: "expectFormContext", locator: { by: "label", text: "Tag" }, value: "stable-1" });
  const planner = new LlmProbePlanner({ baseUrl: "https://gateway.invalid/v1", apiKey: "test", model: "fixture", timeoutMs: 5000 },
    async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(injected) } }] }),
      { headers: { "Content-Type": "application/json" } }));
  await assert.rejects(planner.plan(packet), /ProbePlan/);
  await withTempDir("shallow-controller-only-", async directory => {
    await assert.rejects(new PlanCache(directory).write(packet.id, injected), /Controller-owned/);
  });
});

test("the private cache retains weak diagnostics while preserving strict declared roles", async () => {
  await withTempDir("shallow-partial-cache-", async directory => {
    const { packet, plan } = fixture();
    const cache = new PlanCache(directory);
    await cache.write(packet.id, { ...plan, coverageReview: "verified" });
    const cached = await cache.read(packet);
    assert.equal(cached?.coverageReview, "pending");
    assert.deepEqual(cached?.cases, plan.cases);
    assert.equal(probeCoverageGaps(cached!, packet.requirements).length, 1);
    packet.requirements[0].text += ' A navigation link named "Browse" opens the record.';
    const wrongRole = structuredClone(plan);
    wrongRole.cases[0].steps.push({ op: "click", locator: { by: "role", role: "button", name: "Browse", exact: true } },
      { op: "expectVisible", locator: { by: "role", role: "main" } });
    assert.throws(() => parseProbePlan(wrongRole, packet), /requirement-declared role: link/);
    await cache.write(packet.id, wrongRole);
    assert.equal(await cache.read(packet), undefined, "a declared navigation link cannot be changed into a button");
    const duplicate = structuredClone(plan);
    duplicate.uncoveredOutcomes = [{ scenarioId: "s", stepIndex: 1, clauseIndex: 1, reason: "already mapped" }];
    await cache.write(packet.id, duplicate);
    assert.equal(await cache.read(packet), undefined, "a coverage declaration cannot be simultaneously covered and omitted");
  });
});

test("detection executes a partial pending plan without any review call or verified result", async () => {
  await withModulePipeline(async f => {
    const { packet, plan } = fixture();
    let executions = 0;
    f.deps.runner.run = async input => { executions++; return pass(input); };
    f.deps.planner.reviewPlan = async () => { assert.fail("detection must not request a review"); };
    const state = new RunStateStore({ statusByRequirementId: { A: "todo" }, acceptedSha: "baseline", startedAtMs: 0, totalBudgetMs: 60_000 });
    const result = await auditPacket(packet, { ...plan, coverageReview: "pending" }, f.options, f.deps, state,
      () => 60_000, { refineLocators: false });
    assert.equal(executions, 1);
    assert.equal(result.status, "inconclusive");
    assert.equal(result.failureKind, "coverage");
    assert.deepEqual(result.report?.passedCases, ["record"]);
  });
});

test("a legitimate failure within a partial plan is independently reviewed and reproduced", async () => {
  await withModulePipeline(async f => {
    const { packet, plan } = fixture();
    let executions = 0;
    let reviews = 0;
    f.deps.runner.run = async input => { executions++; return fail(input); };
    f.deps.planner.reviewPlan = async () => { reviews++; return { status: "sound", rationale: "The declared Record heading is missing." }; };
    const state = new RunStateStore({ statusByRequirementId: { A: "todo" }, acceptedSha: "baseline", startedAtMs: 0, totalBudgetMs: 60_000 });
    const result = await auditPacket(packet, { ...plan, coverageReview: "pending" }, f.options, f.deps, state,
      () => 60_000, { refineLocators: true });
    assert.equal(reviews, 1);
    assert.equal(executions, 2);
    assert.equal(result.status, "failed");
  });
});
