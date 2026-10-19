import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager, SettingsManager, DefaultResourceLoader, createAgentSession,
  createReadToolDefinition, createEditToolDefinition, createWriteToolDefinition, createBashToolDefinition,
  VERSION, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { GatewayConfig } from "../runtime-config.js";
import type { CodingAgentRequest } from "./execution-port.js";
import type { BuilderResult, BuilderTermination } from "./port.js";
import type { BuilderTool, ToolImage } from "./tool-contract.js";
import { assertToolPath, assertToolReadPath, createBuilderTools, createShellExecutor } from "./pi-tools.js";
import { BUILDER_SKILLS_DIR } from "./skills.js";
import { PiExecutionCollector, type ExecutionSummary } from "./pi-execution-stats.js";
import { piProviderModel } from "./pi-model-config.js";
import { opencodeSessionHeaders } from "../gateway-headers.js";
import type { BuilderCapabilityPack } from "../application/port.js";
import type { ModelRates } from "../model-usage.js";

type PiSessionOptions = Pick<CodingAgentRequest, "outputDir" | "systemPrompt" | "timeoutMs" | "contextWindow" | "applicationContract" | "toolMode"> & {
  gateway: GatewayConfig;
  sessionDir: string;
  sessionFile?: string;
  /** 控制器解析出的单价（USD / 百万 token）；注册后 SDK 负责换算会话花费。 */
  modelCost?: ModelRates;
};

export interface PiSessionSnapshot extends ExecutionSummary {
  sessionId: string;
  sessionFile?: string;
  engineVersion: string;
  toolCalls: number;
  compactions: number;
  termination: BuilderTermination;
}

export interface PiPromptResult {
  outcome: "completed" | "failed";
  summary: string;
  /** Provider/SDK errors only; assistant text must not classify gateway failures. */
  providerError?: string;
  terminationReason?: BuilderResult["terminationReason"];
}

export interface PiSession {
  /** Resolves after automatic retries, compaction and scheduled continuation. */
  prompt(text: string, images?: ToolImage[]): Promise<PiPromptResult>;
  snapshot(): PiSessionSnapshot;
  dispose(): void;
}

/** Pi's HTTP error envelope retains the provider message used by gateway classification. */
function providerErrorMessage(error: string | undefined): string | undefined {
  const envelope = error?.match(/^\d{3}: (\{[\s\S]*\})$/);
  if (envelope) {
    try {
      const body = JSON.parse(envelope[1]);
      if (typeof body.message === "string") return body.message;
    } catch { /* Preserve the SDK error when the body is not valid JSON. */ }
  }
  return error;
}

function toPiTool(tool: BuilderTool): ToolDefinition {
  return { ...tool, execute: (id, params, signal) => tool.execute(id, params, signal) };
}

// Headless sessions need no renderer types; keep native renderer fields at runtime.
type PiTool = Omit<ToolDefinition, "renderCall" | "renderResult">;

function createTools(input: PiSessionOptions, skillFiles: readonly string[], capabilities?: BuilderCapabilityPack): ToolDefinition[] {
  const { outputDir: cwd, applicationContract: contract } = input;
  const privateDirectory = dirname(input.sessionDir);
  const guard = <T extends PiTool>(tool: T): T => ({ ...tool,
    async execute(...args: Parameters<T["execute"]>) {
      const params = args[1] as { path: string };
      const path = tool.name === "read" ? await assertToolReadPath(cwd, params.path, skillFiles)
        : await assertToolPath(cwd, params.path, skillFiles);
      return tool.execute(args[0], { ...params, path }, args[2], args[3], args[4]);
    },
  });
  const files = [guard(createReadToolDefinition(cwd)), guard(createEditToolDefinition(cwd)), guard(createWriteToolDefinition(cwd))];
  if (input.toolMode === "read_only") return [files[0] as unknown as ToolDefinition];
  const shell = createBashToolDefinition(cwd, { operations: { exec: createShellExecutor(cwd, contract, privateDirectory) } });
  shell.name = "shell";
  shell.description = `Run a short ${process.platform === "win32" ? "PowerShell" : "Bash"} command in the application. Use this for file searches, builds and type checks; run tests with the run_tests tool instead. ${contract ? "Use the app tool to manage application checks." : "Do not leave persistent application processes running."}`;
  const tools: PiTool[] = [...files, shell, ...[...createBuilderTools(cwd, Boolean(contract), contract), ...(capabilities?.tools ?? [])].map(toPiTool)];
  return tools;
}

/** The only module that imports Pi SDK types, tools and session lifecycle. */
export async function createPiSession(input: PiSessionOptions,
  onProgress: (snapshot: PiSessionSnapshot) => void, capabilities?: BuilderCapabilityPack): Promise<PiSession> {
  const agentDir = join(input.sessionDir, "config");
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(),
    modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerProvider("shallow-gateway", {
    baseUrl: input.gateway.baseUrl, api: "openai-completions", apiKey: "SHALLOW_RUNTIME_CREDENTIAL",
    models: [piProviderModel(input.gateway.model, input.contextWindow,
      opencodeSessionHeaders(input.gateway.baseUrl, randomUUID()), input.modelCost)],
  });
  await modelRuntime.setRuntimeApiKey("shallow-gateway", input.gateway.apiKey);
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 1_000,
    provider: { maxRetries: 0, timeoutMs: input.timeoutMs } }, compaction: { enabled: true }, enableInstallTelemetry: false });
  const resourceLoader = new DefaultResourceLoader({ cwd: input.outputDir, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalSkillPaths: [BUILDER_SKILLS_DIR, ...(capabilities?.skillDirectories ?? [])],
    systemPrompt: input.systemPrompt });
  await resourceLoader.reload();
  const manager = input.sessionFile ? SessionManager.open(input.sessionFile) : SessionManager.create(input.outputDir, input.sessionDir);
  if (resolve(manager.getCwd()) !== resolve(input.outputDir)) throw new Error("Persisted Pi session workspace mismatch");
  const tools = createTools(input, resourceLoader.getSkills().skills.map(skill => skill.filePath), capabilities);
  const { session, modelFallbackMessage } = await createAgentSession({ cwd: input.outputDir, agentDir,
    modelRuntime, model: modelRuntime.getModel("shallow-gateway", input.gateway.model),
    settingsManager, resourceLoader, sessionManager: manager,
    tools: tools.map(tool => tool.name), customTools: tools });
  if (modelFallbackMessage) { session.dispose(); throw new Error(modelFallbackMessage); }
  let toolCalls = 0;
  let compactions = 0;
  let pendingRestart = false;
  let lastAssistantResponse: Extract<(typeof session.messages)[number], { role: "assistant" }> | undefined;
  let compactionReason: string | undefined;
  // Only progress after the latest overflow compaction distinguishes a context-bound stop.
  let toolCallsAtOverflowCompaction: number | undefined;
  let recoveryError: string | undefined;
  const collector = new PiExecutionCollector();
  const snapshot = (): PiSessionSnapshot => {
    const stats = session.getSessionStats();
    const tokens = stats.tokens;
    const lastMessage = lastAssistantResponse?.stopReason === "toolUse" ? session.messages.at(-1)
      : lastAssistantResponse ?? session.messages.at(-1);
    return { sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), engineVersion: VERSION,
      toolCalls, compactions,
      ...collector.summarize({ input: tokens.input, output: tokens.output, cacheRead: tokens.cacheRead,
        cacheWrite: tokens.cacheWrite, total: tokens.total, ...(input.modelCost ? { cost: stats.cost } : {}) }),
      termination: {
        lastMessageRole: lastMessage?.role,
        lastAssistantStopReason: lastAssistantResponse?.stopReason ?? [...session.messages].reverse().find(message => message.role === "assistant")?.stopReason,
        compactionPending: session.isCompacting, retryPending: session.isRetrying || pendingRestart,
        ...(compactionReason ? { compactionReason } : {}),
        ...(toolCallsAtOverflowCompaction === undefined ? {} :
          { progressedAfterOverflowCompaction: toolCalls > toolCallsAtOverflowCompaction }),
        ...(recoveryError ? { recoveryError } : {}),
      },
    };
  };
  const unsubscribe = session.subscribe(event => {
    const atMs = Date.now();
    if (event.type === "tool_execution_start") { toolCalls++; collector.toolStarted(event.toolCallId, event.toolName, atMs); }
    else if (event.type === "tool_execution_end") collector.toolEnded(event.toolCallId, atMs);
    else if (event.type === "turn_end") collector.turnEnded();
    else if (event.type === "message_start" && event.message.role === "assistant") collector.modelStarted(atMs);
    else if (event.type === "message_end" && event.message.role === "assistant") {
      collector.modelEnded(atMs);
      // Failed attempts may be omitted from projected history before settlement.
      lastAssistantResponse = event.message;
      collector.outputProduced(event.message.content.filter(part => part.type === "text")
        .reduce((total, part) => total + Buffer.byteLength(part.text, "utf8"), 0));
    }
    if (event.type === "agent_start") { pendingRestart = false; lastAssistantResponse = undefined; }
    if (event.type === "agent_settled") pendingRestart = false;
    if (event.type === "compaction_start") {
      compactionReason = event.reason;
      if (event.reason === "overflow") toolCallsAtOverflowCompaction = toolCalls;
    }
    if (event.type === "compaction_end") {
      if (event.result) compactions++;
      pendingRestart = event.willRetry;
      recoveryError = event.errorMessage;
    }
    if (event.type === "turn_end" || event.type === "compaction_end") onProgress(snapshot());
  });
  return {
    snapshot,
    async prompt(promptText, images = []) {
      let promptError: unknown;
      try {
        await session.prompt(promptText, { images, expandPromptTemplates: false });
        // Session-level idle includes automatic compaction, retry and continuation.
        await session.waitForIdle();
      } catch (error) { promptError = error; }
      const last = lastAssistantResponse ?? session.messages.at(-1);
      const text = last?.role === "assistant" ? last.content.filter(part => part.type === "text").map(part => part.text).join("\n").trim() : "";
      const success = !promptError && last?.role === "assistant" && last.stopReason === "stop" && Boolean(text)
        && !last.content.some(part => part.type === "toolCall");
      return {
        outcome: success ? "completed" : "failed",
        summary: promptError ? String(promptError) : last?.role === "assistant" ? last.errorMessage || text || "Pi returned an empty terminal response" : "Pi did not reach a terminal assistant response",
        providerError: providerErrorMessage(promptError ? String(promptError) : last?.role === "assistant" ? last.errorMessage : undefined),
        ...(!promptError && last?.role !== "assistant" ? { terminationReason: "missing_terminal_response" as const } :
          !promptError && last?.role === "assistant" && last.stopReason === "length" ? { terminationReason: "model_length_limit" as const } :
          !promptError && last?.role === "assistant" && last.stopReason === "stop" && !text ? { terminationReason: "empty_terminal_response" as const } : {}),
      };
    },
    dispose() { unsubscribe(); session.dispose(); },
  };
}
