import { runCheckerPipeline, type CheckerRuntime } from "./checker-pipeline.js";
import type { CheckerConfig } from "./runtime-config.js";
import type { BuilderPort } from "./builder/port.js";
import type { GitOps } from "./git-ops.js";
import type { FeatureGrouper } from "./feature-grouper.js";
import type { LogSink } from "./run-state.js";
import type { GatewayRecovery } from "./gateway-recovery.js";
import type { HistoricalRequirements } from "./evolution.js";
import type { ModelUsageSummary } from "./model-usage.js";
import type { ApplicationContract, DeliveryReport } from "./application/port.js";
import type { InconclusiveKind, RunScenarioResult } from "./types.js";

export interface PipelineDeps {
  checker: CheckerRuntime;
  builder: BuilderPort;
  git: GitOps;
  grouper?: FeatureGrouper;
  clock: { nowMs(): number };
  logSink?: LogSink;
  diagnosticSecrets?: readonly string[];
  runMetadata?: Record<string, unknown>;
  assertContractUnchanged?(): Promise<void>;
  gatewayRecovery?: GatewayRecovery;
}

export interface PipelineOptions {
  checker: CheckerConfig;
  requirementsFile: string;
  outputDir: string;
  ledgerFile: string;
  totalBudgetMs: number;
  /** Command start, including initialization and input preparation. */
  startedAtMs?: number;
  initializationUsage?: import("./model-usage.js").TokenUsage[];
  initialization?: { path: import("./project-initialization.js").InitializationPath; intent: string | null };
  applicationContract: ApplicationContract;
  /** Product-visible journal directory (`shallow-progress`). */
  progressDir?: string;
  /** Read-only history from the input project, outside the owned development copy. */
  historicalProgressDir?: string;
  historicalRequirements?: HistoricalRequirements;
  /** Whether this stage starts from a selected prior-stage application or the blank scaffold. */
  stageStartingPoint?: "inherited_application" | "blank_template" | "unknown";
  /** Evolution only: true includes inherited atomics in audits and delivery coverage. Default false. */
  auditInheritedRequirements?: boolean;
  /** Runnable implementations recovered from an owned checkpoint; replay follows Checker settings. */
  resumedRequirementIds?: string[];
  requirementDigests?: Record<string, string>;
}

export interface RunSummary {
  checker?: { mode: "active"; producedHead?: import("./checker/checkpoints.js").ProducedSnapshot;
    semanticReview?: boolean; replay?: boolean;
    verifiedSnapshotId?: string; outcomes?: Array<import("./checker/port.js").CheckOutcome & { snapshotId?: string }> };
  status: "delivered" | "partial" | "failed";
  verifiedRequirementIds: string[];
  blockedRequirementIds: string[];
  acceptedSha: string;
  implementedRequirementIds?: string[];
  failedRequirementIds?: string[];
  inconclusiveRequirementIds?: string[];
  pendingRequirementIds?: string[];
  inconclusiveByKind?: Partial<Record<InconclusiveKind, string[]>>;
  auditRequirementIds?: string[];
  skippedRequirementIds?: string[];
  delivery?: DeliveryReport;
  scenarioResults?: RunScenarioResult[];
  /** 本轮全部模型调用的 token 与费用（价格已知时）。 */
  modelUsage?: ModelUsageSummary;
}

export async function runPipeline(options: PipelineOptions, deps: PipelineDeps): Promise<RunSummary> {
  return runCheckerPipeline(options, deps, deps.checker);
}
