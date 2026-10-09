import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import type {
  BuilderPort,
  BuilderRequest,
  BuilderResult,
  BuilderRunOptions,
} from "./builder/port.js";
import type {
  BuilderProjectContext,
} from "./builder/prompt-input.js";
import { toBuilderShadowObservation } from "./builder/shadow-observation.js";
import {
  buildArcRequirementRows,
  type ArcRequirementRow,
  type ArcScenarioRow,
} from "./arc-protocol.js";
import { loadRequirementCatalog } from "./catalog.js";
import { maskRequirementLiterals } from "./requirement-text.js";
import { evolutionImplementationCatalog, readHistoricalRequirementIds, selectEvolutionScope } from "./evolution.js";
import type { GitOps } from "./git-ops.js";
import type {
  FinalVerificationReport,
  FinalVerifierPort,
} from "./final-verifier.js";
import { ProbePlannerError, type ProbePlanner, type ProbePlannerUsage } from "./judge/llm-probe-planner.js";
import type { PlaywrightProbeRunner } from "./judge/playwright-probe-runner.js";
import { RunStateStore, sanitizeDiagnosticText, type LogSink } from "./run-state.js";
import { featureGroupPackets, auditPackets, folderDescendants, makePacket, DEFAULT_FEATURE_GROUP_THRESHOLDS } from "./scheduler.js";
import { parseFeatureGrouping, type FeatureGrouper } from "./feature-grouper.js";
import { RunBudget, type PipelinePhase } from "./run-budget.js";
import { auditPacket, type AuditResult, type AuditPolicy } from "./judge/audit.js";
import { publicEntryPlan } from "./judge/public-entry.js";
import { globalControlCrossRoutePlan, overlayLifecyclePlan } from "./judge/compatibility-probes.js";
import { resultCompatibilityPlan } from "./judge/compatibility-contracts.js";
import { groundedLocatorNames, parseProbePlan, probePlanSha256, type ProbePlan } from "./judge/probe-schema.js";
import { repairCaseProgress } from "./judge/repair-progress.js";
import { PlanCache, shouldWritePlanCache, spawnPlanGeneration } from "./judge/plan-cache.js";
import { PROGRESS_DIR_NAME, progressPlansDirectory } from "./progress-journal.js";
import { memorySnapshot } from "./memory-snapshot.js";
import { ExecutionFault } from "./execution-fault.js";
import { GatewayRequestError } from "./gateway-failure.js";
import { GatewayRecovery } from "./gateway-recovery.js";
import type { CandidateRuntime } from "./candidate-runtime.js";
import type { CandidateEvidence } from "./types.js";
import type { InconclusiveKind } from "./types.js";
import type {
  PlatformContract,
  RequirementCatalog,
  RequirementStatus,
  WorkPacket,
} from "./types.js";

/** Compatibility evidence may request a repair, but its type cannot represent
 * a requirement-verifying status. */
type CompatibilityResult = Omit<AuditResult, "status"> & {
  status: "passed" | "failed" | "unresolved";
};

const BOUNDARY_REPAIR_CALL_CEILING_MS = 5_400_000;
const IMPLEMENTATION_CALL_CEILING_MS = 5_400_000;
const IMPLEMENTATION_RETRY_CEILING_MS = 2_700_000;
/** A single Judge operation may recover from transient faults, but cannot own an unlimited run. */
const PLANNER_RECOVERY_WINDOW_MS = 720_000;
/** Delivery repairs get longer calls and more rounds than other fixes: the
 * candidate goes straight to the grader, so delivery must be given every chance. */
const DELIVERY_REPAIR_CALL_CEILING_MS = 1_800_000;
const MAX_DELIVERY_REPAIR_ROUNDS = 3;

function needsImplementationRetry(result: BuilderResult): boolean {
  return !result.gatewayFailure && (result.outcome === "timed_out" ||
    (result.outcome === "failed" && Boolean(result.terminationReason)));
}

export interface AppLifecycle {
  start(
    outputDir: string,
    contract: PlatformContract,
  ): Promise<{ baseUrl: string; candidate?: CandidateEvidence; assertUnchanged?(): Promise<void>; stop(): Promise<void> }>;
}

export interface Clock {
  nowMs(): number;
}

export interface ArcEventsPort {
  runnerState(
    state: "running" | "completed" | "failed",
    message?: string,
  ): Promise<void>;
  requirementState(
    reqId: string,
    phase: "design" | "implement" | "test",
    status: "running" | "completed" | "failed" | "passed",
  ): Promise<void>;
  commitHistorySignal(reason: string): Promise<void>;
  storeRequirementTree(
    requirementRows: Record<string, ArcRequirementRow>,
    scenarioRows: Record<string, ArcScenarioRow>,
  ): Promise<void>;
}

export interface PipelineDeps {
  grouper?: FeatureGrouper;
  builder: BuilderPort;
  planner: ProbePlanner;
  runner: Pick<PlaywrightProbeRunner, "run">;
  git: GitOps;
  appLifecycle: AppLifecycle;
  candidate?: CandidateRuntime;
  clock: Clock;
  finalVerifier: FinalVerifierPort;
  arcEvents?: ArcEventsPort;
  logSink?: LogSink;
  diagnosticSecrets?: readonly string[];
  runMetadata?: Record<string, unknown>;
  gatewayRecovery?: GatewayRecovery;
}

export interface PipelineOptions {
  requirementsFile: string;
  outputDir: string;
  ledgerFile: string;
  totalBudgetMs: number;
  platformContract: PlatformContract;
  plannerRetryDelayMs?: number;
  /** Product-visible journal directory (`shallow-progress`); plans mirror here. */
  progressDir?: string;
  /** Whether this stage starts from a selected prior-stage application or the blank scaffold. */
  stageStartingPoint?: "inherited_application" | "blank_template" | "unknown";
  /** Evolution only: true includes inherited atomics in audits and delivery coverage. Default false. */
  auditInheritedRequirements?: boolean;
  /** Whether final/delivery audits may ask the Planner to replace a missing plan. Default false. */
  generateFinalAuditPlans?: boolean;
}

export interface RunSummary {
  status: "delivered" | "partial" | "failed";
  verifiedRequirementIds: string[];
  blockedRequirementIds: string[];
  acceptedSha: string;
  implementedRequirementIds?: string[];
  failedRequirementIds?: string[];
  inconclusiveRequirementIds?: string[];
  pendingRequirementIds?: string[];
  missingPlanRequirementIds?: string[];
  inconclusiveByKind?: Partial<Record<InconclusiveKind, string[]>>;
  auditRequirementIds?: string[];
  skippedRequirementIds?: string[];
}

export async function runPipeline(options: PipelineOptions, deps: PipelineDeps): Promise<RunSummary> {
  const catalog = await loadRequirementCatalog(options.requirementsFile, {
    inheritedApplication: options.stageStartingPoint === "inherited_application",
  });
  // Freeze provenance before any current progress event or plan mirror write.
  const history = options.stageStartingPoint === "inherited_application" && catalog.requirements[0]?.product.evolution
    ? await readHistoricalRequirementIds(options.progressDir ?? join(options.outputDir, PROGRESS_DIR_NAME))
    : undefined;
  const evolutionScope = history ? selectEvolutionScope(catalog, history.requirementIds) : undefined;
  const auditInheritedRequirements = options.auditInheritedRequirements ?? false;
  const startedAt = deps.clock.nowMs();
  const budget = new RunBudget(options.totalBudgetMs, startedAt, () => deps.clock.nowMs());
  const state = new RunStateStore({ statusByRequirementId: catalog.statusById,
    acceptedSha: await deps.git.captureAccepted("shallow: initial state"), startedAtMs: startedAt,
    totalBudgetMs: options.totalBudgetMs }, options.ledgerFile, deps.logSink ?? null, deps.diagnosticSecrets);
  const implemented = new Set<string>();
  const inherited = new Set<string>();
  const skipped = new Set<string>();
  let implementationCatalog: RequirementCatalog = catalog;
  let packets = auditPackets(catalog);
  let featureGrouping = featureGroupPackets(catalog);
  const requirementById = new Map(catalog.requirements.map(item => [item.id, item]));
  const auditPacketByRequirementId = new Map(packets.flatMap(packet =>
    packet.requirementIds.map(id => [id, packet] as const)));
  const planCache = new PlanCache(dirname(options.ledgerFile),
    options.progressDir ? progressPlansDirectory(options.progressDir) : undefined);
  let results = new Map<string, AuditResult>();
  let boundaryRepairCount = 0;
  let currentBoundaryModule: string | undefined;
  let gatewayPhase: PipelinePhase = "implementation";
  const preplanAbort = new AbortController();
  const pendingPlans = new Map<string, { ready: boolean; failed: boolean; recoveryAttempted: boolean; promise: Promise<void> }>();
  const compatibilityGuards = new Map<string, { packet: WorkPacket; plan: ProbePlan }>();
  const noProgressRefinements = new Set<string>();
  const recoveryAuditPolicy = { refineLocators: true, noProgressRefinements };
  const gateway = deps.gatewayRecovery ?? new GatewayRecovery();
  const dependencyClosure = (requirementIds: readonly string[]): Set<string> => {
    const closure = new Set<string>();
    const pending = requirementIds.flatMap(id => requirementById.get(id)?.dependencyIds ?? []);
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (closure.has(id)) continue;
      closure.add(id);
      pending.push(...(requirementById.get(id)?.dependencyIds ?? []));
    }
    return closure;
  };
  const verificationStatus = (requirementId: string): RequirementStatus => {
    const auditPacket = auditPacketByRequirementId.get(requirementId);
    return (auditPacket ? results.get(auditPacket.id)?.status : undefined)
      ?? state.snapshot.statusByRequirementId[requirementId]
      ?? "todo";
  };
  const dependencyGate = (packet: WorkPacket, moduleId: string): {
    unmet: Array<{ id: string; status: RequirementStatus }>;
    provisional: string[];
  } => {
    const packetIds = new Set(packet.requirementIds);
    const decided = [...dependencyClosure(packet.requirementIds)]
      .filter(id => !packetIds.has(id))
      .filter(id => {
        const dependency = requirementById.get(id);
        const dependencyModuleId = dependency?.folderPath[1] ?? dependency?.id;
        const auditPacket = auditPacketByRequirementId.get(id);
        // Dependencies in the current, not-yet-audited module remain eligible.
        // Other dependencies need a runnable checkpoint before downstream work.
        return dependencyModuleId !== moduleId
          || (auditPacket !== undefined && results.has(auditPacket.id))
          || verificationStatus(id) !== "todo";
      })
      .map(id => ({ id, status: verificationStatus(id) }))
      .sort((left, right) => left.id.localeCompare(right.id));
    return { unmet: decided.filter(item => !implemented.has(item.id)),
      provisional: decided.filter(item => implemented.has(item.id) && item.status !== "verified").map(item => item.id) };
  };
  const auditEligible = (packet: WorkPacket): boolean =>
    packet.requirementIds.every(id => implemented.has(id)) && [...dependencyClosure(packet.requirementIds)].every(id => implemented.has(id));
  const builderProjectContext = (packet: WorkPacket): BuilderProjectContext =>
    buildBuilderProjectContext(packet, catalog, implemented, options.stageStartingPoint, inherited, skipped.size > 0);
  gateway.setRecorder(({ packetId, ...detail }) => state.record({ at: now(), type: "gateway_wait", packetId, detail }));
  const planner = deps.planner;
  const plannerWindow = (): (() => number) => {
    const phase = gatewayPhase;
    // GatewayRecovery first reads this after admitting the Planner request.
    let deadline: number | undefined;
    return () => {
      deadline ??= options.totalBudgetMs <= 0 ? deps.clock.nowMs() + PLANNER_RECOVERY_WINDOW_MS : Infinity;
      return Math.min(budget.remaining(phase), deadline - deps.clock.nowMs());
    };
  };
  const plannerUsage = (packetId: string, operation: "plan" | "refine" | "review") =>
    (usage: ProbePlannerUsage) => state.record({ at: now(), type: "probe_planner_usage", packetId, detail: { operation, ...usage } });
  deps = { ...deps, planner: {
    plan: (packet, feedback, callOptions) => {
      const remaining = plannerWindow();
      return gateway.run("planner", packet.id, remaining,
        () => planner.plan(packet, feedback, { timeoutMs: Math.max(1, Math.min(callOptions?.timeoutMs ?? Infinity, remaining())),
          onUsage: plannerUsage(packet.id, "plan"), onReviewUsage: plannerUsage(packet.id, "review"), signal: callOptions?.signal }), callOptions?.signal);
    },
    refineLocators: (original, failures, feedback, callOptions) => {
      const remaining = plannerWindow();
      return gateway.run("planner", original.packetId, remaining,
        () => planner.refineLocators(original, failures, feedback, { timeoutMs: Math.max(1, Math.min(callOptions?.timeoutMs ?? Infinity, remaining())),
          onUsage: plannerUsage(original.packetId, "refine"), signal: callOptions?.signal }), callOptions?.signal);
    },
    reviewPlan: (packet, original, failures, feedback, callOptions) => {
      const remaining = plannerWindow();
      return gateway.run("planner", packet.id, remaining,
        () => planner.reviewPlan(packet, original, failures, feedback, { timeoutMs: Math.max(1, Math.min(callOptions?.timeoutMs ?? Infinity, remaining())),
          coverageReview: callOptions?.coverageReview,
          preparationOnlyCaseIds: callOptions?.preparationOnlyCaseIds,
          onUsage: plannerUsage(packet.id, "review"), signal: callOptions?.signal }), callOptions?.signal);
    },
  } };
  const backgroundPlanner: Pick<ProbePlanner, "plan"> = {
    plan: async (packet, feedback, callOptions) => {
      for (;;) {
        preplanAbort.signal.throwIfAborted();
        try {
          return await deps.planner.plan(packet, feedback, {
            timeoutMs: callOptions?.timeoutMs ?? Infinity, signal: preplanAbort.signal,
          });
        } catch (error) {
          if (preplanAbort.signal.aborted || !(error instanceof GatewayRequestError) ||
            !error.gatewayFailure.retryable || gateway.exhausted || budget.remaining(gatewayPhase) <= 0) throw error;
          await state.record({ at: now(), type: "probe_planner_retry", packetId: packet.id,
            detail: { source: "planner", message: "后台预规划恢复窗口耗尽，继续后台重试",
              validationError: errorMessage(error) } });
        }
      }
    },
  };
  deps.candidate?.setRecorder(event => state.record(event));

  const phase = async (name: PipelinePhase, round?: number): Promise<void> => {
    gatewayPhase = name;
    const remaining = budget.remaining(name);
    await state.record({ at: now(), type: "phase_started", detail: { phase: name, round,
      memory: await memorySnapshot(),
      ...(Number.isFinite(remaining) ? { remainingMs: remaining } : {}) } });
  };
  const build = async (request: BuilderRequest, name: PipelinePhase, runOptions: BuilderRunOptions = {}): Promise<BuilderResult> => {
    const packetId = "packet" in request ? request.packet.id : "delivery-repair";
    const ceiling = name === "implementation" ? IMPLEMENTATION_CALL_CEILING_MS : name === "repair" ? BOUNDARY_REPAIR_CALL_CEILING_MS : DELIVERY_REPAIR_CALL_CEILING_MS;
    const deadline = deps.clock.nowMs() + Math.min(ceiling, runOptions.timeoutMs ?? ceiling);
    const remaining = () => Math.min(deadline - deps.clock.nowMs(), budget.remaining(name));
    if (remaining() <= 0) return { outcome: "timed_out", sessionId: "unavailable", summary: "phase budget exhausted" };
    state.setPacketAttempt(packetId, "packet" in request ? request.packet.attempt : 1);
    let lastResult: BuilderResult | undefined;
    try {
      return await gateway.run("builder", packetId, remaining, async () => {
        await state.record({ at: now(), type: "builder_started", packetId, detail: { mode: request.mode } });
        const at = deps.clock.nowMs();
        let result: BuilderResult;
        try { result = await deps.builder.run(request, { ...runOptions, timeoutMs: Math.max(1, Math.floor(remaining())) }); }
        catch (error) {
          if (error instanceof ExecutionFault) throw error;
          result = { outcome: "failed", sessionId: "unavailable", summary: errorMessage(error),
            ...(error instanceof GatewayRequestError ? { gatewayFailure: error.gatewayFailure } : {}) };
        }
        lastResult = result;
        await state.record({ at: now(), type: "builder_finished", packetId,
          detail: { ...result, durationMs: Math.max(0, deps.clock.nowMs() - at) } });
        if (result.referenceImages) await state.record({ at: now(), type: "builder_reference_images", packetId, detail: result.referenceImages });
        if (result.outcome !== "completed" && result.gatewayFailure) {
          if (request.mode === "implement") await preserveInterruptedWork(request.packet);
          throw new GatewayRequestError(result.gatewayFailure);
        }
        return result;
      });
    } catch (error) {
      if (error instanceof ExecutionFault) throw error;
      if (!(error instanceof GatewayRequestError)) throw error;
      return { ...lastResult, sessionId: lastResult?.sessionId ?? "unavailable", outcome: "failed",
        summary: lastResult?.summary ?? error.message, gatewayFailure: error.gatewayFailure };
    }
  };
  /**
   * A gateway outage pauses work instead of ending the run: retry the same
   * builder call with a fresh window while the failure is retryable. A
   * non-retryable rejection (authentication or a request error) ends the loop
   * so the caller can stop dispatching instead of spinning without backoff.
   */
  const resumeGatewayWork = async (
    current: BuilderResult,
    emitPause: (failure: NonNullable<BuilderResult["gatewayFailure"]>) => Promise<void>,
    retry: () => Promise<BuilderResult>,
  ): Promise<BuilderResult> => {
    while (current.gatewayFailure?.retryable && current.outcome !== "completed" && !gateway.exhausted) {
      await emitPause(current.gatewayFailure);
      current = await retry();
    }
    return current;
  };
  const stopImplementation = async (packet: WorkPacket,
    failure: NonNullable<BuilderResult["gatewayFailure"]>): Promise<void> => {
    await state.record({ at: now(), type: "implementation_stopped", packetId: packet.id,
      detail: { requirementIds: packet.requirementIds, failure } });
  };
  const runnable = async (): Promise<CandidateEvidence | undefined> => {
    const app = await deps.appLifecycle.start(options.outputDir, options.platformContract);
    try { await app.assertUnchanged?.(); }
    finally { await app.stop(); }
    await app.assertUnchanged?.();
    if (app.candidate) await deps.candidate?.assertCurrent(app.candidate);
    return app.candidate;
  };
  const checkpoint = async (ids: string[], reason: string, candidate?: CandidateEvidence): Promise<void> => {
    if (candidate) await deps.candidate?.assertCurrent(candidate);
    const sha = await deps.git.captureAccepted(`shallow: checkpoint ${reason}`);
    if (candidate) await deps.candidate?.assertCurrent(candidate);
    state.setAcceptedSha(sha);
    if (candidate) deps.candidate?.recordAccepted(candidate);
    await state.record({ at: now(), type: "checkpoint_saved", detail: { requirementIds: ids, reason, candidate } });
    await emitArc(deps, state, arc => arc.commitHistorySignal("git_commit"));
  };
  const preserveInterruptedWork = async (packet: WorkPacket): Promise<void> => {
    if (!await deps.git.hasApplicationChanges(state.snapshot.acceptedSha)) return;
    await deps.git.captureAccepted(`shallow: interrupted attempt ${packet.id}`);
    let candidate: CandidateEvidence | undefined;
    let preserved = false;
    let reason: string | undefined;
    const recoveredPlans = new Map<string, ProbePlan>();
    try {
      candidate = await runnable();
      // Interrupted checkpoints must preserve independently established passes.
      for (const packetToCheck of packets) {
        const previous = results.get(packetToCheck.id);
        if (!previous) continue;
        const passed = previous.report?.passedCases ?? [];
        const plan = previous.plan ?? await planCache.read(packetToCheck);
        if (!plan || (previous.status !== "verified" && !passed.length)) continue;
        const guard = previous.status === "verified" ? plan : {
          packetId: plan.packetId, cases: plan.cases.filter(item => passed.includes(item.id)),
        };
        const checked = await auditPacket(packetToCheck, guard, options, deps, state,
          () => budget.remaining("implementation"), { refineLocators: false, retryPlan: false, checkCoverage: false });
        if (checked.status !== "verified") throw new Error(`Interrupted work did not preserve previously passed behavior: ${packetToCheck.requirementIds.join(", ")}`);
        if (checked.plan) {
          const recovered = mergeCheckedPlan(plan, checked.plan, packetToCheck);
          if (shouldWritePlanCache(plan, recovered)) recoveredPlans.set(packetToCheck.id, recovered);
        }
      }
      preserved = true;
    }
    catch (error) { reason = errorMessage(error); await deps.git.restoreAccepted(state.snapshot.acceptedSha); }
    if (preserved) {
      await checkpoint([], `interrupted ${packet.id}`, candidate);
      for (const [id, plan] of recoveredPlans) {
        results.set(id, { ...results.get(id)!, plan });
        await planCache.write(id, plan).catch(() => {});
      }
    }
    await state.record({ at: now(), type: "builder_work_preserved", packetId: packet.id,
      detail: { preserved, requirementIds: packet.requirementIds, ...(reason ? { reason } : {}) } });
  };
  const audit = async (name: PipelinePhase, previous = results): Promise<Map<string, AuditResult>> => {
    const audited = new Map<string, AuditResult>();
    // Replay cached final probes. Missing plans are only generated when explicitly
    // enabled; the default preserves tokens and reports the evidence gap instead.
    // Runtime edits still check previously passed paths first during delivery revalidation.
    const ordered = [...packets].sort((a, b) =>
      (name === "audit" ? Number(!previous.get(b.id)?.plan) - Number(!previous.get(a.id)?.plan) : 0) ||
      Number(previous.get(b.id)?.status === "verified") - Number(previous.get(a.id)?.status === "verified"));
    for (const packet of ordered) {
      if (!auditEligible(packet)) continue;
      const cached = previous.get(packet.id)?.plan ?? await planCache.read(packet);
      const result = budget.remaining(name) <= 0
        ? { status: "inconclusive" as const, failureKind: "budget" as const, plan: cached, reason: "audit phase budget exhausted" }
        : !cached && !(options.generateFinalAuditPlans ?? false)
          ? { status: "inconclusive" as const, failureKind: "planning" as const,
            reason: "final audit plan generation is disabled and no cached plan is available" }
          : await auditPacket(packet, cached, options, deps, state, () => budget.remaining(name), { refineLocators: false });
      // Detection-only audits never refine; persist a freshly planned result so
      // future audits skip the LLM call.
      if (result.plan && shouldWritePlanCache(cached, result.plan)) {
        await planCache.write(packet.id, result.plan).catch(() => {});
      }
      audited.set(packet.id, result);
    }
    // Structural samples cannot verify a whole requirement or replace its plan.
    // Detection also checks them, so a missing business plan cannot hide an entry loss.
    for (const packet of packets.filter(auditEligible)) {
      const plan = publicEntryPlan(packet);
      if (!plan) continue;
      const entry = await checkPublicEntry(packet, plan, name);
      if (entry.status === "verified") continue;
      const previous = audited.get(packet.id);
      const status = previous?.status === "failed" || entry.status === "failed" ? "failed" : "inconclusive";
      const reports = [previous?.report, entry.report].filter(report => report !== undefined);
      audited.set(packet.id, { ...previous, status,
        ...(reports.length ? { report: { packetId: packet.id, verdict: status === "failed" ? "fail" : "inconclusive",
          passedCases: [...new Set(reports.flatMap(report => report.passedCases))],
          failures: reports.flatMap(report => report.failures) } } : {}),
        reason: [previous?.reason, `public entry contract: ${entry.reason ?? entry.status}`].filter(Boolean).join("; "),
        failureKind: previous?.status === "failed" ? previous.failureKind : entry.failureKind ?? previous?.failureKind });
    }
    return audited;
  };
  const checkPublicEntry = async (packet: WorkPacket, plan: ProbePlan, phase: PipelinePhase): Promise<AuditResult> => {
    const checked = await auditPacket(packet, plan, options, deps, state, () => budget.remaining(phase),
      { refineLocators: false, retryPlan: false, checkCoverage: false });
    await state.record({ at: now(), type: "public_entry_checked", packetId: packet.id,
      detail: { requirementIds: packet.requirementIds,
        status: checked.status === "verified" ? "passed" : checked.status === "failed" ? "failed" : "unresolved",
        failureKind: checked.failureKind } });
    return checked;
  };
  const checkCompatibility = async (packet: WorkPacket, plan: ProbePlan, phase: PipelinePhase): Promise<CompatibilityResult> => {
    const checked = await auditPacket(packet, plan, options, deps, state, () => budget.remaining(phase),
      { refineLocators: false, retryPlan: false, checkCoverage: false });
    const status = checked.status === "verified" ? "passed" : checked.status === "failed" ? "failed" : "unresolved";
    await state.record({ at: now(), type: "compatibility_checked", packetId: packet.id,
      detail: { requirementIds: packet.requirementIds, contract: "derived_web_contracts" as const,
        status,
        failureKind: checked.failureKind } });
    return { ...checked, status };
  };
  const publish = async (): Promise<void> => {
    for (const packet of packets) {
      const result = results.get(packet.id);
      if (!result) continue;
      state.markRequirements(packet.requirementIds, result.status);
      await state.record({ at: now(), type: "audit_result", packetId: packet.id,
        detail: { requirementIds: packet.requirementIds, status: result.status, reason: result.reason,
          failureKind: result.failureKind, navigationRecovered: result.navigationRecovered, uncoveredOutcomes: result.coverageGaps?.length } });
      // The platform has no inconclusive status: leave implementation completed, never claim passed.
      for (const id of packet.requirementIds) {
        if (result.status !== "inconclusive") await emitArc(deps, state, arc => arc.requirementState(id, "test", result.status === "verified" ? "passed" : "failed"));
        else await emitArc(deps, state, arc => arc.requirementState(id, "implement", "completed"));
      }
    }
  };
  const runModuleBoundaryAudit = async (packetIds: string[], moduleId: string, moduleName: string | undefined): Promise<void> => {
    gatewayPhase = "audit";
    if (budget.remaining("audit") <= 0) return;
    // Reset per-module boundary repair quota when switching modules.
    if (currentBoundaryModule !== moduleId) {
      boundaryRepairCount = 0;
      currentBoundaryModule = moduleId;
    }
    await state.record({ at: now(), type: "phase_started", detail: { phase: "audit" as const,
      round: undefined, memory: await memorySnapshot(),
      ...(Number.isFinite(budget.remaining("audit")) ? { remainingMs: budget.remaining("audit") } : {}) } });
    const modulePackets = packets.filter(p => packetIds.includes(p.id));
    const prerequisiteIds = new Set(modulePackets.flatMap(packet => packet.prerequisites?.map(item => item.id) ?? []));
    // Reuse cached probes for verified prerequisites while there is still a repair window.
    const targetPackets = packets.filter(packet => packetIds.includes(packet.id) ||
      (results.get(packet.id)?.status === "verified" && packet.requirementIds.some(id => prerequisiteIds.has(id))));
    // Shared seeded entries can regress without an explicit dependency edge.
    // Sample one cached successful path per other module, escalating a miss to
    // its full audit and the current boundary's existing repair quota.
    const moduleOf = (packet: WorkPacket) => packet.requirements[0].folderPath[1] ?? packet.requirements[0].id;
    const coveredModules = new Set(targetPackets.map(moduleOf));
    const partialModules = new Set<string>();
    const regressionChecks: Array<{ packet: WorkPacket; plan: ProbePlan }> = [];
    // Prefer a declared global entry over an object shortcut in the same module.
    // Its contract matters even when it has no standalone seed declaration.
    const publicEntry = (packet: WorkPacket) => packet.requirements.some(item =>
      /\bglobal(?:\s+[\w-]+){0,2}\s+(?:search|navigation)\b/i.test(maskRequirementLiterals(item.text)));
    const regressionPackets = [...packets].sort((a, b) => Number(publicEntry(b)) - Number(publicEntry(a)));
    for (const packet of regressionPackets) {
      const previous = results.get(packet.id);
      const ownerModule = moduleOf(packet);
      const partial = previous?.status !== "verified" && (previous?.report?.passedCases.length ?? 0) > 0;
      // A verified prerequisite covers its own paths, not a sibling's passed
      // cases whose remaining outcomes are still inconclusive.
      if (packetIds.includes(packet.id) || !previous?.plan ||
        (partial ? partialModules.has(ownerModule) : coveredModules.has(ownerModule)) ||
        (!publicEntry(packet) && !packet.requirements.some(item => item.seedDeclarations.length > 0 || item.product.seedData.length > 0))) continue;
      const passed = new Set(previous.report?.passedCases ?? []);
      const successful = previous.plan.cases.filter(item => previous.status === "verified" || passed.has(item.id));
      const entry = successful.find(item => item.purpose === "happy_path") ??
        successful.find(item => item.purpose === "persistence") ?? (partial ? successful[0] : undefined);
      if (!entry || budget.remaining("audit") <= 0) continue;
      coveredModules.add(ownerModule);
      if (partial) partialModules.add(ownerModule);
      const check = { packet, plan: { packetId: previous.plan.packetId, cases: [entry] } };
      regressionChecks.push(check);
      const checked = await auditPacket(packet, check.plan, options, deps, state,
        () => budget.remaining("audit"), { refineLocators: false, retryPlan: false, checkCoverage: false });
      if (checked.status !== "verified") targetPackets.push(packet);
      else if (checked.plan) {
        check.plan = checked.plan;
        const recovered = mergeCheckedPlan(previous.plan, checked.plan, packet);
        if (shouldWritePlanCache(previous.plan, recovered)) {
          results.set(packet.id, { ...previous, plan: recovered });
          await planCache.write(packet.id, recovered).catch(() => {});
        }
      }
    }
    const ordered = [...targetPackets]
      .filter(auditEligible)
      .sort((a, b) => Number(results.get(b.id)?.status === "verified") - Number(results.get(a.id)?.status === "verified"));
    const boundaryResults = new Map<string, AuditResult>();
    while (ordered.length > 0) {
      let nextIndex = ordered.findIndex(packet => {
        const pending = pendingPlans.get(packet.id);
        return !pending || (pending.ready && !pending.failed);
      });
      if (nextIndex < 0) nextIndex = ordered.findIndex(packet => pendingPlans.get(packet.id)?.ready);
      if (nextIndex < 0) {
        await Promise.race(ordered.map(packet => pendingPlans.get(packet.id)!.promise));
        continue;
      }
      const [packet] = ordered.splice(nextIndex, 1);
      const cached = results.get(packet.id)?.plan ?? await planCache.read(packet);
      if (budget.remaining("audit") <= 0) {
        boundaryResults.set(packet.id, { status: "inconclusive", failureKind: "budget", plan: cached, reason: "module boundary audit budget exhausted" });
        continue;
      }
      const pending = pendingPlans.get(packet.id);
      // The final audit remains cache-only. Recover exactly once here, while a
      // Builder repair window still exists, when this run's completed
      // background attempt either failed or produced a plan that no longer
      // validates under the current requirement contract.
      const recoverMissingPlan = cached === undefined && pending?.ready === true && !pending.recoveryAttempted;
      if (recoverMissingPlan) pending.recoveryAttempted = true;
      const result = await auditPacket(packet, cached, options, deps, state, () => budget.remaining("audit"),
        { ...recoveryAuditPolicy, retryPlan: recoverMissingPlan && pending?.failed !== true });
      if (result.plan && shouldWritePlanCache(cached, result.plan)) {
        await planCache.write(packet.id, result.plan).catch(() => {});
      }
      boundaryResults.set(packet.id, result);
    }
    // Merge boundary results into the main results map (final audit_result events come from publish).
    for (const [id, result] of boundaryResults) {
      results.set(id, result);
    }
    // Requirement-derived visitor contracts run even when complete planning failed.
    // Keep their results and plans out of the business cache and verification map.
    let publicChecks = new Map<string, { packet: WorkPacket; plan: ProbePlan; result: AuditResult }>();
    for (const packet of packets.filter(auditEligible)) {
      const plan = publicEntryPlan(packet);
      if (!plan) continue;
      const result = await checkPublicEntry(packet, plan, "audit");
      publicChecks.set(packet.id, { packet, plan, result });
      if (result.status === "failed" && !targetPackets.includes(packet)) targetPackets.push(packet);
    }
    // Compatibility samples are deliberately separate from `results`: a pass
    // cannot verify a requirement, while a reproducible failure can still enter
    // the normal Builder repair loop.
    let compatibilityChecks = new Map<string, { packet: WorkPacket; plan: ProbePlan; result: CompatibilityResult }>();
    const compatibilityPlans = new Map<string, { packet: WorkPacket; plan: ProbePlan }>();
    const addCompatibility = (packet: WorkPacket, plan: ProbePlan): void => {
      const previous = compatibilityPlans.get(packet.id);
      const ids = new Set(previous?.plan.cases.map(probeCase => probeCase.id));
      compatibilityPlans.set(packet.id, { packet, plan: previous
        ? { ...previous.plan, cases: [...previous.plan.cases, ...plan.cases.filter(probeCase => !ids.has(probeCase.id))] }
        : plan });
    };
    // Retain one successful sample of each shared contract across modules;
    // later repairs must preserve it, rather than replaying every old overlay.
    for (const guard of compatibilityGuards.values()) addCompatibility(guard.packet, guard.plan);
    for (const packet of modulePackets.filter(auditEligible)) {
      const plan = overlayLifecyclePlan(packet, results.get(packet.id)?.plan);
      if (!plan) continue;
      addCompatibility(packet, plan);
    }
    // Individual passed cases remain useful even when another outcome keeps
    // the requirement inconclusive. Samples discard whole-plan review metadata.
    const successfulPlan = (result: AuditResult | undefined): ProbePlan | undefined => {
      if (!result?.plan) return undefined;
      const passed = new Set(result.report?.passedCases ?? []);
      const cases = result.plan.cases.filter(item => result.status === "verified" || passed.has(item.id));
      return cases.length ? { packetId: result.plan.packetId, cases } : undefined;
    };
    for (const packet of modulePackets.filter(auditEligible)) {
      const plan = resultCompatibilityPlan(packet, successfulPlan(results.get(packet.id)));
      if (plan) addCompatibility(packet, plan);
    }
    const sources = packets.flatMap(packet => {
      const plan = successfulPlan(results.get(packet.id));
      return plan ? [{ packet, plan }] : [];
    });
    // Sample an actually opened entity in the current module. A search-results
    // page alone cannot expose a control that changes scope on entity pages.
    for (const packet of modulePackets.filter(auditEligible)) {
      const result = results.get(packet.id);
      const crossRoute = globalControlCrossRoutePlan(packet,
        successfulPlan(result), sources);
      if (!crossRoute) continue;
      addCompatibility(packet, crossRoute);
      break;
    }
    for (const [id, check] of compatibilityPlans) {
      const result = await checkCompatibility(check.packet, check.plan, "audit");
      compatibilityChecks.set(id, { ...check, result });
      if (result.status === "passed") for (const probeCase of check.plan.cases) {
        const kind = probeCase.id.split("-")[1] === "closed" ? "overlay" : probeCase.id.split("-")[1];
        compatibilityGuards.set(kind, { packet: check.packet, plan: { packetId: check.plan.packetId, cases: [probeCase] } });
      }
      if (result.status === "failed" && !targetPackets.includes(check.packet)) targetPackets.push(check.packet);
    }
    await state.record({ at: now(), type: "module_boundary_audit_finished",
      detail: { moduleId, moduleName, packetIds: targetPackets.map(packet => packet.id),
        results: Object.fromEntries([...boundaryResults].map(([id, r]) => [id, r.status])),
        regressionPacketIds: regressionChecks.map(item => item.packet.id) } });
    // Inline repair for module boundary failures, using per-module repair budget.
    while (boundaryRepairCount < 2 && budget.remaining("repair") > 0) {
      const businessFailures = targetPackets.filter(p => {
        const result = results.get(p.id);
        return result?.status === "failed" || result?.repairableProbeFailure;
      });
      const failures = [...new Set([...businessFailures,
        ...[...publicChecks.values()].filter(check => check.result.status === "failed").map(check => check.packet),
        ...[...compatibilityChecks.values()].filter(check => check.result.status === "failed").map(check => check.packet)])];
      if (!failures.length) break;
      const round = ++boundaryRepairCount;
      for (const item of failures) state.setPacketAttempt(item.id, round + 1);
      await phase("repair", round);
      const repairPacket = makePacket(`repair-round-${round}`, failures.flatMap(item => item.requirements), round === 1 ? 2 : 3);
      const reports = failures.flatMap(item => [
        ...(results.get(item.id)?.report ? [results.get(item.id)!.report!] : []),
        ...(publicChecks.get(item.id)?.result.status === "failed" ? [publicChecks.get(item.id)!.result.report!] : []),
        ...(compatibilityChecks.get(item.id)?.result.status === "failed" ? [compatibilityChecks.get(item.id)!.result.report!] : []),
      ]);
      const observation = toBuilderShadowObservation({ packetId: repairPacket.id,
        verdict: businessFailures.some(item => results.get(item.id)?.status === "failed") ||
          failures.some(item => publicChecks.get(item.id)?.result.status === "failed" ||
            compatibilityChecks.get(item.id)?.result.status === "failed") ? "fail" : "inconclusive",
        passedCases: [...new Set(reports.flatMap(report => report.passedCases))],
        failures: reports.flatMap(report => report.failures) }, deps.diagnosticSecrets);
      await state.record({ at: now(), type: "repair_batch_started", detail: { round, requirementIds: repairPacket.requirementIds } });
      const repairTimeoutMs = Math.max(1, Math.floor(Math.min(BOUNDARY_REPAIR_CALL_CEILING_MS, budget.remaining("repair") / 2)));
      let repairResult = await build({ mode: "repair", packet: repairPacket, projectContext: builderProjectContext(repairPacket),
        outputDir: options.outputDir, platformContract: options.platformContract, shadowObservation: observation },
        "repair", { timeoutMs: repairTimeoutMs });
      // Same recovery rule as implementation: an outage postpones the repair
      // instead of abandoning an entire module while its quota is untouched.
      repairResult = await resumeGatewayWork(repairResult,
        failure => state.record({ at: now(), type: "repair_paused", packetId: repairPacket.id,
          detail: { requirementIds: repairPacket.requirementIds, failure } }),
        () => build({ mode: "repair", packet: repairPacket, projectContext: builderProjectContext(repairPacket),
          outputDir: options.outputDir, platformContract: options.platformContract, shadowObservation: observation },
        "repair", { timeoutMs: repairTimeoutMs }));
      let reason = repairResult.outcome === "completed" ? "" : repairResult.summary || repairResult.outcome;
      let candidate: CandidateEvidence | undefined;
      if (!reason) {
        try { candidate = await runnable(); } catch (error) { reason = errorMessage(error); }
      }
      let nextResults = results;
      let nextPublicChecks = publicChecks;
      let nextCompatibilityChecks = compatibilityChecks;
      let improvedCases = 0;
      let resolvedGaps = 0;
      if (!reason) {
        // A boundary repair may break a module path that already passed. Recheck
        // this module's verified packets first and discard the repair on the first
        // loss; only then look for improvement across the failed packets.
        let regressed = false;
        let progressUnconfirmed = false;
        const rechecked = new Map<string, AuditResult>();
        const repairChecks = [...regressionChecks];
        // A verified prerequisite covers only its own paths, not siblings in
        // the same module that use a shared menu, settings or other control.
        for (const packet of packets) {
          if (targetPackets.includes(packet) || repairChecks.some(check => check.packet.id === packet.id)) continue;
          const previous = results.get(packet.id);
          if (previous?.status !== "verified" || !previous.plan) continue;
          const entry = previous.plan.cases.find(item => item.purpose === "happy_path") ??
            previous.plan.cases.find(item => item.purpose === "persistence") ?? previous.plan.cases[0];
          if (entry) repairChecks.push({ packet, plan: { ...previous.plan, cases: [entry] } });
        }
        const pendingCriticalGuards: Array<{ packet: WorkPacket; plan: ProbePlan; policy: AuditPolicy }> = [];
        const criticalGuard = (packet: WorkPacket, plan: ProbePlan) => {
          if (packet.requirementIds.some(id => prerequisiteIds.has(id))) return true;
          if (plan.cases.some(item => item.steps.some(step => "locator" in step &&
            (step.locator.by === "label" || (step.locator.by === "role" && step.locator.name !== undefined)) &&
            groundedLocatorNames(step.locator, packet).length > 0))) return true;
          const declarations = packet.requirements.flatMap(item => [...item.seedDeclarations, ...item.product.seedData.flatMap(category => category.items)]);
          const names = declarations.flatMap(text => [text, ...[...text.matchAll(/[“"`]([^”"`]+)[”"`]/g)].map(match => match[1])]);
          return plan.cases.some(item => item.steps.some(step => {
            if (!step.op.startsWith("expect") || !("locator" in step)) return false;
            const name = step.locator.by === "role" ? step.locator.name : step.locator.text;
            const values = [...(name ? [name] : []), ...(step.op === "expectText" ? step.anyOf ?? [step.text] : [])];
            return values.some(value => names.some(name => name.length > 0 &&
              (value === name || value.startsWith(`${name}/`) || value.endsWith(`/${name}`))));
          }));
        };
        const checkGuard = async (packet: WorkPacket, plan: ProbePlan, policy: AuditPolicy): Promise<AuditResult> => {
          const guardPolicy = { ...policy, checkCoverage: false, retryPlan: false };
          let checked = await auditPacket(packet, plan, options, deps, state, () => budget.remaining("repair"), guardPolicy);
          const retried = checked.status === "inconclusive" && !checked.repairableProbeFailure && budget.remaining("repair") > 0;
          if (retried) checked = await auditPacket(packet, checked.plan ?? plan, options, deps, state, () => budget.remaining("repair"), guardPolicy);
          await state.record({ at: now(), type: "repair_guard_checked", packetId: packet.id,
            detail: { requirementIds: packet.requirementIds, status: checked.status === "verified" ? "passed"
              : checked.status === "failed" || checked.repairableProbeFailure ? "regressed" : "unresolved",
            critical: criticalGuard(packet, plan), retried, failureKind: checked.failureKind } });
          return checked;
        };
        for (const packet of targetPackets) {
          const previous = results.get(packet.id);
          if (!previous) continue;
          const passed = previous.report?.passedCases ?? [];
          if (previous.status !== "verified" && (!previous.plan || !passed.length)) continue;
          if (budget.remaining("repair") <= 0) { regressed = true; break; }
          const cachedPlan = previous.plan ?? await planCache.read(packet);
          const guardPlan = previous.status === "verified" ? cachedPlan : {
            packetId: cachedPlan!.packetId, cases: cachedPlan!.cases.filter(item => passed.includes(item.id)),
          };
          const policy = previous.status === "verified" ? recoveryAuditPolicy : { refineLocators: false };
          const recheck = await checkGuard(packet, guardPlan!, policy);
          if (recheck.status === "failed" || recheck.repairableProbeFailure) { regressed = true; break; }
          if (recheck.status !== "verified" && criticalGuard(packet, guardPlan!)) pendingCriticalGuards.push({ packet, plan: guardPlan!, policy });
          if (previous.status === "verified") rechecked.set(packet.id, recheck);
        }
        if (!regressed) for (const check of repairChecks) {
          if (targetPackets.includes(check.packet)) continue;
          if (budget.remaining("repair") <= 0) { regressed = true; break; }
          const policy = regressionChecks.includes(check) ? { refineLocators: false } : recoveryAuditPolicy;
          const recheck = await checkGuard(check.packet, check.plan, policy);
          if (recheck.status === "failed" || recheck.repairableProbeFailure) { regressed = true; break; }
          if (recheck.status !== "verified" && criticalGuard(check.packet, check.plan)) {
            pendingCriticalGuards.push({ packet: check.packet, plan: check.plan, policy });
          }
          const previous = results.get(check.packet.id)!;
          if (recheck.plan) rechecked.set(check.packet.id, { ...previous, ...(previous.status === "verified" ? recheck : {}),
            plan: mergeCheckedPlan(previous.plan!, recheck.plan, check.packet) });
        }
        const reAudit = new Map<string, AuditResult>();
        if (!regressed) {
          // Re-audit the failed packets with cached plans.
          for (const packet of businessFailures) {
            const cachedPlan = results.get(packet.id)?.plan ?? await planCache.read(packet);
            const r = budget.remaining("repair") <= 0
              ? { status: "inconclusive" as const, failureKind: "budget" as const, plan: cachedPlan, reason: "module boundary repair budget exhausted" }
              : await auditPacket(packet, cachedPlan, options, deps, state, () => budget.remaining("repair"), recoveryAuditPolicy);
            reAudit.set(packet.id, r);
            const progress = repairCaseProgress(results.get(packet.id)!, r);
            if (progress.passed.length && r.status !== "verified") {
              const confirmation = await auditPacket(packet, { packetId: r.plan!.packetId,
                cases: r.plan!.cases.filter(item => progress.passed.includes(item.id)) },
              options, deps, state, () => budget.remaining("repair"), { refineLocators: false, checkCoverage: false });
              if (confirmation.status !== "verified") { progressUnconfirmed = true; break; }
            }
            improvedCases += progress.passed.length;
            resolvedGaps += progress.resolvedGaps.length;
          }
        }
        let criticalUnconfirmed = false;
        nextPublicChecks = new Map(publicChecks);
        if (!regressed) for (const [id, check] of publicChecks) {
          if (check.result.status === "inconclusive") continue;
          let checked = await checkPublicEntry(check.packet, check.plan, "repair");
          if (checked.status === "inconclusive" && budget.remaining("repair") > 0) {
            checked = await checkPublicEntry(check.packet, check.plan, "repair");
          }
          if (check.result.status === "verified") {
            if (checked.status === "failed") { regressed = true; break; }
            if (checked.status !== "verified") criticalUnconfirmed = true;
          } else if (checked.status === "verified") {
            // New structural progress is also confirmed in an independent instance.
            checked = await checkPublicEntry(check.packet, check.plan, "repair");
            if (checked.status !== "verified") { progressUnconfirmed = true; break; }
            improvedCases += checked.report?.passedCases.length ?? 0;
          }
          nextPublicChecks.set(id, { ...check, result: checked });
        }
        nextCompatibilityChecks = new Map(compatibilityChecks);
        if (!regressed) for (const [id, check] of compatibilityChecks) {
          if (check.result.status === "unresolved") continue;
          let checked = await checkCompatibility(check.packet, check.plan, "repair");
          if (checked.status === "unresolved" && budget.remaining("repair") > 0) {
            checked = await checkCompatibility(check.packet, check.plan, "repair");
          }
          if (check.result.status === "passed") {
            if (checked.status === "failed") { regressed = true; break; }
            if (checked.status !== "passed") criticalUnconfirmed = true;
          } else if (checked.status === "passed") {
            checked = await checkCompatibility(check.packet, check.plan, "repair");
            if (checked.status !== "passed") { progressUnconfirmed = true; break; }
            improvedCases += checked.report?.passedCases.length ?? 0;
          }
          nextCompatibilityChecks.set(id, { ...check, result: checked });
        }
        if (!regressed) for (const guard of pendingCriticalGuards) {
          const checked = await checkGuard(guard.packet, guard.plan, guard.policy);
          if (checked.status === "failed" || checked.repairableProbeFailure) { regressed = true; break; }
          if (checked.status !== "verified") { criticalUnconfirmed = true; continue; }
          const previous = results.get(guard.packet.id)!;
          if (previous.status === "verified") rechecked.set(guard.packet.id, { ...checked,
            plan: mergeCheckedPlan(previous.plan!, checked.plan!, guard.packet) });
        }
        const improved = failures.some(item => reAudit.get(item.id)?.status === "verified") || improvedCases > 0 || resolvedGaps > 0;
        if (regressed) reason = "previously verified behavior was lost or could not be reverified";
        else if (criticalUnconfirmed) reason = "critical shared identity or prerequisite guard could not be reverified";
        else if (progressUnconfirmed) reason = "newly passed repair cases could not be reverified";
        else if (!improved) reason = "repair produced no independently verified improvement";
        else {
          // The repair is kept, so locator refinements the rechecks needed survive
          // too: detection-only audits cannot refine again and would otherwise
          // demote these verified packets with the pre-repair plans.
          for (const [id, recheck] of rechecked) {
            const previousPlan = results.get(id)?.plan;
            if (recheck.plan && shouldWritePlanCache(previousPlan, recheck.plan)) {
              await planCache.write(id, recheck.plan).catch(() => {});
            }
            nextResults = new Map(nextResults);
            nextResults.set(id, recheck);
          }
          for (const [id, r] of reAudit) {
            if (r.plan) await planCache.write(id, r.plan).catch(() => {});
            nextResults = new Map(nextResults);
            nextResults.set(id, r);
          }
        }
      }
      if (reason) {
        await deps.git.restoreAccepted(state.snapshot.acceptedSha);
        await state.record({ at: now(), type: "repair_batch_finished", detail: { round, retained: false, reason } });
        break;
      }
      await checkpoint(repairPacket.requirementIds, repairPacket.id, candidate);
      results = nextResults;
      publicChecks = nextPublicChecks;
      compatibilityChecks = nextCompatibilityChecks;
      for (const check of compatibilityChecks.values()) if (check.result.status === "passed") {
        for (const probeCase of check.plan.cases) {
          const kind = probeCase.id.split("-")[1] === "closed" ? "overlay" : probeCase.id.split("-")[1];
          compatibilityGuards.set(kind, { packet: check.packet, plan: { packetId: check.plan.packetId, cases: [probeCase] } });
        }
      }
      await state.record({ at: now(), type: "repair_batch_finished", detail: { round, retained: true,
        improvedCases, resolvedGaps, reason: "verified improvement with regression coverage" } });
    }
  };

  const product = catalog.requirements[0]?.product;
  const externalDependencyIds = [...new Set(catalog.requirements.flatMap(item => item.externalDependencyIds ?? []))];
  await state.record({ at: now(), type: "pipeline_started", detail: {
    requirements: catalog.requirements.length, totalBudgetMs: options.totalBudgetMs, port: options.platformContract.port,
    auditInheritedRequirements,
    ...(product?.evolution ? { evolution: {
      ...(product.stage ? { stageIndex: product.stage.index } : {}),
      startingPoint: options.stageStartingPoint ?? "unknown",
      externalDependencyIds,
    } } : product?.stage ? { progressiveStage: {
      ...product.stage,
      startingPoint: options.stageStartingPoint ?? "unknown",
      externalDependencyIds,
    } } : {}),
    ...(deps.grouper && catalog.requirements.length > 0 ? { groupingSource: "pending_llm" as const }
      : { grouping: featureGrouping.stats }), ...deps.runMetadata } });
  await emitArc(deps, state, arc => arc.runnerState("running", "feature-group pipeline started"));
  const rows = buildArcRequirementRows(catalog.tree);
  await emitArc(deps, state, arc => arc.storeRequirementTree(rows.requirementRows, rows.scenarioRows));
  const folderMap = folderDescendants(catalog);
  // The platform counts FOLDER nodes as requirements too; derive their state
  // from their atomic descendants so the functional-rate denominator is covered.
  const emitFolderRollup = async (): Promise<void> => {
    const statuses = state.snapshot.statusByRequirementId;
    const folders = [...folderMap].sort(([, left], [, right]) => left.length - right.length);
    for (const [folderId, allLeaves] of folders) {
      const leaves = allLeaves.filter(id => !skipped.has(id));
      if (!leaves.length) continue;
      const implementedLeaves = leaves.filter(id => implemented.has(id));
      await emitArc(deps, state, arc => arc.requirementState(folderId, "design", "running"));
      await emitArc(deps, state, arc => arc.requirementState(folderId, "design", "completed"));
      await emitArc(deps, state, arc => arc.requirementState(folderId, "implement", "running"));
      await emitArc(deps, state, arc => arc.requirementState(folderId, "implement", implementedLeaves.length === leaves.length ? "completed" : "failed"));
      const allVerified = leaves.every(id => statuses[id] === "verified");
      // The full source tree is still projected. A mixed folder must not imply its skipped leaves passed.
      if (leaves.length === allLeaves.length) {
        await emitArc(deps, state, arc => arc.requirementState(folderId, "test", allVerified ? "passed" : "failed"));
      }
    }
  };
  try {
    await phase("implementation");
    if (evolutionScope && history) {
      let reason: string | undefined;
      let ready = false;
      let candidate: CandidateEvidence | undefined;
      if (evolutionScope.inheritedRequirementIds.length > 0) {
        if (budget.remaining("implementation") <= 0) reason = "继承应用尚未通过可运行检查：实现阶段预算耗尽";
        else {
          try { candidate = await runnable(); ready = true; }
          catch (error) {
            if (error instanceof ExecutionFault) throw error;
            reason = sanitizeDiagnosticText(`继承应用无法运行，恢复全量实现：${errorMessage(error)}`, deps.diagnosticSecrets);
          }
        }
      }
      if (ready) {
        await checkpoint(evolutionScope.inheritedRequirementIds, "inherited application", candidate);
        for (const id of evolutionScope.inheritedRequirementIds) {
          inherited.add(id);
          implemented.add(id);
          await emitArc(deps, state, arc => arc.requirementState(id, "design", "running"));
          await emitArc(deps, state, arc => arc.requirementState(id, "design", "completed"));
          await emitArc(deps, state, arc => arc.requirementState(id, "implement", "running"));
          await emitArc(deps, state, arc => arc.requirementState(id, "implement", "completed"));
        }
      }
      implementationCatalog = evolutionImplementationCatalog(catalog, inherited);
      featureGrouping = featureGroupPackets(implementationCatalog);
      if (!auditInheritedRequirements) {
        for (const id of evolutionScope.inheritedRequirementIds) skipped.add(id);
        // Keep original prerequisite evidence for the selected cases; exclude legacy audit targets.
        packets = packets.filter(packet => packet.requirementIds.every(id => !skipped.has(id)));
      }
      await state.record({ at: now(), type: "evolution_scope_selected", detail: {
        historicalPlans: history.plans, ignoredPlans: history.ignoredPlans,
        historicalPlanRequirementCount: history.planRequirementCount,
        historicalCheckpointRequirementCount: history.checkpointRequirementCount,
        historicalCheckpointSupplementCount: history.checkpointSupplementCount,
        historicalRequirementCount: history.requirementIds.size,
        addedRequirementIds: evolutionScope.addedRequirementIds, changedRequirementIds: evolutionScope.changedRequirementIds,
        inheritedRequirementIds: [...inherited], implementationRequirementIds: implementationCatalog.requirements.map(item => item.id), reason,
        auditRequirementIds: packets.flatMap(packet => packet.requirementIds), skippedRequirementIds: [...skipped],
      } });
    }
    if (deps.grouper && implementationCatalog.requirements.length > 0) {
      const groupingStarted = deps.clock.nowMs();
      await state.record({ at: now(), type: "feature_grouping_started", detail: {
        requirements: implementationCatalog.requirements.length, limits: DEFAULT_FEATURE_GROUP_THRESHOLDS } });
      let source: "llm" | "deterministic" = "deterministic";
      let reason: string | undefined;
      let feedback: { validationError: string; cutOffByModel: boolean } | undefined;
      let attempts = 0;
      for (const attempt of [1, 2]) {
        const remaining = () => budget.remaining("implementation");
        if (remaining() <= 0 || gateway.exhausted) break;
        attempts = attempt;
        try {
          // Pending responses wait within the run budget; transport recovery is shared.
          const proposal = await gateway.run("planner", "feature-grouping", remaining,
            () => deps.grouper!.group(implementationCatalog, { timeoutMs: Math.max(1, remaining()), signal: preplanAbort.signal,
              feedback, onUsage: usage => state.record({ at: now(), type: "feature_grouping_usage", detail: { ...usage, attempt } }) }),
            preplanAbort.signal);
          featureGrouping = parseFeatureGrouping(proposal, implementationCatalog);
          source = "llm"; reason = undefined;
          break;
        } catch (error) {
          const diagnostic = error instanceof ProbePlannerError ? error.diagnostics : undefined;
          reason = sanitizeDiagnosticText([errorMessage(error), diagnostic?.validationError].filter(Boolean).join(": "), deps.diagnosticSecrets, 500);
          const nonRetryableRequest = diagnostic?.category === "transport" && !diagnostic.retryable;
          if (attempt === 2 || nonRetryableRequest || preplanAbort.signal.aborted || remaining() <= 0) break;
          feedback = { validationError: reason, cutOffByModel: diagnostic?.validationError?.includes("cut off by the model") ?? false };
          await state.record({ at: now(), type: "feature_grouping_retry", detail: { attempt: 2, reason,
            ...(diagnostic ? { category: diagnostic.category, httpStatus: diagnostic.httpStatus } : {}),
            cutOffByModel: feedback.cutOffByModel } });
        }
      }
      await state.record({ at: now(), type: "feature_grouping_finished", detail: {
        source, reason, attempts, grouping: featureGrouping.stats, durationMs: Math.max(0, deps.clock.nowMs() - groupingStarted),
        groups: featureGrouping.packets.map((packet, index) => ({ packetId: packet.id,
          requirementIds: packet.requirementIds, purpose: featureGrouping.purposes?.[index] })),
      } });
    }
    let previousModuleId: string | undefined;
    const pendingModuleAudit: { packetIds: string[]; moduleId: string } = { packetIds: [], moduleId: "" };
    const collectInheritedAudits = (): Map<string, string[]> => {
      const modules = new Map<string, string[]>();
      for (const packet of packets) {
        if (!packet.requirementIds.every(id => inherited.has(id)) || results.has(packet.id)) continue;
        const moduleId = packet.requirements[0].folderPath[1] ?? packet.requirements[0].id;
        const ids = modules.get(moduleId) ?? [];
        ids.push(packet.id);
        modules.set(moduleId, ids);
      }
      return modules;
    };
    const inheritedAuditsByModule = collectInheritedAudits();
    // Scheduling may bypass inherited nodes; restore the original contracts for Builder.
    const implementationQueue = featureGrouping.packets.map(packet =>
      makePacket(packet.id, packet.requirementIds.map(id => requirementById.get(id)!), packet.attempt));
    // A split-out atom is a first implementation of its own requirement: the
    // unfinished package it came from never delivered it, so the atom keeps the
    // first-attempt window plus one bounded continuation. Only "dependency"
    // atoms additionally follow their declared order, which the queue already
    // preserves, so both kinds share the same attempt budget.
    const splitPacket = async (packet: WorkPacket, index: number, reason: string,
      kind: "recovery" | "dependency"): Promise<boolean> => {
      if (packet.requirements.length < 2 || budget.remaining("implementation") <= 0 || gateway.exhausted) return false;
      const recovery = packet.requirements.map((requirement, i) => kind === "recovery"
        ? makePacket(`${packet.id}-recovery-${i + 1}`, [requirement], 2)
        : makePacket(`${packet.id}-split-${i + 1}`, [requirement]));
      implementationQueue.splice(index + 1, 0, ...recovery);
      await state.record({ at: now(), type: "implementation_split", packetId: packet.id,
        detail: { requirementIds: packet.requirementIds, reason, kind,
          packets: recovery.map(item => ({ packetId: item.id, requirementIds: item.requirementIds })) } });
      return true;
    };
    for (let packetIndex = 0; packetIndex < implementationQueue.length; packetIndex++) {
      const packet = implementationQueue[packetIndex];
      if (budget.remaining("implementation") <= 0 || gateway.exhausted) break;
      const currentModuleId = packet.requirements[0]?.folderPath[1] ?? packet.requirements[0]?.id;
      // Module boundary: run full audit on the previous module before starting the next one.
      if (currentModuleId !== pendingModuleAudit.moduleId && pendingModuleAudit.packetIds.length > 0) {
        await runModuleBoundaryAudit(pendingModuleAudit.packetIds, pendingModuleAudit.moduleId, previousModuleId);
        pendingModuleAudit.packetIds = [];
      }
      pendingModuleAudit.moduleId = currentModuleId;
      const inheritedAuditIds = inheritedAuditsByModule.get(currentModuleId);
      if (inheritedAuditIds) {
        pendingModuleAudit.packetIds.push(...inheritedAuditIds);
        inheritedAuditsByModule.delete(currentModuleId);
      }
      gatewayPhase = "implementation";
      await state.record({ at: now(), type: "packet_selected", packetId: packet.id,
        detail: { requirementIds: packet.requirementIds, names: packet.requirements.map(item => item.name) } });
      for (const id of packet.requirementIds) {
        // Design is folded into the implementation turn; keep the platform's phase trace complete.
        await emitArc(deps, state, arc => arc.requirementState(id, "design", "running"));
        await emitArc(deps, state, arc => arc.requirementState(id, "design", "completed"));
        await emitArc(deps, state, arc => arc.requirementState(id, "implement", "running"));
      }
      const { unmet: unmetDependencies, provisional: provisionalDependencies } = dependencyGate(packet, currentModuleId);
      if (unmetDependencies.length > 0) {
        const hasEligibleMember = packet.requirements.some(requirement =>
          dependencyGate(makePacket(packet.id, [requirement]), currentModuleId).unmet.length === 0);
        if (hasEligibleMember && await splitPacket(packet, packetIndex, "Separate requirements with ready dependencies from blocked members", "dependency")) continue;
        state.markRequirements(packet.requirementIds, "blocked");
        await state.record({ at: now(), type: "dependency_gate_blocked", packetId: packet.id,
          detail: { requirementIds: packet.requirementIds,
            unmetDependencyIds: unmetDependencies.map(item => item.id),
            dependencyStatuses: Object.fromEntries(unmetDependencies.map(item => [item.id, item.status])) } });
        for (const id of packet.requirementIds) {
          await emitArc(deps, state, arc => arc.requirementState(id, "implement", "failed"));
        }
        previousModuleId = currentModuleId;
        continue;
      }
      if (provisionalDependencies.length > 0) {
        await state.record({ at: now(), type: "dependency_gate_provisional", packetId: packet.id,
          detail: { requirementIds: packet.requirementIds, dependencyIds: provisionalDependencies } });
      }
      // Spawn plan generation in parallel with Builder execution.
      // The corresponding audit packets get their plans pre-computed.
      const relatedAuditPackets = packets.filter(p => packet.requirementIds.some(id => p.requirementIds.includes(id)));
      // Judge events and evidence correlate back to the build attempt that produced the code.
      for (const auditPacket of relatedAuditPackets) state.setPacketAttempt(auditPacket.id, packet.attempt);
      const planTimeoutMs = budget.remaining("implementation");
      for (const auditPacket of relatedAuditPackets) {
        if (!results.has(auditPacket.id) && !pendingPlans.has(auditPacket.id)) {
          const pending = { ready: false, failed: false, recoveryAttempted: false, promise: Promise.resolve() };
          pending.promise = spawnPlanGeneration(auditPacket, auditPacket.id, backgroundPlanner, planCache, planTimeoutMs,
            async error => {
              if (preplanAbort.signal.aborted) return;
              await state.record({ at: now(), type: "probe_preplan_failed", packetId: auditPacket.id,
                detail: error instanceof ProbePlannerError
                  ? { source: "planner", ...error.diagnostics }
                  : { source: "planner", message: errorMessage(error) } });
            })
            .then(plan => { pending.failed = !plan; pending.ready = true; });
          pendingPlans.set(auditPacket.id, pending);
        }
      }
      // Every packet is implemented in a fresh session; handoff across packets
      // goes through the project itself (code, tests, ARCHITECTURE.md).
      let result: BuilderResult;
      const implementationBaselineSha = state.snapshot.acceptedSha;
      const implementationTimeoutMs = budget.callTimeout("implementation", packet.attempt === 3 ? IMPLEMENTATION_RETRY_CEILING_MS : IMPLEMENTATION_CALL_CEILING_MS);
      const implementationDeadline = deps.clock.nowMs() + implementationTimeoutMs;
      const sessionKey = randomUUID();
      let mayContinue = true;
      result = await build({ mode: "implement", packet, outputDir: options.outputDir,
        platformContract: options.platformContract, projectContext: builderProjectContext(packet) }, "implementation", { sessionKey, timeoutMs: implementationTimeoutMs });
      // A gateway outage must not end the run: keep retrying the same packet
      // with a fresh call window while the failure is retryable; a
      // non-retryable rejection stops dispatch at the check below.
      result = await resumeGatewayWork(result,
        failure => state.record({ at: now(), type: "implementation_paused", packetId: packet.id,
          detail: { requirementIds: packet.requirementIds, failure } }),
        () => build({ mode: "implement", packet, outputDir: options.outputDir,
          platformContract: options.platformContract, projectContext: builderProjectContext(packet) },
        "implementation", { sessionKey, timeoutMs: implementationTimeoutMs }));
      if (needsImplementationRetry(result)) {
        mayContinue = false;
        await preserveInterruptedWork(packet);
        // A compaction reason is a historical marker, not a cause. Only an
        // overflow compaction followed by no further tool call shows the
        // context window ended the call; anything else is clock-bound and
        // still deserves the whole-package continuation.
        const firstAttemptOverflow = packet.attempt !== 3 && result.outcome === "timed_out" &&
          result.execution?.termination?.compactionReason === "overflow" &&
          result.execution.termination.progressedAfterOverflowCompaction === false;
        if (firstAttemptOverflow && await splitPacket(packet, packetIndex,
          "First implementation attempt exhausted the context window", "recovery")) continue;
        const retryTimeoutMs = packet.attempt === 3 ? 0 : budget.callTimeout("implementation", IMPLEMENTATION_RETRY_CEILING_MS);
        if (retryTimeoutMs > 0 && !gateway.exhausted) {
          const retryPacket: WorkPacket = { ...packet, attempt: 2 };
          state.setPacketAttempt(packet.id, retryPacket.attempt);
          for (const auditPacket of relatedAuditPackets) state.setPacketAttempt(auditPacket.id, retryPacket.attempt);
          await state.record({ at: now(), type: "implementation_retry", packetId: packet.id,
            detail: { requirementIds: packet.requirementIds, timeoutMs: retryTimeoutMs,
              reason: result.terminationReason ?? "timeout" } });
          result = await build({ mode: "implement", packet: retryPacket, outputDir: options.outputDir,
            platformContract: options.platformContract, projectContext: builderProjectContext(packet) },
            "implementation", { timeoutMs: retryTimeoutMs, resumeInterrupted: true });
          result = await resumeGatewayWork(result,
            failure => state.record({ at: now(), type: "implementation_paused", packetId: packet.id,
              detail: { requirementIds: packet.requirementIds, failure } }),
            () => build({ mode: "implement", packet: retryPacket, outputDir: options.outputDir,
              platformContract: options.platformContract, projectContext: builderProjectContext(packet) },
              "implementation", { timeoutMs: retryTimeoutMs, resumeInterrupted: true }));
          if (needsImplementationRetry(result)) await preserveInterruptedWork(retryPacket);
        }
        if (needsImplementationRetry(result)) {
          if (await splitPacket(packet, packetIndex, result.terminationReason ?? "Implementation retry reached its deadline", "recovery")) continue;
          state.markRequirements(packet.requirementIds, "blocked");
          await state.record({ at: now(), type: "module_failed", packetId: packet.id,
            detail: { requirementIds: packet.requirementIds, reason: "Builder did not complete within the bounded implementation attempts; partial work is not a completed implementation" } });
          for (const id of packet.requirementIds) await emitArc(deps, state, arc => arc.requirementState(id, "implement", "failed"));
          continue;
        }
      }
      if (result.gatewayFailure && result.outcome !== "completed") {
        await stopImplementation(packet, result.gatewayFailure);
        break;
      }
      let candidate: CandidateEvidence | undefined;
      let reason = result.outcome === "completed" ? undefined : result.summary || result.outcome;
      if (result.outcome === "completed") {
        try { candidate = await runnable(); }
        catch (error) { reason = errorMessage(error); }
        const remainingMs = Math.min(implementationDeadline - deps.clock.nowMs(), budget.remaining("implementation"));
        if (reason !== undefined && mayContinue && remainingMs > 0 && !gateway.exhausted) {
          const failure = sanitizeDiagnosticText(reason, deps.diagnosticSecrets);
          await state.record({ at: now(), type: "implementation_continued", packetId: packet.id,
            detail: { reason: failure, timeoutMs: remainingMs } });
          result = await build({ mode: "implement", packet, outputDir: options.outputDir,
            platformContract: options.platformContract, projectContext: builderProjectContext(packet) },
          "implementation", { sessionKey, timeoutMs: remainingMs, continuationFeedback: failure });
          result = await resumeGatewayWork(result,
            pause => state.record({ at: now(), type: "implementation_paused", packetId: packet.id,
              detail: { requirementIds: packet.requirementIds, failure: pause } }),
            () => build({ mode: "implement", packet, outputDir: options.outputDir,
              platformContract: options.platformContract, projectContext: builderProjectContext(packet) },
            "implementation", { sessionKey, timeoutMs: remainingMs, continuationFeedback: failure }));
          if (result.gatewayFailure && result.outcome !== "completed") {
            await stopImplementation(packet, result.gatewayFailure);
            break;
          }
          if (result.outcome === "completed") {
            try { candidate = await runnable(); reason = undefined; }
            catch (error) { reason = errorMessage(error); }
          } else reason = result.summary || result.outcome;
        }
      }
      // Initial and continued ordinary failures share the same rescue gate.
      // Timeouts and gateway failures retain their separate recovery semantics.
      if (result.outcome === "failed") {
        await deps.git.captureAccepted(`shallow: attempt ${packet.id}`);
        const receiptFailure = result.summary || result.outcome;
        try {
          if (!await deps.git.hasApplicationChanges(implementationBaselineSha)) throw new Error("Builder failed without application changes");
          candidate = await runnable(); reason = undefined;
        }
        catch (error) { reason = errorMessage(error); }
        if (reason === undefined) {
          await state.record({ at: now(), type: "module_rescued", packetId: packet.id, detail: { requirementIds: packet.requirementIds, reason: receiptFailure } });
        }
      }
      if (reason !== undefined) {
        if (needsImplementationRetry(result)) {
          await preserveInterruptedWork(packet);
          if (await splitPacket(packet, packetIndex, reason, "recovery")) continue;
        }
        if (result.outcome !== "failed") await deps.git.captureAccepted(`shallow: attempt ${packet.id}`);
        await deps.git.restoreAccepted(state.snapshot.acceptedSha);
        state.markRequirements(packet.requirementIds, "blocked");
        await state.record({ at: now(), type: "module_failed", packetId: packet.id, detail: { requirementIds: packet.requirementIds, reason } });
        for (const id of packet.requirementIds) await emitArc(deps, state, arc => arc.requirementState(id, "implement", "failed"));
        continue;
      }
      // Track which audit packets are eligible for module boundary audit.
      for (const p of relatedAuditPackets) {
        if (!pendingModuleAudit.packetIds.includes(p.id)) pendingModuleAudit.packetIds.push(p.id);
      }
      await checkpoint(packet.requirementIds, packet.id, candidate);
      for (const id of packet.requirementIds) {
        implemented.add(id);
        await emitArc(deps, state, arc => arc.requirementState(id, "implement", "completed"));
      }
      previousModuleId = currentModuleId;
    }
    // Final module boundary audit for the last module.
    if (pendingModuleAudit.packetIds.length > 0) {
      await runModuleBoundaryAudit(pendingModuleAudit.packetIds, pendingModuleAudit.moduleId, previousModuleId);
    }
    // Include pure inherited modules and audits deferred until their changed prerequisites are runnable.
    for (const moduleId of collectInheritedAudits().keys()) {
      // Full module coverage keeps all previously verified sibling cases in the repair guards.
      const packetIds = packets.filter(packet => (packet.requirements[0].folderPath[1] ?? packet.requirements[0].id) === moduleId)
        .map(packet => packet.id);
      await runModuleBoundaryAudit(packetIds, moduleId, moduleId);
    }
    for (const packet of packets.filter(item => item.requirementIds.every(id => inherited.has(id)) && !auditEligible(item))) {
      const unmetDependencyIds = [...dependencyClosure(packet.requirementIds)].filter(id => !implemented.has(id));
      state.markRequirements(packet.requirementIds, "blocked");
      await state.record({ at: now(), type: "dependency_gate_blocked", packetId: packet.id,
        detail: { requirementIds: packet.requirementIds, unmetDependencyIds,
          dependencyStatuses: Object.fromEntries(unmetDependencyIds.map(id => [id, verificationStatus(id)])) } });
    }

    // Final audit is detection-only: failures are published as-is instead of
    // funneling into a late consolidated repair whose giant packet and full
    // re-audit cost more than they recover.
    await phase("audit");
    results = await audit("audit");
    await publish();

    await phase("delivery");
    await state.record({ at: now(), type: "delivery_started" });
    await deps.candidate?.assertAcceptedInput();
    let finalReport = await runFinalVerifier(options, deps, state);
    let repairedRounds = 0;
    for (let round = 1; !finalReport.ok && round <= MAX_DELIVERY_REPAIR_ROUNDS && !gateway.exhausted && budget.remaining("delivery") > 0; round += 1) {
      repairedRounds = round;
      await state.record({ at: now(), type: "delivery_repair_started", detail: { stage: finalReport.stage, message: finalReport.message, round } });
      const result = await build({ mode: "delivery_repair", outputDir: options.outputDir,
        platformContract: options.platformContract, deliveryFailure: { stage: finalReport.stage,
          expected: expectedByStage[finalReport.stage], actual: sanitizeDiagnosticText(finalReport.message, deps.diagnosticSecrets) } }, "delivery");
      // A repair the Builder did not complete is restored unseen: its verification
      // would be discarded anyway, so spend the remaining rounds on fresh attempts.
      const repaired = result.outcome === "completed" ? await runFinalVerifier(options, deps, state) : finalReport;
      if (result.outcome === "completed" && repaired.ok) {
        await checkpoint([...implemented], "delivery-repair", repaired.candidate);
        // Runtime repair changed the delivered source: old feature passes are not evidence for it.
        results = await audit("delivery");
        await publish();
        finalReport = repaired;
        await state.record({ at: now(), type: "delivery_repair_accepted" });
        break;
      }
      await deps.git.restoreAccepted(state.snapshot.acceptedSha);
      await state.record({ at: now(), type: "delivery_repair_restored", detail: { round } });
    }
    if (!finalReport.ok && repairedRounds > 0) {
      // All attempted rounds failed and were restored; confirm the accepted state
      // once so the final report describes the delivered candidate, not a rejected attempt.
      finalReport = await runFinalVerifier(options, deps, state);
    }
    await deps.candidate?.assertAcceptedInput();
    if (finalReport.ok && finalReport.candidate) await deps.candidate?.assertCurrent(finalReport.candidate);
    await state.record({ at: now(), type: "delivery_finished", detail: finalReport });
    const statuses = state.snapshot.statusByRequirementId;
    const auditedRequirements = catalog.requirements.filter(item => !skipped.has(item.id));
    const ids = (status: typeof statuses[string]) => auditedRequirements.filter(item => statuses[item.id] === status).map(item => item.id);
    const verifiedRequirementIds = ids("verified");
    const missingPlanRequirementIds = packets.filter(packet => packet.requirementIds.every(id => implemented.has(id)) && !results.get(packet.id)?.plan)
      .flatMap(packet => packet.requirementIds);
    const inconclusiveByKind: Partial<Record<InconclusiveKind, string[]>> = {};
    for (const packet of packets) {
      const result = results.get(packet.id);
      if (result?.status !== "inconclusive") continue;
      (inconclusiveByKind[result.failureKind ?? "unreproduced"] ??= []).push(...packet.requirementIds);
    }
    const summary: RunSummary = { status: !finalReport.ok ? "failed" : verifiedRequirementIds.length === auditedRequirements.length ? "delivered" : "partial",
      acceptedSha: state.snapshot.acceptedSha, implementedRequirementIds: [...implemented].filter(id => !skipped.has(id)), verifiedRequirementIds,
      blockedRequirementIds: ids("blocked"), failedRequirementIds: ids("failed"), inconclusiveRequirementIds: ids("inconclusive"), pendingRequirementIds: ids("todo"),
      missingPlanRequirementIds, inconclusiveByKind,
      ...(skipped.size > 0 ? { auditRequirementIds: auditedRequirements.map(item => item.id), skippedRequirementIds: [...skipped] } : {}) };
    await state.record({ at: now(), type: "pipeline_finished", detail: { ...summary, pendingRequirementIds: ids("todo"), memory: await memorySnapshot() } });
    await emitFolderRollup();
    await emitArc(deps, state, arc => arc.runnerState(finalReport.ok ? "completed" : "failed", `summary ${summary.status}`));
    return summary;
  } catch (error) {
    // An uncontained writer must never race a checkout. Stop the run for host cleanup.
    if (!(error instanceof ExecutionFault && error.code === "builder_cleanup")) await deps.git.restoreAccepted(state.snapshot.acceptedSha);
    await state.record({ at: now(), type: "pipeline_failed", detail: { message: errorMessage(error) } });
    await emitFolderRollup();
    await emitArc(deps, state, arc => arc.runnerState("failed", sanitizeDiagnosticText(errorMessage(error), deps.diagnosticSecrets)));
    throw error;
  } finally {
    preplanAbort.abort();
    try { await deps.builder.close(); }
    finally { await Promise.allSettled([...pendingPlans.values()].map(item => item.promise)); }
  }
}

function buildBuilderProjectContext(
  packet: WorkPacket,
  catalog: RequirementCatalog,
  implemented: ReadonlySet<string>,
  startingPoint: PipelineOptions["stageStartingPoint"] = "unknown",
  inherited: ReadonlySet<string> = new Set(),
  skipInheritedAudit = false,
): BuilderProjectContext {
  const first = packet.requirements[0];
  if (!first) throw new Error(`Packet ${packet.id} has no requirements`);
  const dependencyIds = new Set(
    packet.requirements.flatMap((item) => item.dependencyIds),
  );
  const stage = first.product.stage;
  const incrementalContext = {
    startingPoint: startingPoint ?? "unknown",
    externalPrerequisiteIds: [...new Set(packet.requirements.flatMap(item => item.externalDependencyIds ?? []))],
  };
  return {
    product: first.product,
    ancestors: dedupeAncestors(
      packet.requirements.flatMap((item) => item.ancestors),
    ),
    satisfiedDependencies: catalog.requirements
      .filter((item) => dependencyIds.has(item.id) && implemented.has(item.id))
      .map((item) => ({ id: item.id, name: item.name, ...(!inherited.has(item.id) ? { contract: item.text } : {}) })),
    ...(first.product.evolution ? { evolution: {
      ...incrementalContext,
      ...(stage ? { stageIndex: stage.index } : {}),
      ...(inherited.size > 0 ? { changesOnly: true as const } : {}),
      ...(skipInheritedAudit ? { auditInheritedRequirements: false as const } : {}),
    } } : stage ? { progressiveStage: {
      ...stage,
      ...incrementalContext,
    } } : {}),
  };
}

function dedupeAncestors(
  ancestors: WorkPacket["requirements"][number]["ancestors"],
): WorkPacket["requirements"][number]["ancestors"] {
  const seen = new Set<string>();
  const unique: WorkPacket["requirements"][number]["ancestors"] = [];
  for (const ancestor of ancestors) {
    if (seen.has(ancestor.id)) continue;
    seen.add(ancestor.id);
    unique.push(ancestor);
  }
  return unique;
}

const expectedByStage = {
  candidate: "验收与接受对应同一份未变化的候选文件和构建产物",
  install: "平台安装命令成功退出",
  build: "平台构建命令成功退出并生成生产构建产物",
  readiness: "应用使用随机端口启动且健康检查返回成功；只设置 PORT 时额外端口也必须绑定，未知路径必须返回响应且进程不退出",
  browser: "根页面可访问并显示主要内容区域",
  complete: "完整交付验证成功",
} satisfies Record<FinalVerificationReport["stage"], string>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function emitArc(
  deps: PipelineDeps,
  state: RunStateStore,
  emit: (arc: ArcEventsPort) => Promise<void> | void,
): Promise<void> {
  if (!deps.arcEvents) return;
  try {
    await emit(deps.arcEvents);
  } catch (error) {
    await state.record({ at: now(), type: "arc_projection_failed", detail: { message: errorMessage(error) } });
  }
}

async function runFinalVerifier(
  options: PipelineOptions,
  deps: PipelineDeps,
  state: RunStateStore,
): Promise<FinalVerificationReport> {
  for (let retryCount = 0; ; retryCount += 1) {
    const startedAt = deps.clock.nowMs();
    await state.record({ at: now(), type: "verification_started", detail: { retryCount } });
    try {
      const report = await deps.finalVerifier.verify(options.outputDir, options.platformContract);
      await state.record({ at: now(), type: "verification_finished",
        detail: { ...report, durationMs: Math.max(0, deps.clock.nowMs() - startedAt), retryCount } });
      return report;
    } catch (error) {
      if (error instanceof ExecutionFault) {
        const retry = error.retryable && retryCount === 0;
        await state.record({ at: now(), type: "execution_fault", packetId: "final-verification",
          detail: { source: error.source, code: error.code, retryable: error.retryable, retry, retryCount } });
        if (retry) continue;
        throw error;
      }
      return { ok: false, stage: "readiness", message: errorMessage(error) };
    }
  }
}


/** A successful sampled check may recover locators, but cannot replace untested cases. */
function mergeCheckedPlan(original: ProbePlan, checked: ProbePlan, packet: WorkPacket): ProbePlan {
  const cases = new Map(checked.cases.map(item => [item.id, item]));
  return parseProbePlan({ ...original,
    ...(checked.navigationRecovered ? { navigationRecovered: true } : {}),
    ...(checked.coverageReview ? { coverageReview: checked.coverageReview } : {}),
    cases: original.cases.map(item => cases.get(item.id) ?? item) }, packet);
}

function now(): string { return new Date().toISOString(); }
