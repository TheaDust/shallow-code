import { runVerifierPipeline, type VerifierRuntime } from "./verifier-pipeline.js";
import type { VerifierConfig } from "./runtime-config.js";
import type { BuilderPort } from "./builder/port.js";
import type { GitOps } from "./git-ops.js";
import type { FeatureGrouper } from "./feature-grouper.js";
import type { LogSink } from "./run-state.js";
import type { GatewayRecovery } from "./gateway-recovery.js";
import type { ModelUsageSummary } from "./model-usage.js";
import type { ApplicationContract, DeliveryReport } from "./application/port.js";
import type { InconclusiveKind, RunScenarioResult } from "./types.js";

export interface PipelineDeps {
  verifier: VerifierRuntime;
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
  verifier: VerifierConfig;
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
  /** Project state at the start of this build. */
  startingPoint?: "inherited_application" | "blank_template" | "unknown";
  /** Unchanged implementations found in the current project; always checked again in a fresh build. */
  resumedRequirementIds?: string[];
  requirementDigests?: Record<string, string>;
}

export interface RunSummary {
  verifier?: { mode: "active"; producedHead?: import("./verifier/checkpoints.js").ProducedSnapshot;
    semanticReview?: boolean; replay?: boolean;
    verifiedSnapshotId?: string; outcomes?: Array<import("./verifier/port.js").CheckOutcome & { snapshotId?: string }> };
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
  return runVerifierPipeline(options, deps, deps.verifier);
}
