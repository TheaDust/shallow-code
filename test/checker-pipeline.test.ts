import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { ArtifactStore, contentDigest } from "../src/checker/artifacts.js";
import { CheckerCheckpoints, readCheckerCheckpoint } from "../src/checker/checkpoints.js";
import type { AdapterDeclaration, CheckJob, CheckOutcome, CheckReport, ExecutionBindingRef } from "../src/checker/port.js";
import { SnapshotStore } from "../src/snapshot-store.js";
import type { CheckerRuntime } from "../src/checker-pipeline.js";
import { parseCheckerConfig } from "../src/runtime-config.js";
import { writeRunReport } from "../src/run-record.js";
import { HumanRunFormatter } from "../src/human-log.js";
import { BuildView } from "../src/terminal/build-tui.js";
import { terminalTheme } from "../src/terminal/theme.js";
import { withModulePipeline, type PipelineFixture } from "./helpers/module-pipeline.js";

async function attach(f: PipelineFixture, hook?: (job: CheckJob, signal: AbortSignal) => Promise<void>,
  status?: (job: CheckJob) => Promise<CheckOutcome["status"]>): Promise<CheckerRuntime> {
  const directory = join(dirname(f.options.ledgerFile), "checker");
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
  const runtime: CheckerRuntime = { directory, artifacts, snapshots, binding, initialState: input, resourceKeys: [],
    async verifyDelivery() { return { ok: true, stage: "complete", message: "Fake execution readiness" }; },
    checker: { async check(job, signal, onProgress): Promise<CheckReport> {
      await onProgress?.({ stage: "prepare" });
      await hook?.(job, signal);
      if (job.mode !== "prepare") await onProgress?.({ stage: "replay" });
      const environment = await artifacts.putTypedJson({ instance: ++instance }, schema);
      const ready = await artifacts.putReceipt(job, { id: `receipt-${instance}`, job: await artifacts.putJson(job),
        snapshot: job.snapshot, binding, environment, sequence: 0, recordedAt: new Date().toISOString(),
        kind: "readiness", readiness: { result: "ready" }, inputs: [], payload: input, attachments: [] });
      return { job: await artifacts.putJson(job), snapshot: job.snapshot, binding, manifest: await artifacts.putJson({ receipts: [ready] }), programs: [],
        outcomes: job.mode === "prepare" ? [] : await Promise.all(job.requirementIds.map(async requirementId => ({ requirementId,
          scenarioId: "description", clauseId: `${requirementId}:result`, status: await status?.(job) ?? "pass", evidence: [ready] }))) };
    } } };
  f.options.checker = { mode: "active", concurrency: 2 };
  f.deps.checker = runtime;
  f.deps.grouper = { async group(catalog) { return { groups: catalog.requirements.map(item => ({ requirementIds: [item.id], purpose: "Separate groups" })) }; } };
  return runtime;
}

test("Checker configuration declares migration mode and bounded concurrency", () => {
  assert.deepEqual(parseCheckerConfig({}), { mode: "active", concurrency: 2 });
  assert.deepEqual(parseCheckerConfig({ SHALLOW_CHECKER_MODE: "active", SHALLOW_CHECKER_CONCURRENCY: "1" }), { mode: "active", concurrency: 1 });
  assert.throws(() => parseCheckerConfig({ SHALLOW_CHECKER_MODE: "agent" }));
  for (const mode of ["legacy", "observe"]) assert.throws(() => parseCheckerConfig({ SHALLOW_CHECKER_MODE: mode }), /only supports active/);
  assert.throws(() => parseCheckerConfig({ SHALLOW_CHECKER_CONCURRENCY: "3" }));
});

test("Gateway transport recovery retries feature grouping before dispatch", async () => {
  await withModulePipeline(async f => {
    await attach(f);
    let calls = 0;
    f.deps.grouper = { async group(catalog) {
      if (++calls === 1) throw Object.assign(new Error("gateway temporarily unavailable"), {
        gatewayFailure: { kind: "unavailable" as const, retryable: true },
      });
      return { groups: catalog.requirements.map(item => ({ requirementIds: [item.id], purpose: "Separate groups" })) };
    } };
    const result = await f.run();
    assert.equal(calls, 2);
    const waits = (await f.events()).filter(event => event.type === "gateway_wait");
    assert.equal(waits.length, 1);
    assert.equal(waits[0]!.detail?.source, "planning");
    assert.notEqual(result.status, "failed");
  });
});

test("Checker progress reaches the correlated event ledger without granting verification", async () => {
  await withModulePipeline(async f => {
    await attach(f);
    await f.run();
    const events = await f.events();
    const progress = events.filter(item => item.type === "check_progress");
    assert(progress.length > 0);
    for (const event of progress) {
      assert.equal(event.phase, "checker");
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

test("In-flight Checker usage reaches only the live view, not the ledger or settled report", async () => {
  await withModulePipeline(async f => {
    const runtime = await attach(f);
    const presented: string[] = [];
    f.deps.logSink = { write() {}, present: chunk => { presented.push(chunk); } };
    let progressRecorder: Parameters<NonNullable<CheckerRuntime["setUsageProgressRecorder"]>>[0] | undefined;
    runtime.setUsageProgressRecorder = recorder => { progressRecorder = recorder; };
    const check = runtime.checker.check.bind(runtime.checker);
    runtime.checker.check = async (job, signal, onProgress) => {
      progressRecorder?.({ jobId: job.jobId, role: "exploration", input: 10, output: 2,
        cacheRead: 0, cacheWrite: 0, total: 12, cost: 0.0001 });
      return check(job, signal, onProgress);
    };
    const result = await f.run();
    const live = presented.map(chunk => JSON.parse(chunk) as { type: string; phase?: string; detail?: { total?: number } })
      .filter(event => event.type === "checker_usage_progress");
    assert.ok(live.length > 0);
    assert.equal(live[0]!.phase, "checker");
    assert.equal(live[0]!.detail?.total, 12);
    assert.equal((await f.events()).some(event => event.type === "checker_usage_progress"), false,
      "display-only usage never enters the ledger");
    assert.equal(result.modelUsage?.checker.total, 0, "in-flight usage is display-only");
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

test("Current changed requirements are audited while inherited Evolution context remains explicitly skipped", async () => {
  await withModulePipeline(async f => {
    await attach(f);
    const input = JSON.parse(await readFile(f.options.requirementsFile, "utf8"));
    input.type = "ROOT";
    input.name = "Product - Evolution";
    await writeFile(f.options.requirementsFile, JSON.stringify(input));
    f.options.stageStartingPoint = "inherited_application";
    f.options.auditInheritedRequirements = false;
    f.options.historicalRequirements = { requirementIds: ["A"], plans: 0, ignoredPlans: 0,
      planRequirementCount: 0, checkpointRequirementCount: 1, checkpointSupplementCount: 1, requirementDigests: {} };
    const result = await f.run();
    assert.deepEqual(result.skippedRequirementIds, ["A"]);
    assert.deepEqual(result.verifiedRequirementIds.sort(), ["B", "C"]);
    assert.ok(!f.builder.requests.some(request => request.mode === "implement" && request.packet.requirementIds.includes("A")));
  });
});

test("Feature groups retain sealed snapshots and Checker starts on the latest module snapshot at closure", async () => {
  await withModulePipeline(async f => {
    const jobs: CheckJob[] = [];
    const runtime = await attach(f, async job => { jobs.push(job); });
    const build = f.builder.run.bind(f.builder);
    f.builder.run = async (request, options) => {
      if (request.mode === "implement" && request.packet.requirementIds[0] === "B") {
        assert.equal(jobs.length, 0);
        const checkpoint = await readCheckerCheckpoint(join(runtime.directory, "controller.json"));
        assert.deepEqual(checkpoint!.producedHead!.implementedRequirementIds, ["A"]);
        assert.equal(checkpoint!.accepted.ordinal, 0);
      }
      const result = await build(request, options);
      await writeFile(join(f.options.outputDir, "marker.txt"), request.mode === "implement" ? request.packet.requirementIds[0] : "repair");
      return result;
    };
    const result = await f.run();
    assert.equal(result.status, "delivered");
    assert.deepEqual(result.verifiedRequirementIds.sort(), ["A", "B", "C"]);
    assert.equal(f.builder.closeCount, 1);
    const checkpoint = await readCheckerCheckpoint(join(runtime.directory, "controller.json"));
    assert.equal(checkpoint!.snapshots.length, 3);
    for (const [index, marker] of ["A", "B", "C"].entries()) {
      const sealed = await runtime.snapshots.open(checkpoint!.snapshots[index].snapshot);
      assert.equal(await readFile(join(sealed.sourceDirectory, "marker.txt"), "utf8"), marker);
    }
    assert.ok(!jobs.some(job => job.snapshot.id === checkpoint!.snapshots[0].snapshot.id));
    const firstModuleJobs = jobs.filter(job => job.moduleEpoch === 1);
    assert.equal(firstModuleJobs.length, 3);
    assert.ok(firstModuleJobs.every(job => job.snapshot.id === checkpoint!.snapshots[1].snapshot.id));
    assert.deepEqual(firstModuleJobs.filter(job => job.mode !== "prepare").flatMap(job => job.requirementIds).sort(), ["A", "B"]);
    const events = await f.events();
    assert.ok(!events.some(item => item.type === "check_cancelled"));
    const boundary = events.findIndex(item => item.type === "module_check_started");
    assert.ok(boundary >= 0);
    assert.ok(!events.slice(0, boundary).some(item => item.type === "check_queued" || item.type === "check_started"));
    assert.ok(events.some(item => item.type === "module_check_finished" && item.detail?.moduleId === "<final>"));
    await writeRunReport(dirname(f.options.ledgerFile), result);
    assert.match(await readFile(join(dirname(f.options.ledgerFile), "checker-report.md"), "utf8"), /Checker 验收证据/);
    const ledger = events.map(item => item.sequence);
    assert.deepEqual(ledger, Array.from({ length: ledger.length }, (_, i) => i + 1));
  });
});

test("Module boundary rechecks prerequisite behavior changed by a later module", async () => {
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

test("Checker observations update only published current results in the terminal", () => {
  const view = new BuildView({ requirementIds: ["A"], models: { builder: "b", checker: "c" }, onInterrupt() {} }, () => 24, terminalTheme(false));
  const formatter = new HumanRunFormatter();
  const event = { at: "2026-10-16T00:00:00Z", type: "module_check_finished" as const,
    detail: { moduleId: "M", moduleEpoch: 2, snapshotId: "snapshot", published: true, requirementResults: { A: "verified" as const } } };
  view.receive(event, formatter.format(JSON.stringify(event))!);
  assert.match(view.render(100).join("\n"), /已验证 1\/1/);
  view.receive({ ...event, detail: { ...event.detail, published: false, requirementResults: { A: "failed" } } }, "历史结果");
  assert.match(view.render(100).join("\n"), /已验证 1\/1/);
  view.receive({ at: event.at, type: "snapshot_sealed", detail: { snapshotId: "new", sourceSha: "new-sha", requirementIds: ["A"], sequence: 2 } }, "新版本");
  assert.match(view.render(100).join("\n"), /已验证 0\/1/);
});

test("Rejected repair restores the complete module, including B produced after A", async () => {
  await withModulePipeline(async f => {
    const runtime = await attach(f, undefined, async job => {
      const snapshot = await runtime.snapshots.open(job.snapshot);
      const repaired = await readFile(join(snapshot.sourceDirectory, "repaired.txt"), "utf8").then(() => true, () => false);
      return job.requirementIds[0] === "A" ? repaired ? "pass" : "fail" : job.requirementIds[0] === "B" && repaired ? "fail" : "pass";
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
    assert.ok((await f.events()).some(item => item.type === "repair_batch_finished" && item.detail?.retained === false));
  });
});


test("Source drift after final snapshot invalidates delivery and its current verification", async () => {
  await withModulePipeline(async f => {
    const runtime = await attach(f);
    runtime.verifyDelivery = async () => {
      await writeFile(join(f.options.outputDir, "external-edit.txt"), "changed after sealing");
      return { ok: true, stage: "complete", message: "execution itself was ready" };
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
    runtime.verifyDelivery = async job => {
      const snapshot = await runtime.snapshots.open(job.snapshot);
      const broken = await readFile(join(snapshot.sourceDirectory, "cannot-run.txt")).then(() => true, () => false);
      return { ok: !broken, stage: broken ? "readiness" : "complete", message: broken ? "Cannot start" : "Ready" };
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
    const newest = await runtime.snapshots.open(result.checker!.producedHead!.snapshot);
    assert.equal(await readFile(join(newest.sourceDirectory, "cannot-run.txt"), "utf8"), "newer source");
    assert.notEqual(result.checker!.producedHead!.snapshot.id, result.checker!.verifiedSnapshotId);
  });
});

test("Repair retains partial improvement and checks each packet once per round from the bound input state", async () => {
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
    assert.ok((await f.events()).some(item => item.type === "repair_batch_finished" && item.detail?.retained === true));
    assert.ok(jobs.every(job => job.initialState.id === runtime.initialState.id));
    assert.ok(jobs.every(job => job.budget.timeoutMs === 1_800_000));
    const audit = jobs.filter(job => job.mode !== "prepare");
    // A repair is checked twice for confirmation; the first module audit and final audit each check once.
    for (const epoch of [1, Math.max(...audit.map(job => job.moduleEpoch))]) {
      const round = audit.filter(job => job.moduleEpoch === epoch);
      assert.equal(new Set(round.map(job => job.packetId)).size, round.length);
    }
  });
});

test("Checker execution allowances are independent of queue time and share only the total run limit", async () => {
  await withModulePipeline(async f => {
    const jobs: CheckJob[] = [];
    await attach(f, async job => { jobs.push(job); });
    f.options.totalBudgetMs = 3_600_000;
    assert.equal((await f.run()).status, "delivered");
    assert.ok(jobs.length > 0);
    assert.ok(jobs.every(job => job.budget.timeoutMs === 1_800_000));
    assert.ok(jobs.every(job => job.budget.deadlineAt - Date.now() > 1_800_000));
  });
});

test("Checkpoint readiness is monotone and a rejected ready descendant never promotes an unready baseline", async () => {
  await withModulePipeline(async f => {
    const file = join(dirname(f.options.ledgerFile), "checker", "controller.json");
    await mkdir(dirname(file), { recursive: true });
    const store = await CheckerCheckpoints.open(file, "binding", "initial");
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
    const reopened = await CheckerCheckpoints.open(file, "binding", "ignored-initial");
    assert.equal(reopened.snapshot.accepted.sha, "sha-B");
    await assert.rejects(CheckerCheckpoints.open(file, "changed-binding", "initial"), /binding changed/);
    assert.equal(await reopened.ready(repaired.snapshot), false);
  });
});
