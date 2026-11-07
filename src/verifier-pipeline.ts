import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { BuilderRequest, BuilderResult } from "./builder/port.js";
import type { BuilderProjectContext, BuilderShadowObservation } from "./builder/prompt-input.js";
import { loadRequirementCatalog } from "./catalog.js";
import { pendingImplementationCatalog, saveImplementationDigests } from "./requirement-progress.js";
import { ExecutionFault } from "./execution-fault.js";
import { GatewayRequestError } from "./gateway-failure.js";
import { GatewayRecovery } from "./gateway-recovery.js";
import type { DeliveryReport } from "./application/port.js";
import { parseFeatureGrouping } from "./feature-grouper.js";
import { sanitizeDiagnosticText } from "./diagnostics.js";
import { ModelUsageTotals } from "./model-usage.js";
import type { PipelineDeps, PipelineOptions, RunCheckOutcome, RunSummary } from "./pipeline.js";
import { BUILDER_TIMEOUT_MS } from "./runtime-config.js";
import { RunStateStore } from "./run-state.js";
import { auditPackets, DEFAULT_FEATURE_GROUP_THRESHOLDS, featureGroupPackets, featureGroupingFromIds, makePacket, requirementModuleId } from "./scheduler.js";
import type { AtomicRequirement, RequirementCatalog, RequirementStatus, RunEvent, RunScenarioResult,
  ScenarioCoverageCounts, WorkPacket } from "./types.js";
import type { ArtifactStore } from "./verifier/artifacts.js";
import { atomicWrite, canonicalJson, sameRef } from "./verifier/artifacts.js";
import { verifierSourceClauses, type AcceptanceContract, type VerifierProgramDescriptor } from "./verifier/evidence.js";
import type { RepairDiffReader } from "./builder/repair-diff.js";
import { VerifierCheckpoints, type ProducedSnapshot } from "./verifier/checkpoints.js";
import { VerifierQueue, type QueueRecord } from "./verifier/queue.js";
import type { CheckJob, VerifierPort, CheckOutcome, CheckReport, ContentRef, EvidenceReceipt, ExecutionBindingRef, ProgramRef, TypedRef } from "./verifier/port.js";
import type { SnapshotStore } from "./snapshot-store.js";
import type { VerifierModelUsage } from "./verifier/model.js";

export interface VerifierRuntime {
  directory: string;
  artifacts: ArtifactStore;
  snapshots: SnapshotStore;
  verifier: VerifierPort;
  binding: ExecutionBindingRef;
  initialState: TypedRef;
  resourceKeys: string[];
  setUsageRecorder?(recorder: (usage: VerifierModelUsage) => void): void;
  setUsageProgressRecorder?(recorder: (usage: VerifierModelUsage) => void): void;
  verifyDelivery(job: CheckJob, signal: AbortSignal): Promise<{ report: DeliveryReport; receipts: ContentRef[] }>;
}
const VERIFIER_TIMEOUT_MS = 3_600_000;
type ScopedOutcome = RunCheckOutcome;
type CheckCompletion = (record: QueueRecord, report: CheckReport | undefined) => Promise<void>;

function checkTrace(record: QueueRecord) {
  return { jobId: record.job.jobId, job: record.ref, snapshotId: record.job.snapshot.id,
    initialState: record.job.initialState, ...(record.report ? { report: record.report } : {}) };
}

/** Controller-side orchestration; all domain operations are provided by the execution adapter. */
export class VerifierCoordinator {
  private monitors = new Set<Promise<void>>();
  private failure?: unknown;
  private constructor(readonly runtime: VerifierRuntime, readonly queue: VerifierQueue,
    readonly checkpoints: VerifierCheckpoints, private readonly options: PipelineOptions,
    private readonly deps: PipelineDeps, private readonly emit: (event: RunEvent) => Promise<void>,
    private readonly accepted?: (head: ProducedSnapshot) => Promise<void>) {}

  static async open(runtime: VerifierRuntime, options: PipelineOptions, deps: PipelineDeps,
    initialSha: string, emit: (event: RunEvent) => Promise<void>, accepted?: (head: ProducedSnapshot) => Promise<void>): Promise<VerifierCoordinator> {
    await runtime.artifacts.validateBinding(runtime.binding);
    const checkpoints = await VerifierCheckpoints.open(join(runtime.directory, "controller.json"), runtime.binding.digest, initialSha);
    const queue = await VerifierQueue.open({ directory: runtime.directory, artifacts: runtime.artifacts,
      verifier: { check: async (job, signal) => {
        const head = checkpoints.snapshot.snapshots.find(item => sameRef(item.snapshot, job.snapshot));
        await emit({ at: now(), type: "check_started", packetId: job.packetId, detail: { ...jobDetail(job, head?.sourceSha ?? ""),
          archived: checkpoints.snapshot.producedHead?.snapshot.id !== job.snapshot.id || checkpoints.snapshot.epoch !== job.moduleEpoch } });
        return runtime.verifier.check(job, signal, async progress => {
          const current = checkpoints.snapshot;
          await emit({ at: now(), type: "check_progress", packetId: job.packetId,
            detail: { ...jobDetail(job, head?.sourceSha ?? ""), ...progress,
              archived: current.producedHead?.snapshot.id !== job.snapshot.id || current.epoch !== job.moduleEpoch } });
        });
      } }, concurrency: options.verifier?.concurrency ?? 2, resourceKeys: () => runtime.resourceKeys, startPaused: true });
    const coordinator = new VerifierCoordinator(runtime, queue, checkpoints, options, deps, emit, accepted);
    // A resumed controller creates fresh attempts after checking its current head.
    for (const record of queue.records()) if (record.status === "queued" || record.status === "running") await queue.cancel(record.job.jobId);
    if (checkpoints.snapshot.producedHead) await runtime.snapshots.open(checkpoints.snapshot.producedHead!.snapshot);
    queue.start();
    return coordinator;
  }

  assertHealthy(): void { if (this.failure) throw this.failure; }

  async seal(packet: WorkPacket, implemented: ReadonlySet<string>): Promise<ProducedSnapshot> {
    this.assertHealthy();
    const parent = this.checkpoints.snapshot.producedHead;
    const sourceSha = await this.deps.git.captureAccepted(`shallow: produced ${packet.id}`);
    const sealed = await this.runtime.snapshots.seal({ sourceDirectory: this.options.outputDir, sourceSha, packetId: packet.id,
      parent: parent?.snapshot, generatedPaths: this.options.applicationContract.generatedPaths, dataPaths: this.options.applicationContract.dataPaths });
    const head = await this.checkpoints.produced({ snapshot: sealed.ref, sourceSha,
      ...(parent ? { parentSnapshotId: parent.snapshot.id } : {}), implementedRequirementIds: [...implemented] });
    if (this.options.progressDir && this.options.requirementDigests) {
      await saveImplementationDigests(this.options.progressDir, this.options.requirementDigests, [...implemented]);
    }
    await this.emit({ at: now(), type: "snapshot_sealed", packetId: packet.id, detail: { snapshotId: head.snapshot.id,
      sourceSha, parentSnapshotId: head.parentSnapshotId, requirementIds: packet.requirementIds,
      implementedRequirementIds: head.implementedRequirementIds, sequence: head.ordinal, authoritative: true } });
    return head;
  }

  async submit(head: ProducedSnapshot, packet: WorkPacket, mode: CheckJob["mode"], timeoutMs: number,
    options: { epoch?: number; programs?: ProgramRef[]; priority?: number; requirementIds?: string[]; clauseIds?: string[];
      feedbackReports?: ContentRef[]; onCompleted?: CheckCompletion } = {}): Promise<CheckJob> {
    const job = await this.createJob(head, packet, mode, timeoutMs, options);
    await this.queue.enqueue(job, { priority: options.priority ?? 3 });
    await this.emit({ at: now(), type: "check_queued", packetId: packet.id, detail: jobDetail(job, head.sourceSha) });
    const monitor = this.monitor(job, head, options.onCompleted).catch(error => { this.failure = error; });
    this.monitors.add(monitor);
    void monitor.finally(() => this.monitors.delete(monitor));
    return job;
  }

  private async createJob(head: ProducedSnapshot, packet: WorkPacket, mode: CheckJob["mode"], timeoutMs: number,
    options: { epoch?: number; programs?: ProgramRef[]; requirementIds?: string[]; clauseIds?: string[]; feedbackReports?: ContentRef[] } = {}): Promise<CheckJob> {
    this.assertHealthy();
    const contextualIds = new Set([...packet.requirementIds, ...(packet.prerequisites ?? []).map(item => item.id)]);
    const requirements = await this.runtime.artifacts.putJson(JSON.parse(JSON.stringify({ requirements: packet.requirements,
      prerequisites: packet.prerequisites ?? [], implementedRequirementIds: head.implementedRequirementIds.filter(id => contextualIds.has(id)) })));
    const requirementIds = options.requirementIds ?? packet.requirementIds;
    const programs = options.programs ?? (mode === "prepare" ? [] : await this.programs(requirementIds, this.runtime.initialState, requirements, options.clauseIds));
    return { jobId: randomUUID(), runId: this.runtime.artifacts.runId, moduleId: moduleId(packet.requirements[0]),
      packetId: packet.id, attempt: packet.attempt, moduleEpoch: options.epoch ?? this.checkpoints.snapshot.epoch, snapshot: head.snapshot, requirements,
      binding: this.runtime.binding, initialState: this.runtime.initialState, requirementIds, mode, programs,
      ...(options.clauseIds ? { clauseIds: options.clauseIds } : {}), ...(options.feedbackReports ? { feedbackReports: options.feedbackReports } : {}),
      timeoutMs };
  }

  async verifyDelivery(head: ProducedSnapshot, packet: WorkPacket, timeoutMs: number, signal: AbortSignal): Promise<{ report: DeliveryReport; jobId: string }> {
    await this.drain();
    const job = await this.createJob(head, packet, "prepare", timeoutMs);
    const { report, receipts } = await this.runtime.verifyDelivery(job, signal);
    const ready = await this.acceptReadiness(job, head, receipts);
    const checked = report.ok && !ready ? { ok: false, stage: "readiness" as const, message: "Delivery did not produce current readiness evidence" } : report;
    await atomicWrite(join(this.runtime.directory, "delivery", job.jobId + ".json"),
      canonicalJson({ job: await this.runtime.artifacts.putJson(job), report: checked, receipts }));
    return { report: checked, jobId: job.jobId };
  }

  async report(job: CheckJob): Promise<CheckReport | undefined> {
    const record = await this.queue.wait(job.jobId);
    this.assertHealthy();
    return record.status === "completed" && record.report ? this.runtime.artifacts.getJson<CheckReport>(record.report) : undefined;
  }

  async drain(): Promise<void> { await this.queue.drain(); await Promise.all(this.monitors); this.assertHealthy(); }

  async cancelOutstanding(module?: string): Promise<void> {
    const records = this.queue.records().filter(item => (!module || item.job.moduleId === module) &&
      (item.status === "queued" || item.status === "running"));
    await Promise.all(records.map(item => this.queue.cancel(item.job.jobId)));
    await Promise.all(this.monitors);
    this.assertHealthy();
  }

  async programs(requirementIds: string[], initialState?: TypedRef, requirements?: ContentRef, clauseIds?: string[]): Promise<ProgramRef[]> {
    const programs = new Map<string, ProgramRef>();
    const covered = new Set<string>();
    const ancestors = this.ancestorIds(this.checkpoints.snapshot.producedHead);
    for (const record of this.queue.records().reverse()) {
      const ref = record.report ?? record.lateReport;
      if (!ref || !ancestors.has(record.job.snapshot.id) || !record.job.requirementIds.some(id => requirementIds.includes(id)) ||
        record.job.binding.digest !== this.runtime.binding.digest) continue;
      if (requirements && !sameRef(record.job.requirements, requirements)) continue;
      const report = await this.runtime.artifacts.getJson<CheckReport>(ref);
      await this.runtime.artifacts.validateReport(record.job, report);
      for (const program of [...(report.activePrograms ?? report.programs)].reverse()) {
        if (!sameRef(program.binding, this.runtime.binding)) continue;
        const descriptor = await this.runtime.artifacts.readTypedJson<VerifierProgramDescriptor>(program.descriptor);
        if (initialState && !sameRef(descriptor.initialState, initialState)) continue;
        const contract = await this.runtime.artifacts.getJson<AcceptanceContract>(program.contract);
        if (requirements && !sameRef(contract.requirements, requirements)) continue;
        if (!contract.clauses.every(clause => requirementIds.includes(clause.requirementId) && (!clauseIds || clauseIds.includes(clause.id))) ||
          contract.clauses.some(clause => covered.has(clause.id))) continue;
        contract.clauses.forEach(clause => covered.add(clause.id));
        programs.set(canonicalJson(program), program);
      }
      if (record.job.mode === "diagnose") report.outcomes.forEach(outcome => covered.add(outcome.clauseId));
    }
    return [...programs.values()];
  }

  ancestorIds(head: ProducedSnapshot | undefined): Set<string> {
    const ids = new Set<string>();
    while (head) {
      ids.add(head.snapshot.id);
      head = this.checkpoints.snapshot.snapshots.find(item => item.snapshot.id === head!.parentSnapshotId);
    }
    return ids;
  }

  private async monitor(job: CheckJob, head: ProducedSnapshot, onCompleted?: CheckCompletion): Promise<void> {
    const record = await this.queue.wait(job.jobId);
    let report: CheckReport | undefined;
    if (record.status === "completed" && record.report) {
      report = await this.runtime.artifacts.getJson<CheckReport>(record.report);
      const manifest = await this.runtime.artifacts.getJson<{ receipts?: ContentRef[] }>(report.manifest);
      await this.acceptReadiness(job, head, manifest.receipts ?? []);
    }
    const current = this.checkpoints.snapshot;
    await this.emit({ at: now(), type: record.status === "cancelled" ? "check_cancelled" : "check_completed", packetId: job.packetId,
      detail: { ...jobDetail(job, head.sourceSha), status: record.status, reason: record.error,
        archived: current.producedHead?.snapshot.id !== job.snapshot.id || current.epoch !== job.moduleEpoch,
        durationMs: (record.completedAt ?? Date.now()) - (record.startedAt ?? record.queuedAt) } });
    // Group evidence is published independently of later implementation work; drain awaits this callback.
    if (onCompleted) await onCompleted(record, report);
  }

  private async acceptReadiness(job: CheckJob, head: ProducedSnapshot, receipts: ContentRef[]): Promise<boolean> {
    let ready = false;
    for (const ref of receipts) {
      const receipt = await this.runtime.artifacts.getJson<EvidenceReceipt>(ref);
      await this.runtime.artifacts.validateReceipt(job, receipt);
      if (receipt.kind === "readiness" && receipt.readiness?.result === "ready") ready = true;
    }
    if (ready && this.accepted && await this.checkpoints.ready(head.snapshot)) await this.accepted(head);
    return ready;
  }
}

export async function runVerifierPipeline(options: PipelineOptions, deps: PipelineDeps, runtime: VerifierRuntime): Promise<RunSummary> {
  const catalog = await loadRequirementCatalog(options.requirementsFile, { inheritedApplication: options.startingPoint === "inherited_application" });
  const started = options.startedAtMs ?? deps.clock.nowMs();
  const initialSha = await deps.git.captureAccepted("shallow: initial Verifier state");
  const state = new RunStateStore({ statusByRequirementId: catalog.statusById, acceptedSha: initialSha,
    startedAtMs: started }, options.ledgerFile, deps.logSink ?? null, deps.diagnosticSecrets);
  const usage = new ModelUsageTotals();
  for (const item of options.initializationUsage ?? []) usage.add("builder", item);
  const gateway = deps.gatewayRecovery ?? new GatewayRecovery();
  gateway.setRecorder(({ packetId, ...detail }) => state.record({ at: now(), type: "gateway_wait", packetId, detail }));
  runtime.setUsageRecorder?.(item => {
    usage.add("verifier", item);
    void state.record({ at: now(), type: "verifier_usage", detail: item });
  });
  runtime.setUsageProgressRecorder?.(item => {
    // 进行中用量只服务交互终端的实时展示，不进入账本或日志。
    state.present({ at: now(), type: "verifier_usage_progress", detail: item });
  });
  const coordinator = await VerifierCoordinator.open(runtime, options, deps, initialSha, event => state.record(event), async head => {
    state.setAcceptedSha(head.sourceSha);
    await state.record({ at: now(), type: "checkpoint_saved", detail: { requirementIds: head.implementedRequirementIds, reason: "Verifier readiness" } });
  });
  state.setAcceptedSha(coordinator.checkpoints.snapshot.accepted.sha);
  const recoveredHead = coordinator.checkpoints.snapshot.producedHead;
  if (recoveredHead) await runtime.snapshots.restore(recoveredHead.snapshot, options.outputDir,
    { generatedPaths: options.applicationContract.generatedPaths, dataPaths: options.applicationContract.dataPaths });
  const implemented = new Set(coordinator.checkpoints.snapshot.producedHead?.implementedRequirementIds ?? options.resumedRequirementIds ?? []);
  const currentResults = new Map<string, ScopedOutcome[]>();
  const replay = options.verifier.replay === true;
  let auditGroups: WorkPacket[] = [];
  const byId = new Map(catalog.requirements.map(item => [item.id, item]));
  let implementationCatalog: RequirementCatalog = catalog;
  const emitPhase = (phase: "implementation" | "audit" | "repair" | "delivery") => state.record({ at: now(), type: "phase_started", detail: { phase } });
  const packetFor = (id: string, requirements: AtomicRequirement[], attempt: 1 | 2 | 3 = 1): WorkPacket => ({
    ...makePacket(id, requirements, attempt),
    prerequisites: catalog.requirements.filter(item => !requirements.includes(item) && dependencyClosure(requirements, byId).has(item.id)) });
  const contextFor = (packet: WorkPacket): BuilderProjectContext => ({ product: packet.requirements[0].product,
    ancestors: [...new Map(packet.requirements.flatMap(item => item.ancestors).map(item => [item.id, item])).values()],
    satisfiedDependencies: (packet.prerequisites ?? []).filter(item => implemented.has(item.id)).map(item => ({ id: item.id, name: item.name, contract: item.text })),
    startingPoint: options.startingPoint ?? "unknown",
    externalPrerequisiteIds: packet.externalPrerequisiteIds ?? [] });
  const build = async (request: BuilderRequest, resumeInterrupted = false, repairDiff?: RepairDiffReader): Promise<BuilderResult> => {
    // Adapter-declared exclusive resources must also be exclusive with Builder self-tests.
    if (runtime.resourceKeys.length) await coordinator.drain();
    const packetId = "packet" in request ? request.packet.id : "delivery";
    await state.record({ at: now(), type: "builder_started", packetId, detail: { mode: request.mode } });
    let reported = false;
    const onUsage = async (item: Parameters<ModelUsageTotals["add"]>[1]) => {
      reported = true; usage.add("builder", item);
      await state.record({ at: now(), type: "builder_usage", packetId, detail: { ...item, total: item.input + item.output + item.cacheRead + item.cacheWrite } });
    };
    let result: BuilderResult = { outcome: "failed", sessionId: "unavailable", summary: "Builder did not start" };
    const deadlineAt = Date.now() + (resumeInterrupted ? 2_700_000 : BUILDER_TIMEOUT_MS);
    const remainingMs = () => Math.max(0, deadlineAt - Date.now());
    try {
      result = await gateway.run("builder", packetId, remainingMs, async () => {
        reported = false;
        result = await deps.builder.run({ ...request, ...(options.initialization ? { initialization: options.initialization } : {}) },
          { timeoutMs: remainingMs(), resumeInterrupted, onUsage,
            // Reuse one conversation within a requirement module; a module boundary starts a fresh handoff.
            ...(request.mode === "implement"
              ? { sessionKey: `implementation:${requirementModuleId(request.packet.requirements[0])}` }
              : {}),
            ...(repairDiff ? { repairDiff } : {}) });
        try { await deps.assertContractUnchanged?.(); }
        catch (error) {
          await deps.git.restoreAccepted(coordinator.checkpoints.snapshot.accepted.sha);
          throw new ExecutionFault("builder", "builder_cleanup", false, { cause: error });
        }
        if (!reported && result.execution?.usage.status === "available") await onUsage(result.execution.usage);
        await state.record({ at: now(), type: "builder_finished", packetId, detail: { ...result } });
        if (result.gatewayFailure && result.outcome !== "completed") throw new GatewayRequestError(result.gatewayFailure);
        return result;
      });
    } catch (error) {
      if (!(error instanceof GatewayRequestError)) throw error;
      result = { ...result, gatewayFailure: error.gatewayFailure, summary: error.message, outcome: "failed" };
    }
    coordinator.assertHealthy();
    return result;
  };
  const aggregate = async (head: ProducedSnapshot, requirements: AtomicRequirement[]): Promise<ScopedOutcome[]> => {
    const ancestors = coordinator.ancestorIds(head);
    const collected = new Map<string, ScopedOutcome>();
    for (const record of coordinator.queue.records().reverse()) {
      if (record.job.mode === "prepare" || !ancestors.has(record.job.snapshot.id) || !sameRef(record.job.binding, runtime.binding) ||
        !sameRef(record.job.initialState, runtime.initialState)) continue;
      const report = record.status === "completed" && record.report ? await runtime.artifacts.getJson<CheckReport>(record.report) : undefined;
      if (report) await runtime.artifacts.validateReport(record.job, report);
      for (const requirement of requirements.filter(item => record.job.requirementIds.includes(item.id))) {
        const sources = verifierSourceClauses({ requirements: [requirement] }, [requirement.id])
          .filter(source => !record.job.clauseIds || record.job.clauseIds.includes(source.id));
        for (const source of sources) if (!collected.has(source.id)) {
          const outcome = report?.outcomes.find(item => item.clauseId === source.id);
          collected.set(source.id, { ...(outcome ?? { requirementId: requirement.id, scenarioId: source.scenarioId, clauseId: source.id,
            status: "inconclusive" as const, evidence: [], reason: sanitizeDiagnosticText(record.error ?? "Verifier did not commit a source-clause result", deps.diagnosticSecrets) }), ...checkTrace(record) });
        }
      }
    }
    return requirements.flatMap(requirement => {
      const sources = verifierSourceClauses({ requirements: [requirement] }, [requirement.id]);
      return sources.length ? sources.map(source => collected.get(source.id) ?? { requirementId: requirement.id, scenarioId: source.scenarioId,
        clauseId: source.id, status: "inconclusive" as const, evidence: [], snapshotId: head.snapshot.id, reason: "No applicable source-clause report" })
        : [{ requirementId: requirement.id, scenarioId: "unknown", clauseId: `${requirement.id}:missing-source`, status: "inconclusive" as const,
          evidence: [], snapshotId: head.snapshot.id, reason: "Requirement has no source result clause" }];
    });
  };
  const inspect = async (head: ProducedSnapshot, requirements: AtomicRequirement[], epoch: number,
    mode: "replay" | "diagnose", clauseIds?: string[], feedbackReports?: ContentRef[]): Promise<ScopedOutcome[]> => {
    const jobs: CheckJob[] = [];
    const scope = new Set(requirements.map(item => item.id));
    const grouped = new Set(auditGroups.flatMap(packet => packet.requirementIds));
    const packets = [...auditGroups, ...auditPackets({ requirements: requirements.filter(item => !grouped.has(item.id)), statusById: catalog.statusById })];
    for (const packet of packets.filter(packet => packet.requirementIds.some(id => scope.has(id)))) {
      jobs.push(await coordinator.submit(head, packetFor(packet.id, packet.requirements), mode, VERIFIER_TIMEOUT_MS, { epoch, priority: 1,
        requirementIds: packet.requirementIds.filter(id => scope.has(id)), ...(clauseIds ? { clauseIds } : {}),
        ...(feedbackReports ? { feedbackReports } : {}) }));
    }
    const reports = await Promise.all(jobs.map(job => coordinator.report(job)));
    await coordinator.drain();
    return reports.flatMap((report, index) => {
      const job = jobs[index];
      const record = coordinator.queue.records().find(item => item.job.jobId === job.jobId)!;
      const sources = verifierSourceClauses({ requirements }, job.requirementIds).filter(source => !clauseIds || clauseIds.includes(source.id));
      return sources.map(source => ({ ...(report?.outcomes.find(outcome => outcome.clauseId === source.id) ?? {
        requirementId: source.requirementId, scenarioId: source.scenarioId, clauseId: source.id, status: "inconclusive" as const, evidence: [],
        reason: sanitizeDiagnosticText(record.error ?? "Verifier did not commit a current source-clause result", deps.diagnosticSecrets) }), ...checkTrace(record) }));
    });
  };
  const publish = async (head: ProducedSnapshot, module: string, epoch: number, outcomes: ScopedOutcome[], scope: AtomicRequirement[],
    fullReplay = false, featureGroupId?: string): Promise<void> => {
    for (const requirement of scope) {
      const previous = currentResults.get(requirement.id) ?? [];
      const incoming = outcomes.filter(item => item.requirementId === requirement.id);
      const clauses = [...previous.filter(item => !incoming.some(next => next.clauseId === item.clauseId)), ...incoming];
      currentResults.set(requirement.id, clauses);
      state.markRequirements([requirement.id], outcomeStatus(clauses));
    }
    const selected = catalog.requirements;
    const allOutcomes = [...currentResults.values()].flat();
    await state.record({ at: now(), type: "module_check_finished", detail: { moduleId: module, moduleEpoch: epoch,
      snapshotId: head.snapshot.id, published: true, replay: fullReplay, ...(featureGroupId ? { featureGroupId } : {}),
      requirementResults: Object.fromEntries(scope.map(item => [item.id, outcomeStatus(currentResults.get(item.id) ?? [])])),
      scenarioResults: scenarioResults(scope, allOutcomes, implemented),
      scenarioCoverage: scenarioCoverage(selected, allOutcomes, implemented) } });
  };
  const publishFeatureGroup = async (groupId: string, requirements: AtomicRequirement[], head: ProducedSnapshot,
    record: QueueRecord, report: CheckReport | undefined): Promise<void> => {
    const outcomes: ScopedOutcome[] = requirements.flatMap(requirement => {
      const sources = verifierSourceClauses({ requirements: [requirement] }, [requirement.id]);
      return sources.length ? sources.map(source => ({ ...(report?.outcomes.find(item => item.clauseId === source.id) ?? {
        requirementId: requirement.id, scenarioId: source.scenarioId, clauseId: source.id,
        status: "inconclusive" as const, evidence: [], reason: sanitizeDiagnosticText(
          record.error ?? "Verifier did not commit a source-clause result", deps.diagnosticSecrets) }), ...checkTrace(record) }))
        : [{ requirementId: requirement.id, scenarioId: "unknown", clauseId: `${requirement.id}:missing-source`,
          status: "inconclusive" as const, evidence: [], reason: "Requirement has no source result clause", ...checkTrace(record) }];
    });
    await publish(head, moduleId(requirements[0]), record.job.moduleEpoch, outcomes, requirements, false, groupId);
  };
  const restore = async (baseline: ProducedSnapshot): Promise<void> => {
    await coordinator.cancelOutstanding();
    await deps.git.restoreAccepted(baseline.sourceSha);
    await runtime.snapshots.restore(baseline.snapshot, options.outputDir,
      { generatedPaths: options.applicationContract.generatedPaths, dataPaths: options.applicationContract.dataPaths });
    await coordinator.checkpoints.restore(baseline);
    state.setAcceptedSha(coordinator.checkpoints.snapshot.accepted.sha);
  };
  const repairDiffFor = async (head: ProducedSnapshot, failures: ScopedOutcome[]): Promise<RepairDiffReader> => {
    const ancestors = coordinator.ancestorIds(head);
    const comparisons = new Map<string, { before: ProducedSnapshot; after: ProducedSnapshot }>();
    for (const failure of failures.filter(item => item.status === "fail")) {
      const failedJob = failure.job ? await runtime.artifacts.getJson<CheckJob>(failure.job) : undefined;
      if (!failedJob || !failure.report) continue;
      const failedReport = await runtime.artifacts.getJson<CheckReport>(failure.report);
      const contractFor = async (report: CheckReport) => {
        for (const program of report.activePrograms ?? report.programs) {
          const contract = await runtime.artifacts.getJson<AcceptanceContract>(program.contract);
          if (contract.clauses.some(clause => clause.id === failure.clauseId)) return canonicalJson(contract);
        }
        return undefined;
      };
      const failedContract = await contractFor(failedReport);
      if (!failedContract) continue;
      for (const record of coordinator.queue.records().reverse()) {
        if (!record.report || record.status !== "completed" || record.job.snapshot.id === head.snapshot.id ||
          !ancestors.has(record.job.snapshot.id) || !sameRef(record.job.requirements, failedJob.requirements) ||
          !sameRef(record.job.binding, failedJob.binding) || !sameRef(record.job.initialState, failedJob.initialState)) continue;
        const report = await runtime.artifacts.getJson<CheckReport>(record.report);
        const scene = report.outcomes.filter(item => item.requirementId === failure.requirementId && item.scenarioId === failure.scenarioId);
        const expected = verifierSourceClauses({ requirements: catalog.requirements }, [failure.requirementId]).filter(item => item.scenarioId === failure.scenarioId);
        if (!expected.length || !expected.every(source => scene.some(item => item.clauseId === source.id && item.status === "pass")) ||
          await contractFor(report) !== failedContract) continue;
        const before = coordinator.checkpoints.snapshot.snapshots.find(item => sameRef(item.snapshot, record.job.snapshot));
        if (before) comparisons.set(`${failure.requirementId}/${failure.scenarioId}/${failure.clauseId}`, { before, after: head });
        break;
      }
    }
    const allowed = new Set(failures.map(item => `${item.requirementId}/${item.scenarioId}/${item.clauseId}`));
    return async ({ caseId, path, offset }) => {
      if (!allowed.has(caseId)) throw new Error("Case is outside this repair batch");
      const pair = comparisons.get(caseId);
      if (!pair) return { available: false, reason: "No compatible historical passing scenario on this candidate lineage" };
      return { available: true, beforeSnapshotId: pair.before.snapshot.id, afterSnapshotId: pair.after.snapshot.id,
        changes: await deps.git.applicationDiff(pair.before.sourceSha, pair.after.sourceSha, path, offset) };
    };
  };

  try {
    await state.record({ at: now(), type: "pipeline_started", detail: { requirements: catalog.requirements.length,
      adapterId: options.applicationContract.adapterId, ...deps.runMetadata } });
    // 恢复运行时先把已实现范围交给展示层；验收结果仍由后续独立检查确定。
    if (implemented.size) await state.record({ at: now(), type: "run_resumed", detail: { requirementIds: [...implemented] } });
    if (!recoveredHead && options.resumedRequirementIds !== undefined) {
      implementationCatalog = pendingImplementationCatalog(catalog, implemented);
    }
    const savedGroups = coordinator.checkpoints.snapshot.featureGroups;
    let grouping = savedGroups ? featureGroupingFromIds(implementationCatalog, savedGroups) : featureGroupPackets(implementationCatalog);
    const grouper = deps.grouper;
    if (!savedGroups && grouper && implementationCatalog.requirements.length) {
      await state.record({ at: now(), type: "feature_grouping_started", detail: { requirements: implementationCatalog.requirements.length,
        limits: DEFAULT_FEATURE_GROUP_THRESHOLDS } });
      const at = Date.now(); let reason: string | undefined; let source: "llm" | "deterministic" = "deterministic";
      try {
        // The grouper owns its Pi session and retries without discarding tool history.
        const proposal = await grouper.group(implementationCatalog, { timeoutMs: 720_000,
          onUsage: async item => { usage.add("grouper", item); await state.record({ at: now(), type: "feature_grouping_usage", detail: item }); } });
        grouping = parseFeatureGrouping(proposal, implementationCatalog); source = "llm";
      } catch (error) { reason = message(error); }
      await state.record({ at: now(), type: "feature_grouping_finished", detail: { source, reason, grouping: grouping.stats,
        durationMs: Date.now() - at, groups: grouping.packets.map(item => ({ packetId: item.id, requirementIds: item.requirementIds })) } });
    }
    if (!savedGroups) await coordinator.checkpoints.setFeatureGroups(grouping.packets.map(packet => packet.requirementIds));
    auditGroups = grouping.packets.map(packet => packetFor(packet.id, packet.requirementIds.map(id => byId.get(id)!)));
    if (!coordinator.checkpoints.snapshot.producedHead && options.resumedRequirementIds?.length) {
      const continued = catalog.requirements.filter(item => implemented.has(item.id));
      if (continued.length) {
        const head = await coordinator.seal(packetFor("continue", continued), implemented);
        for (const group of auditPackets({ requirements: continued, statusById: catalog.statusById })) {
          await coordinator.submit(head, packetFor(group.id, group.requirements), "discover", VERIFIER_TIMEOUT_MS, {
            onCompleted: (record, report) => publishFeatureGroup(group.id, group.requirements, head, record, report) });
        }
      }
    }
    if (recoveredHead) {
      const head = coordinator.checkpoints.snapshot.producedHead!;
      const packet = packetFor("resume", catalog.requirements.filter(item => implemented.has(item.id)));
      if (packet.requirements.length) {
        const job = await coordinator.submit(head, packet, "prepare", VERIFIER_TIMEOUT_MS, { priority: 0 });
        await coordinator.report(job); await coordinator.drain();

      }
    }
    for (const grouped of grouping.packets) {
      const requirements = grouped.requirements.filter(item => !implemented.has(item.id));
      if (!requirements.length) continue;
      const packet = packetFor(grouped.id, requirements);
      const dependencies = [...dependencyClosure(requirements, byId)].filter(id => !packet.requirementIds.includes(id) && !implemented.has(id));
      if (dependencies.length) {
        state.markRequirements(packet.requirementIds, "blocked");
        await state.record({ at: now(), type: "dependency_gate_blocked", packetId: packet.id, detail: {
          requirementIds: packet.requirementIds, unmetDependencyIds: dependencies,
          dependencyStatuses: Object.fromEntries(dependencies.map(id => [id, state.snapshot.statusByRequirementId[id] ?? "todo"])) } });
        continue;
      }
      await emitPhase("implementation");
      await state.record({ at: now(), type: "packet_selected", packetId: packet.id, detail: { requirementIds: packet.requirementIds, names: requirements.map(item => item.name) } });
      const request: BuilderRequest = { mode: "implement", packet, projectContext: contextFor(packet), outputDir: options.outputDir, applicationContract: options.applicationContract,
        finalImplementation: catalog.requirements.every(item => implemented.has(item.id) || packet.requirementIds.includes(item.id)) };
      let result = await build(request);
      if (result.outcome !== "completed" && !result.gatewayFailure) result = await build(request, true);
      if (result.outcome !== "completed") {
        // Seal partial work for recovery; incomplete feature groups never become implemented.
        await coordinator.seal(packet, implemented);
        state.markRequirements(packet.requirementIds, "blocked");
        if (result.gatewayFailure) break;
        continue;
      }
      for (const id of packet.requirementIds) implemented.add(id);
      const head = await coordinator.seal(packet, implemented);
      await coordinator.submit(head, auditGroups.find(group => group.id === grouped.id)!, "discover", VERIFIER_TIMEOUT_MS, {
        onCompleted: (record, report) => publishFeatureGroup(grouped.id, requirements, head, record, report) });
    }
    if (!coordinator.checkpoints.snapshot.producedHead) await coordinator.seal(packetFor("initial", catalog.requirements), implemented);
    await coordinator.drain();
    let head = coordinator.checkpoints.snapshot.producedHead!;
    const scope = catalog.requirements;
    let fullSnapshotId: string | undefined;
    let delivery: DeliveryReport = { ok: false, stage: "candidate", message: "No sealed application is available" };
    let deliveryJobId: string | undefined;
    let deliverySnapshotId: string | undefined;
    let deliveryRounds = 0;
    const verifyDelivery = async (candidate: ProducedSnapshot): Promise<DeliveryReport> => {
      const packet = packetFor("delivery", scope.slice(0, 1));
      await state.record({ at: now(), type: "delivery_check_started", detail: { snapshotId: candidate.snapshot.id } });
      const checked = await coordinator.verifyDelivery(candidate, packet, VERIFIER_TIMEOUT_MS, AbortSignal.timeout(720_000));
      deliveryJobId = checked.jobId;
      deliverySnapshotId = checked.report.ok ? candidate.snapshot.id : undefined;
      await state.record({ at: now(), type: "delivery_check_finished", detail: { snapshotId: candidate.snapshot.id, jobId: checked.jobId, ...checked.report } });
      return checked.report;
    };
    const ensureDelivery = async (): Promise<void> => {
      delivery = await verifyDelivery(head);
      while (!delivery.ok && deliveryRounds < 3) {
        const round = ++deliveryRounds;
        const baseline = head;
        const firstCheck = coordinator.queue.records().length;
        await state.record({ at: now(), type: "delivery_repair_started", detail: {
          round, stage: delivery.stage, message: delivery.message, baselineSnapshotId: baseline.snapshot.id } });
        let candidateSnapshotId: string | undefined;
        let candidateDeliveryJobId: string | undefined;
        const result = await build({ mode: "delivery_repair", outputDir: options.outputDir, applicationContract: options.applicationContract,
          deliveryFailure: { stage: delivery.stage, expected: "The application satisfies the declared execution and delivery contract",
            actual: sanitizeDiagnosticText(delivery.message, deps.diagnosticSecrets) } });
        if (result.outcome === "completed") {
          const repaired = await coordinator.seal(packetFor(`delivery-repair-${round}`, scope.slice(0, 1)), implemented);
          candidateSnapshotId = repaired.snapshot.id;
          const checked = await verifyDelivery(repaired);
          candidateDeliveryJobId = deliveryJobId;
          if (checked.ok) {
            head = repaired; delivery = checked;
            await state.record({ at: now(), type: "delivery_repair_accepted", detail: { round,
              baselineSnapshotId: baseline.snapshot.id, candidateSnapshotId, retainedSnapshotId: head.snapshot.id,
              deliveryJobId: candidateDeliveryJobId, checkJobIds: coordinator.queue.records().slice(firstCheck).map(item => item.job.jobId) } });
            break;
          }
        }
        await restore(baseline);
        await state.record({ at: now(), type: "delivery_repair_restored", detail: { round,
          baselineSnapshotId: baseline.snapshot.id, candidateSnapshotId, retainedSnapshotId: baseline.snapshot.id,
          deliveryJobId: candidateDeliveryJobId, checkJobIds: coordinator.queue.records().slice(firstCheck).map(item => item.job.jobId) } });
        delivery = await verifyDelivery(baseline);
      }
    };
    const fullCheck = async (): Promise<void> => {
      const epoch = await coordinator.checkpoints.nextEpoch();
      const checkedScope = scope.filter(item => implemented.has(item.id));
      await emitPhase("audit");
      await state.record({ at: now(), type: "module_check_started", detail: { moduleId: "<final>", moduleEpoch: epoch,
        snapshotId: head.snapshot.id, requirementIds: scope.map(item => item.id) } });
      await publish(head, "<final>", epoch, await inspect(head, checkedScope, epoch, "replay"), checkedScope, true);
      fullSnapshotId = head.snapshot.id;
    };
    await emitPhase("delivery");
    await state.record({ at: now(), type: "delivery_started" });
    await ensureDelivery();
    const activeScope = () => scope.filter(item => implemented.has(item.id));
    await publish(head, "<final>", coordinator.checkpoints.snapshot.epoch, await aggregate(head, activeScope()), activeScope());
    if (replay && delivery.ok) await fullCheck();

    // Diagnose once per round on a fixed candidate. Only freshly diagnosed violations reach Builder.
    for (let round = 1; delivery.ok && round <= 1; round++) {
      const previous = [...currentResults.values()].flat();
      const unresolved = previous.filter(item => item.status !== "pass" && implemented.has(item.requirementId));
      if (!unresolved.length) break;
      const sceneKeys = new Set(unresolved.map(item => JSON.stringify([item.requirementId, item.scenarioId])));
      // Failed jobs without source results still expand from the original scenario universe.
      const clauseIds = verifierSourceClauses({ requirements: activeScope() }, [...implemented])
        .filter(source => sceneKeys.has(JSON.stringify([source.requirementId, source.scenarioId]))).map(source => source.id);
      const requirements = activeScope().filter(item => unresolved.some(outcome => outcome.requirementId === item.id));
      const epoch = await coordinator.checkpoints.nextEpoch();
      const feedbackReports = [...new Map(unresolved.filter(item => item.report).map(item => [item.report!.id, item.report!])).values()];
      const diagnosed = await inspect(head, requirements, epoch, "diagnose", clauseIds, feedbackReports);
      await publish(head, "<diagnosis>", epoch, diagnosed, requirements);
      const failures = diagnosed.filter(item => item.status === "fail");
      if (!failures.length) break;
      const repairRequirements = requirements.filter(item => failures.some(outcome => outcome.requirementId === item.id));
      const targetScenes = new Set(failures.map(item => JSON.stringify([item.requirementId, item.scenarioId])));
      const targetClauses = diagnosed.filter(item => targetScenes.has(JSON.stringify([item.requirementId, item.scenarioId]))).map(item => item.clauseId);
      const packet = packetFor(`verifier-repair-final-${round}`, repairRequirements, 2);
      const baseline = head;
      const baselineOutcomes = [...currentResults.values()].flat();
      const firstCheck = coordinator.queue.records().length;
      await emitPhase("repair");
      await state.record({ at: now(), type: "repair_batch_started", packetId: packet.id, detail: {
        round, requirementIds: packet.requirementIds, baselineSnapshotId: baseline.snapshot.id } });
      const observation = await repairObservation(runtime.artifacts, packet, diagnosed, false, deps.diagnosticSecrets);
      const result = await build({ mode: "repair", packet, projectContext: contextFor(packet), shadowObservation: observation,
        outputDir: options.outputDir, applicationContract: options.applicationContract }, false, await repairDiffFor(head, failures));
      let retained = false;
      let candidateSnapshotId: string | undefined;
      if (result.outcome === "completed") {
        const repaired = await coordinator.seal(packet, implemented);
        candidateSnapshotId = repaired.snapshot.id;
        const readyJob = await coordinator.submit(repaired, packet, "prepare", VERIFIER_TIMEOUT_MS, { priority: 0 });
        await coordinator.report(readyJob); await coordinator.drain();
        if (coordinator.checkpoints.snapshot.accepted.snapshot?.id === repaired.snapshot.id) {
          const targetEpoch = await coordinator.checkpoints.nextEpoch();
          const checked = await inspect(repaired, repairRequirements, targetEpoch, "replay", targetClauses);
          const improved = failures.some(failure => checked.some(item => outcomeKey(item) === outcomeKey(failure) && item.status === "pass"));
          if (improved) {
            retained = true; head = repaired;
            await publish(head, "<repair>", targetEpoch, checked, repairRequirements);
          }
        }
      }
      if (!retained) {
        await restore(baseline); head = baseline;
        // Results from a rejected descendant never enter the retained lineage.
        await publish(head, "<repair>", coordinator.checkpoints.snapshot.epoch, baselineOutcomes, activeScope());
      }
      await state.record({ at: now(), type: "repair_batch_finished", packetId: packet.id, detail: { round, retained,
        reason: retained ? "Repair target improvement confirmed; full final check is deferred" : "Repair did not establish target improvement",
        baselineSnapshotId: baseline.snapshot.id, candidateSnapshotId, retainedSnapshotId: head.snapshot.id,
        requirementIds: packet.requirementIds, checkJobIds: coordinator.queue.records().slice(firstCheck)
          .filter(item => item.job.snapshot.id === candidateSnapshotId).map(item => item.job.jobId) } });
      if (!retained) break;
    }
    // Technical repairs must precede the last behavioral check; no writer runs afterwards.
    if (delivery.ok && head.snapshot.id !== deliverySnapshotId) await ensureDelivery();
    if (!delivery.ok && coordinator.checkpoints.snapshot.accepted.sha !== head.sourceSha) {
      const accepted = coordinator.checkpoints.snapshot.accepted;
      const fallback = coordinator.checkpoints.snapshot.snapshots.find(item => item.snapshot.id === accepted.snapshot?.id);
      currentResults.clear();
      for (const item of scope) state.markRequirements([item.id], "inconclusive");
      if (fallback) {
        await deps.git.restoreAccepted(fallback.sourceSha);
        await runtime.snapshots.restore(fallback.snapshot, options.outputDir,
          { generatedPaths: options.applicationContract.generatedPaths, dataPaths: options.applicationContract.dataPaths });
        head = fallback;
        implemented.clear(); for (const id of fallback.implementedRequirementIds) implemented.add(id);
        delivery = await verifyDelivery(fallback);
        await publish(head, "<fallback>", coordinator.checkpoints.snapshot.epoch, await aggregate(head, activeScope()), activeScope());
      }
    }
    if (replay && delivery.ok && fullSnapshotId !== head.snapshot.id) await fullCheck();
    if (!replay) await publish(head, "<final>", coordinator.checkpoints.snapshot.epoch, await aggregate(head, activeScope()), activeScope());
    if (head && delivery.ok) {
      try { await runtime.snapshots.assertMatches(head.snapshot, options.outputDir,
        { generatedPaths: options.applicationContract.generatedPaths, dataPaths: options.applicationContract.dataPaths }); }
      catch (error) {
        delivery = { ok: false, stage: "candidate", message: message(error) };
        for (const item of scope) state.markRequirements([item.id], "inconclusive");
        currentResults.clear();
      }
    }
    await state.record({ at: now(), type: "delivery_finished", detail: delivery });
    const selected = catalog.requirements;
    const ids = (status: RequirementStatus) => selected.filter(item => state.snapshot.statusByRequirementId[item.id] === status).map(item => item.id);
    const verified = ids("verified");
    const summary: RunSummary = { status: !delivery.ok ? "failed" : verified.length === selected.length ? "delivered" : "partial",
      acceptedSha: state.snapshot.acceptedSha, delivery, verifiedRequirementIds: verified,
      blockedRequirementIds: ids("blocked"), failedRequirementIds: ids("failed"), inconclusiveRequirementIds: ids("inconclusive"), pendingRequirementIds: ids("todo"),
      implementedRequirementIds: [...implemented], modelUsage: usage.summary(),
      auditRequirementIds: selected.map(item => item.id), skippedRequirementIds: [],
      verifier: { mode: "active", semanticReview: options.verifier.semanticReview === true, replay,
        producedHead: coordinator.checkpoints.snapshot.producedHead,
        checkedSnapshotId: delivery.ok && replay && fullSnapshotId === head.snapshot.id ? head.snapshot.id : undefined,
        verifiedSnapshotId: delivery.ok && replay && fullSnapshotId === head.snapshot.id && verified.length === selected.length
          && [...currentResults.values()].flat().every(item => item.snapshotId === head.snapshot.id) ? head.snapshot.id : undefined, outcomes: [...currentResults.values()].flat() },
      scenarioResults: scenarioResults(selected, [...currentResults.values()].flat(), implemented) };
    if (options.progressDir && options.requirementDigests) {
      await saveImplementationDigests(options.progressDir, options.requirementDigests, [...implemented]);
    }
    await state.record({ at: now(), type: "pipeline_finished", detail: { ...summary, pendingRequirementIds: ids("todo"),
      scenarioCoverage: scenarioCoverage(selected, [...currentResults.values()].flat(), implemented) } });
    return summary;
  } catch (error) {
    // A cleanup fault means the writer may still be active; no checkout is safe then.
    if (!(error instanceof ExecutionFault && error.code === "builder_cleanup")) {
      await coordinator.cancelOutstanding();
      const partial = catalog.requirements.slice(0, 1);
      if (partial.length) await coordinator.seal(packetFor("interrupted", partial), implemented);
    }
    await state.record({ at: now(), type: "pipeline_failed", detail: { message: message(error) } });
    throw error;
  } finally {
    try { await coordinator.cancelOutstanding(); }
    finally {
      runtime.setUsageRecorder?.(() => {});
      runtime.setUsageProgressRecorder?.(() => {});
      await deps.builder.close();
    }
  }
}

function jobDetail(job: CheckJob, sha: string) {
  return { jobId: job.jobId, snapshotId: job.snapshot.id, checkedSourceSha: sha, moduleEpoch: job.moduleEpoch,
    attempt: job.attempt, mode: job.mode, requirementIds: job.requirementIds };
}
function moduleId(requirement: AtomicRequirement | undefined): string { return requirement ? requirementModuleId(requirement) : "<application>"; }
function dependencyClosure(requirements: AtomicRequirement[], byId: Map<string, AtomicRequirement>): Set<string> {
  const ids = new Set<string>(); const pending = requirements.flatMap(item => item.dependencyIds);
  while (pending.length) { const id = pending.pop()!; if (ids.has(id)) continue; ids.add(id); pending.push(...(byId.get(id)?.dependencyIds ?? [])); }
  return ids;
}
export function outcomeStatus(outcomes: CheckOutcome[]): RequirementStatus {
  if (!outcomes.length) return "inconclusive";
  if (outcomes.some(item => item.status === "fail")) return "failed";
  if (outcomes.every(item => item.status === "pass")) return "verified";
  if (outcomes.every(item => item.status === "blocked")) return "blocked";
  return "inconclusive";
}
/** Scenario identities stay source-derived; implementation alone cannot grant coverage. */
function scenarioResults(requirements: AtomicRequirement[], outcomes: CheckOutcome[],
  implemented: ReadonlySet<string>): RunScenarioResult[] {
  return requirements.flatMap(requirement => (requirement.scenarioContracts ?? []).map(scenario => {
    const clauses = outcomes.filter(item => item.requirementId === requirement.id && item.scenarioId === scenario.id);
    const status = outcomeStatus(clauses);
    return { requirementId: requirement.id, scenarioId: scenario.id, name: scenario.name,
      status: !implemented.has(requirement.id) ? "not_run" as const
        : clauses.length === 0 ? "pending" as const
        : status === "verified" ? "verified" as const
        : status === "failed" ? "failed" as const : "inconclusive" as const,
      caseIds: [...new Set(clauses.map(item => item.clauseId))],
      reason: clauses.filter(item => item.status !== "pass").map(item => item.reason).filter(Boolean).join("; ") };
  }));
}
function scenarioCoverage(requirements: AtomicRequirement[], outcomes: CheckOutcome[],
  implemented: ReadonlySet<string>): ScenarioCoverageCounts {
  const results = scenarioResults(requirements, outcomes, implemented);
  const count = (status: RunScenarioResult["status"]) => results.filter(item => item.status === status).length;
  return { total: results.length, verified: count("verified"), failed: count("failed"),
    inconclusive: count("inconclusive"), pending: count("pending"), notRun: count("not_run") };
}
function outcomeKey(item: ScopedOutcome): string { return JSON.stringify([item.requirementId, item.scenarioId, item.clauseId, item.initialState?.digest]); }
async function repairObservation(artifacts: ArtifactStore, packet: WorkPacket, outcomes: CheckOutcome[], startup: boolean,
  secrets?: readonly string[], startupMessage?: string): Promise<BuilderShadowObservation> {
  const failures: BuilderShadowObservation["failures"] = [];
  for (const outcome of outcomes.filter(item => packet.requirementIds.includes(item.requirementId) && item.status === "fail")) {
    const observations: unknown[] = [];
    for (const ref of outcome.evidence) {
      const receipt = await artifacts.getJson<EvidenceReceipt>(ref);
      if (receipt.kind !== "assertion") continue;
      // Only semantic values from the assertion receipt are projected, never executable content or paths.
      const payload = await artifacts.readTypedJson<Record<string, unknown>>(receipt.payload);
      observations.push(Object.fromEntries(["actual", "expected", "operator", "message"].filter(key => payload[key] !== undefined).map(key => [key, payload[key]])));
    }
    failures.push({ caseId: `${outcome.requirementId}/${outcome.scenarioId}/${outcome.clauseId}`, stepIndex: 0, category: "assertion",
      message: sanitizeDiagnosticText(outcome.reason ?? "Required result was violated in independent executions", secrets),
      inputSummary: sanitizeDiagnosticText(JSON.stringify(observations), secrets, 2_000) });
  }
  if (startup) failures.push({ caseId: "<application>", stepIndex: 0, category: "runner", message: sanitizeDiagnosticText(
    startupMessage || "Current module snapshot did not satisfy execution readiness", secrets) });
  return { packetId: packet.id, passedCaseIds: outcomes.filter(item => item.status === "pass").map(item => item.clauseId),
    failures, applicationStartupFailed: startup };
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function now(): string { return new Date().toISOString(); }
