import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactStore, atomicWrite, canonicalJson, sameRef } from "./artifacts.js";
import type { CheckJob, CheckerPort, CheckReport, ContentRef, ExecutionBindingRef } from "./port.js";

export type CheckJobStatus = "queued" | "running" | "completed" | "cancelled" | "interrupted";
export interface QueueRecord {
  job: CheckJob;
  ref: ContentRef;
  resourceKeys: string[];
  priority: number;
  ordinal: number;
  status: CheckJobStatus;
  queuedAt: number;
  startedAt?: number;
  completedAt?: number;
  report?: ContentRef;
  lateReport?: ContentRef;
  error?: string;
  replacedBy?: string;
}
interface QueueState { schemaVersion: 1; records: QueueRecord[]; controller: unknown }
export interface CheckerQueueOptions {
  directory: string;
  checker: CheckerPort;
  artifacts: ArtifactStore;
  concurrency?: number;
  /** Recovery may cancel persisted queued work before enabling any execution. */
  startPaused?: boolean;
  resourceKeys(job: Readonly<CheckJob>): string[] | Promise<string[]>;
}
export interface CheckProjection {
  moduleId: string;
  moduleEpoch: number;
  snapshot: ContentRef;
  binding: ExecutionBindingRef;
  requirementIds: string[];
}
interface ActiveJob { abort: AbortController; done: Promise<void>; keys: string[] }
function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) immutable(item);
    Object.freeze(value);
  }
  return value;
}

/** A single-controller durable scheduler. A running slot remains occupied until cleanup resolves. */
export class CheckerQueue {
  private state: QueueState = { schemaVersion: 1, records: [], controller: null };
  private commit: Promise<void> = Promise.resolve();
  private active = new Map<string, ActiveJob>();
  private pumping = false;
  private changed = new Set<() => void>();
  private failure?: unknown;
  private paused: boolean;
  private constructor(private readonly options: CheckerQueueOptions) { this.paused = options.startPaused ?? false; }
  start(): void { this.paused = false; this.kick(); }
  static async open(options: CheckerQueueOptions): Promise<CheckerQueue> {
    if (!Number.isInteger(options.concurrency ?? 2) || (options.concurrency ?? 2) < 1 || (options.concurrency ?? 2) > 2) throw new Error("Checker concurrency must be 1 or 2");
    const queue = new CheckerQueue(options);
    let saved: string | undefined;
    try { saved = await readFile(join(options.directory, "state.json"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (saved !== undefined) {
      queue.state = JSON.parse(saved);
      if (queue.state.schemaVersion !== 1 || !Array.isArray(queue.state.records)) throw new Error("Unsupported Checker queue state");
      const identities = new Set<string>();
      for (const record of queue.state.records) {
        if (!record.job?.jobId || identities.has(record.job.jobId) || !["queued", "running", "completed", "cancelled", "interrupted"].includes(record.status) ||
          !Number.isFinite(record.priority) || !Number.isInteger(record.ordinal) || !Array.isArray(record.resourceKeys) ||
          !record.resourceKeys.every(key => typeof key === "string" && key.length > 0)) throw new Error("Invalid Checker queue record");
        identities.add(record.job.jobId);
        if (record.job.runId !== options.artifacts.runId || !sameRef(await options.artifacts.putJson(record.job), record.ref)) throw new Error("Persisted job integrity mismatch");
        if (record.report) await options.artifacts.validateReport(record.job, await options.artifacts.getJson<CheckReport>(record.report));
        if (record.status === "running") { record.status = "interrupted"; record.error = "Controller stopped during execution; a fresh job is required"; }
      }
    }
    await queue.transaction(() => {});
    queue.kick();
    return queue;
  }
  records(): QueueRecord[] { return structuredClone(this.state.records); }
  controllerState<T = unknown>(): T { return structuredClone(this.state.controller) as T; }
  async setControllerState<T>(value: T): Promise<void> { await this.transaction(state => { state.controller = structuredClone(value); }); }
  async enqueue(job: CheckJob, options: { priority?: number } = {}): Promise<ContentRef> {
    const fixed = immutable(structuredClone(job));
    if (fixed.runId !== this.options.artifacts.runId || !fixed.jobId || !Number.isFinite(fixed.budget.deadlineAt) ||
      (fixed.budget.timeoutMs !== undefined && (!Number.isFinite(fixed.budget.timeoutMs) || fixed.budget.timeoutMs <= 0)) || !Number.isInteger(fixed.moduleEpoch) ||
      !Array.isArray(fixed.requirementIds) || new Set(fixed.requirementIds).size !== fixed.requirementIds.length) throw new Error("Invalid Checker job");
    await this.options.artifacts.validateBinding(fixed.binding);
    await this.options.artifacts.getBytes(fixed.requirements);
    await this.options.artifacts.readTypedJson(fixed.initialState);
    const ref = await this.options.artifacts.putJson(fixed);
    const keys = [...new Set(await this.options.resourceKeys(fixed))].sort();
    if (!keys.every(key => typeof key === "string" && key.length > 0)) throw new Error("Invalid resource key");
    await this.transaction(state => {
      const existing = state.records.find(record => record.job.jobId === fixed.jobId);
      if (existing) { if (!sameRef(existing.ref, ref)) throw new Error("Job identity is already bound to different contents"); return; }
      state.records.push({ job: fixed, ref, resourceKeys: keys, priority: options.priority ?? 3,
        ordinal: state.records.length, status: "queued", queuedAt: Date.now() });
    });
    this.kick();
    return ref;
  }
  /** Atomically replaces queued work; every old requirement must remain in the replacement. */
  async replaceQueued(jobIds: string[], replacement: CheckJob, options: { priority?: number } = {}): Promise<ContentRef> {
    replacement = immutable(structuredClone(replacement));
    const ref = await this.options.artifacts.putJson(replacement);
    await this.options.artifacts.validateBinding(replacement.binding);
    await this.options.artifacts.readTypedJson(replacement.initialState);
    await this.options.artifacts.getBytes(replacement.requirements);
    const keys = [...new Set(await this.options.resourceKeys(replacement))].sort();
    await this.transaction(state => {
      if (replacement.runId !== this.options.artifacts.runId || state.records.some(record => record.job.jobId === replacement.jobId)) throw new Error("Invalid replacement identity");
      const old = jobIds.map(id => {
        const record = state.records.find(record => record.job.jobId === id);
        if (!record || record.status !== "queued" || record.job.moduleId !== replacement.moduleId) throw new Error("Only queued work in the same module can be replaced");
        return record;
      });
      if (old.some(record => record.job.requirementIds.some(id => !replacement.requirementIds.includes(id)))) throw new Error("Replacement loses requirement scope");
      if (old.some(({ job }) => !sameRef(job.requirements, replacement.requirements) || canonicalJson(job.binding) !== canonicalJson(replacement.binding) ||
        canonicalJson(job.initialState) !== canonicalJson(replacement.initialState) || job.mode !== replacement.mode ||
        job.programs.some(program => !replacement.programs.some(next => canonicalJson(next) === canonicalJson(program))))) throw new Error("Replacement loses execution scope");
      state.records.push({ job: structuredClone(replacement), ref, resourceKeys: keys, priority: options.priority ?? 2,
        ordinal: state.records.length, status: "queued", queuedAt: Date.now() });
      for (const record of old) { record.status = "cancelled"; record.replacedBy = replacement.jobId; record.completedAt = Date.now(); }
    });
    this.kick();
    return ref;
  }
  async cancel(jobId: string): Promise<void> {
    await this.transaction(state => {
      const record = state.records.find(record => record.job.jobId === jobId);
      if (!record) throw new Error("Unknown Checker job: " + jobId);
      if (record.status === "queued" || record.status === "running") { record.status = "cancelled"; record.error = "Cancelled"; }
    });
    const active = this.active.get(jobId);
    if (active) { active.abort.abort(new Error("Checker job cancelled")); await active.done; }
    this.kick();
  }
  async drain(signal?: AbortSignal): Promise<void> {
    for (;;) {
      signal?.throwIfAborted();
      if (this.failure) throw this.failure;
      if (!this.state.records.some(record => record.status === "queued" || record.status === "running") && !this.active.size && !this.pumping) return;
      await new Promise<void>((resolve, reject) => {
        const wake = () => { signal?.removeEventListener("abort", abort); this.changed.delete(wake); resolve(); };
        const abort = () => { this.changed.delete(wake); reject(signal!.reason); };
        this.changed.add(wake);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
  }
  async wait(jobId: string, signal?: AbortSignal): Promise<QueueRecord> {
    for (;;) {
      signal?.throwIfAborted();
      if (this.failure) throw this.failure;
      const record = this.state.records.find(record => record.job.jobId === jobId);
      if (!record) throw new Error("Unknown Checker job: " + jobId);
      if (record.status !== "queued" && record.status !== "running" && !this.active.has(jobId)) return structuredClone(record);
      await new Promise<void>((resolve, reject) => {
        const wake = () => { signal?.removeEventListener("abort", abort); this.changed.delete(wake); resolve(); };
        const abort = () => { this.changed.delete(wake); reject(signal!.reason); };
        this.changed.add(wake);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
  }
  /** Reads only matching current-version results; historical reports remain archived. */
  async publish(projection: CheckProjection): Promise<CheckReport[]> {
    const reports: CheckReport[] = [];
    for (const record of this.state.records) {
      const job = record.job;
      if (record.status !== "completed" || !record.report || job.moduleId !== projection.moduleId || job.moduleEpoch !== projection.moduleEpoch ||
        !sameRef(job.snapshot, projection.snapshot) || canonicalJson(job.binding) !== canonicalJson(projection.binding)) continue;
      const report = await this.options.artifacts.getJson<CheckReport>(record.report);
      await this.options.artifacts.validateReport(job, report);
      reports.push({ ...report, outcomes: report.outcomes.filter(outcome => projection.requirementIds.includes(outcome.requirementId)) });
    }
    return reports;
  }
  private transaction(change: (state: QueueState) => void): Promise<void> {
    const result = this.commit.then(async () => {
      const next = structuredClone(this.state);
      change(next);
      await atomicWrite(join(this.options.directory, "state.json"), canonicalJson(next));
      this.state = next;
      this.wake();
    });
    this.commit = result.catch(() => {});
    return result;
  }
  private wake(): void { for (const resolve of [...this.changed]) resolve(); }
  private kick(): void {
    if (this.pumping || this.paused || this.failure) return;
    this.pumping = true;
    void this.pump().catch(error => { this.failure = error; }).finally(() => { this.pumping = false; this.wake(); });
  }
  private async pump(): Promise<void> {
    while (!this.failure && this.active.size < (this.options.concurrency ?? 2)) {
      const occupied = new Set([...this.active.values()].flatMap(active => active.keys));
      const record = this.state.records.filter(record => record.status === "queued" && !record.resourceKeys.some(key => occupied.has(key)))
        .sort((a, b) => a.priority - b.priority || a.ordinal - b.ordinal)[0];
      if (!record) return;
      if (record.job.budget.deadlineAt <= Date.now()) {
        await this.transaction(state => { const item = state.records.find(item => item.job.jobId === record.job.jobId)!; item.status = "cancelled"; item.error = "Run budget exhausted before Checker execution"; item.completedAt = Date.now(); });
        continue;
      }
      await this.transaction(state => { const item = state.records.find(item => item.job.jobId === record.job.jobId)!; if (item.status === "queued") { item.status = "running"; item.startedAt = Date.now(); } });
      if (this.failure) return;
      if (this.state.records.find(item => item.job.jobId === record.job.jobId)!.status !== "running") continue;
      const abort = new AbortController();
      // Defer the worker until its lease is visible, including to synchronous cancellation.
      const active: ActiveJob = { abort, keys: record.resourceKeys, done: Promise.resolve() };
      this.active.set(record.job.jobId, active);
      active.done = Promise.resolve().then(() => this.execute(record, abort)).catch(error => { this.failure = error; }).finally(() => {
        if (!this.failure) { this.active.delete(record.job.jobId); this.kick(); }
        this.wake();
      });
    }
  }
  private async execute(record: QueueRecord, abort: AbortController): Promise<void> {
    const deadlineAt = Math.min(record.job.budget.deadlineAt, Date.now() + (record.job.budget.timeoutMs ?? Infinity));
    const timer = setTimeout(() => abort.abort(new Error("Checker job deadline exceeded")), Math.min(2_147_483_647,
      Math.max(1, deadlineAt - Date.now())));
    let report: ContentRef | undefined, error: string | undefined, cleanupFailure: unknown;
    try {
      const result = await this.options.checker.check(immutable(structuredClone(record.job)), abort.signal);
      await this.options.artifacts.validateReport(record.job, result);
      report = await this.options.artifacts.putJson(result);
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
      if (failure && typeof failure === "object" && "code" in failure && failure.code === "CHECKER_CLEANUP_FAILED") {
        cleanupFailure = failure; this.failure = failure;
      }
    }
    finally { clearTimeout(timer); }
    await this.transaction(state => {
      const item = state.records.find(item => item.job.jobId === record.job.jobId)!;
      const late = item.status === "cancelled" || abort.signal.aborted || Date.now() >= deadlineAt;
      item.status = cleanupFailure ? "interrupted" : late ? "cancelled" : "completed";
      item.completedAt = Date.now();
      if (report) { if (late) item.lateReport = report; else item.report = report; }
      if (error) item.error = error;
      else if (late) item.error = "Result archived after cancellation or deadline";
    });
    if (cleanupFailure) throw cleanupFailure;
  }
}
