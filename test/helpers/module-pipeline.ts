import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runPipeline, type PipelineDeps, type PipelineOptions } from "../../src/pipeline.js";
import type { ProbePlan } from "../../src/judge/probe-schema.js";
import type { RunEvent, ShadowReport, WorkPacket } from "../../src/types.js";
import { FakeBuilder } from "../fakes/fake-builder.js";
import { FakeGitOps } from "../fakes/fake-git-ops.js";
import { withTempDir } from "./temp-dir.js";
import { GatewayRecovery } from "../../src/gateway-recovery.js";

export function testPlan(packet: WorkPacket): ProbePlan {
  return { packetId: packet.id, cases: [{ id: `case-${packet.requirementIds[0]}`, requirementIds: packet.requirementIds,
    purpose: "happy_path", expectationBasis: [packet.requirements[0]?.text ?? "fixture"],
    steps: [{ op: "goto", path: "/" }, { op: "expectVisible", locator: { by: "role", role: "main" } }] }] };
}
export function pass(plan: ProbePlan): ShadowReport { return { packetId: plan.packetId, verdict: "pass", passedCases: plan.cases.map(item => item.id), failures: [] }; }
export function fail(plan: ProbePlan, category: "assertion" | "locator" | "runner" = "assertion"): ShadowReport {
  return { packetId: plan.packetId, verdict: category === "locator" ? "inconclusive" : "fail", passedCases: [],
    failures: [{ caseId: plan.cases[0].id, stepIndex: 1, category, message: "expected requirement behavior",
      ...(category === "locator" ? { locatorSnapshot: '- main "Workspace"' } : {}) }] };
}
export interface PipelineFixture {
  options: PipelineOptions; deps: PipelineDeps; builder: FakeBuilder; git: FakeGitOps;
  events(): Promise<RunEvent[]>; run(): ReturnType<typeof runPipeline>;
}
export async function withModulePipeline(callback: (fixture: PipelineFixture) => Promise<void>): Promise<void> {
  await withTempDir("shallow-module-pipeline-", async directory => {
    const atom = (id: string, dependencies: string[] = []) => ({ id, name: id, type: "ATOMIC", dependencies, description: "Display the main workspace." });
    const requirementsFile = join(directory, "requirements.yaml");
    await writeFile(requirementsFile, JSON.stringify({ id: "ROOT", name: "Product", type: "FOLDER", dependencies: [], children: [
      { id: "FIRST", name: "First", type: "FOLDER", dependencies: [], children: [atom("A"), atom("B", ["A"])] },
      { id: "SECOND", name: "Second", type: "FOLDER", dependencies: [], children: [atom("C", ["B"])] },
    ] }));
    const options: PipelineOptions = { requirementsFile, outputDir: join(directory, "output"), ledgerFile: join(directory, "logs", "ledger.jsonl"),
      totalBudgetMs: 60_000, plannerRetryDelayMs: 0, auditInheritedRequirements: true, platformContract: { port: 43210, baseUrl: "http://127.0.0.1:43210", evaluationPort: 3000,
        installCommands: [], buildCommands: [], startCommand: { executable: "node", args: ["server.mjs"], cwd: "output" }, healthPath: "/health", buildTimeoutMs: 5_000, startTimeoutMs: 5_000 } };
    const builder = new FakeBuilder();
    const git = new FakeGitOps(["initial", "first", "second", "repair-one", "repair-two"]);
    let gatewayTime = 0;
    const deps: PipelineDeps = { builder, git, clock: { nowMs: () => 0 },
      gatewayRecovery: new GatewayRecovery({ now: () => gatewayTime, sleep: async ms => { gatewayTime += ms; } }),
      planner: { plan: async packet => testPlan(packet), refineLocators: async original => original,
        reviewPlan: async () => ({ status: "sound" as const, rationale: "fixture review" }) },
      runner: { run: async plan => pass(plan) },
      appLifecycle: { start: async () => ({ baseUrl: options.platformContract.baseUrl, stop: async () => {} }) },
      finalVerifier: { verify: async () => ({ ok: true, stage: "complete", message: "fixture ready" }) } };
    await callback({ options, deps, builder, git,
      events: async () => (await readFile(options.ledgerFile, "utf8")).trim().split("\n").map(line => JSON.parse(line)),
      run: () => runPipeline(options, deps) });
  });
}
