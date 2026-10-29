import type { AgentRole } from "./agent-config.js";
import type { VerifierProgress } from "./verifier/port.js";

export type RequirementStatus = "todo" | "verified" | "blocked" | "failed" | "inconclusive";
export type InconclusiveKind = "planning" | "coverage" | "preparation" | "locator" | "execution" | "review" | "gateway" | "budget" | "unreproduced";

export interface RunScenarioResult {
  requirementId: string;
  scenarioId: string;
  name: string;
  status: "verified" | "failed" | "inconclusive" | "not_run";
  caseIds: string[];
  reason?: string;
}

/** Cumulative scenario coverage over the current audit scope. */
export interface ScenarioCoverageCounts {
  total: number;
  verified: number;
  failed: number;
  inconclusive: number;
  notRun: number;
}

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
  /** Root-declared implementation guidance: expectations that cannot be verified independently. */
  guidance?: string[];
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
  /** Implementation guidance from this requirement and its ancestors; not independently verified. */
  guidance?: string[];
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
  /** Declared expectations that cannot be verified independently (theme, style, tone). */
  guidance?: string[];
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

export type { ApplicationContract, ProcessCommand } from "./application/port.js";

interface RunEventEnvelope {
  at: string;
  packetId?: string;
  runId?: string;
  eventId?: string;
  sequence?: number;
  elapsedMs?: number;
  phase?: "pipeline" | "builder" | "planning" | "application" | "verifier" | "decision" | "delivery" | "evidence";
  acceptedSha?: string;
  attempt?: number;
}

type DiagnosticDetail = { message?: string; source?: string; category?: string; code?: string;
  validationError?: string; contentPreview?: string; retryable?: boolean; fatal?: boolean;
  httpStatus?: number; attempt?: number; retryCount?: number; retry?: boolean };

interface RunEventDetails {
  initialization_started: { path: string; hasCode: boolean; hasConfig: boolean; intentPresent: boolean };
  initialization_attempt: { path: string; attempt: number };
  initialization_verification_started: { path: string; attempt: number };
  initialization_validation_failed: { path: string; attempt: number; message: string };
  initialization_verified: { path: string; adapterId: string; attempt?: number; resumed?: boolean };
  initialization_finished: { path: string; adapterId: string; attempt?: number };
  snapshot_sealed: { snapshotId: string; sourceSha: string; parentSnapshotId?: string; requirementIds: string[];
    /** Cumulative Builder-implemented requirements carried by this sealed source; independent of verification. */
    implementedRequirementIds?: string[]; sequence: number; authoritative?: boolean };
  check_queued: CheckEventDetail;
  check_started: CheckEventDetail;
  check_progress: CheckEventDetail & VerifierProgress;
  check_completed: CheckEventDetail;
  check_cancelled: CheckEventDetail;
  module_check_started: { moduleId: string; moduleEpoch: number; snapshotId: string; requirementIds: string[] };
  module_check_finished: { moduleId: string; moduleEpoch: number; snapshotId: string;
    replay?: boolean;
    requirementResults: Record<string, RequirementStatus>; published: boolean;
    /** Scenario results for the module scope that was just checked. */
    scenarioResults?: RunScenarioResult[];
    /** Cumulative scenario coverage across the current audit scope. */
    scenarioCoverage?: ScenarioCoverageCounts };
  verifier_usage: { jobId: string; role: string; input: number; output: number; cacheRead: number; cacheWrite: number;
    total: number; cost?: number; reasoning?: number };
  /** 进行中 Verifier 会话的累计用量；仅投递交互终端实时展示，不写账本或日志，最终以 verifier_usage 结算。 */
  verifier_usage_progress: { jobId: string; role: string; input: number; output: number; cacheRead: number; cacheWrite: number;
    total: number; cost?: number; reasoning?: number };
  gateway_wait: { source: AgentRole; retry: number; delayMs: number; failure: import("./gateway-failure.js").GatewayFailure; reason?: string };
  builder_work_preserved: { preserved: boolean; requirementIds: string[]; reason?: string };
  implementation_retry: { requirementIds: string[]; timeoutMs: number; reason?: "timeout" | import("./builder/port.js").BuilderResult["terminationReason"] };
  implementation_split: { requirementIds: string[]; reason: string; kind?: "recovery" | "dependency"; packets: Array<{ packetId: string; requirementIds: string[] }> };
  implementation_continued: { reason: string; timeoutMs: number };
  implementation_paused: { requirementIds: string[]; failure: import("./gateway-failure.js").GatewayFailure };
  implementation_stopped: { requirementIds: string[]; failure: import("./gateway-failure.js").GatewayFailure };
  phase_started: { phase: "implementation" | "audit" | "repair" | "delivery"; remainingMs?: number; round?: number; memory?: Record<string, unknown> };
  checkpoint_saved: { requirementIds: string[]; reason: string; candidate?: CandidateEvidence };
  run_resumed: { requirementIds: string[] };
  module_failed: { requirementIds: string[]; reason: string };
  module_rescued: { requirementIds: string[]; reason: string };
  repair_batch_started: { round: number; requirementIds: string[] };
  repair_batch_finished: { round: number; retained: boolean; reason: string; improvedCases?: number; resolvedGaps?: number;
    requirementResults?: Record<string, "verified" | "failed" | "inconclusive">;
    scenarioResults?: RunScenarioResult[]; scenarioCoverage?: ScenarioCoverageCounts };
  repair_paused: { requirementIds: string[]; failure: import("./gateway-failure.js").GatewayFailure };

  pipeline_started: { requirements?: number; totalBudgetMs?: number; adapterId?: string; model?: string;
    verifierModel?: string; grouperModel?: string;
    builderTimeoutMs?: number; builderContextWindow?: number;
    promptSha256?: string;
    starterScaffold?: { status: import("./application/port.js").ScaffoldResult["status"]; reason: string; files: string[] };
    grouping?: GroupingStats; groupingSource?: "pending_llm" };
  feature_grouping_started: { requirements: number; limits: import("./scheduler.js").FeatureGroupThresholds };
  feature_grouping_usage: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost?: number; attempt?: number };
  builder_usage: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number;
    cost?: number; unpricedTokens?: number };
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
  execution_fault: DiagnosticDetail;
  delivery_started: Record<string, never>;
  delivery_check_started: { snapshotId: string };
  delivery_check_finished: { snapshotId: string; ok: boolean; stage: string; message: string };
  delivery_repair_started: { stage: string; message: string; round?: number };
  delivery_repair_accepted: { candidate?: CandidateEvidence };
  delivery_repair_restored: { round?: number };
  delivery_finished: { ok: boolean; stage: string; message: string };
  pipeline_finished: { status: "delivered" | "partial" | "failed"; verifiedRequirementIds: string[];
    blockedRequirementIds: string[]; implementedRequirementIds?: string[]; failedRequirementIds?: string[]; inconclusiveRequirementIds?: string[]; pendingRequirementIds: string[]; acceptedSha: string; memory?: Record<string, unknown>;
    inconclusiveByKind?: Partial<Record<InconclusiveKind, string[]>>;
    auditRequirementIds?: string[]; skippedRequirementIds?: string[];
    scenarioResults?: RunScenarioResult[];
    scenarioCoverage?: ScenarioCoverageCounts;
    modelUsage?: import("./model-usage.js").ModelUsageSummary;
  };
  pipeline_failed: DiagnosticDetail;
}

type CheckEventDetail = {
  jobId: string;
  snapshotId: string;
  checkedSourceSha: string;
  moduleEpoch: number;
  attempt: number;
  mode: string;
  requirementIds: string[];
  status?: string;
  reason?: string;
  archived?: boolean;
  durationMs?: number;
}

export type RunEvent = RunEventEnvelope & {
  [Type in keyof RunEventDetails]: { type: Type; detail?: RunEventDetails[Type] }
}[keyof RunEventDetails];

export interface CandidateEvidence {
  candidateId: string;
  inputDigest: string;
  applicationDigest: string;
  buildId: string;
  runtimeId: string;
}
