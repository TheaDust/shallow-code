import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactStore, contentDigest } from "../src/checker/artifacts.js";
import { CheckerQueue } from "../src/checker/queue.js";
import type { AdapterDeclaration, CheckJob, CheckReport, ExecutionBindingRef } from "../src/checker/port.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "checker-core-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = new ArtifactStore(join(root, "artifacts"), "run");
  const schema = await artifacts.putJson({});
  const input = await artifacts.putTypedJson({}, schema);
  const executor = { id: "test", version: "1", digest: "release" };
  const declaration: AdapterDeclaration = { schemaVersion: 1, id: "test", version: "1", implementation: executor,
    execution: input, initialStates: [input], resourceKeys: [], capabilities: [], programFormat: { id: "test", version: "1", mediaType: "application/json", schema },
    observations: [], attachments: [], prompts: [] };
  const binding: ExecutionBindingRef = { ...await artifacts.putJson({ schemaVersion: 1, declaration: await artifacts.putJson(declaration), executor, schemas: [schema], dependencies: {}, promptDigest: contentDigest([]) }), executor };
  const snapshot = await artifacts.putJson({ snapshot: 1 });
  const requirements = await artifacts.putJson({ text: "input" });
  const job = (id: string, patch: Partial<CheckJob> = {}): CheckJob => ({ jobId: id, runId: "run", moduleId: "module", packetId: "packet", attempt: 1, moduleEpoch: 1,
    snapshot, requirements, binding, initialState: input, requirementIds: ["r1"], mode: "prepare", programs: [], budget: { deadlineAt: Date.now() + 60_000 }, ...patch });
  const report = async (job: CheckJob): Promise<CheckReport> => ({ job: await artifacts.putJson(job), snapshot: job.snapshot, binding: job.binding,
    manifest: await artifacts.putJson({ receipts: [] }), programs: [], outcomes: [] });
  return { root, artifacts, schema, input, binding, job, report };
}
function deferred<T = void>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function awaitStarted(queue: CheckerQueue, jobId: string, started: Promise<void>, signal: AbortSignal): Promise<void> {
  await Promise.race([started, queue.wait(jobId, signal).then(record => { throw new Error("Job ended before starting: " + JSON.stringify(record)); })]);
}

test("artifacts canonicalize JSON, enforce schemas and detect modified bytes and executor identity", async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.artifacts.putJson({ b: 2, a: 1 }), await f.artifacts.putJson({ a: 1, b: 2 }));
  const schema = await f.artifacts.putJson({ type: "object", required: ["count"], properties: { count: { type: "number" } }, additionalProperties: false });
  await assert.rejects(f.artifacts.putTypedJson({ count: "1" }, schema), /schema/);
  const ref = await f.artifacts.putTypedJson({ count: 1 }, schema);
  assert.deepEqual(await f.artifacts.readTypedJson(ref), { count: 1 });
  await writeFile(join(f.artifacts.directory, "objects", ref.id), "tampered");
  await assert.rejects(f.artifacts.getBytes(ref), /integrity/);
  await assert.rejects(f.artifacts.validateBinding({ ...f.binding, executor: { ...f.binding.executor, version: "wrong" } }), /binding mismatch/);
  await assert.rejects(f.artifacts.getBytes({ id: "../outside", digest: "x" }), /reference/);
});

test("concurrent identical artifact writes share one immutable publication on Windows", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  for (let index = 0; index < 12; index++) {
    const value = { receipts: [], index };
    const refs = await Promise.all(Array.from({ length: 16 }, () => f.artifacts.putJson(value)));
    assert.ok(refs.every(ref => ref.digest === refs[0].digest));
    assert.deepEqual(await f.artifacts.getJson(refs[0]), value);
  }
});

test("queue caps concurrency, excludes opaque shared resources and commits fixed identities before execution", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  let running = 0, maximum = 0;
  const release = deferred();
  const twoStarted = deferred();
  const started: string[] = [];
  const queue = await CheckerQueue.open({ directory: join(f.root, "queue"), artifacts: f.artifacts, concurrency: 2,
    resourceKeys: job => job.packetId === "shared" ? ["resource:shared"] : [], checker: { async check(job) {
      assert.ok(Object.isFrozen(job)); assert.ok(Object.isFrozen(job.budget)); assert.ok(Object.isFrozen(job.requirementIds));
      const state = JSON.parse(await readFile(join(f.root, "queue", "state.json"), "utf8"));
      assert.equal(state.records.find((record: { job: CheckJob }) => record.job.jobId === job.jobId).status, "running");
      started.push(job.jobId); maximum = Math.max(maximum, ++running);
      if (started.length === 2) twoStarted.resolve();
      await release.promise; running--; return f.report(job);
    } } });
  const one = f.job("one", { packetId: "shared" }), two = f.job("two", { packetId: "shared" }), three = f.job("three");
  try {
  await queue.enqueue(one); await queue.enqueue(two); await queue.enqueue(three);
  await awaitStarted(queue, "three", twoStarted.promise, t.signal);
  assert.deepEqual(started, ["one", "three"]);
  assert.equal(maximum, 2);
  await assert.rejects(queue.enqueue({ ...one, attempt: 2 }), /identity/);
  release.resolve(); await queue.drain(t.signal);
  assert.equal(queue.records().filter(record => record.status === "completed").length, 3);
  const persisted = JSON.parse(await readFile(join(f.root, "queue", "state.json"), "utf8"));
  assert.ok(persisted.records.every((record: { report?: unknown }) => record.report), JSON.stringify(persisted.records));
  await queue.enqueue(one); await queue.drain(); assert.equal(started.length, 3);
  assert.equal((await queue.publish({ moduleId: "module", moduleEpoch: 1, snapshot: one.snapshot, binding: one.binding, requirementIds: ["r1"] })).length, 3);
  assert.deepEqual(await queue.publish({ moduleId: "module", moduleEpoch: 2, snapshot: one.snapshot, binding: one.binding, requirementIds: ["r1"] }), []);
  } finally { release.resolve(); await queue.drain(t.signal).catch(() => {}); }
});

test("cancellation waits for cleanup and late reports never publish", { timeout: 30_000 }, async t => {
  const f = await fixture(t), began = deferred(), cleanup = deferred();
  let cleaned = false;
  const queue = await CheckerQueue.open({ directory: join(f.root, "queue"), artifacts: f.artifacts, resourceKeys: () => [], checker: { async check(job, signal) {
    began.resolve(); await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    await cleanup.promise; cleaned = true; return f.report(job);
  } } });
  const job = f.job("cancel");
  try {
  await queue.enqueue(job); await awaitStarted(queue, job.jobId, began.promise, t.signal);
  let resolved = false; const cancelled = queue.cancel(job.jobId).then(() => { resolved = true; });
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(resolved, false);
  cleanup.resolve(); await cancelled; assert.equal(cleaned, true);
  const record = await queue.wait(job.jobId); assert.equal(record.status, "cancelled"); assert.ok(record.lateReport); assert.equal(record.report, undefined);
  assert.deepEqual(await queue.publish({ moduleId: job.moduleId, moduleEpoch: 1, snapshot: job.snapshot, binding: job.binding, requirementIds: job.requirementIds }), []);
  } finally { cleanup.resolve(); await queue.cancel(job.jobId).catch(() => {}); }
});

test("deadline includes queue time and cancellation retains resource lease through cleanup", { timeout: 30_000 }, async t => {
  const f = await fixture(t), started = deferred(), cleaned = deferred();
  const order: string[] = [];
  const aborted = deferred();
  const queue = await CheckerQueue.open({ directory: join(f.root, "queue"), artifacts: f.artifacts, resourceKeys: () => ["singleton"], checker: { async check(job, signal) {
    order.push(job.jobId);
    if (job.jobId === "slow") {
      started.resolve(); await new Promise<void>(resolve => signal.addEventListener("abort", () => { aborted.resolve(); resolve(); }, { once: true })); await cleaned.promise;
    }
    return f.report(job);
  } } });
  try {
  await queue.enqueue(f.job("slow", { budget: { deadlineAt: Date.now() + 5_000 } }));
  await awaitStarted(queue, "slow", started.promise, t.signal);
  await queue.enqueue(f.job("waiting"));
  await queue.enqueue(f.job("expired", { budget: { deadlineAt: Date.now() - 1 } }));
  await awaitStarted(queue, "slow", aborted.promise, t.signal); assert.deepEqual(order, ["slow"]);
  cleaned.resolve(); await queue.drain(t.signal);
  assert.deepEqual(order, ["slow", "waiting"]);
  assert.equal(queue.records().find(record => record.job.jobId === "slow")?.status, "cancelled");
  assert.equal(queue.records().find(record => record.job.jobId === "expired")?.status, "cancelled");
  } finally { cleaned.resolve(); await queue.cancel("slow").catch(() => {}); await queue.drain(t.signal).catch(() => {}); }
});

test("recovery marks active work interrupted and refuses missing completed evidence", async t => {
  const f = await fixture(t), job = f.job("recover"), ref = await f.artifacts.putJson(job);
  const directory = join(f.root, "queue");
  const { mkdir } = await import("node:fs/promises"); await mkdir(directory);
  const record = { job, ref, resourceKeys: [], priority: 1, ordinal: 0, status: "running", queuedAt: 1 };
  await writeFile(join(directory, "state.json"), JSON.stringify({ schemaVersion: 1, records: [record], controller: { epoch: 4 } }));
  const options = { directory, artifacts: f.artifacts, resourceKeys: () => [], checker: { check: f.report } };
  const queue = await CheckerQueue.open(options);
  assert.equal(queue.records()[0].status, "interrupted"); assert.deepEqual(queue.controllerState(), { epoch: 4 });
  await queue.setControllerState({ epoch: 5 });
  const saved = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
  saved.records[0].status = "completed"; saved.records[0].report = { id: "a".repeat(64), digest: "a".repeat(64) };
  await writeFile(join(directory, "state.json"), JSON.stringify(saved));
  await assert.rejects(CheckerQueue.open(options), /ENOENT/);
});

test("queued replacement preserves scope and archives cancellation atomically", { timeout: 30_000 }, async t => {
  const f = await fixture(t), began = deferred(), release = deferred();
  const queue = await CheckerQueue.open({ directory: join(f.root, "queue"), artifacts: f.artifacts, concurrency: 1, resourceKeys: () => [], checker: { async check(job) {
    if (job.jobId === "busy") { began.resolve(); await release.promise; } return f.report(job);
  } } });
  try {
  await queue.enqueue(f.job("busy")); await awaitStarted(queue, "busy", began.promise, t.signal);
  await queue.enqueue(f.job("old", { requirementIds: ["r1", "r2"] }));
  await assert.rejects(queue.replaceQueued(["old"], f.job("bad")), /loses requirement scope/);
  await assert.rejects(queue.replaceQueued(["old"], f.job("wrong-initial-state", { requirementIds: ["r1", "r2"],
    initialState: await f.artifacts.putTypedJson({ mode: "different" }, f.schema) })), /loses execution scope/);
  await queue.replaceQueued(["old"], f.job("new", { requirementIds: ["r1", "r2", "r3"], moduleEpoch: 2 }));
  assert.equal(queue.records().find(record => record.job.jobId === "old")?.replacedBy, "new");
  release.resolve(); await queue.drain();
  assert.equal(queue.records().find(record => record.job.jobId === "old")?.status, "cancelled");
  assert.equal(queue.records().find(record => record.job.jobId === "new")?.status, "completed");
  } finally { release.resolve(); await queue.drain(t.signal).catch(() => {}); }
});

test("paused recovery can cancel historical queued work before starting workers", async t => {
  const f = await fixture(t); let invoked = 0;
  const queue = await CheckerQueue.open({ directory: join(f.root, "queue"), artifacts: f.artifacts, startPaused: true,
    resourceKeys: () => [], checker: { async check(job) { invoked++; return f.report(job); } } });
  await queue.enqueue(f.job("historic")); assert.equal(invoked, 0);
  await queue.cancel("historic"); queue.start(); await queue.drain();
  assert.equal(invoked, 0); assert.equal(queue.records()[0].status, "cancelled");
});

test("cleanup failure halts scheduling and preserves the failed execution lease", { timeout: 30_000 }, async t => {
  const f = await fixture(t), started = deferred(), release = deferred(); const invoked: string[] = [];
  const fault = Object.assign(new Error("owned process is still alive"), { code: "CHECKER_CLEANUP_FAILED" });
  const queue = await CheckerQueue.open({ directory: join(f.root, "queue"), artifacts: f.artifacts, concurrency: 1,
    resourceKeys: () => ["owned-resource"], checker: { async check(job) {
      invoked.push(job.jobId); started.resolve(); await release.promise; throw fault;
    } } });
  try {
  await queue.enqueue(f.job("leaked")); await awaitStarted(queue, "leaked", started.promise, t.signal);
  await queue.enqueue(f.job("next")); release.resolve();
  await assert.rejects(queue.drain(), /owned process/);
  assert.deepEqual(invoked, ["leaked"]);
  assert.equal(queue.records().find(record => record.job.jobId === "leaked")?.status, "interrupted");
  assert.equal(queue.records().find(record => record.job.jobId === "next")?.status, "queued");
  } finally { release.resolve(); await queue.drain(t.signal).catch(() => {}); }
});
