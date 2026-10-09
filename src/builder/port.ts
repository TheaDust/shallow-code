import type { BuilderPromptInput } from "./prompt-input.js";
import type { ExecutionTiming, ExecutionUsage } from "./pi-execution-stats.js";
import type { GatewayFailure } from "../gateway-failure.js";

export type BuilderRequest = BuilderPromptInput;

export interface BuilderResult {
  sessionId: string;
  outcome: "completed" | "failed" | "timed_out";
  summary: string;
  terminationReason?: "missing_terminal_response" | "empty_terminal_response" | "model_length_limit";
  gatewayFailure?: GatewayFailure;
  execution?: { engine: string; version: string; nodeVersion: string; workerPid: number; resumed: boolean;
    durationMs: number; cleanupMs: number; toolCalls?: number; compactions?: number; peakRssBytes?: number;
    usage: ExecutionUsage; timing?: ExecutionTiming; termination?: BuilderTermination };
  referenceImages?: {
    /** disabled: run switch off; unsupported: preflight probe found no vision. */
    mode: "attached" | "text_fallback" | "unavailable" | "disabled" | "unsupported";
    attachedCount: number;
    skipped: Array<{ reference: string; reason: string }>;
  };
}

export interface BuilderTermination {
  lastMessageRole?: string;
  lastAssistantStopReason?: string;
  compactionPending: boolean;
  retryPending: boolean;
  compactionReason?: string;
  /** Set only after an overflow compaction: whether the session made another tool call since. */
  progressedAfterOverflowCompaction?: boolean;
  recoveryError?: string;
}

export interface BuilderRunOptions {
  timeoutMs?: number;
  /** Controller-owned conversation key; omitted for isolated repair calls. */
  sessionKey?: string;
  /** Concrete controller build/start failure, never hidden Judge plans. */
  continuationFeedback?: string;
  /** Fresh-session completion of a controller-observed interrupted implementation. */
  resumeInterrupted?: boolean;
}

export interface BuilderPort {
  run(request: BuilderRequest, options?: BuilderRunOptions): Promise<BuilderResult>;
  close(): Promise<void>;
}
