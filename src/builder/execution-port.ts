import type { BuilderResult } from "./port.js";
import type { PlatformContract } from "../types.js";

/** Engine-independent prompt execution shared by the controller and raw baseline. */
export interface CodingAgentRequest {
  systemPrompt: string;
  taskPrompt: string;
  outputDir: string;
  timeoutMs: number;
  sessionKey?: string;
  platformContract?: PlatformContract;
  requirementsDir?: string;
  references?: string[];
  textOnly?: boolean;
  /** false keeps declared references out of the model input entirely. */
  attachReferences?: boolean;
  /** Preflight probe found the model accepts no image input. */
  visionUnsupported?: boolean;
  /** Override the model context window; omitted runs use the shared default. */
  contextWindow?: number;
}
export interface CodingAgentResult extends BuilderResult {
  imageUnsupported?: boolean;
  toolCalls?: number;
  compactions?: number;
}
export interface CodingAgentPort {
  /** Resolve only after owned processes have exited. Failure invalidates the session key. */
  run(request: CodingAgentRequest): Promise<CodingAgentResult>;
  close(): Promise<void>;
}
