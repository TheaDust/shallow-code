import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { ArtifactStore, contentDigest } from "../src/checker/artifacts.js";
import { CheckerCheckpoints } from "../src/checker/checkpoints.js";
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
  const runtime: CheckerRuntime = { directory, artifacts, snapshots, binding, initialStates: [input], resourceKeys: [],
    async verifyDelivery() { return { ok: true, stage: "complete", message: "Fake execution readiness" }; },
    checker: { async check(job, signal): Promise<CheckReport> {
      await hook?.(job, signal);
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

test("Builder continues B while Checker reads sealed A and current final evidence alone publishes", async () => {
  await withModulePipeline(async f => {
    let started!: () => void;
    const checking = new Promise<void>(resolve => { started = resolve; });
    let checkingA = false, overlapped = false;
    const runtime = await attach(f, async (job, signal) => {
      if (job.requirementIds[0] !== "A" || job.moduleEpoch !== 0) return;
      checkingA = true; started();
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
      const sealed = await runtime.snapshots.open(job.snapshot);
      assert.equal(await readFile(join(sealed.sourceDirectory, "marker.txt"), "utf8"), "A");
      checkingA = false;
    });
    const build = f.builder.run.bind(f.builder);
    f.builder.run = async (request, options) => {
      if (request.mode === "implement" && request.packet.requirementIds[0] === "B") { await checking; overlapped = checkingA; }
      const result = await build(request, options);
      await writeFile(join(f.options.outputDir, "marker.txt"), request.mode === "implement" ? request.packet.requirementIds[0] : "repair");
      return result;
    };
    const result = await f.run();
    assert.equal(overlapped, true); assert.equal(result.status, "delivered");
    assert.deepEqual(result.verifiedRequirementIds.sort(), ["A", "B", "C"]);
    assert.equal(f.builder.closeCount, 1);
    const events = await f.events();
    assert.ok(events.some(item => item.type === "check_cancelled" && item.detail?.archived));
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

test("Repair guards keep empty and inherited results separate when accepting partial improvement", async () => {
  await withModulePipeline(async f => {
    const runtime = await attach(f, undefined, async job => {
      const snapshot = await runtime.snapshots.open(job.snapshot);
      const repaired = await readFile(join(snapshot.sourceDirectory, "partial-improvement.txt")).then(() => true, () => false);
      if (job.requirementIds[0] === "A" && job.initialState.id === runtime.initialStates[1].id) return "fail";
      return job.requirementIds[0] === "B" && !repaired ? "fail" : "pass";
    });
    const schema = await runtime.artifacts.putJson({});
    runtime.initialStates.push(await runtime.artifacts.putTypedJson({ mode: "empty" }, schema));
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
