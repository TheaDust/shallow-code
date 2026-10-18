import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { piProviderModel, DEFAULT_CONTEXT_WINDOW } from "../builder/pi-model-config.js";
import { opencodeSessionHeaders } from "../gateway-headers.js";
import type { GatewayConfig } from "../runtime-config.js";
import type { ModelRates } from "../model-usage.js";
import type { CheckJob } from "./port.js";

export interface CheckerTool {
  name: string;
  description: string;
  parameters: TSchema;
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
}): CheckerModel {
  return { async run(request) {
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
    // Long explorations compact older turns before the model's 256k context window is exhausted.
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 1_000,
      provider: { maxRetries: 0 } }, compaction: { enabled: true }, enableInstallTelemetry: false });
    const resources = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true,
      disabledBuiltinExtensions: ["mcp"], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: request.systemPrompt });
    await resources.reload();
    const customTools: ToolDefinition[] = request.tools.map(tool => ({ name: tool.name, label: tool.name, description: tool.description,
      parameters: tool.parameters, executionMode: "sequential", async execute(_id, input) {
        request.signal.throwIfAborted();
        const result = await tool.execute(input);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      } }));
    const { session, modelFallbackMessage } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime,
      model: runtime.getModel("checker-gateway", options.gateway.model), settingsManager, resourceLoader: resources,
      sessionManager: SessionManager.create(cwd, cwd), noTools: "builtin", tools: customTools.map(tool => tool.name), customTools });
    if (modelFallbackMessage) { session.dispose(); throw new Error(modelFallbackMessage); }
    let reasoning = 0;
    let hasReasoning = false;
    let providerError: string | undefined;
    const unsubscribe = session.subscribe(event => {
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      const count = event.message.usage.reasoning;
      if (count !== undefined) { reasoning += count; hasReasoning = true; }
      if (event.message.stopReason === "error" || event.message.stopReason === "aborted") providerError = event.message.errorMessage ?? event.message.stopReason;
      // A successful retry clears the previous attempt's transient failure.
      else providerError = undefined;
    });
    const abort = () => { void session.abort(); };
    request.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, Math.max(1, request.job.budget.deadlineAt - Date.now()));
    try {
      await session.prompt(request.prompt, { expandPromptTemplates: false });
      await session.waitForIdle();
      request.signal.throwIfAborted();
      if (Date.now() >= request.job.budget.deadlineAt) throw new Error("Checker model deadline exhausted");
      if (providerError) throw new Error(providerError);
      return { totalTokens: session.getSessionStats().tokens.total };
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
      unsubscribe();
      const stats = session.getSessionStats();
      session.dispose();
      options.onUsage?.({ role: request.role, jobId: request.job.jobId, ...stats.tokens,
        ...(hasReasoning ? { reasoning } : {}), ...(options.modelCost ? { cost: stats.cost } : {}) });
    }
  } };
}
