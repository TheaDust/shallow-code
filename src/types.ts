import type { ProbeLocator, ProbePlan } from "./judge/probe-schema.js";

export type RequirementStatus = "todo" | "verified" | "blocked" | "failed" | "inconclusive";
export type InconclusiveKind = "planning" | "coverage" | "preparation" | "locator" | "execution" | "review" | "gateway" | "budget" | "unreproduced";

export type ProductKind =
  | "repository_collaboration"
  | "spreadsheet"
  | "generic_web";

export interface SeedDataCategory {
  category: string;
  items: string[];
}

export interface ProductContext {
  kind: ProductKind;
  rootId: string;
  rootName: string;
  description: string;
  seedData: SeedDataCategory[];
  /** The selected requirement tree is an Evolution increment over an existing application. */
  evolution?: true;
  /** Present when the selected requirement file is one increment of a progressive task. */
  stage?: {
    index: number;
    currentStageTestsOnly: boolean;
  };
}

export interface RequirementAncestor {
  id: string;
  name: string;
  description: string;
}

export interface AtomicRequirement {
  id: string;
  folderPath: string[];
  declarationIndex: number;
  name: string;
  text: string;
  dependencyIds: string[];
  /** Earlier-increment dependencies intentionally absent from the selected requirement tree. */
  externalDependencyIds?: string[];
  scenarios: string[];
  /** Source scenario IDs and steps for outcome coverage; text remains available unchanged. */
  scenarioContracts?: RequirementNode["scenarios"];
  references: string[];
  exactUiStrings: string[];
  /** Seed declarations with source wording from requirement evidence (ancestors included). */
  seedDeclarations: string[];
  product: ProductContext;
  ancestors: RequirementAncestor[];
}

export interface RequirementCatalog {
  requirements: AtomicRequirement[];
  statusById: Record<string, RequirementStatus>;
}

/** Read-only statistics about a grouping of requirements into feature packets. */
export interface GroupingStats {
  packets: number;
  requirements: number;
  maxPacketSize: number;
  crossModulePackets: number;
  cohesionRate: number;
  thresholdLimitedPackets: number;
}

/** Original hierarchy for platform projection; scheduling uses expanded atomics. */
export interface RequirementNode {
  id: string;
  name: string;
  type: "ROOT" | "FOLDER" | "ATOMIC";
  description: string;
  dependencies: string[];
  children: RequirementNode[];
  visual_reference: string[];
  scenarios: Array<{ id: string; name: string; steps: Array<{ keyword: string; content: string }> }>;
}

export interface WorkPacket {
  prerequisites?: AtomicRequirement[];
  /** Earlier-increment capabilities are context, not requirements audited in this packet. */
  externalPrerequisiteIds?: string[];
  id: string;
  requirementIds: string[];
  requirements: AtomicRequirement[];
  attempt: 1 | 2 | 3;
}

export interface ProcessCommand {
  executable: string;
  args: string[];
  cwd: "output" | "frontend" | "backend";
}

export interface PlatformContract {
  /** Controller-owned runtime data, outside the frozen application tree. */
  dataDirectory?: string;
  baseUrl: string;
  port: number;
  /** Port the grader reaches at evaluation time; generation must never bind it. */
  evaluationPort: number;
  installCommands: ProcessCommand[];
  buildCommands: ProcessCommand[];
  startCommand: ProcessCommand;
  healthPath: string;
  /** Ports the platform's acceptance specs hard-code (e.g. 3301); graded starts bind them. */
  extraPorts?: number[];
  buildTimeoutMs: number;
  startTimeoutMs: number;
}

interface RunEventEnvelope {
  at: string;
  packetId?: string;
  runId?: string;
  eventId?: string;
  sequence?: number;
  elapsedMs?: number;
  phase?: "pipeline" | "builder" | "planner" | "application" | "probe" | "decision" | "delivery" | "projection" | "evidence";
  acceptedSha?: string;
  attempt?: number;
}

type DiagnosticDetail = { message?: string; source?: string; category?: string; code?: string;
  validationError?: string; contentPreview?: string; retryable?: boolean; fatal?: boolean;
  httpStatus?: number; attempt?: number; retryCount?: number; retry?: boolean };

interface RunEventDetails {
  evolution_scope_selected: { historicalPlans: number; ignoredPlans: number;
    historicalPlanRequirementCount: number; historicalCheckpointRequirementCount: number;
    historicalCheckpointSupplementCount: number; historicalRequirementCount: number; addedRequirementIds: string[];
    changedRequirementIds: string[]; inheritedRequirementIds: string[]; implementationRequirementIds: string[]; reason?: string;
    auditRequirementIds?: string[]; skippedRequirementIds?: string[] };
  gateway_wait: { source: "builder" | "planner"; retry: number; delayMs: number; failure: import("./gateway-failure.js").GatewayFailure; reason?: string };
  builder_work_preserved: { preserved: boolean; requirementIds: string[]; reason?: string };
  implementation_retry: { requirementIds: string[]; timeoutMs: number; reason?: "timeout" | import("./builder/port.js").BuilderResult["terminationReason"] };
  implementation_split: { requirementIds: string[]; reason: string; kind?: "recovery" | "dependency"; packets: Array<{ packetId: string; requirementIds: string[] }> };
  implementation_continued: { reason: string; timeoutMs: number };
  implementation_paused: { requirementIds: string[]; failure: import("./gateway-failure.js").GatewayFailure };
  implementation_stopped: { requirementIds: string[]; failure: import("./gateway-failure.js").GatewayFailure };
  phase_started: { phase: "implementation" | "audit" | "repair" | "delivery"; remainingMs?: number; round?: number; memory?: Record<string, unknown> };
  checkpoint_saved: { requirementIds: string[]; reason: string; candidate?: CandidateEvidence };
  module_failed: { requirementIds: string[]; reason: string };
  module_rescued: { requirementIds: string[]; reason: string };
  audit_result: { requirementIds: string[]; status: "verified" | "failed" | "inconclusive"; reason?: string;
    failureKind?: InconclusiveKind; navigationRecovered?: boolean; uncoveredOutcomes?: number };
  repair_guard_checked: { requirementIds: string[]; status: "passed" | "regressed" | "unresolved"; critical: boolean; retried: boolean; failureKind?: InconclusiveKind };
  public_entry_checked: { requirementIds: string[]; status: "passed" | "failed" | "unresolved"; failureKind?: InconclusiveKind };
  compatibility_checked: { requirementIds: string[]; contract: "derived_web_contracts";
    status: "passed" | "failed" | "unresolved"; failureKind?: InconclusiveKind };
  repair_batch_started: { round: number; requirementIds: string[] };
  repair_batch_finished: { round: number; retained: boolean; reason: string; improvedCases?: number; resolvedGaps?: number };
  repair_paused: { requirementIds: string[]; failure: import("./gateway-failure.js").GatewayFailure };

  pipeline_started: { requirements?: number; totalBudgetMs?: number; port?: number; model?: string;
    auditInheritedRequirements?: boolean;
    builderTimeoutMs?: number; plannerTimeoutMs?: number; builderContextWindow?: number;
    promptSha256?: string; probeSchemaSha256?: string;
    progressiveStage?: { index: number; currentStageTestsOnly: boolean;
      startingPoint: "inherited_application" | "blank_template" | "unknown"; externalDependencyIds: string[] };
    evolution?: { stageIndex?: number;
      startingPoint: "inherited_application" | "blank_template" | "unknown"; externalDependencyIds: string[] };
    starterScaffold?: { status: import("./starter-scaffold.js").StarterScaffoldStatus; reason: string; files: string[] };
    grouping?: GroupingStats; groupingSource?: "pending_llm" };
  feature_grouping_started: { requirements: number; limits: import("./scheduler.js").FeatureGroupThresholds };
  feature_grouping_usage: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; attempt?: number };
  feature_grouping_retry: { attempt: number; reason: string; category?: string; httpStatus?: number; cutOffByModel: boolean };
  feature_grouping_finished: { source: "llm" | "deterministic"; reason?: string; attempts?: number; grouping: GroupingStats; durationMs: number;
    groups: Array<{ packetId: string; requirementIds: string[]; purpose?: string }> };
  dependency_gate_blocked: { requirementIds: string[]; unmetDependencyIds: string[];
    dependencyStatuses: Record<string, RequirementStatus> };
  dependency_gate_provisional: { requirementIds: string[]; dependencyIds: string[] };
  packet_selected: { requirementIds?: string[]; names?: string[] };
  builder_started: { attempt?: number; mode?: string };
  builder_finished: { outcome?: "completed" | "failed" | "timed_out"; sessionId?: string; summary?: string;
    terminationReason?: import("./builder/port.js").BuilderResult["terminationReason"];
    attempt?: number; durationMs?: number; execution?: Record<string, unknown>; gatewayFailure?: import("./gateway-failure.js").GatewayFailure };
  builder_reference_images: { mode: string; attachedCount: number; skipped: Array<{ reference: string; reason: string }> };
  candidate_prepared: Omit<CandidateEvidence, "runtimeId"> & { reused: boolean; installed: boolean;
    durationMs: number; installMs: number; buildMs: number };
  candidate_prepare_failed: { stage: string; message: string; durationMs: number };
  probe_planning: Record<string, never>;
  probe_preplan_failed: DiagnosticDetail;
  probe_planned: { cases: number };
  probe_planner_usage: { operation: "plan" | "refine" | "review"; input: number; output: number;
    cacheRead: number; cacheWrite: number; total: number };
  probe_started: { cases: number; retryCount: number; plan?: ProbePlan; planSha256?: string };
  probe_finished: { verdict: ShadowReport["verdict"]; refined?: boolean; passed?: number; failed?: number;
    durationMs?: number; categories?: ProbeFailure["category"][]; evidenceId?: string; candidate?: CandidateEvidence };
  probe_refined: { plan?: ProbePlan; refinementAttempt?: number; beforePlanSha256?: string; planSha256?: string };
  probe_navigation_attempted: { recovered: boolean; improved?: boolean; beforePlanSha256: string; planSha256: string };
  probe_refinement_failed: DiagnosticDetail & { refinementAttempt?: number; planSha256?: string };
  probe_review_started: { cases: number; failed: number };
  probe_reviewed: { verdict: "sound" | "corrected"; rationale?: string;
    corrections?: Array<{ caseId: string; conflict?: string; basis?: string[] }>;
    beforePlanSha256?: string; planSha256?: string };
  probe_review_failed: DiagnosticDetail & { planSha256?: string };
  probe_planner_retry: DiagnosticDetail;
  probe_planner_failed: DiagnosticDetail;
  application_starting: Record<string, never>;
  application_ready: { baseUrl: string; candidate?: CandidateEvidence };
  application_start_failed: DiagnosticDetail;
  application_stopped: Record<string, never>;
  execution_fault: DiagnosticDetail;
  packet_accepted: { candidate?: CandidateEvidence };
  delivery_started: Record<string, never>;
  delivery_repair_started: { stage: string; message: string; round?: number };
  delivery_repair_accepted: { candidate?: CandidateEvidence };
  delivery_repair_restored: { round?: number };
  delivery_finished: { ok: boolean; stage: string; message: string };
  module_boundary_audit_finished: { moduleId: string; moduleName?: string; packetIds: string[];
    regressionPacketIds?: string[];
    results: Record<string, "verified" | "failed" | "inconclusive"> };
  verification_started: { retryCount: number };
  verification_finished: { ok: boolean; stage: string; message: string; durationMs: number; retryCount: number; candidate?: CandidateEvidence };
  pipeline_finished: { status: "delivered" | "partial" | "failed"; verifiedRequirementIds: string[];
    blockedRequirementIds: string[]; implementedRequirementIds?: string[]; failedRequirementIds?: string[]; inconclusiveRequirementIds?: string[]; pendingRequirementIds: string[]; acceptedSha: string; memory?: Record<string, unknown>;
    missingPlanRequirementIds?: string[]; inconclusiveByKind?: Partial<Record<InconclusiveKind, string[]>>;
    auditRequirementIds?: string[]; skippedRequirementIds?: string[] };
  pipeline_failed: DiagnosticDetail;
  arc_projection_failed: DiagnosticDetail;
  evidence_write_failed: Record<string, never>;
}

export type RunEvent = RunEventEnvelope & {
  [Type in keyof RunEventDetails]: { type: Type; detail?: RunEventDetails[Type] }
}[keyof RunEventDetails];

export interface ProbeFailure {
  caseId: string;
  stepIndex: number;
  category: "assertion" | "locator" | "navigation" | "timeout" | "runner" | "precondition";
  message: string;
  inputSummary?: string;
  /** Observed location for Judge recovery and private evidence. */
  pageUrl?: string;
  locatorSnapshot?: string;
  locatorAttempts?: Array<{ locator: ProbeLocator; message: string; matchCount?: number }>;
}

export interface ShadowReport {
  candidate?: CandidateEvidence;
  packetId: string;
  verdict: "pass" | "fail" | "inconclusive";
  passedCases: string[];
  failures: ProbeFailure[];
}

export interface CandidateEvidence {
  candidateId: string;
  inputDigest: string;
  applicationDigest: string;
  buildId: string;
  runtimeId: string;
}
