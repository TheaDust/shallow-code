import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { piProviderModel, DEFAULT_CONTEXT_WINDOW } from "../builder/pi-model-config.js";
import { createPiGateway, piGatewaySettings } from "../pi-gateway.js";
import { GatewayRecovery } from "../gateway-recovery.js";
import { opencodeSessionHeaders } from "../gateway-headers.js";
import type { GatewayConfig } from "../runtime-config.js";
import type { ModelRates } from "../model-usage.js";
import type { CheckJob } from "./port.js";

export interface VerifierTool {
  name: string;
  description: string;
  parameters: TSchema;
  /** Compatibility shim run before schema validation, matching the Pi tool contract. */
  prepareArguments?(input: unknown): unknown;
  execute(input: unknown): Promise<unknown>;
}
export interface VerifierModelRequest {
  role: "exploration" | "semantic_review";
  job: Readonly<CheckJob>;
  systemPrompt: string;
  prompt: string;
  tools: VerifierTool[];
  signal: AbortSignal;
}
export interface VerifierModelResult { totalTokens: number }
export interface VerifierModel { run(request: VerifierModelRequest): Promise<VerifierModelResult> }
export interface VerifierModelUsage {
  role: VerifierModelRequest["role"];
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
export function createPiVerifierModel(options: {
  gateway: GatewayConfig;
  sessionDir: string;
  contextWindow?: number;
  modelCost?: ModelRates;
  onUsage?: (usage: VerifierModelUsage) => void;
  /** 会话进行中的累计用量；仅供实时展示，最终结算仍以 onUsage 为准。 */
  onProgress?: (usage: VerifierModelUsage) => void;
  /** Shared pipeline gateway window; defaults to a model-local recovery window. */
  recovery?: GatewayRecovery;
}): VerifierModel {
  const recovery = options.recovery ?? new GatewayRecovery();
  return {
    async run(request) {
      request.signal.throwIfAborted();
      if (Date.now() >= request.job.budget.deadlineAt) throw new Error("Verifier model deadline exhausted");
      const timeoutMs = Math.max(1, Math.min(2_147_483_647,
        request.job.budget.timeoutMs ?? Infinity, request.job.budget.deadlineAt - Date.now()));
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
      return runSession({ ...request, signal });
    },
  };

  async function runSession(request: VerifierModelRequest): Promise<VerifierModelResult> {
    request.signal.throwIfAborted();
    if (Date.now() >= request.job.budget.deadlineAt) throw new Error("Verifier model deadline exhausted");
    const cwd = join(options.sessionDir, randomUUID());
    const agentDir = join(cwd, "config");
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    // The model's 256k context window is the only per-call token bound; there is no cumulative token budget.
    runtime.registerProvider("verifier-gateway", { baseUrl: options.gateway.baseUrl, api: "openai-completions", apiKey: "VERIFIER_RUNTIME_CREDENTIAL",
      models: [piProviderModel(options.gateway.model, options.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        opencodeSessionHeaders(options.gateway.baseUrl, randomUUID()), options.modelCost)] });
    await runtime.setRuntimeApiKey("verifier-gateway", options.gateway.apiKey);
    const settingsManager = piGatewaySettings(Math.min(request.job.budget.timeoutMs ?? Infinity,
      request.job.budget.deadlineAt - Date.now()));
    const resources = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true,
      disabledBuiltinExtensions: ["mcp"], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: request.systemPrompt });
    await resources.reload();
    const requiresFinish = request.tools.some(tool => tool.name === "finish");
    let finished = false;
    const customTools: ToolDefinition[] = request.tools.map(tool => ({ name: tool.name, label: tool.name, description: tool.description,
      parameters: tool.parameters, prepareArguments: tool.prepareArguments, executionMode: "sequential", async execute(_id, input) {
        request.signal.throwIfAborted();
        if (finished) throw new Error("Verifier submission already finished");
        const result = await tool.execute(input);
        if (tool.name === "finish") finished = true;
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      } }));
    const { session, modelFallbackMessage } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime,
      model: runtime.getModel("verifier-gateway", options.gateway.model), settingsManager, resourceLoader: resources,
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
    // 当前会话的累计用量：每次助手消息结束后上报一次，供 TUI 实时展示。
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
    });
    const gateway = createPiGateway(options.gateway.baseUrl);
    let prompt = request.prompt;
    let reminders = 0;
    try {
      return await recovery.run("verifier", request.job.packetId,
        () => Math.max(0, request.job.budget.deadlineAt - Date.now()), async () => {
          for (;;) {
            request.signal.throwIfAborted();
            const nextPrompt = prompt;
            prompt = "Continue the current Verifier task using the existing observations and tool results; submit with finish when ready.";
            await gateway.prompt(session, nextPrompt, { signal: request.signal });
            request.signal.throwIfAborted();
            if (!requiresFinish || finished) return { totalTokens: session.getSessionStats().tokens.total };
            if (reminders++ === 2) throw new Error(`Verifier ${request.role} did not call finish successfully after 2 submission reminders`);
            prompt = (await readFile(new URL("../../prompts/verifier/submission.md", import.meta.url), "utf8")).trimEnd();
          }
        }, request.signal);
    } finally {
      await session.abort();
      await session.waitForIdle();
      unsubscribe();
      const stats = session.getSessionStats();
      session.dispose();
      gateway.dispose();
      options.onUsage?.({ role: request.role, jobId: request.job.jobId, ...stats.tokens,
        ...(hasReasoning ? { reasoning } : {}), ...(options.modelCost ? { cost: stats.cost } : {}) });
    }
  }
}
