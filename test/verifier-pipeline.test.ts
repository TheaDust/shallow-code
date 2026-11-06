import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { ArtifactStore, contentDigest } from "../src/verifier/artifacts.js";
import { VerifierCheckpoints, readVerifierCheckpoint } from "../src/verifier/checkpoints.js";
import type { AdapterDeclaration, CheckJob, CheckOutcome, CheckReport, ExecutionBindingRef } from "../src/verifier/port.js";
import { SnapshotStore } from "../src/snapshot-store.js";
import { VerifierCoordinator, type VerifierRuntime } from "../src/verifier-pipeline.js";
import { makePacket } from "../src/scheduler.js";
import { parseVerifierConfig } from "../src/runtime-config.js";
import { writeRunReport } from "../src/run-record.js";
import { HumanRunFormatter } from "../src/human-log.js";
import { BuildView } from "../src/terminal/build-tui.js";
import { terminalTheme } from "../src/terminal/theme.js";
import { withModulePipeline, type PipelineFixture } from "./helpers/module-pipeline.js";
import { verifierSourceClauses, type VerifierRequirements } from "../src/verifier/evidence.js";
import { loadRequirementCatalog } from "../src/catalog.js";
import { readImplementationDigests, requirementDigest } from "../src/requirement-progress.js";
import type { RunEvent } from "../src/types.js";
import { createWebExecutionAdapter } from "../src/verifier/adapters/web/index.js";

async function attach(f: PipelineFixture, hook?: (job: CheckJob, signal: AbortSignal) => Promise<void>,
  status?: (job: CheckJob) => Promise<CheckOutcome["status"]>): Promise<VerifierRuntime> {
  const directory = join(dirname(f.options.ledgerFile), "verifier");
  const artifacts = new ArtifactStore(directory, "test-run");
  const snapshots = new SnapshotStore(join(directory, "snapshots"));
  const schema = await artifacts.putJson({});
  const input = await artifacts.putTypedJson({}, schema);
  const executor = { id: "fake", version: "1", digest: "release" };
  const declaration: AdapterDeclaration = { schemaVersion: 1, id: "fake", version: "1", implementation: executor,
    execution: input, initialStates: [input], resourceKeys: [], capabilities: [],
    programFormat: { id: "fake", version: "1", mediaType: "application/json", schema }, observations: [], attachments: [], prompts: [] };
  const binding: ExecutionBindingRef = { ...await artifacts.putJson({ schemaVersion: 1, declaration: await artifacts.putJson(declaration),
    executor, schemas: [schema], dependencies: {}, promptDigest: contentDigest([]) }), executor };
  let instance = 0;
  const readiness = async (job: CheckJob) => {
    const environment = await artifacts.putTypedJson({ instance: ++instance }, schema);
    return artifacts.putReceipt(job, { id: `receipt-${instance}`, job: await artifacts.putJson(job),
      snapshot: job.snapshot, binding, environment, sequence: 0, recordedAt: new Date().toISOString(),
      kind: "readiness", readiness: { result: "ready" }, inputs: [], payload: input, attachments: [] });
  };
  const runtime: VerifierRuntime = { directory, artifacts, snapshots, binding, initialState: input, resourceKeys: [],
    async verifyDelivery(job) { return { report: { ok: true, stage: "complete", message: "Fake execution readiness" }, receipts: [await readiness(job)] }; },
    verifier: { async check(job, signal, onProgress): Promise<CheckReport> {
      await onProgress?.({ stage: "prepare" });
      await hook?.(job, signal);
      if (job.mode !== "prepare") await onProgress?.({ stage: "replay" });
      const ready = await readiness(job);
      const input = await artifacts.getJson<VerifierRequirements>(job.requirements);
      const sources = verifierSourceClauses(input, job.requirementIds).filter(source => !job.clauseIds || job.clauseIds.includes(source.id));
      return { job: await artifacts.putJson(job), snapshot: job.snapshot, binding, manifest: await artifacts.putJson({ receipts: [ready] }), programs: [],
        outcomes: job.mode === "prepare" ? [] : await Promise.all(sources.map(async source => ({ requirementId: source.requirementId,
          scenarioId: source.scenarioId, clauseId: source.id, status: await status?.(job) ?? "pass", evidence: [ready] }))) };

    } } };
  f.options.verifier = { mode: "active", concurrency: 2, semanticReview: true, replay: true };
  f.deps.verifier = runtime;
  f.deps.grouper = { async group(catalog) { return { groups: catalog.requirements.map(item => ({ requirementIds: [item.id], purpose: "Separate groups" })) }; } };
  return runtime;
}

test("Only the last pending implementation packet is marked for self-test finalization", async () => {
  await withModulePipeline(async f => {
    await attach(f);
    await f.run();
    const requests = f.builder.requests.filter(request => request.mode === "implement");
    assert.ok(requests.length >= 2);
    assert.ok(requests.slice(0, -1).every(request => request.finalImplementation === false));
    assert.equal(requests.at(-1)!.finalImplementation, true);
  });
});

test("Fresh builds continue interrupted or completed work in place and reimplement changed requirements", async () => {
  for (const interrupted of [true, false]) await withModulePipeline(async f => {
    await attach(f);
    f.options.verifier.replay = false;
    f.options.progressDir = join(f.options.outputDir, "shallow-progress");
    const catalog = await loadRequirementCatalog(f.options.requirementsFile);
    f.options.requirementDigests = Object.fromEntries(catalog.requirements.map(r => [r.id, requirementDigest(r)]));
    const runBuilder = f.builder.run.bind(f.builder);
    f.deps.builder = { close: () => f.builder.close(), async run(request, options) {
      if (interrupted && request.mode === "implement" && request.packet.requirementIds.includes("C")) throw new Error("manual interruption");
      return runBuilder(request, options);
    } };
    if (interrupted) await assert.rejects(f.run(), /manual interruption/);
    else assert.equal((await f.run()).status, "delivered");
    const previous = await readImplementationDigests(f.options.progressDir);
    assert.deepEqual(Object.keys(previous), interrupted ? ["A", "B"] : ["A", "B", "C"]);
    await writeFile(join(f.options.outputDir, "user-edit.txt"), "current user code");
    const input = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    input.children[0].children[1].description = "Display the updated workspace and current user selection.";
    await writeFile(f.options.requirementsFile, JSON.stringify(input));
    const updated = await loadRequirementCatalog(f.options.requirementsFile);
    f.options.requirementDigests = Object.fromEntries(updated.requirements.map(r => [r.id, requirementDigest(r)]));
    f.options.resumedRequirementIds = Object.keys(previous).filter(id => previous[id] === f.options.requirementDigests![id]);
    f.options.startingPoint = "inherited_application";
    f.options.ledgerFile = join(dirname(f.options.ledgerFile), "next-build", "ledger.jsonl");
    const jobs: CheckJob[] = [];
    await attach(f, async job => { jobs.push(job); });
    f.options.verifier.replay = false;
    f.deps.builder = f.builder;
    const requestCount = f.builder.requests.length;
    const result = await f.run();
    assert.equal(result.status, "delivered");
    assert.deepEqual(new Set(result.verifiedRequirementIds), new Set(["A", "B", "C"]));
    assert.deepEqual(f.builder.requests.slice(requestCount).filter(r => r.mode === "implement").map(r => r.packet.requirementIds),
      interrupted ? [["B"], ["C"]] : [["B"]]);
    assert(f.builder.requests.slice(requestCount).filter(r => "projectContext" in r).every(r =>
      "projectContext" in r && r.projectContext.startingPoint === "inherited_application"),
    "Builder context agrees that continued work is included in current verification");
    assert(jobs.some(job => job.mode === "discover" && job.requirementIds.includes("A")), "continued implementations receive fresh behavior checks even with replay disabled");
    assert.equal(await readFile(join(f.options.outputDir, "user-edit.txt"), "utf8"), "current user code");
    assert.deepEqual(await readImplementationDigests(f.options.progressDir), f.options.requirementDigests);
  });
});

test("Continued implementations do not inherit a passing verdict when current verification fails", async () => {
  await withModulePipeline(async f => {
    await mkdir(f.options.outputDir, { recursive: true });
    await writeFile(join(f.options.outputDir, "app.txt"), "current code");
    await attach(f, undefined, async () => "fail");
    f.options.verifier.replay = false;
    f.options.resumedRequirementIds = ["A", "B", "C"];
    let groupingCalls = 0;
    f.deps.grouper = { async group() { groupingCalls++; return { groups: [] }; } };
    const result = await f.run();
    assert.deepEqual(result.verifiedRequirementIds, []);
    assert.notEqual(result.status, "delivered");
    assert.equal(f.builder.requests.filter(r => r.mode === "implement").length, 0);
    assert.equal(groupingCalls, 0, "a build with no implementation work does not call the Grouper");
    assert(f.builder.requests.some(r => r.mode === "repair" || r.mode === "root_cause_repair"));
  });
});

test("Verifier configuration declares migration mode and bounded concurrency", () => {
  assert.deepEqual(parseVerifierConfig({}), { mode: "active", concurrency: 2, semanticReview: false, replay: false });
  assert.deepEqual(parseVerifierConfig({ SHALLOW_VERIFIER_MODE: "active", SHALLOW_VERIFIER_CONCURRENCY: "1" }), { mode: "active", concurrency: 1, semanticReview: false, replay: false });
  for (const enabled of ["1", "true", "YES", " on "]) {
    assert.equal(parseVerifierConfig({ SHALLOW_VERIFIER_SEMANTIC_REVIEW: enabled }).semanticReview, true);
    assert.equal(parseVerifierConfig({ SHALLOW_VERIFIER_REPLAY: enabled }).replay, true);
  }
  for (const disabled of ["", "0", "false", "NO", " off "]) {
    assert.equal(parseVerifierConfig({ SHALLOW_VERIFIER_SEMANTIC_REVIEW: disabled }).semanticReview, false);
    assert.equal(parseVerifierConfig({ SHALLOW_VERIFIER_REPLAY: disabled }).replay, false);
  }
  for (const key of ["SHALLOW_VERIFIER_SEMANTIC_REVIEW", "SHALLOW_VERIFIER_REPLAY"]) assert.throws(() => parseVerifierConfig({ [key]: "maybe" }), /must be/);
  assert.throws(() => parseVerifierConfig({ SHALLOW_VERIFIER_MODE: "agent" }));
  for (const mode of ["legacy", "observe"]) assert.throws(() => parseVerifierConfig({ SHALLOW_VERIFIER_MODE: mode }), /only supports active/);
  assert.throws(() => parseVerifierConfig({ SHALLOW_VERIFIER_CONCURRENCY: "3" }));
});

test("ROOT-direct requirements reach grouping, implementation and one feature-group summary each", async () => {
  for (const replay of [false, true]) await withModulePipeline(async f => {
    const input = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    input.type = "ROOT";
    input.children = input.children.flatMap((folder: { children: unknown[] }) => folder.children);
    await writeFile(f.options.requirementsFile, JSON.stringify(input));
    const jobs: CheckJob[] = [];
    await attach(f, async job => { jobs.push(job); });
    f.options.verifier!.replay = replay;
    let calls = 0;
    f.deps.grouper = { async group() {
      calls++;
      return { groups: [["A", "B"], ["C"]].map(requirementIds => ({ requirementIds, purpose: "Counter operations" })) };
    } };
    const result = await f.run();
    assert.equal(calls, 1);
    assert.equal(result.status, "delivered");
    assert.deepEqual(result.implementedRequirementIds, ["A", "B", "C"]);
    assert.deepEqual(result.verifiedRequirementIds, ["A", "B", "C"]);
    assert.deepEqual(f.builder.requests.filter(request => request.mode === "implement").map(request => request.packet.requirementIds),
      [["A", "B"], ["C"]]);
    assert(jobs.some(job => job.requirementIds.length > 0));
    assert(jobs.filter(job => job.requirementIds.length > 0).every(job => job.moduleId === "ROOT"));
    const groups = (await f.events()).flatMap(event =>
      event.type === "module_check_finished" && event.detail?.featureGroupId
        ? [{ moduleId: event.detail.moduleId, featureGroupId: event.detail.featureGroupId }] : []);
    assert.equal(groups.length, 2);
    assert(groups.every(group => group.moduleId === "ROOT"));
    assert(groups.every(group => group.featureGroupId.startsWith("feature-")));
  });
});

test("An exhausted grouper falls back once without restarting its private planning session", async () => {
  await withModulePipeline(async f => {
    await attach(f);
    let calls = 0;
    f.deps.grouper = { async group() {
      calls++;
      throw Object.assign(new Error("gateway temporarily unavailable"), {
        gatewayFailure: { kind: "unavailable" as const, retryable: true },
      });
    } };
    const result = await f.run();
    assert.equal(calls, 1);
    const waits = (await f.events()).filter(event => event.type === "gateway_wait");
    assert.equal(waits.length, 0);
    const grouping = (await f.events()).find(event => event.type === "feature_grouping_finished");
    assert.equal(grouping?.detail?.source, "deterministic");
    assert.match(String(grouping?.detail?.reason), /gateway temporarily unavailable/);
    assert.notEqual(result.status, "failed");
  });
});

test("Verifier progress reaches the correlated event ledger without granting verification", async () => {
  await withModulePipeline(async f => {
    await attach(f);
    await f.run();
    const events = await f.events();
    const progress = events.filter(item => item.type === "check_progress");
    assert(progress.length > 0);
    for (const event of progress) {
      assert.equal(event.phase, "verifier");
      assert(event.runId && event.eventId && event.sequence);
      assert(event.detail?.jobId && event.detail.snapshotId && event.detail.checkedSourceSha);
      assert(events.some(start => start.type === "check_started" && start.detail?.jobId === event.detail?.jobId));
    }
    const deliveryStart = events.findIndex(event => event.type === "delivery_check_started");
    const deliveryEnd = events.findIndex(event => event.type === "delivery_check_finished");
    assert(deliveryStart >= 0 && deliveryEnd > deliveryStart);
    assert.equal(events[deliveryStart]!.phase, "delivery");
  });
});

test("In-flight Verifier usage reaches only the live view, not the ledger or settled report", async () => {
  await withModulePipeline(async f => {
    const runtime = await attach(f);
    const presented: string[] = [];
    f.deps.logSink = { write() {}, present: chunk => { presented.push(chunk); } };
    let progressRecorder: Parameters<NonNullable<VerifierRuntime["setUsageProgressRecorder"]>>[0] | undefined;
    runtime.setUsageProgressRecorder = recorder => { progressRecorder = recorder; };
    const check = runtime.verifier.check.bind(runtime.verifier);
    runtime.verifier.check = async (job, signal, onProgress) => {
      progressRecorder?.({ jobId: job.jobId, role: "exploration", input: 10, output: 2,
        cacheRead: 0, cacheWrite: 0, total: 12, cost: 0.0001 });
      return check(job, signal, onProgress);
    };
    const result = await f.run();
    const live = presented.map(chunk => JSON.parse(chunk) as { type: string; phase?: string; detail?: { total?: number } })
      .filter(event => event.type === "verifier_usage_progress");
    assert.ok(live.length > 0);
    assert.equal(live[0]!.phase, "verifier");
    assert.equal(live[0]!.detail?.total, 12);
    assert.equal((await f.events()).some(event => event.type === "verifier_usage_progress"), false,
      "display-only usage never enters the ledger");
    assert.equal(result.modelUsage?.verifier.total, 0, "in-flight usage is display-only");
  });
});

test("Delivery records readiness and advances the runnable checkpoint without a separate prepare job", async () => {
  await withModulePipeline(async f => {
    await mkdir(f.options.outputDir);
    await writeFile(f.options.requirementsFile, JSON.stringify({ id: "ROOT", name: "Product", type: "ROOT", children: [] }));
    const jobs: CheckJob[] = [];
    const runtime = await attach(f, async job => { jobs.push(job); });
    const result = await f.run();
    assert.equal(result.status, "delivered");
    assert.deepEqual(jobs, [], "delivery alone prepares the empty application");
    assert.equal(result.acceptedSha, result.verifier!.producedHead!.sourceSha);
    const attempts = await readdir(join(runtime.directory, "delivery"));
    assert.equal(attempts.length, 1);
    const attempt = JSON.parse(await readFile(join(runtime.directory, "delivery", attempts[0]!), "utf8"));
    const job = await runtime.artifacts.getJson<CheckJob>(attempt.job);
    assert.equal(job.packetId, "delivery");
    assert.equal(job.snapshot.digest, result.verifier!.producedHead!.snapshot.digest);
    assert.equal(attempt.receipts.length, 1);
    await runtime.artifacts.validateReceipt(job, await runtime.artifacts.getJson(attempt.receipts[0]));
    assert.equal((await f.events()).filter(event => event.type === "check_queued" && event.packetId === "delivery").length, 0);
  });
});

test("A successful delivery claim without readiness evidence cannot advance the runnable checkpoint", async () => {
  await withModulePipeline(async f => {
    await mkdir(f.options.outputDir);
    await writeFile(f.options.requirementsFile, JSON.stringify({ id: "ROOT", name: "Product", type: "ROOT", children: [] }));
    const runtime = await attach(f);
    runtime.verifyDelivery = async () => ({ report: { ok: true, stage: "complete", message: "Unproven" }, receipts: [] });
    f.builder.run = async () => ({ outcome: "failed", sessionId: "test", summary: "No change" });
    const result = await f.run();
    assert.equal(result.status, "failed");
    assert.equal(result.acceptedSha, "initial");
    assert.match(result.delivery!.message, /readiness evidence/);
    for (const name of await readdir(join(runtime.directory, "delivery"))) {
      const attempt = JSON.parse(await readFile(join(runtime.directory, "delivery", name), "utf8"));
      assert.equal(attempt.report.ok, false, "the stored attempt records the evidence-checked decision");
    }
  });
});

test("Delivery rejects readiness receipts belonging to another job", async () => {
  await withModulePipeline(async f => {
    await mkdir(f.options.outputDir);
    await writeFile(f.options.requirementsFile, JSON.stringify({ id: "ROOT", name: "Product", type: "ROOT", children: [] }));
    const runtime = await attach(f);
    const verify = runtime.verifyDelivery.bind(runtime);
    runtime.verifyDelivery = async (job, signal) => verify({ ...job, jobId: "another-job" }, signal);
    await assert.rejects(f.run(), /receipt.*job|job.*receipt/i);
    const checkpoint = await readVerifierCheckpoint(join(runtime.directory, "controller.json"));
    assert.equal(checkpoint!.accepted.sha, "initial");
  });
});

test("An incomplete group cannot grant its implementation or dispatch dependent groups", async () => {
  await withModulePipeline(async f => {
    await attach(f);
    const build = f.builder.run.bind(f.builder);
    f.builder.run = async (request, options) => {
      const result = await build(request, options);
      return request.mode === "implement" && request.packet.requirementIds.includes("A")
        ? { ...result, outcome: "failed", terminationReason: "missing_terminal_response" } : result;
    };
    const result = await f.run();
    assert.equal(result.status, "partial");
    assert.deepEqual(result.verifiedRequirementIds, []);
    assert.deepEqual(result.implementedRequirementIds, []);
    assert.equal(f.builder.requests.filter(request => request.mode === "implement").length, 2);
    assert.ok((await f.events()).some(event => event.type === "dependency_gate_blocked"));
  });
});

for (const title of ["Product", "Product - Evolution", "Product - Stage 2"]) test(`Current scope is verified uniformly for ${title}`, async () => {
  await withModulePipeline(async f => {
    await mkdir(f.options.outputDir, { recursive: true });
    await writeFile(join(f.options.outputDir, "existing.txt"), "implemented A");
    const jobs: CheckJob[] = [];
    const runtime = await attach(f, async job => { jobs.push(job); });
    const input = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    input.name = title;
    await writeFile(f.options.requirementsFile, JSON.stringify(input));
    f.options.startingPoint = "inherited_application";
    f.options.resumedRequirementIds = ["A"];
    const result = await f.run();
    assert.deepEqual(result.skippedRequirementIds, []);
    assert.deepEqual(result.verifiedRequirementIds.sort(), ["A", "B", "C"]);
    assert.ok(!f.builder.requests.some(request => request.mode === "implement" && request.packet.requirementIds.includes("A")));
    const audit = jobs.find(job => job.mode !== "prepare" && job.requirementIds.includes("B"))!;
    const context = await runtime.artifacts.getJson<{ requirements: Array<{ dependencyIds: string[] }>; prerequisites: Array<{ id: string }> }>(audit.requirements);
    assert.deepEqual(context.requirements[0]!.dependencyIds, ["A"]);
    assert(context.prerequisites.some(item => item.id === "A"));
    assert(jobs.some(job => job.mode !== "prepare" && job.requirementIds.includes("A")));
  });
});

test("default switches aggregate group snapshots without historical replay, including resume", async () => {
  await withModulePipeline(async f => {
    const jobs: CheckJob[] = [];
    const runtime = await attach(f, async job => { jobs.push(job); }, async job => {
      const snapshot = await runtime.snapshots.open(job.snapshot);
      const changed = await readFile(join(snapshot.sourceDirectory, "later-change.txt")).then(() => true, () => false);
      return job.requirementIds.includes("A") && changed ? "fail" : "pass";
    });
    f.options.verifier = parseVerifierConfig({});
    const build = f.builder.run.bind(f.builder);
    f.builder.run = async (request, options) => {
      const result = await build(request, options);
      if (request.mode === "implement" && request.packet.requirementIds.includes("C")) await writeFile(join(f.options.outputDir, "later-change.txt"), "changed");
      return result;
    };
    const result = await f.run();
    assert.equal(result.status, "delivered");
    assert.equal(jobs.filter(job => job.mode === "discover").length, 3);
    assert(jobs.every(job => job.mode === "discover" || job.mode === "prepare"));
    assert(jobs.every(job => job.programs.length === 0));
    assert.equal(f.builder.requests.some(request => request.mode === "repair"), false);
    assert.equal(result.verifier?.replay, false);
    assert.equal(result.verifier?.semanticReview, false);
    assert.equal(result.verifier?.verifiedSnapshotId, undefined);
    const first = jobs.find(job => job.mode === "discover" && job.requirementIds.includes("A"))!;
    assert(result.verifier?.outcomes?.filter(item => item.requirementId === "A").every(item => item.snapshotId === first.snapshot.id));
    for (const outcome of result.verifier!.outcomes!) {
      assert.ok(outcome.job && outcome.report);
      const job = await runtime.artifacts.getJson<CheckJob>(outcome.job);
      const report = await runtime.artifacts.getJson<CheckReport>(outcome.report);
      assert.equal(outcome.jobId, job.jobId);
      assert.equal(outcome.snapshotId, job.snapshot.id);
      assert.equal(report.job.id, outcome.job.id);
      assert.ok(report.outcomes.some(item => item.clauseId === outcome.clauseId));
    }
    await writeRunReport(dirname(f.options.ledgerFile), result);
    const report = await readFile(join(dirname(f.options.ledgerFile), "verifier-report.md"), "utf8");
    assert.match(report, /独立语义复核：关闭；最终全量重放：关闭/);
    assert.match(report, new RegExp(`检查快照：${first.snapshot.id}`));
    const events = await f.events();
    const final = events.find(item => item.type === "module_check_finished" && item.detail?.moduleId === "<final>")!;
    assert.match(new HumanRunFormatter().format(JSON.stringify(final))!, /最终功能组结果汇总/);
    const previousJobs = jobs.length;
    const resumed = await f.run();
    assert.equal(resumed.status, "delivered");
    assert(jobs.slice(previousJobs).every(job => job.mode === "prepare"));
    assert.deepEqual(resumed.verifier?.outcomes, result.verifier?.outcomes);
  });
});

test("Failed Verifier tasks retain their task references and redacted errors with replay enabled or disabled", async () => {
  for (const replay of [false, true]) await withModulePipeline(async f => {
    const runtime = await attach(f, async job => {
      if (job.mode !== "prepare") throw new Error("Verifier connection closed: private-credential");
    });
    f.options.verifier.replay = replay;
    f.deps.diagnosticSecrets = ["private-credential"];
    const result = await f.run();
    assert.equal(result.status, "partial");
    assert.deepEqual(result.inconclusiveRequirementIds?.sort(), ["A", "B", "C"]);
    for (const outcome of result.verifier!.outcomes!) {
      assert.equal(outcome.status, "inconclusive");
      assert.deepEqual(outcome.evidence, []);
      assert.equal(outcome.report, undefined);
      assert.ok(outcome.job && outcome.jobId && outcome.snapshotId);
      const job = await runtime.artifacts.getJson<CheckJob>(outcome.job);
      assert.equal(outcome.jobId, job.jobId);
      assert.equal(outcome.snapshotId, job.snapshot.id);
      assert.match(outcome.reason!, /Verifier connection closed: \[redacted\]/);
    }
    await writeRunReport(dirname(f.options.ledgerFile), result);
    const report = await readFile(join(dirname(f.options.ledgerFile), "verifier-report.md"), "utf8");
    assert.match(report, /原文依据：/);
    assert.match(report, /验收任务：/);
    assert.doesNotMatch(report, /private-credential/);
  });
});

test("replay off still diagnoses failures and replays only the repaired scenario targets", async () => {
  await withModulePipeline(async f => {
    const jobs: CheckJob[] = [];
    const runtime = await attach(f, async job => { jobs.push(job); }, async job => {
      const snapshot = await runtime.snapshots.open(job.snapshot);
      const fixed = await readFile(join(snapshot.sourceDirectory, "fixed.txt")).then(() => true, () => false);
      return job.requirementIds.includes("A") && !fixed ? "fail" : "pass";
    });
    f.options.verifier = parseVerifierConfig({ SHALLOW_VERIFIER_SEMANTIC_REVIEW: "1" });
    const build = f.builder.run.bind(f.builder);
    f.builder.run = async (request, options) => {
      const result = await build(request, options);
      if (request.mode === "repair") await writeFile(join(f.options.outputDir, "fixed.txt"), "fixed");
      return result;
    };
    const result = await f.run();
    assert.equal(result.status, "delivered");
    assert.equal(result.verifier?.semanticReview, true);
    assert.equal(result.verifier?.replay, false);
    assert.deepEqual(jobs.filter(job => job.mode === "discover").map(job => job.requirementIds), [["A"], ["B"], ["C"]]);
    assert.deepEqual(jobs.filter(job => job.mode === "diagnose").map(job => job.requirementIds), [["A"]]);
    assert.deepEqual(jobs.filter(job => job.mode === "replay").map(job => job.requirementIds), [["A"]]);
    assert(jobs.filter(job => job.mode === "replay").every(job => job.clauseIds?.length));
  });
});

test("replay off excludes rejected repair reports when aggregating the restored lineage", async () => {
  await withModulePipeline(async f => {
    const jobs: CheckJob[] = [];
    await attach(f, async job => { jobs.push(job); }, async job => job.requirementIds.includes("A") ? "fail" : "pass");
    f.options.verifier = parseVerifierConfig({});
    const build = f.builder.run.bind(f.builder);
    f.builder.run = async (request, options) => {
      const result = await build(request, options);
      if (request.mode === "repair") await writeFile(join(f.options.outputDir, "rejected.txt"), "rejected");
      return result;
    };
    const result = await f.run();
    assert.equal(result.status, "partial");
    assert.deepEqual(result.failedRequirementIds, ["A"]);
    await assert.rejects(readFile(join(f.options.outputDir, "rejected.txt")));
    const original = jobs.find(job => job.mode === "diagnose" && job.requirementIds.includes("A"))!;
    assert(result.verifier?.outcomes?.filter(item => item.requirementId === "A").every(item => item.snapshotId === original.snapshot.id));
    assert(jobs.filter(job => job.mode === "replay").every(job => job.clauseIds?.length));
  });
});

for (const continued of [false, true]) for (const replay of [false, true]) test(`Web extra ports allow group checks to overlap Builder across modules and join before delivery (continued=${continued}, replay=${replay})`, { timeout: 20_000 }, async () => {
  await withModulePipeline(async f => {
    if (continued) {
      await mkdir(f.options.outputDir, { recursive: true });
      await writeFile(join(f.options.outputDir, "marker.txt"), "A");
      f.options.resumedRequirementIds = ["A"];
    }
    const jobs: CheckJob[] = [];
    let started!: () => void, startedB!: () => void, release!: () => void, sealedAll!: () => void;
    const checking = new Promise<void>(resolve => { started = resolve; });
    const checkingB = new Promise<void>(resolve => { startedB = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const implementationFinished = new Promise<void>(resolve => { sealedAll = resolve; });
    let checkingA = false, overlapped = false;
    const runtime = await attach(f, async (job, signal) => {
      jobs.push(job);
      if (job.mode === "replay") assert.equal(checkingA, false, "final replay waits for background checks");
      if (job.mode === "discover" && job.requirementIds[0] === "B") startedB();
      if (job.requirementIds[0] !== "A" || job.moduleEpoch !== 0) return;
      checkingA = true;
      started();
      await released;
      assert.equal(signal.aborted, false, "later modules do not cancel group checks");
      const sealed = await runtime.snapshots.open(job.snapshot);
      assert.equal(await readFile(join(sealed.sourceDirectory, "marker.txt"), "utf8"), "A");
      checkingA = false;
    });
    const initialSource = join(runtime.directory, "port-input");
    await mkdir(initialSource, { recursive: true });
    const initial = await runtime.snapshots.seal({ sourceDirectory: initialSource, sourceSha: "initial", packetId: "initial-data" });
    const { declaration } = await createWebExecutionAdapter({ artifacts: runtime.artifacts, snapshots: runtime.snapshots,
      workspace: join(runtime.directory, "web-workers"), initialDataSnapshot: initial.ref,
      spec: { start: { executable: process.execPath }, adapterConfig: { extraPorts: [4321] } } });
    runtime.resourceKeys = declaration.resourceKeys;
    f.options.verifier!.replay = replay;
    const verifyDelivery = runtime.verifyDelivery.bind(runtime);
    runtime.verifyDelivery = async (job, signal) => {
      assert.equal(checkingA, false, "delivery waits for background checks");
      return verifyDelivery(job, signal);
    };
    let timer!: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Group check did not overlap Builder")), 8_000); });
    const build = f.builder.run.bind(f.builder);
    f.builder.run = async (request, options) => {
      if (request.mode === "implement" && request.packet.requirementIds[0] === "B") {
        await Promise.race([checking, timeout]);
        overlapped = checkingA;
        const checkpoint = await readVerifierCheckpoint(join(runtime.directory, "controller.json"));
        assert.deepEqual(checkpoint!.producedHead!.implementedRequirementIds, ["A"]);
        assert.equal(checkpoint!.accepted.ordinal, 0);
      }
      if (request.mode === "implement" && request.packet.requirementIds[0] === "C") {
        assert.equal(checkingA, true, "the next module starts while the first group is still checking");
        const events = await f.events();
        assert.ok(!events.some(event => event.type === "module_check_finished" &&
          (event.detail?.requirementResults as Record<string, unknown> | undefined)?.A),
          "an in-flight group publishes only when its own check completes");
      }
      const result = await build(request, options);
      await writeFile(join(f.options.outputDir, "marker.txt"), request.mode === "implement" ? request.packet.requirementIds[0] : "repair");
      return result;
    };
    const logSink = f.deps.logSink;
    f.deps.logSink = { write(chunk) {
      logSink?.write(chunk);
      const event = JSON.parse(chunk) as RunEvent;
      if (event.type === "snapshot_sealed" && event.detail?.requirementIds.includes("C")) sealedAll();
    } };
    const running = f.run();
    let result: Awaited<typeof running>;
    try {
      await Promise.race([implementationFinished, running, timeout]);
      assert.equal(checkingA, true, "all implementation finishes before the slow group check");
      await Promise.race([checkingB, running, timeout]);
      assert.equal(checkingA, true, "another Verifier job starts while the first check is still running");
      assert.equal((await f.events()).some(event => event.type === "delivery_started"), false);
      release();
      result = await Promise.race([running, timeout]);
    }
    finally { release(); clearTimeout(timer); await running.catch(() => {}); }
    assert.equal(overlapped, true);
    assert.equal(result.status, "delivered");
    assert.deepEqual(result.verifiedRequirementIds.sort(), ["A", "B", "C"]);
    assert.equal(f.builder.closeCount, 1);
    const checkpoint = await readVerifierCheckpoint(join(runtime.directory, "controller.json"));
    assert.equal(checkpoint!.snapshots.length, 3);
    for (const [index, marker] of ["A", "B", "C"].entries()) {
      const sealed = await runtime.snapshots.open(checkpoint!.snapshots[index].snapshot);
      assert.equal(await readFile(join(sealed.sourceDirectory, "marker.txt"), "utf8"), marker);
    }
    const groupJobs = jobs.filter(job => job.moduleEpoch === 0);
    assert.deepEqual(groupJobs.map(job => job.requirementIds), [["A"], ["B"], ["C"]]);
    assert(groupJobs.every(job => job.mode === "discover"));
    assert.equal(groupJobs[0]!.snapshot.id, checkpoint!.snapshots[0].snapshot.id);
    assert.equal(groupJobs[1]!.snapshot.id, checkpoint!.snapshots[1].snapshot.id);
    assert.ok(groupJobs.every(job => job.initialState.id === runtime.initialState.id && job.timeoutMs === 3_600_000));
    const fullJobs = jobs.filter(job => job.mode === "replay" && !job.clauseIds);
    assert.equal(fullJobs.length, replay ? 3 : 0);
    assert(fullJobs.every(job => job.snapshot.id === checkpoint!.snapshots[2].snapshot.id), "only the completed application receives full replay");
    const events = await f.events();
    assert.ok(!events.some(item => item.type === "check_cancelled"));
    const delivery = events.findIndex(item => item.type === "delivery_started");
    assert.ok(delivery >= 0);
    assert.ok(events.slice(0, delivery).some(item => item.type === "check_started"));
    assert.ok(events.slice(0, delivery).filter(item => item.type === "module_check_finished").every(item => item.detail?.replay === false));
    assert.ok(events.some(item => item.type === "module_check_finished" && item.detail?.moduleId === "<final>"));
    await writeRunReport(dirname(f.options.ledgerFile), result);
    assert.match(await readFile(join(dirname(f.options.ledgerFile), "verifier-report.md"), "utf8"), /Verifier 验收证据/);
    const ledger = events.map(item => item.sequence);
    assert.deepEqual(ledger, Array.from({ length: ledger.length }, (_, i) => i + 1));
  });
});

test("Adapter-declared shared resources still serialize Verifier checks with Builder self-tests", { timeout: 20_000 }, async () => {
  await withModulePipeline(async f => {
    let started!: () => void, release!: () => void;
    const checking = new Promise<void>(resolve => { started = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    let finishedA = false;
    const runtime = await attach(f, async job => {
      if (job.mode !== "discover" || !job.requirementIds.includes("A")) return;
      started();
      await released;
      finishedA = true;
    });
    runtime.resourceKeys = ["test:shared-resource"];
    const build = f.builder.run.bind(f.builder);
    f.builder.run = async (request, options) => {
      if (request.mode === "implement" && !request.packet.requirementIds.includes("A")) {
        assert.equal(finishedA, true, "Builder self-tests wait for the shared resource");
      }
      return build(request, options);
    };
    let timer!: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Shared-resource check did not start")), 8_000); });
    const running = f.run();
    try {
      await Promise.race([checking, running, timeout]);
      assert.equal(finishedA, false);
      assert.deepEqual(f.builder.requests.map(request => request.mode === "implement" ? request.packet.requirementIds : request.mode), [["A"]]);
      release();
      assert.equal((await Promise.race([running, timeout])).status, "delivered");
    } finally { release(); clearTimeout(timer); await running.catch(() => {}); }
  });
});

test("feature groups share discovery context, aggregate scoped program history and survive resume", async () => {
  await withModulePipeline(async f => {
    const input = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    input.children[1].children[0].dependencies = ["A"];
    await writeFile(f.options.requirementsFile, JSON.stringify(input));
    const jobs: CheckJob[] = [];
    const runtime = await attach(f, async job => { jobs.push(job); });
    let groupCalls = 0;
    f.deps.grouper = { async group() {
      groupCalls++;
      return { groups: [{ requirementIds: ["A", "B"], purpose: "Shared workspace" }, { requirementIds: ["C"], purpose: "Next module" }] };
    } };
    const check = runtime.verifier.check.bind(runtime.verifier);
    runtime.verifier.check = async (job, signal, onProgress) => {
      const report = await check(job, signal, onProgress);
      if (job.mode === "prepare") return report;
      const programs = await Promise.all(job.requirementIds.map(async requirementId => {
        const clauseId = `${requirementId}:description:0:0`, checkpointId = `${requirementId}-result`;
        const contract = await runtime.artifacts.putJson({ requirements: job.requirements,
          checkpoints: [{ id: checkpointId, kind: "assertion", requirementId, scenarioId: "description", clauseId, dependsOn: [], basis: "Display the main workspace." }],
          clauses: [{ id: clauseId, requirementId, scenarioId: "description", basis: "Display the main workspace.", checkpointId, expected: { operator: "equal", value: true } }] });
        return { contract, binding: job.binding, format: "fake@1", descriptor: await runtime.artifacts.putTypedJson({
          source: await runtime.artifacts.putBytes(`// ${requirementId}`), initialState: job.initialState, clauses: [{ clauseId, checkpointId }],
        }, runtime.initialState.schema) };
      }));
      return { ...report, programs };
    };
    const result = await f.run();
    assert.equal(result.status, "delivered");
    const initial = jobs.filter(job => job.moduleEpoch === 0 && job.mode !== "prepare");
    assert.deepEqual(initial.map(job => job.requirementIds), [["A", "B"], ["C"]], "each sealed feature group creates one discovery job");
    const sharedContext = initial[0]!.requirements.digest;
    const groupJobs = jobs.filter(job => job.requirementIds.includes("A") && job.mode !== "prepare");
    assert(groupJobs.every(job => job.requirements.digest === sharedContext));
    assert.equal(groupJobs.some(job => job.mode === "replay" && job.requirementIds.length === 1), false, "no prerequisite boundary replay");
    const final = groupJobs.at(-1)!;
    assert.deepEqual(final.requirementIds, ["A", "B"]);
    assert.equal(final.programs.length, 2, "latest scoped A report cannot hide the earlier B program");
    assert.equal(final.mode, "replay");
    const file = join(runtime.directory, "controller.json");
    assert.deepEqual((await readVerifierCheckpoint(file))!.featureGroups, [["A", "B"], ["C"]]);
    const implementations = f.builder.requests.filter(request => request.mode === "implement").length;
    f.deps.grouper = { async group() { groupCalls++; throw new Error("Resume must keep the saved grouping"); } };
    const resumed = await f.run();
    assert.equal(resumed.status, "delivered");
    assert.equal(groupCalls, 1);
    assert.equal(f.builder.requests.filter(request => request.mode === "implement").length, implementations);
    const resumedEvents = await f.events();
    assert.ok(resumedEvents.some(item => item.type === "run_resumed" && item.detail?.requirementIds.length === 3),
      "resume reports the recovered implemented scope");
    assert.ok(resumedEvents.filter(item => item.type === "snapshot_sealed")
      .some(item => item.detail?.implementedRequirementIds?.length === 3),
      "sealed snapshots carry the implemented scope for live progress");
    const store = await VerifierCheckpoints.open(file, runtime.binding.digest, "ignored");
    await assert.rejects(store.setFeatureGroups([["A"], ["B"], ["C"]]), /changed within the run/);
  });
});

test("Concentrated repairs wait for all modules and follow current-snapshot Verifier diagnosis", async () => {
  await withModulePipeline(async f => {
    const runtime = await attach(f, undefined, async job => {
      const snapshot = await runtime.snapshots.open(job.snapshot);
      const repaired = await readFile(join(snapshot.sourceDirectory, "repaired.txt")).then(() => true, () => false);
      return job.requirementIds[0] === "A" && !repaired ? "fail" : "pass";
    });
    const build = f.builder.run.bind(f.builder);
    let builtB = false, builtC = false;
    f.builder.run = async (request, options) => {
      if (request.mode === "repair") {
        assert(builtB && builtC, "all modules finish before concentrated repair");
        assert.ok((await f.events()).some(event => event.type === "check_completed" && event.detail?.mode === "diagnose"));
      }
      if (request.mode === "implement" && request.packet.requirementIds[0] === "C") {
        await assert.rejects(readFile(join(f.options.outputDir, "repaired.txt")));
        builtC = true;
      }
      const result = await build(request, options);
      if (request.mode === "implement" && request.packet.requirementIds[0] === "B") builtB = true;
      if (request.mode === "repair") await writeFile(join(f.options.outputDir, "repaired.txt"), "fixed");
      return result;
    };
    assert.equal((await f.run()).status, "delivered");
    const modes = f.builder.requests.map(request => request.mode === "implement" ? request.packet.requirementIds[0] : request.mode);
    assert.deepEqual(modes, ["A", "B", "C", "repair"]);
  });
});

test("Final replay finds prerequisite behavior changed by a later module", async () => {
  await withModulePipeline(async f => {
    const runtime = await attach(f, undefined, async job => {
      const snapshot = await runtime.snapshots.open(job.snapshot);
      const broken = await readFile(join(snapshot.sourceDirectory, "broken-prerequisite.txt")).then(() => true, () => false);
      return job.requirementIds[0] === "A" && broken ? "fail" : "pass";
    });
    const build = f.builder.run.bind(f.builder);
    f.builder.run = async (request, options) => {
      const result = await build(request, options);
      if (request.mode === "implement" && request.packet.requirementIds[0] === "C") await writeFile(join(f.options.outputDir, "broken-prerequisite.txt"), "broken");
      if (request.mode === "repair") await rm(join(f.options.outputDir, "broken-prerequisite.txt"), { force: true });
      return result;
    };
    assert.equal((await f.run()).status, "delivered");
    assert.ok(f.builder.requests.some(item => item.mode === "repair" && item.packet.requirementIds.includes("A")));
  });
});

test("Verifier observations update published results without resetting them at a module boundary", () => {
  const view = new BuildView({ requirementIds: ["A"], models: { grouper: "a", builder: "b", verifier: "c" }, onInterrupt() {} }, () => 24, terminalTheme(false));
  const formatter = new HumanRunFormatter();
  const event = { at: "2026-10-16T00:00:00Z", type: "module_check_finished" as const,
    detail: { moduleId: "M", moduleEpoch: 2, snapshotId: "snapshot", published: true, requirementResults: { A: "verified" as const } } };
  view.receive(event, formatter.format(JSON.stringify(event))!);
  assert.match(view.render(100).join("\n"), /已验证 1\/1/);
  view.receive({ ...event, detail: { ...event.detail, published: false, requirementResults: { A: "failed" } } }, "历史结果");
  assert.match(view.render(100).join("\n"), /已验证 1\/1/);
  view.receive({ at: event.at, type: "snapshot_sealed", detail: { snapshotId: "new", sourceSha: "new-sha", requirementIds: ["A"], sequence: 2 } }, "新版本");
  assert.match(view.render(100).join("\n"), /已验证 1\/1/, "a sealed module keeps prior coverage until new results replace it");
});

test("Feature-group and final events report cumulative scenario coverage", async () => {
  await withModulePipeline(async f => {
    const input = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    const scenario = (id: string, name: string) => ({ id, name, steps: [
      { keyword: "GIVEN", content: "The workspace is open" },
      { keyword: "WHEN", content: "The user acts" },
      { keyword: "THEN", content: "The result is visible" },
    ] });
    input.children[0].children[0].scenarios = [scenario("A-1", "First"), scenario("A-2", "Second")];
    input.children[1].children[0].scenarios = [scenario("C-1", "Third")];
    await writeFile(f.options.requirementsFile, JSON.stringify(input));
    await attach(f);
    const result = await f.run();
    assert.equal(result.status, "delivered");
    const events = await f.events();
    const first = events.find(event => event.type === "module_check_finished" &&
      event.detail?.featureGroupId && event.detail.scenarioResults?.some(item => item.requirementId === "A"));
    assert.equal(first?.type, "module_check_finished");
    if (first?.type !== "module_check_finished") return;
    assert.equal(first.detail?.scenarioCoverage?.total, 3);
    assert.equal(first.detail?.scenarioCoverage?.verified, 2);
    assert.equal(first.detail?.scenarioCoverage?.failed, 0);
    assert.equal((first.detail?.scenarioCoverage?.inconclusive ?? 0) + (first.detail?.scenarioCoverage?.pending ?? 0) +
      (first.detail?.scenarioCoverage?.notRun ?? 0), 1,
      "only the feature group that just finished is verified");
    assert.deepEqual(first.detail?.scenarioResults?.map(item => [item.requirementId, item.scenarioId, item.status]),
      [["A", "A-1", "verified"], ["A", "A-2", "verified"]]);
    const final = events.find(event => event.type === "pipeline_finished");
    assert.equal(final?.type, "pipeline_finished");
    if (final?.type !== "pipeline_finished") return;
    assert.deepEqual(final.detail?.scenarioCoverage, { total: 3, verified: 3, failed: 0, inconclusive: 0, pending: 0, notRun: 0 });
    assert.equal(result.scenarioResults?.filter(item => item.status === "verified").length, 3);
  });
});

for (const checkFails of [false, true]) test(`Feature-group ${checkFails ? "faults" : "results"} publish while later implementation groups are still running`, { timeout: 20_000 }, async () => {
  await withModulePipeline(async f => {
    const input = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    input.children[0].children[0].scenarios = [{ id: "a-results", name: "workspace results", steps: [
      { keyword: "WHEN", content: "Open the main workspace." },
      { keyword: "THEN", content: "The main workspace is visible." },
      { keyword: "AND", content: "The current selection is visible." },
    ] }];
    await writeFile(f.options.requirementsFile, JSON.stringify(input));
    const catalog = await loadRequirementCatalog(f.options.requirementsFile);
    const expectedClauses = verifierSourceClauses({ requirements: catalog.requirements }, ["A"]).map(source => source.id);
    assert.equal(expectedClauses.length, 2);
    let releaseB!: () => void;
    const bReleased = new Promise<void>(resolve => { releaseB = resolve; });
    let resolveGroup!: (event: RunEvent) => void;
    const groupPublished = new Promise<RunEvent>(resolve => { resolveGroup = resolve; });
    await attach(f, async job => {
      if (checkFails && job.mode !== "prepare" && job.requirementIds.includes("A")) {
        throw new Error("Verifier connection closed: private-credential");
      }
      if (job.mode === "discover" && job.requirementIds[0] === "B") await bReleased;
    });
    f.options.verifier.replay = false;
    f.deps.diagnosticSecrets = ["private-credential"];
    const expectedStatus = checkFails ? "inconclusive" : "verified";
    const logSink = f.deps.logSink;
    f.deps.logSink = { ...logSink, write(chunk) {
      logSink?.write(chunk);
      const event = JSON.parse(chunk) as RunEvent;
      if (event.type === "module_check_finished" && event.detail?.featureGroupId &&
        event.detail.requirementResults?.A === expectedStatus) resolveGroup(event);
    } };
    const build = f.builder.run.bind(f.builder);
    let publishedBeforeLaterGroupFinished = false;
    f.builder.run = async (request, options) => {
      if (request.mode === "implement" && request.packet.requirementIds[0] === "C") {
        let timer!: ReturnType<typeof setTimeout>;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("feature-group result was not published before the later group finished")), 5_000);
        });
        try {
          const event = await Promise.race([groupPublished, timeout]);
          publishedBeforeLaterGroupFinished = true;
          assert.equal(event.type, "module_check_finished");
          assert.ok(event.detail?.featureGroupId);
          assert.equal(event.detail?.requirementResults?.A, expectedStatus);
          const scene = event.detail?.scenarioResults?.find(item => item.requirementId === "A");
          assert.equal(scene?.status, expectedStatus);
          assert.deepEqual(scene?.caseIds, expectedClauses);
          if (checkFails) {
            assert.match(scene?.reason ?? "", /Verifier connection closed: \[redacted\]/);
            assert.doesNotMatch(scene?.reason ?? "", /private-credential/);
          }
        } finally {
          clearTimeout(timer);
          releaseB();
        }
      }
      return build(request, options);
    };
    const result = await f.run();
    assert.equal(publishedBeforeLaterGroupFinished, true);
    assert.equal(result.status, checkFails ? "partial" : "delivered");
    const events = await f.events();
    assert.ok(events.some(event => event.type === "module_check_finished" && event.detail?.featureGroupId &&
      event.detail.requirementResults?.A === expectedStatus));
    assert.ok(events.some(event => event.type === "module_check_finished" && event.detail?.moduleId === "<final>"));
  });
});

test("Verifier completion callbacks receive deadline-expired tasks without their late reports", { timeout: 20_000 }, async () => {
  await withModulePipeline(async f => {
    const runtime = await attach(f, async (_job, signal) => {
      await new Promise<void>(resolve => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    await mkdir(f.options.outputDir, { recursive: true });
    const catalog = await loadRequirementCatalog(f.options.requirementsFile);
    const packet = makePacket("expired-group", catalog.requirements.filter(item => item.id === "A"));
    const coordinator = await VerifierCoordinator.open(runtime, f.options, f.deps, "initial", async () => {});
    try {
      const head = await coordinator.seal(packet, new Set(["A"]));
      let completions = 0;
      await coordinator.submit(head, packet, "discover", 50, { onCompleted: async (record, report) => {
        completions++;
        assert.equal(record.status, "cancelled");
        assert.ok(record.lateReport, "the expired task returned a report after its deadline");
        assert.equal(record.report, undefined);
        assert.equal(report, undefined, "late results must not grant verification");
        assert.equal(record.job.snapshot.id, head.snapshot.id);
        assert.match(record.error ?? "", /cancellation or deadline/);
      } });
      await coordinator.drain();
      assert.equal(completions, 1);
    } finally {
      await coordinator.cancelOutstanding();
    }
  });
});

test("Rejected non-improving repair restores the complete application including later modules", async () => {
  await withModulePipeline(async f => {
    const runtime = await attach(f, undefined, async job => {
      const snapshot = await runtime.snapshots.open(job.snapshot);
      const repaired = await readFile(join(snapshot.sourceDirectory, "repaired.txt"), "utf8").then(() => true, () => false);
      return job.requirementIds[0] === "A" ? "fail" : "pass";
    });
    const build = f.builder.run.bind(f.builder);
    f.builder.run = async (request, options) => {
      const result = await build(request, options);
      if (request.mode === "implement" && request.packet.requirementIds[0] === "B") await writeFile(join(f.options.outputDir, "later-B.txt"), "B preserved");
      if (request.mode === "repair") await writeFile(join(f.options.outputDir, "repaired.txt"), "regression");
      return result;
    };
    const result = await f.run();
    assert.equal(result.status, "partial");
    assert.deepEqual(result.failedRequirementIds, ["A"]);
    assert.equal(await readFile(join(f.options.outputDir, "later-B.txt"), "utf8"), "B preserved");
    await assert.rejects(readFile(join(f.options.outputDir, "repaired.txt")));
    const events = await f.events();
    const decision = events.find(item => item.type === "repair_batch_finished" && item.detail?.retained === false);
    assert.ok(decision?.type === "repair_batch_finished" && decision.detail);
    assert.ok(decision.packetId);
    assert.notEqual(decision.detail.candidateSnapshotId, decision.detail.baselineSnapshotId);
    assert.equal(decision.detail.retainedSnapshotId, decision.detail.baselineSnapshotId);
    assert.ok(decision.detail.checkJobIds!.length > 0);
    const checks = events.filter(item => item.type === "check_queued" && decision.detail!.checkJobIds!.includes(item.detail!.jobId));
    assert.equal(checks.length, decision.detail.checkJobIds!.length);
    assert.ok(checks.every(item => item.type === "check_queued" && item.detail!.snapshotId === decision.detail!.candidateSnapshotId));
  });
});


test("Source drift after final snapshot invalidates delivery and its current verification", async () => {
  await withModulePipeline(async f => {
    const runtime = await attach(f);
    const verify = runtime.verifyDelivery.bind(runtime);
    runtime.verifyDelivery = async (job, signal) => {
      const result = await verify(job, signal);
      await writeFile(join(f.options.outputDir, "external-edit.txt"), "changed after sealing");
      return result;
    };
    const result = await f.run();
    assert.equal(result.status, "failed"); assert.deepEqual(result.verifiedRequirementIds, []);
    assert.equal(result.delivery?.stage, "candidate");
    assert.equal(await readFile(join(f.options.outputDir, "external-edit.txt"), "utf8"), "changed after sealing");
  });
});

test("A runnable ancestor can be delivered while newer sealed source remains recoverable", async () => {
  await withModulePipeline(async f => {
    const runtime = await attach(f, async job => {
      const snapshot = await runtime.snapshots.open(job.snapshot);
      if (await readFile(join(snapshot.sourceDirectory, "cannot-run.txt")).then(() => true, () => false)) throw new Error("Application cannot start");
    });
    const verify = runtime.verifyDelivery.bind(runtime);
    runtime.verifyDelivery = async (job, signal) => {
      const snapshot = await runtime.snapshots.open(job.snapshot);
      const broken = await readFile(join(snapshot.sourceDirectory, "cannot-run.txt")).then(() => true, () => false);
      return broken ? { report: { ok: false, stage: "readiness", message: "Cannot start" }, receipts: [] } : verify(job, signal);
    };
    const build = f.builder.run.bind(f.builder);
    f.builder.run = async (request, options) => {
      const result = await build(request, options);
      if (request.mode === "implement" && request.packet.requirementIds[0] === "C") await writeFile(join(f.options.outputDir, "cannot-run.txt"), "newer source");
      return request.mode === "repair" || request.mode === "delivery_repair" ? { ...result, outcome: "failed" } : result;
    };
    const result = await f.run();
    assert.equal(result.status, "partial"); assert.deepEqual(result.verifiedRequirementIds.sort(), ["A", "B"]);
    assert.deepEqual(result.implementedRequirementIds?.sort(), ["A", "B"]);
    await assert.rejects(readFile(join(f.options.outputDir, "cannot-run.txt")));
    const newest = await runtime.snapshots.open(result.verifier!.producedHead!.snapshot);
    assert.equal(await readFile(join(newest.sourceDirectory, "cannot-run.txt"), "utf8"), "newer source");
    assert.notEqual(result.verifier!.producedHead!.snapshot.id, result.verifier!.verifiedSnapshotId);
  });
});

test("One concentrated repair retains partial improvement and leaves remaining failures for the final report", async () => {
  await withModulePipeline(async f => {
    const jobs: CheckJob[] = [];
    const runtime = await attach(f, async job => { jobs.push(job); }, async job => {
      const snapshot = await runtime.snapshots.open(job.snapshot);
      const repaired = await readFile(join(snapshot.sourceDirectory, "partial-improvement.txt")).then(() => true, () => false);
      if (job.requirementIds[0] === "A") return "fail";
      return job.requirementIds[0] === "B" && !repaired ? "fail" : "pass";
    });
    const build = f.builder.run.bind(f.builder);
    f.builder.run = async (request, options) => {
      const result = await build(request, options);
      if (request.mode === "repair") await writeFile(join(f.options.outputDir, "partial-improvement.txt"), "B fixed");
      return result;
    };
    const result = await f.run();
    assert.equal(result.status, "partial"); assert.deepEqual(result.failedRequirementIds, ["A"]);
    assert.ok(result.verifiedRequirementIds.includes("B"));
    assert.equal(f.builder.requests.filter(request => request.mode === "repair").length, 1, "remaining failures cannot start a second business repair");
    const decision = (await f.events()).find(item => item.type === "repair_batch_finished" && item.detail?.retained === true);
    assert.ok(decision?.type === "repair_batch_finished" && decision.detail);
    assert.notEqual(decision.detail.baselineSnapshotId, decision.detail.candidateSnapshotId);
    assert.equal(decision.detail.retainedSnapshotId, decision.detail.candidateSnapshotId);
    assert.ok(decision.detail.checkJobIds!.length > 0);
    assert.ok(jobs.every(job => job.initialState.id === runtime.initialState.id));
    assert.ok(jobs.every(job => job.timeoutMs === 3_600_000));
    const audit = jobs.filter(job => job.mode !== "prepare");
    for (const epoch of new Set(audit.map(job => job.moduleEpoch))) {
      const round = audit.filter(job => job.moduleEpoch === epoch);
      assert.equal(new Set(round.map(job => job.packetId)).size, round.length);
    }
  });
});

test("Delivery repair decisions link retained versions and their persisted delivery checks", async () => {
  for (const retained of [false, true]) await withModulePipeline(async f => {
    const runtime = await attach(f);
    const verify = runtime.verifyDelivery.bind(runtime);
    runtime.verifyDelivery = async (job, signal) => {
      const snapshot = await runtime.snapshots.open(job.snapshot);
      const fixed = await readFile(join(snapshot.sourceDirectory, "delivery-fixed.txt")).then(() => true, () => false);
      return retained && fixed ? verify(job, signal)
        : { report: { ok: false, stage: "readiness", message: "Delivery needs repair" }, receipts: [] };
    };
    const build = f.builder.run.bind(f.builder);
    f.builder.run = async (request, options) => {
      const result = await build(request, options);
      if (request.mode === "delivery_repair") await writeFile(join(f.options.outputDir, "delivery-fixed.txt"), "fixed");
      return result;
    };
    const result = await f.run();
    assert.equal(result.status, retained ? "delivered" : "failed");
    const decisions = (await f.events()).filter(item => item.type === "delivery_repair_accepted" || item.type === "delivery_repair_restored");
    assert.equal(decisions.length, retained ? 1 : 3);
    for (const decision of decisions) {
      assert.ok(decision.type === "delivery_repair_accepted" || decision.type === "delivery_repair_restored");
      const detail = decision.detail!;
      assert.notEqual(detail.candidateSnapshotId, detail.baselineSnapshotId);
      assert.equal(detail.retainedSnapshotId, retained ? detail.candidateSnapshotId : detail.baselineSnapshotId);
      assert.ok(detail.deliveryJobId);
      const check = JSON.parse(await readFile(join(runtime.directory, "delivery", `${detail.deliveryJobId}.json`), "utf8"));
      const job = await runtime.artifacts.getJson<CheckJob>(check.job);
      assert.equal(job.snapshot.id, detail.candidateSnapshotId);
      assert.equal(check.report.ok, retained);
    }
  });
});

test("Verifier jobs use the fixed execution limit across all stages", async () => {
  await withModulePipeline(async f => {
    const jobs: CheckJob[] = [];
    await attach(f, async job => { jobs.push(job); });
    assert.equal((await f.run()).status, "delivered");
    assert.ok(jobs.length > 0);
    assert.ok(jobs.every(job => job.timeoutMs === 3_600_000));
  });
});

test("Elapsed run time does not shorten grouping, implementation, continuation or verification", async () => {
  await withModulePipeline(async f => {
    const jobs: CheckJob[] = [];
    await attach(f, async job => { jobs.push(job); });
    let clock = 7 * 24 * 3_600_000;
    f.options.startedAtMs = 0;
    f.deps.clock.nowMs = () => clock;
    f.deps.grouper = { async group(catalog, options) {
      assert.equal(options.timeoutMs, 720_000);
      return { groups: catalog.requirements.map(item => ({ requirementIds: [item.id], purpose: "Separate groups" })) };
    } };
    const build = f.builder.run.bind(f.builder);
    f.builder.run = async (request, options) => {
      clock += 4 * 3_600_000;
      const result = await build(request, options);
      return f.builder.requests.length === 1 ? { ...result, outcome: "timed_out" } : result;
    };
    const result = await f.run();
    assert.equal(result.status, "delivered");
    assert.deepEqual(result.verifiedRequirementIds, ["A", "B", "C"]);
    assert.equal(f.builder.runOptions.length, 4);
    for (const options of f.builder.runOptions) {
      const limit = options?.resumeInterrupted ? 2_700_000 : 5_400_000;
      assert.ok(options!.timeoutMs! > limit - 60_000 && options!.timeoutMs! <= limit);
    }
    assert.equal(f.builder.runOptions[1]?.resumeInterrupted, true);
    assert.ok(jobs.length > 0 && jobs.every(job => job.timeoutMs === 3_600_000));
  });
});

test("Checkpoint readiness is monotone and a rejected ready descendant never promotes an unready baseline", async () => {
  await withModulePipeline(async f => {
    const file = join(dirname(f.options.ledgerFile), "verifier", "controller.json");
    await mkdir(dirname(file), { recursive: true });
    const store = await VerifierCheckpoints.open(file, "binding", "initial");
    const ref = (value: string) => ({ id: value, digest: value });
    const a = await store.produced({ snapshot: ref("A"), sourceSha: "sha-A", implementedRequirementIds: ["A"] });
    const b = await store.produced({ snapshot: ref("B"), sourceSha: "sha-B", parentSnapshotId: a.snapshot.id, implementedRequirementIds: ["A", "B"] });
    await store.ready(b.snapshot); await store.ready(a.snapshot);
    assert.equal(store.snapshot.accepted.sha, "sha-B");
    const unready = await store.produced({ snapshot: ref("unready"), sourceSha: "sha-unready", parentSnapshotId: b.snapshot.id, implementedRequirementIds: ["A", "B"] });
    const repaired = await store.produced({ snapshot: ref("repair"), sourceSha: "sha-repair", parentSnapshotId: unready.snapshot.id, implementedRequirementIds: ["A", "B"] });
    await store.ready(repaired.snapshot); await store.restore(unready);
    assert.equal(store.snapshot.producedHead?.sourceSha, "sha-unready");
    assert.equal(store.snapshot.accepted.sha, "sha-B");
    const reopened = await VerifierCheckpoints.open(file, "binding", "ignored-initial");
    assert.equal(reopened.snapshot.accepted.sha, "sha-B");
    await assert.rejects(VerifierCheckpoints.open(file, "changed-binding", "initial"), /binding changed/);
    assert.equal(await reopened.ready(repaired.snapshot), false);
  });
});


test("Final failure diagnosis can fix a program without invoking Builder or repeating unchanged full replay", async () => {
  for (const replay of [false, true]) await withModulePipeline(async f => {
    const jobs: CheckJob[] = [];
    await attach(f, async job => { jobs.push(job); }, async job => job.requirementIds.includes("A") && job.mode !== "diagnose" ? "fail" : "pass");
    f.options.verifier = { ...parseVerifierConfig({}), replay };
    const result = await f.run();
    assert.equal(result.status, "delivered");
    assert.equal(f.builder.requests.some(request => request.mode === "repair"), false);
    assert.deepEqual(jobs.filter(job => job.mode === "diagnose").map(job => job.requirementIds), [["A"]]);
    const full = jobs.filter(job => job.mode === "replay" && !job.clauseIds);
    assert.equal(full.length, replay ? 3 : 0);
    assert.equal(result.verifier?.verifiedSnapshotId !== undefined, replay);
  });
});

test("Repair target checks defer sibling regressions to the last full check and do not start another repair", async () => {
  await withModulePipeline(async f => {
    const jobs: CheckJob[] = [];
    const runtime = await attach(f, async job => { jobs.push(job); }, async job => {
      const candidate = await runtime.snapshots.open(job.snapshot);
      const fixed = await readFile(join(candidate.sourceDirectory, "fix-A.txt")).then(() => true, () => false);
      return job.requirementIds.includes("A") ? fixed ? "pass" : "fail" : job.requirementIds.includes("B") && fixed ? "fail" : "pass";
    });
    const build = f.builder.run.bind(f.builder);
    f.builder.run = async (request, options) => {
      const result = await build(request, options);
      if (request.mode === "repair") await writeFile(join(f.options.outputDir, "fix-A.txt"), "A fixed; B regressed");
      return result;
    };
    const result = await f.run();
    assert.equal(result.status, "partial"); assert.deepEqual(result.failedRequirementIds, ["B"]);
    assert.equal(result.verifier?.verifiedSnapshotId, undefined);
    assert.equal(f.builder.requests.filter(request => request.mode === "repair").length, 1);
    const targets = jobs.filter(job => job.mode === "replay" && job.clauseIds);
    assert.deepEqual(targets.map(job => job.requirementIds), [["A"]]);
    const full = jobs.filter(job => job.mode === "replay" && !job.clauseIds);
    assert.equal(new Set(full.map(job => job.snapshot.id)).size, 2);
    assert.equal(full.length, 6, "two full passes over three groups, with no boundary replay");
    assert(result.verifier!.outcomes!.every(outcome => outcome.snapshotId === result.verifier!.producedHead!.snapshot.id));
  });
});

test("Local diagnosis preserves a passing sibling scenario and only rechecks the failed scenario", async () => {
  await withModulePipeline(async f => {
    const input = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    input.children[0].children[0].scenarios = ["one", "two"].map(id => ({ id, name: id, steps: [
      { keyword: "GIVEN", content: "Workspace open" }, { keyword: "WHEN", content: "Save" }, { keyword: "THEN", content: "Saved" }] }));
    await writeFile(f.options.requirementsFile, JSON.stringify(input));
    const jobs: CheckJob[] = [];
    const runtime = await attach(f, async job => { jobs.push(job); });
    f.options.verifier.replay = false;
    const check = runtime.verifier.check.bind(runtime.verifier);
    runtime.verifier.check = async (job, signal, progress) => {
      const report = await check(job, signal, progress);
      return { ...report, outcomes: report.outcomes.map(outcome => outcome.requirementId === "A" && outcome.scenarioId === "one" && job.mode !== "diagnose"
        ? { ...outcome, status: "inconclusive" as const, reason: "stale route" } : outcome) };
    };
    const result = await f.run();
    assert.equal(result.status, "delivered");
    const diagnosis = jobs.filter(job => job.mode === "diagnose");
    assert.equal(diagnosis.length, 1);
    assert(diagnosis[0].clauseIds?.every(id => id.includes(":one:")));
    const a = result.verifier!.outcomes!.filter(item => item.requirementId === "A");
    assert.deepEqual(new Set(a.map(item => item.scenarioId)), new Set(["one", "two"]));
    assert.equal(a.find(item => item.scenarioId === "two")!.jobId, jobs.find(job => job.mode === "discover" && job.requirementIds.includes("A"))!.jobId);
  });
});

test("Builder receives a bounded diff reader only after diagnosis and only for its confirmed repair cases", async () => {
  await withModulePipeline(async f => {
    const jobs: CheckJob[] = [];
    const runtime = await attach(f, async job => { jobs.push(job); });
    const check = runtime.verifier.check.bind(runtime.verifier);
    runtime.verifier.check = async (job, signal, progress) => {
      const report = await check(job, signal, progress);
      if (job.mode === "prepare") return report;
      const candidate = await runtime.snapshots.open(job.snapshot);
      const broken = await readFile(join(candidate.sourceDirectory, "broken.txt")).then(() => true, () => false);
      const outcomes = report.outcomes.map(item => item.requirementId === "A" && broken ? { ...item, status: "fail" as const } : item);
      const programs = await Promise.all(outcomes.map(async item => {
        const contract = await runtime.artifacts.putJson({ requirements: job.requirements, checkpoints: [],
          clauses: [{ id: item.clauseId, requirementId: item.requirementId, scenarioId: item.scenarioId, basis: "Display the main workspace.", checkpointId: "result", expected: true }] });
        return { contract, binding: job.binding, format: "fake@1", descriptor: await runtime.artifacts.putTypedJson({
          source: await runtime.artifacts.putBytes("stable application check"), initialState: job.initialState,
          clauses: [{ clauseId: item.clauseId, checkpointId: "result" }] }, runtime.initialState.schema) };
      }));
      return { ...report, outcomes, programs };
    };
    const build = f.builder.run.bind(f.builder);
    let consulted = false;
    f.builder.run = async (request, options) => {
      if (request.mode === "repair") {
        assert(jobs.some(job => job.mode === "diagnose"));
        assert(options?.repairDiff);
        const summary = await options.repairDiff({ caseId: "A/description/A:description:0:0" }) as { available: boolean; beforeSnapshotId: string; afterSnapshotId: string };
        assert.equal(summary.available, true);
        assert.notEqual(summary.beforeSnapshotId, summary.afterSnapshotId);
        await assert.rejects(options.repairDiff({ caseId: "C/unrelated" }), /outside/);
        consulted = true;
      } else assert.equal(options?.repairDiff, undefined);
      const result = await build(request, options);
      if (request.mode === "implement" && request.packet.requirementIds.includes("C")) await writeFile(join(f.options.outputDir, "broken.txt"), "regression");
      if (request.mode === "repair") await rm(join(f.options.outputDir, "broken.txt"));
      return result;
    };
    assert.equal((await f.run()).status, "delivered"); assert(consulted);
  });
});


test("An unresolved diagnosis cannot forward an old reproducible failure to Builder", async () => {
  await withModulePipeline(async f => {
    await attach(f, undefined, async job => job.requirementIds.includes("A") ? job.mode === "diagnose" ? "inconclusive" : "fail" : "pass");
    f.options.verifier.replay = false;
    const result = await f.run();
    assert.equal(result.status, "partial"); assert.deepEqual(result.inconclusiveRequirementIds, ["A"]);
    assert.deepEqual(result.failedRequirementIds, []);
    assert.equal(f.builder.requests.some(request => request.mode === "repair"), false);
  });
});
