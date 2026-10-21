import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { BuilderRequest, BuilderResult } from "./builder/port.js";
import type { BuilderProjectContext, BuilderShadowObservation } from "./builder/prompt-input.js";
import { loadRequirementCatalog } from "./catalog.js";
import { evolutionImplementationCatalog, readHistoricalRequirementIds, selectEvolutionScope } from "./evolution.js";
import { ExecutionFault } from "./execution-fault.js";
import { GatewayRequestError } from "./gateway-failure.js";
import { GatewayRecovery } from "./gateway-recovery.js";
import type { DeliveryReport } from "./application/port.js";
import { parseFeatureGrouping } from "./feature-grouper.js";
import { sanitizeDiagnosticText } from "./diagnostics.js";
import { ModelUsageTotals } from "./model-usage.js";
import type { PipelineDeps, PipelineOptions, RunSummary } from "./pipeline.js";
import { RunBudget, type PipelinePhase } from "./run-budget.js";
import { RunStateStore } from "./run-state.js";
import { auditPackets, featureGroupPackets, featureGroupingFromIds, makePacket } from "./scheduler.js";
import type { AtomicRequirement, RequirementCatalog, RequirementStatus, RunEvent, RunScenarioResult,
  ScenarioCoverageCounts, WorkPacket } from "./types.js";
import type { ArtifactStore } from "./checker/artifacts.js";
import { atomicWrite, canonicalJson, sameRef } from "./checker/artifacts.js";
import type { AcceptanceContract, CheckerProgramDescriptor } from "./checker/evidence.js";
import { CheckerCheckpoints, type ProducedSnapshot } from "./checker/checkpoints.js";
import { CheckerQueue } from "./checker/queue.js";
import type { CheckJob, CheckerPort, CheckOutcome, CheckReport, ContentRef, EvidenceReceipt, ExecutionBindingRef, ProgramRef, TypedRef } from "./checker/port.js";
import type { SnapshotStore } from "./snapshot-store.js";
import type { CheckerModelUsage } from "./checker/model.js";

export interface CheckerRuntime {
  directory: string;
  artifacts: ArtifactStore;
  snapshots: SnapshotStore;
  checker: CheckerPort;
  binding: ExecutionBindingRef;
  initialState: TypedRef;
  resourceKeys: string[];
  setUsageRecorder?(recorder: (usage: CheckerModelUsage) => void): void;
  setUsageProgressRecorder?(recorder: (usage: CheckerModelUsage) => void): void;
  verifyDelivery(job: CheckJob, signal: AbortSignal): Promise<{ report: DeliveryReport; receipts: ContentRef[] }>;
}
type ScopedOutcome = CheckOutcome & { initialState?: TypedRef };

/** Controller-side orchestration; all domain operations are provided by the execution adapter. */
export class CheckerCoordinator {
  private monitors = new Set<Promise<void>>();
  private failure?: unknown;
  private constructor(readonly runtime: CheckerRuntime, readonly queue: CheckerQueue,
    readonly checkpoints: CheckerCheckpoints, private readonly options: PipelineOptions,
    private readonly deps: PipelineDeps, private readonly emit: (event: RunEvent) => Promise<void>,
    private readonly accepted?: (head: ProducedSnapshot) => Promise<void>) {}

  static async open(runtime: CheckerRuntime, options: PipelineOptions, deps: PipelineDeps,
    initialSha: string, emit: (event: RunEvent) => Promise<void>, accepted?: (head: ProducedSnapshot) => Promise<void>): Promise<CheckerCoordinator> {
    await runtime.artifacts.validateBinding(runtime.binding);
    const checkpoints = await CheckerCheckpoints.open(join(runtime.directory, "controller.json"), runtime.binding.digest, initialSha);
    const queue = await CheckerQueue.open({ directory: runtime.directory, artifacts: runtime.artifacts,
      checker: { check: async (job, signal) => {
        const head = checkpoints.snapshot.snapshots.find(item => sameRef(item.snapshot, job.snapshot));
        await emit({ at: now(), type: "check_started", packetId: job.packetId, detail: { ...jobDetail(job, head?.sourceSha ?? ""),
          archived: checkpoints.snapshot.producedHead?.snapshot.id !== job.snapshot.id || checkpoints.snapshot.epoch !== job.moduleEpoch } });
        return runtime.checker.check(job, signal, async progress => {
          const current = checkpoints.snapshot;
          await emit({ at: now(), type: "check_progress", packetId: job.packetId,
            detail: { ...jobDetail(job, head?.sourceSha ?? ""), ...progress,
              archived: current.producedHead?.snapshot.id !== job.snapshot.id || current.epoch !== job.moduleEpoch } });
        });
      } }, concurrency: options.checker?.concurrency ?? 2, resourceKeys: () => runtime.resourceKeys, startPaused: true });
    const coordinator = new CheckerCoordinator(runtime, queue, checkpoints, options, deps, emit, accepted);
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
    await this.emit({ at: now(), type: "snapshot_sealed", packetId: packet.id, detail: { snapshotId: head.snapshot.id,
      sourceSha, parentSnapshotId: head.parentSnapshotId, requirementIds: packet.requirementIds,
      implementedRequirementIds: head.implementedRequirementIds, sequence: head.ordinal, authoritative: true } });
    return head;
  }

  async submit(head: ProducedSnapshot, packet: WorkPacket, mode: CheckJob["mode"], budget: CheckJob["budget"],
    options: { epoch?: number; programs?: ProgramRef[]; priority?: number; requirementIds?: string[] } = {}): Promise<CheckJob> {
    const job = await this.createJob(head, packet, mode, budget, options);
    await this.queue.enqueue(job, { priority: options.priority ?? 3 });
    await this.emit({ at: now(), type: "check_queued", packetId: packet.id, detail: jobDetail(job, head.sourceSha) });
    const monitor = this.monitor(job, head).catch(error => { this.failure = error; });
    this.monitors.add(monitor);
    void monitor.finally(() => this.monitors.delete(monitor));
    return job;
  }

  private async createJob(head: ProducedSnapshot, packet: WorkPacket, mode: CheckJob["mode"], budget: CheckJob["budget"],
    options: { epoch?: number; programs?: ProgramRef[]; requirementIds?: string[] } = {}): Promise<CheckJob> {
    this.assertHealthy();
    const contextualIds = new Set([...packet.requirementIds, ...(packet.prerequisites ?? []).map(item => item.id)]);
    const requirements = await this.runtime.artifacts.putJson(JSON.parse(JSON.stringify({ requirements: packet.requirements,
      prerequisites: packet.prerequisites ?? [], implementedRequirementIds: head.implementedRequirementIds.filter(id => contextualIds.has(id)) })));
    const requirementIds = options.requirementIds ?? packet.requirementIds;
    const programs = options.programs ?? (mode === "prepare" ? [] : await this.programs(requirementIds, this.runtime.initialState, requirements));
    return { jobId: randomUUID(), runId: this.runtime.artifacts.runId, moduleId: moduleId(packet.requirements[0]),
      packetId: packet.id, attempt: packet.attempt, moduleEpoch: options.epoch ?? this.checkpoints.snapshot.epoch, snapshot: head.snapshot, requirements,
      binding: this.runtime.binding, initialState: this.runtime.initialState, requirementIds, mode, programs,
      budget };
  }

  async verifyDelivery(head: ProducedSnapshot, packet: WorkPacket, budget: CheckJob["budget"], signal: AbortSignal): Promise<DeliveryReport> {
    await this.drain();
    const job = await this.createJob(head, packet, "prepare", budget);
    const { report, receipts } = await this.runtime.verifyDelivery(job, signal);
    const ready = await this.acceptReadiness(job, head, receipts);
    const checked = report.ok && !ready ? { ok: false, stage: "readiness" as const, message: "Delivery did not produce current readiness evidence" } : report;
    await atomicWrite(join(this.runtime.directory, "delivery", job.jobId + ".json"),
      canonicalJson({ job: await this.runtime.artifacts.putJson(job), report: checked, receipts }));
    return checked;
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

  async programs(requirementIds: string[], initialState?: TypedRef, requirements?: ContentRef): Promise<ProgramRef[]> {
    const programs = new Map<string, ProgramRef>();
    for (const record of this.queue.records().reverse()) {
      const ref = record.report ?? record.lateReport;
      if (!ref || !record.job.requirementIds.some(id => requirementIds.includes(id)) ||
        record.job.binding.digest !== this.runtime.binding.digest) continue;
      if (requirements && !sameRef(record.job.requirements, requirements)) continue;
      const report = await this.runtime.artifacts.getJson<CheckReport>(ref);
      await this.runtime.artifacts.validateReport(record.job, report);
      for (const program of report.programs) {
        if (!sameRef(program.binding, this.runtime.binding)) continue;
        const descriptor = await this.runtime.artifacts.readTypedJson<CheckerProgramDescriptor>(program.descriptor);
        if (initialState && !sameRef(descriptor.initialState, initialState)) continue;
        const contract = await this.runtime.artifacts.getJson<AcceptanceContract>(program.contract);
        if (requirements && !sameRef(contract.requirements, requirements)) continue;
        if (!contract.clauses.every(clause => requirementIds.includes(clause.requirementId))) continue;
        programs.set(canonicalJson(program), program);
      }
    }
    return [...programs.values()];
  }

  private async monitor(job: CheckJob, head: ProducedSnapshot): Promise<void> {
    const record = await this.queue.wait(job.jobId);
    if (record.status === "completed" && record.report) {
      const report = await this.runtime.artifacts.getJson<CheckReport>(record.report);
      const manifest = await this.runtime.artifacts.getJson<{ receipts?: ContentRef[] }>(report.manifest);
      await this.acceptReadiness(job, head, manifest.receipts ?? []);
    }
    const current = this.checkpoints.snapshot;
    await this.emit({ at: now(), type: record.status === "cancelled" ? "check_cancelled" : "check_completed", packetId: job.packetId,
      detail: { ...jobDetail(job, head.sourceSha), status: record.status, reason: record.error,
        archived: current.producedHead?.snapshot.id !== job.snapshot.id || current.epoch !== job.moduleEpoch,
        durationMs: (record.completedAt ?? Date.now()) - (record.startedAt ?? record.queuedAt) } });
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

export async function runCheckerPipeline(options: PipelineOptions, deps: PipelineDeps, runtime: CheckerRuntime): Promise<RunSummary> {
  const catalog = await loadRequirementCatalog(options.requirementsFile, { inheritedApplication: options.stageStartingPoint === "inherited_application" });
  const started = options.startedAtMs ?? deps.clock.nowMs();
  const budget = new RunBudget(options.totalBudgetMs, started, () => deps.clock.nowMs());
  const initialSha = await deps.git.captureAccepted("shallow: initial Checker state");
  const state = new RunStateStore({ statusByRequirementId: catalog.statusById, acceptedSha: initialSha,
    startedAtMs: started, totalBudgetMs: options.totalBudgetMs }, options.ledgerFile, deps.logSink ?? null, deps.diagnosticSecrets);
  const usage = new ModelUsageTotals();
  for (const item of options.initializationUsage ?? []) usage.add("builder", item);
  const gateway = deps.gatewayRecovery ?? new GatewayRecovery();
  gateway.setRecorder(({ packetId, ...detail }) => state.record({ at: now(), type: "gateway_wait", packetId, detail }));
  runtime.setUsageRecorder?.(item => {
    usage.add("checker", item);
    void state.record({ at: now(), type: "checker_usage", detail: item });
  });
  runtime.setUsageProgressRecorder?.(item => {
    // 进行中用量只服务交互终端的实时展示，不进入账本或日志。
    state.present({ at: now(), type: "checker_usage_progress", detail: item });
  });
  const coordinator = await CheckerCoordinator.open(runtime, options, deps, initialSha, event => state.record(event), async head => {
    state.setAcceptedSha(head.sourceSha);
    await state.record({ at: now(), type: "checkpoint_saved", detail: { requirementIds: head.implementedRequirementIds, reason: "Checker readiness" } });
  });
  state.setAcceptedSha(coordinator.checkpoints.snapshot.accepted.sha);
  const recoveredHead = coordinator.checkpoints.snapshot.producedHead;
  if (recoveredHead) await runtime.snapshots.restore(recoveredHead.snapshot, options.outputDir,
    { generatedPaths: options.applicationContract.generatedPaths, dataPaths: options.applicationContract.dataPaths });
  const implemented = new Set(coordinator.checkpoints.snapshot.producedHead?.implementedRequirementIds ?? options.resumedRequirementIds ?? []);
  const inherited = new Set<string>();
  const skipped = new Set<string>();
  const currentResults = new Map<string, ScopedOutcome[]>();
  let auditGroups: WorkPacket[] = [];
  const byId = new Map(catalog.requirements.map(item => [item.id, item]));
  let implementationCatalog: RequirementCatalog = catalog;
  const checkBudget = (): CheckJob["budget"] => ({ timeoutMs: 3_600_000,
    deadlineAt: Number.isFinite(budget.remaining("delivery")) ? Date.now() + budget.remaining("delivery") : Number.MAX_SAFE_INTEGER });
  const emitPhase = (phase: PipelinePhase) => state.record({ at: now(), type: "phase_started", detail: { phase, remainingMs: finite(budget.remaining(phase)) } });
  const packetFor = (id: string, requirements: AtomicRequirement[], attempt: 1 | 2 | 3 = 1): WorkPacket => ({
    ...makePacket(id, requirements, attempt),
    prerequisites: catalog.requirements.filter(item => !requirements.includes(item) && dependencyClosure(requirements, byId).has(item.id)) });
  const contextFor = (packet: WorkPacket): BuilderProjectContext => ({ product: packet.requirements[0].product,
    ancestors: [...new Map(packet.requirements.flatMap(item => item.ancestors).map(item => [item.id, item])).values()],
    satisfiedDependencies: (packet.prerequisites ?? []).filter(item => implemented.has(item.id)).map(item => ({ id: item.id, name: item.name, contract: item.text })),
    ...(packet.requirements[0].product.evolution ? { evolution: { startingPoint: options.stageStartingPoint ?? "unknown",
      externalPrerequisiteIds: packet.externalPrerequisiteIds ?? [], changesOnly: true as const,
      ...(!options.auditInheritedRequirements ? { auditInheritedRequirements: false as const } : {}) } }
      : packet.requirements[0].product.stage ? { progressiveStage: { ...packet.requirements[0].product.stage,
        startingPoint: options.stageStartingPoint ?? "unknown", externalPrerequisiteIds: packet.externalPrerequisiteIds ?? [] } } : {}) });
  const build = async (request: BuilderRequest, phase: PipelinePhase, resumeInterrupted = false): Promise<BuilderResult> => {
    // Fixed services declared by a project must also be exclusive with Builder self-tests.
    if (runtime.resourceKeys.length) await coordinator.drain();
    const packetId = "packet" in request ? request.packet.id : "delivery";
    await state.record({ at: now(), type: "builder_started", packetId, detail: { mode: request.mode } });
    let reported = false;
    const onUsage = async (item: Parameters<ModelUsageTotals["add"]>[1]) => {
      reported = true; usage.add("builder", item);
      await state.record({ at: now(), type: "builder_usage", packetId, detail: { ...item, total: item.input + item.output + item.cacheRead + item.cacheWrite } });
    };
    let result: BuilderResult = { outcome: "failed", sessionId: "unavailable", summary: "Builder did not start" };
    try {
      result = await gateway.run("builder", packetId, () => budget.remaining(phase), async () => {
        reported = false;
        result = await deps.builder.run({ ...request, ...(options.initialization ? { initialization: options.initialization } : {}) },
          { timeoutMs: budget.callTimeout(phase, resumeInterrupted ? 2_700_000 : 5_400_000), resumeInterrupted, onUsage });
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
  const inspect = async (head: ProducedSnapshot, requirements: AtomicRequirement[], epoch: number): Promise<ScopedOutcome[]> => {
    const jobs: CheckJob[] = [];
    const scope = new Set(requirements.map(item => item.id));
    const grouped = new Set(auditGroups.flatMap(packet => packet.requirementIds));
    const packets = [...auditGroups, ...auditPackets({ requirements: requirements.filter(item => !grouped.has(item.id)), statusById: catalog.statusById })];
    for (const packet of packets.filter(packet => packet.requirementIds.some(id => scope.has(id)))) {
      const full = packetFor(packet.id, packet.requirements);
      jobs.push(await coordinator.submit(head, full, "replay", checkBudget(), { epoch, priority: 1,
        requirementIds: packet.requirementIds.filter(id => scope.has(id)) }));
    }
    const reports = await Promise.all(jobs.map(job => coordinator.report(job)));
    await coordinator.drain();
    return reports.flatMap((report, index) => {
      const outcomes = report?.outcomes ?? jobs[index].requirementIds.map(requirementId => ({
        requirementId, scenarioId: "<execution>", clauseId: "<execution>", status: "inconclusive" as const,
        evidence: [], reason: "Checker did not commit a current report" }));
      return outcomes.map(outcome => ({ ...outcome, initialState: jobs[index].initialState }));
    });
  };
  const publish = async (head: ProducedSnapshot, module: string, epoch: number, outcomes: CheckOutcome[], scope: AtomicRequirement[]): Promise<void> => {
    for (const requirement of scope) {
      const clauses = outcomes.filter(item => item.requirementId === requirement.id);
      currentResults.set(requirement.id, clauses);
      state.markRequirements([requirement.id], outcomeStatus(clauses));
    }
    const selected = catalog.requirements.filter(item => !skipped.has(item.id));
    const allOutcomes = [...currentResults.values()].flat();
    await state.record({ at: now(), type: "module_check_finished", detail: { moduleId: module, moduleEpoch: epoch,
      snapshotId: head.snapshot.id, published: true,
      requirementResults: Object.fromEntries(scope.map(item => [item.id, outcomeStatus(currentResults.get(item.id) ?? [])])),
      scenarioResults: scenarioResults(scope, allOutcomes, implemented),
      scenarioCoverage: scenarioCoverage(selected, allOutcomes, implemented) } });
  };
  const boundary = async (module: string, allowRepair = true): Promise<void> => {
    await coordinator.drain();
    let head = coordinator.checkpoints.snapshot.producedHead;
    if (!head) return;
    const moduleRequirements = catalog.requirements.filter(item => moduleId(item) === module && implemented.has(item.id));
    const prerequisites = dependencyClosure(moduleRequirements, byId);
    const scope = catalog.requirements.filter(item => !skipped.has(item.id) && implemented.has(item.id) &&
      (moduleId(item) === module || prerequisites.has(item.id)));
    let epoch = await coordinator.checkpoints.nextEpoch();
    await state.record({ at: now(), type: "module_check_started", detail: { moduleId: module, moduleEpoch: epoch,
      snapshotId: head.snapshot.id, requirementIds: scope.map(item => item.id) } });
    const prepare = await coordinator.submit(head, packetFor(`prepare-${module}`, scope.length ? scope : catalog.requirements.slice(0, 1)),
      "prepare", checkBudget(), { epoch, priority: 0 });
    const prepared = await coordinator.report(prepare);
    await coordinator.drain();
    let runnable = coordinator.checkpoints.snapshot.accepted.snapshot?.id === head.snapshot.id;
    const preparationDiagnostics = prepared ? (await runtime.artifacts.getJson<{ diagnostics?: string[] }>(prepared.manifest)).diagnostics ?? [] : ["No readiness report was committed"];
    let outcomes = runnable ? await inspect(head, scope, epoch) : scope.map(item => ({ requirementId: item.id,
      scenarioId: "<readiness>", clauseId: "<readiness>", status: "inconclusive" as const, evidence: [], reason: "Current snapshot readiness failed" }));
    for (let round = 1; allowRepair && round <= 2 && budget.remaining("repair") > 0; round++) {
      const failedIds = scope.filter(item => outcomes.some(result => result.requirementId === item.id && result.status === "fail")).map(item => item.id);
      if (runnable && !failedIds.length) break;
      const baseline: ProducedSnapshot = head;
      const baselineOutcomes = outcomes;
      const repairRequirements = runnable ? scope.filter(item => failedIds.includes(item.id)) : scope;
      if (!repairRequirements.length) break;
      const repairPacket = packetFor(`checker-repair-${module}-${round}`, repairRequirements, round === 1 ? 2 : 3);
      await emitPhase("repair");
      await state.record({ at: now(), type: "repair_batch_started", detail: { round, requirementIds: repairPacket.requirementIds } });
      const observation = await repairObservation(runtime.artifacts, repairPacket, outcomes, !runnable, deps.diagnosticSecrets,
        preparationDiagnostics.join("; ").replaceAll(runtime.directory, "<execution>"));
      const result = await build({ mode: "repair", packet: repairPacket, projectContext: contextFor(repairPacket),
        shadowObservation: observation, outputDir: options.outputDir, applicationContract: options.applicationContract }, "repair");
      let retained = false;
      if (result.outcome === "completed") {
        const repaired = await coordinator.seal(repairPacket, implemented);
        epoch = await coordinator.checkpoints.nextEpoch();
        const readyJob = await coordinator.submit(repaired, repairPacket, "prepare", checkBudget(), { epoch, priority: 0 });
        await coordinator.report(readyJob); await coordinator.drain();
        if (coordinator.checkpoints.snapshot.accepted.snapshot?.id === repaired.snapshot.id) {
          const regressionScope = catalog.requirements.filter(item => !skipped.has(item.id) && implemented.has(item.id) &&
            (moduleId(item) === module || currentResults.get(item.id)?.some(outcome => outcome.status === "pass")));
          const checked = await inspect(repaired, regressionScope, epoch);
          const guards = [...baselineOutcomes, ...[...currentResults.values()].flat()].filter(item => item.status === "pass");
          const preserved = guards.every(previous => checked.filter(item => outcomeKey(item) === outcomeKey(previous)).length > 0 &&
            checked.filter(item => outcomeKey(item) === outcomeKey(previous)).every(item => item.status === "pass"));
          const improved = !runnable || baselineOutcomes.some(previous => previous.status === "fail" &&
            checked.filter(item => outcomeKey(item) === outcomeKey(previous)).length > 0 &&
            checked.filter(item => outcomeKey(item) === outcomeKey(previous)).every(item => item.status === "pass"));
          if (preserved && improved) {
            retained = true; runnable = true; head = repaired;
            outcomes = checked.filter(item => scope.some(requirement => requirement.id === item.requirementId));
            for (const requirement of regressionScope.filter(item => moduleId(item) !== module)) currentResults.set(requirement.id,
              checked.filter(item => item.requirementId === requirement.id));
          }
        }
      }
      if (!retained) {
        await coordinator.cancelOutstanding();
        await deps.git.restoreAccepted(baseline.sourceSha);
        await runtime.snapshots.restore(baseline.snapshot, options.outputDir, { generatedPaths: options.applicationContract.generatedPaths, dataPaths: options.applicationContract.dataPaths });
        await coordinator.checkpoints.restore(baseline);
        state.setAcceptedSha(coordinator.checkpoints.snapshot.accepted.sha);
        head = baseline;
        epoch = coordinator.checkpoints.snapshot.epoch;
        runnable = coordinator.checkpoints.snapshot.accepted.snapshot?.id === baseline.snapshot.id;
        outcomes = runnable ? await inspect(baseline, scope, epoch) : baselineOutcomes.map(item => ({ ...item,
          status: "inconclusive" as const, evidence: [], reason: "Restored module readiness remains unconfirmed" }));
      }
      await state.record({ at: now(), type: "repair_batch_finished", detail: { round, retained,
        reason: retained ? "Current-version improvement and regression replay confirmed" : "Repair did not establish improvement with complete regression evidence" } });
      if (!retained) break;
    }
    await publish(head!, module, epoch, outcomes, scope);
  };

  try {
    await state.record({ at: now(), type: "pipeline_started", detail: { requirements: catalog.requirements.length,
      totalBudgetMs: options.totalBudgetMs, adapterId: options.applicationContract.adapterId, ...deps.runMetadata } });
    // 恢复运行时先把已实现范围交给展示层；验收结果仍由后续独立检查确定。
    if (implemented.size) await state.record({ at: now(), type: "run_resumed", detail: { requirementIds: [...implemented] } });
    if (options.stageStartingPoint === "inherited_application" && catalog.requirements[0]?.product.evolution) {
      const history = options.historicalRequirements ?? await readHistoricalRequirementIds(options.historicalProgressDir ?? options.progressDir ?? join(options.outputDir, "shallow-progress"));
      const selection = selectEvolutionScope(catalog, new Set(history.requirementIds), history.requirementDigests, options.requirementDigests);
      for (const id of selection.inheritedRequirementIds) { inherited.add(id); implemented.add(id); if (!options.auditInheritedRequirements) skipped.add(id); }
      implementationCatalog = evolutionImplementationCatalog(catalog, inherited);
      await state.record({ at: now(), type: "evolution_scope_selected", detail: {
        ...selection, historicalPlans: history.plans, ignoredPlans: history.ignoredPlans,
        historicalPlanRequirementCount: history.planRequirementCount, historicalCheckpointRequirementCount: history.checkpointRequirementCount,
        historicalCheckpointSupplementCount: history.checkpointSupplementCount, historicalRequirementCount: new Set(history.requirementIds).size,
        implementationRequirementIds: implementationCatalog.requirements.map(item => item.id),
        auditRequirementIds: catalog.requirements.filter(item => !skipped.has(item.id)).map(item => item.id), skippedRequirementIds: [...skipped] } });
    }
    const savedGroups = coordinator.checkpoints.snapshot.featureGroups;
    let grouping = savedGroups ? featureGroupingFromIds(implementationCatalog, savedGroups) : featureGroupPackets(implementationCatalog);
    const grouper = deps.grouper;
    if (!savedGroups && grouper && implementationCatalog.requirements.length && budget.remaining("implementation") > 0) {
      await state.record({ at: now(), type: "feature_grouping_started", detail: { requirements: implementationCatalog.requirements.length,
        limits: { maxRequirements: 4, maxScenarios: 12, maxTextChars: 20_000 } } });
      const at = Date.now(); let reason: string | undefined; let source: "llm" | "deterministic" = "deterministic";
      try {
        const proposal = await gateway.run("planning", "feature-grouping", () => budget.remaining("implementation"),
          () => grouper.group(implementationCatalog, { timeoutMs: Math.min(720_000, budget.remaining("implementation")),
            onUsage: async item => { usage.add("planner", item); await state.record({ at: now(), type: "feature_grouping_usage", detail: item }); } }));
        grouping = parseFeatureGrouping(proposal, implementationCatalog); source = "llm";
      } catch (error) { reason = message(error); }
      await state.record({ at: now(), type: "feature_grouping_finished", detail: { source, reason, grouping: grouping.stats,
        durationMs: Date.now() - at, groups: grouping.packets.map(item => ({ packetId: item.id, requirementIds: item.requirementIds })) } });
    }
    if (!savedGroups) await coordinator.checkpoints.setFeatureGroups(grouping.packets.map(packet => packet.requirementIds));
    auditGroups = grouping.packets.map(packet => packetFor(packet.id, packet.requirementIds.map(id => byId.get(id)!)));
    if (coordinator.checkpoints.snapshot.producedHead) {
      const head = coordinator.checkpoints.snapshot.producedHead!;
      const packet = packetFor("resume", catalog.requirements.filter(item => implemented.has(item.id)));
      if (packet.requirements.length) {
        const job = await coordinator.submit(head, packet, "prepare", checkBudget(), { priority: 0 });
        await coordinator.report(job); await coordinator.drain();
        if (coordinator.checkpoints.snapshot.accepted.snapshot?.id !== head.snapshot.id) await boundary(moduleId(packet.requirements.at(-1)!));
      }
    }
    let previousModule: string | undefined;
    for (const grouped of grouping.packets) {
      if (budget.remaining("implementation") <= 0) break;
      const requirements = grouped.requirements.filter(item => !implemented.has(item.id));
      if (!requirements.length) continue;
      const packet = packetFor(grouped.id, requirements);
      const module = moduleId(requirements[0]);
      if (previousModule && previousModule !== module) await boundary(previousModule);
      previousModule = module;
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
      const request: BuilderRequest = { mode: "implement", packet, projectContext: contextFor(packet), outputDir: options.outputDir, applicationContract: options.applicationContract };
      let result = await build(request, "implementation");
      if (result.outcome !== "completed" && !result.gatewayFailure && budget.remaining("implementation") > 0) result = await build(request, "implementation", true);
      if (result.outcome !== "completed") {
        // Seal partial work for recovery; incomplete feature groups never become implemented.
        await coordinator.seal(packet, implemented);
        state.markRequirements(packet.requirementIds, "blocked");
        if (result.gatewayFailure) break;
        continue;
      }
      for (const id of packet.requirementIds) implemented.add(id);
      const head = await coordinator.seal(packet, implemented);
      await coordinator.submit(head, auditGroups.find(group => group.id === grouped.id)!, "discover", checkBudget());
    }
    if (previousModule) await boundary(previousModule);
    if (!coordinator.checkpoints.snapshot.producedHead) await coordinator.seal(packetFor("initial", catalog.requirements), implemented);
    await coordinator.drain();
    await emitPhase("audit");
    // Freeze and replay the complete current scope, including earlier modules.
    let head = coordinator.checkpoints.snapshot.producedHead;
    const scope = catalog.requirements.filter(item => !skipped.has(item.id) && implemented.has(item.id));
    if (head) {
      const epoch = await coordinator.checkpoints.nextEpoch();
      const outcomes = await inspect(head, scope, epoch);
      await publish(head, "<final>", epoch, outcomes, scope);
    }
    await emitPhase("delivery");
    await state.record({ at: now(), type: "delivery_started" });
    let delivery: DeliveryReport = { ok: false, stage: "candidate", message: "No sealed application is available" };
    const verifyDelivery = async (candidate: ProducedSnapshot): Promise<DeliveryReport> => {
      const packet = packetFor("delivery", scope.length ? scope : catalog.requirements.slice(0, 1));
      const signal = AbortSignal.timeout(Math.max(1, Math.min(720_000, budget.remaining("delivery"))));
      await state.record({ at: now(), type: "delivery_check_started", detail: { snapshotId: candidate.snapshot.id } });
      const report = await coordinator.verifyDelivery(candidate, packet, checkBudget(), signal);
      await state.record({ at: now(), type: "delivery_check_finished", detail: { snapshotId: candidate.snapshot.id, ...report } });
      return report;
    };
    if (head && budget.remaining("delivery") > 0) delivery = await verifyDelivery(head);
    for (let round = 1; head && !delivery.ok && round <= 3 && budget.remaining("delivery") > 0; round++) {
      const baseline = head;
      await state.record({ at: now(), type: "delivery_repair_started", detail: { stage: delivery.stage, message: delivery.message, round } });
      const result = await build({ mode: "delivery_repair", outputDir: options.outputDir, applicationContract: options.applicationContract,
        deliveryFailure: { stage: delivery.stage, expected: "The application satisfies the declared execution and delivery contract", actual: sanitizeDiagnosticText(delivery.message, deps.diagnosticSecrets) } }, "delivery");
      if (result.outcome === "completed") {
        const repaired = await coordinator.seal(packetFor(`delivery-repair-${round}`, scope.length ? scope : catalog.requirements), implemented);
        const checked = await verifyDelivery(repaired);
        if (checked.ok) {
          const epoch = await coordinator.checkpoints.nextEpoch();
          const outcomes = await inspect(repaired, scope, epoch);
          const guards = [...currentResults.values()].flat().filter(item => item.status === "pass");
          if (guards.every(item => outcomes.filter(next => outcomeKey(next) === outcomeKey(item)).length > 0 &&
            outcomes.filter(next => outcomeKey(next) === outcomeKey(item)).every(next => next.status === "pass"))) {
            head = repaired; delivery = checked; await publish(repaired, "<delivery>", epoch, outcomes, scope); break;
          }
        }
      }
      await coordinator.cancelOutstanding(); await deps.git.restoreAccepted(baseline.sourceSha);
      await runtime.snapshots.restore(baseline.snapshot, options.outputDir, { generatedPaths: options.applicationContract.generatedPaths, dataPaths: options.applicationContract.dataPaths });
      await coordinator.checkpoints.restore(baseline);
      state.setAcceptedSha(coordinator.checkpoints.snapshot.accepted.sha);
      await state.record({ at: now(), type: "delivery_repair_restored", detail: { round } });
      delivery = await verifyDelivery(baseline);
    }
    if (head && !delivery.ok && coordinator.checkpoints.snapshot.accepted.sha !== head.sourceSha) {
      // Preserve the latest sealed source in the private history before delivering a runnable ancestor.
      const accepted = coordinator.checkpoints.snapshot.accepted;
      const fallback = coordinator.checkpoints.snapshot.snapshots.find(item => item.snapshot.id === accepted.snapshot?.id);
      for (const item of scope) state.markRequirements([item.id], "inconclusive");
      currentResults.clear();
      if (fallback) {
        await deps.git.restoreAccepted(fallback.sourceSha);
        await runtime.snapshots.restore(fallback.snapshot, options.outputDir,
          { generatedPaths: options.applicationContract.generatedPaths, dataPaths: options.applicationContract.dataPaths });
        head = fallback;
        implemented.clear(); for (const id of [...fallback.implementedRequirementIds, ...inherited]) implemented.add(id);
        if (budget.remaining("delivery") > 0) {
          delivery = await verifyDelivery(fallback);
          const fallbackScope = scope.filter(item => implemented.has(item.id));
          const epoch = await coordinator.checkpoints.nextEpoch();
          const outcomes = await inspect(fallback, fallbackScope, epoch);
          await publish(fallback, "<fallback>", epoch, outcomes, fallbackScope);
        }
      }
    }
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
    const selected = catalog.requirements.filter(item => !skipped.has(item.id));
    const ids = (status: RequirementStatus) => selected.filter(item => state.snapshot.statusByRequirementId[item.id] === status).map(item => item.id);
    const verified = ids("verified");
    const summary: RunSummary = { status: !delivery.ok ? "failed" : verified.length === selected.length ? "delivered" : "partial",
      acceptedSha: state.snapshot.acceptedSha, delivery, verifiedRequirementIds: verified,
      blockedRequirementIds: ids("blocked"), failedRequirementIds: ids("failed"), inconclusiveRequirementIds: ids("inconclusive"), pendingRequirementIds: ids("todo"),
      implementedRequirementIds: [...implemented].filter(id => !skipped.has(id)), modelUsage: usage.summary(),
      auditRequirementIds: selected.map(item => item.id), skippedRequirementIds: [...skipped],
      checker: { mode: "active", producedHead: coordinator.checkpoints.snapshot.producedHead,
        verifiedSnapshotId: delivery.ok ? head?.snapshot.id : undefined, outcomes: [...currentResults.values()].flat() },
      scenarioResults: scenarioResults(selected, [...currentResults.values()].flat(), implemented) };
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
function moduleId(requirement: AtomicRequirement | undefined): string { return requirement?.folderPath[1] ?? requirement?.id ?? "<application>"; }
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
      status: !implemented.has(requirement.id) ? "not_run" as const : status === "verified" ? "verified" as const
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
    inconclusive: count("inconclusive"), notRun: count("not_run") };
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
function finite(value: number): number | undefined { return Number.isFinite(value) ? value : undefined; }
function now(): string { return new Date().toISOString(); }
