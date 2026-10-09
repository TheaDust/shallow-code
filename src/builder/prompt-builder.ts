import type { BuilderPort, BuilderRequest, BuilderRunOptions, BuilderResult } from "./port.js";
import { compileBuilderPrompt } from "./prompt.js";
import type { CodingAgentPort, CodingAgentRequest } from "./execution-port.js";
import { loadPrompt } from "../prompt-assets.js";
import type { VisionCapability } from "./vision-probe.js";

export class PromptBuilder implements BuilderPort {
  private textOnly = false;
  private visionUnsupported = false;
  private visionProbed = false;
  constructor(private client: CodingAgentPort, private options: { timeoutMs: number; requirementsDir?: string; contextWindow?: number;
    /** Reference images are opt-in; without this no image is read or attached. */
    referenceImages?: boolean; visionProbe?: VisionCapability }) {}
  async run(request: BuilderRequest, options: BuilderRunOptions = {}): Promise<BuilderResult> {
    const timeoutMs = Math.min(this.options.timeoutMs, options.timeoutMs ?? this.options.timeoutMs);
    const deadline = Date.now() + timeoutMs;
    const remainingMs = () => Math.max(0, deadline - Date.now());
    const references = "packet" in request ? request.packet.requirements.flatMap(req => req.references) : [];
    // An inconclusive probe must leave images enabled for the normal Builder
    // gateway recovery and image rejection fallback. Reserve most of the call
    // for implementation when its window is short.
    if (this.options.referenceImages && !this.textOnly && !this.visionProbed && this.options.visionProbe && references.length > 0) {
      this.visionUnsupported = (await this.options.visionProbe.supports(Math.floor(remainingMs() / 10))) === "unsupported";
      this.visionProbed = true;
    }
    const prompt = compileBuilderPrompt(request);
    if (remainingMs() <= 0) return { sessionId: "unavailable", outcome: "timed_out",
      summary: "Builder call deadline exhausted during reference-image preflight" };
    const attachReferences = Boolean(this.options.referenceImages) && !this.textOnly && !this.visionUnsupported;
    const input: CodingAgentRequest = { ...prompt, outputDir: request.outputDir,
      timeoutMs: remainingMs(), sessionKey: options.sessionKey, platformContract: request.platformContract, requirementsDir: this.options.requirementsDir,
      references, textOnly: this.textOnly, attachReferences, visionUnsupported: this.visionUnsupported,
      contextWindow: this.options.contextWindow };
    if (options.continuationFeedback) input.taskPrompt += "\n\n" + loadPrompt("system", "implementation-continuation")
      .replace("{{FAILURE}}", () => options.continuationFeedback!);
    if (options.resumeInterrupted) input.taskPrompt += "\n\n" + loadPrompt("system", "implementation-resume");
    let result = await this.client.run(input);
    if (result.imageUnsupported && !this.textOnly && remainingMs() > 0) {
      this.textOnly = true;
      result = await this.client.run({ ...input, textOnly: true, timeoutMs: remainingMs() });
    }
    // Session paths and SDK internals stay private to the execution adapter.
    return { sessionId: result.sessionId, outcome: result.outcome, summary: result.summary, referenceImages: result.referenceImages, execution: result.execution,
      ...(result.terminationReason ? { terminationReason: result.terminationReason } : {}),
      ...(result.gatewayFailure ? { gatewayFailure: result.gatewayFailure } : {}) };
  }
  close(): Promise<void> { return this.client.close(); }
}
