import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { piProviderModel, DEFAULT_CONTEXT_WINDOW } from "../builder/pi-model-config.js";
import { acquireSseResilience } from "../builder/sse-resilience.js";
import { GatewayRequestError, observeGatewayFailures, providerGatewayFailure,
  type GatewayFailure, type GatewayFailureObservation } from "../gateway-failure.js";
import { GatewayRecovery } from "../gateway-recovery.js";
import { opencodeSessionHeaders } from "../gateway-headers.js";
import type { GatewayConfig } from "../runtime-config.js";
import type { ModelRates } from "../model-usage.js";
import type { CheckJob } from "./port.js";

export interface CheckerTool {
  name: string;
  description: string;
  parameters: TSchema;
  /** Compatibility shim run before schema validation, matching the Pi tool contract. */
  prepareArguments?(input: unknown): unknown;
  execute(input: unknown): Promise<unknown>;
}
export interface CheckerModelRequest {
  role: "exploration" | "semantic_review";
  job: Readonly<CheckJob>;
  systemPrompt: string;
  prompt: string;
  tools: CheckerTool[];
  signal: AbortSignal;
}
export interface CheckerModelResult { totalTokens: number }
export interface CheckerModel { run(request: CheckerModelRequest): Promise<CheckerModelResult> }
export interface CheckerModelUsage {
  role: CheckerModelRequest["role"];
  jobId: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  total: number;
  cost?: number;
}

/** Each call creates an isolated private session; SDK discovery and built-in tools are disabled. */
export function createPiCheckerModel(options: {
  gateway: GatewayConfig;
  sessionDir: string;
  contextWindow?: number;
  modelCost?: ModelRates;
  onUsage?: (usage: CheckerModelUsage) => void;
  /** 会话进行中的累计用量；仅供实时展示，最终结算仍以 onUsage 为准。 */
  onProgress?: (usage: CheckerModelUsage) => void;
  /** Shared pipeline gateway window; defaults to a model-local recovery window. */
  recovery?: GatewayRecovery;
}): CheckerModel {
  const recovery = options.recovery ?? new GatewayRecovery();
  return {
    async run(request) {
      request.signal.throwIfAborted();
      if (Date.now() >= request.job.budget.deadlineAt) throw new Error("Checker model deadline exhausted");
      // Install per call so overlapping Checker jobs share fetch observation and
      // SSE repair without one run uninstalling another run's wrapper.
      const observation = observeGatewayFailures(options.gateway.baseUrl);
      const resilience = acquireSseResilience();
      try {
        return await recovery.run("checker", request.job.packetId,
          () => Math.max(0, request.job.budget.deadlineAt - Date.now()),
          () => attempt(request, observation), request.signal);
      } finally {
        resilience.uninstall();
        observation.uninstall();
      }
    },
  };

  async function attempt(request: CheckerModelRequest, gateway: GatewayFailureObservation): Promise<CheckerModelResult> {
    request.signal.throwIfAborted();
    if (Date.now() >= request.job.budget.deadlineAt) throw new Error("Checker model deadline exhausted");
    const cwd = join(options.sessionDir, randomUUID());
    const agentDir = join(cwd, "config");
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    // The model's 256k context window is the only per-call token bound; there is no cumulative token budget.
    runtime.registerProvider("checker-gateway", { baseUrl: options.gateway.baseUrl, api: "openai-completions", apiKey: "CHECKER_RUNTIME_CREDENTIAL",
      models: [piProviderModel(options.gateway.model, options.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        opencodeSessionHeaders(options.gateway.baseUrl, randomUUID()), options.modelCost)] });
    await runtime.setRuntimeApiKey("checker-gateway", options.gateway.apiKey);
    // Transient gateway drops are retryable; the provider adds no second layer of its own.
    // The provider timeout tracks the Checker job deadline, matching the Builder's call window.
    // Long explorations compact older turns before the model's 256k context window is exhausted.
    const remainingMs = Math.max(1, Math.min(2_147_483_647, request.job.budget.timeoutMs ?? Infinity, request.job.budget.deadlineAt - Date.now()));
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 1_000,
      provider: { maxRetries: 0, timeoutMs: remainingMs } }, compaction: { enabled: true }, enableInstallTelemetry: false });
    const resources = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true,
      disabledBuiltinExtensions: ["mcp"], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: request.systemPrompt });
    await resources.reload();
    const requiresFinish = request.tools.some(tool => tool.name === "finish");
    let finished = false;
    const customTools: ToolDefinition[] = request.tools.map(tool => ({ name: tool.name, label: tool.name, description: tool.description,
      parameters: tool.parameters, prepareArguments: tool.prepareArguments, executionMode: "sequential", async execute(_id, input) {
        request.signal.throwIfAborted();
        if (finished) throw new Error("Checker submission already finished");
        const result = await tool.execute(input);
        if (tool.name === "finish") finished = true;
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      } }));
    const { session, modelFallbackMessage } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime,
      model: runtime.getModel("checker-gateway", options.gateway.model), settingsManager, resourceLoader: resources,
      sessionManager: SessionManager.create(cwd, cwd), noTools: "builtin", tools: customTools.map(tool => tool.name), customTools });
    if (modelFallbackMessage) { session.dispose(); throw new Error(modelFallbackMessage); }
    const finishTurn = session.agent.finishTurn;
    session.agent.finishTurn = async (turn, signal) => {
      const decision = await finishTurn?.(turn, signal);
      if (finished) return { action: "end" };
      if (decision) return decision;
      return undefined;
    };
    let reasoning = 0;
    let hasReasoning = false;
    let providerError: string | undefined;
    // 当前 attempt 的累计用量：每次助手消息结束后上报一次，供 TUI 实时展示。
    const live = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    const unsubscribe = session.subscribe(event => {
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      const count = event.message.usage.reasoning;
      if (count !== undefined) { reasoning += count; hasReasoning = true; }
      const usage = event.message.usage;
      live.input += usage.input; live.output += usage.output;
      live.cacheRead += usage.cacheRead; live.cacheWrite += usage.cacheWrite;
      live.cost += usage.cost?.total ?? 0;
      const total = live.input + live.output + live.cacheRead + live.cacheWrite;
      if (total > 0) {
        try {
          options.onProgress?.({ role: request.role, jobId: request.job.jobId,
            input: live.input, output: live.output, cacheRead: live.cacheRead, cacheWrite: live.cacheWrite,
            total, ...(hasReasoning ? { reasoning } : {}), ...(options.modelCost ? { cost: live.cost } : {}) });
        } catch { /* 用量展示不影响检查结果。 */ }
      }
      if (event.message.stopReason === "error" || event.message.stopReason === "aborted") providerError = event.message.errorMessage ?? event.message.stopReason;
      // A successful retry clears the previous attempt's transient failure.
      else providerError = undefined;
    });
    const abort = () => { void session.abort(); };
    request.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, remainingMs);
    let observed: GatewayFailure | undefined;
    try {
      return await gateway.track(async () => {
        try {
          let prompt = request.prompt;
          for (let reminders = 0; ; reminders++) {
            await session.prompt(prompt, { expandPromptTemplates: false });
            await session.waitForIdle();
            request.signal.throwIfAborted();
            if (Date.now() >= request.job.budget.deadlineAt) throw new Error("Checker model deadline exhausted");
            if (providerError) {
              const failure = providerGatewayFailure(providerError, gateway.failure());
              if (failure) throw new GatewayRequestError(failure);
              throw new Error(providerError);
            }
            if (!requiresFinish || finished) return { totalTokens: session.getSessionStats().tokens.total };
            if (reminders === 2) throw new Error(`Checker ${request.role} did not call finish successfully after 2 submission reminders`);
            prompt = (await readFile(new URL("../../prompts/checker/submission.md", import.meta.url), "utf8")).trimEnd();
          }
        } catch (error) {
          // Capture scoped metadata before the async scope ends and cleanup runs.
          observed = gateway.failure();
          throw error;
        } finally {
          clearTimeout(timer);
          request.signal.removeEventListener("abort", abort);
          unsubscribe();
          const stats = session.getSessionStats();
          session.dispose();
          options.onUsage?.({ role: request.role, jobId: request.job.jobId, ...stats.tokens,
            ...(hasReasoning ? { reasoning } : {}), ...(options.modelCost ? { cost: stats.cost } : {}) });
        }
      });
    } catch (error) {
      request.signal.throwIfAborted();
      if (Date.now() >= request.job.budget.deadlineAt) throw new Error("Checker model deadline exhausted");
      if (error instanceof GatewayRequestError) throw error;
      const message = providerError ?? (error instanceof Error ? error.message : String(error));
      const failure = providerGatewayFailure(message, observed);
      if (failure) throw new GatewayRequestError(failure, { cause: error });
      throw error;
    }
  }
}
