import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { AuthStorage, ModelRegistry, SessionManager, SettingsManager, DefaultResourceLoader, createAgentSession,
  createReadToolDefinition, createEditToolDefinition, createWriteToolDefinition, createBashToolDefinition,
  VERSION, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { GatewayConfig } from "../runtime-config.js";
import type { CodingAgentRequest } from "./execution-port.js";
import type { BuilderResult, BuilderTermination } from "./port.js";
import type { BuilderTool, ToolImage } from "./tool-contract.js";
import { assertToolPath, createBuilderTools, createShellExecutor } from "./pi-tools.js";
import { PiExecutionCollector, type ExecutionSummary } from "./pi-execution-stats.js";
import { piProviderModel } from "./pi-model-config.js";

type PiSessionOptions = Pick<CodingAgentRequest, "outputDir" | "systemPrompt" | "timeoutMs" | "contextWindow" | "platformContract"> & {
  gateway: GatewayConfig;
  sessionDir: string;
  sessionFile?: string;
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

function toPiTool(tool: BuilderTool): ToolDefinition {
  return { ...tool, execute: (id, params, signal) => tool.execute(id, params, signal) };
}

// Headless sessions need no renderer types; keep native renderer fields at runtime.
type PiTool = Omit<ToolDefinition, "renderCall" | "renderResult">;

function createTools(input: PiSessionOptions): ToolDefinition[] {
  const { outputDir: cwd, platformContract: contract } = input;
  const privateDirectory = dirname(input.sessionDir);
  const guard = <T extends PiTool>(tool: T): T => ({ ...tool,
    async execute(...args: Parameters<T["execute"]>) {
      await assertToolPath(cwd, (args[1] as { path: string }).path);
      return tool.execute(args[0], args[1], args[2], args[3], args[4]);
    },
  });
  const files = [guard(createReadToolDefinition(cwd)), guard(createEditToolDefinition(cwd)), guard(createWriteToolDefinition(cwd))];
  const shell = createBashToolDefinition(cwd, { operations: { exec: createShellExecutor(cwd, contract, privateDirectory) } });
  shell.name = "shell";
  shell.description = `Run a short ${process.platform === "win32" ? "PowerShell" : "Bash"} command in the application. Use this for file searches, builds and type checks; run tests with the run_tests tool instead. ${contract ? "Use the app tool to start and stop the application for browser checks." : "Do not start persistent servers; briefly starting the app in the background for a browser-tool check is allowed when instructed."}`;
  const tools: PiTool[] = [...files, shell, ...createBuilderTools(cwd, Boolean(contract), contract).map(toPiTool)];
  return tools;
}

/** The only module that imports Pi SDK types, tools and session lifecycle. */
export async function createPiSession(input: PiSessionOptions,
  onProgress: (snapshot: PiSessionSnapshot) => void): Promise<PiSession> {
  const agentDir = join(input.sessionDir, "config");
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey("shallow-gateway", input.gateway.apiKey);
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  modelRegistry.registerProvider("shallow-gateway", {
    baseUrl: input.gateway.baseUrl, api: "openai-completions", apiKey: "SHALLOW_RUNTIME_CREDENTIAL",
    models: [piProviderModel(input.gateway.model, input.contextWindow)],
  });
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 1_000,
    provider: { maxRetries: 0, timeoutMs: input.timeoutMs } }, compaction: { enabled: true }, enableInstallTelemetry: false });
  const resourceLoader = new DefaultResourceLoader({ cwd: input.outputDir, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: input.systemPrompt });
  await resourceLoader.reload();
  const manager = input.sessionFile ? SessionManager.open(input.sessionFile) : SessionManager.create(input.outputDir, input.sessionDir);
  if (resolve(manager.getCwd()) !== resolve(input.outputDir)) throw new Error("Persisted Pi session workspace mismatch");
  const tools = createTools(input);
  const { session, modelFallbackMessage } = await createAgentSession({ cwd: input.outputDir, agentDir,
    authStorage, modelRegistry, model: modelRegistry.find("shallow-gateway", input.gateway.model),
    settingsManager, resourceLoader, sessionManager: manager,
    tools: tools.map(tool => tool.name), customTools: tools });
  if (modelFallbackMessage) { session.dispose(); throw new Error(modelFallbackMessage); }
  let toolCalls = 0;
  let compactions = 0;
  let pendingRestart = false;
  let terminalResponse: Extract<(typeof session.messages)[number], { role: "assistant" }> | undefined;
  let compactionReason: string | undefined;
  // Only progress after the latest overflow compaction distinguishes a context-bound stop.
  let toolCallsAtOverflowCompaction: number | undefined;
  let recoveryError: string | undefined;
  let wake: (() => void) | undefined;
  const collector = new PiExecutionCollector();
  const snapshot = (): PiSessionSnapshot => {
    const tokens = session.getSessionStats().tokens;
    return { sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), engineVersion: VERSION,
      toolCalls, compactions,
      ...collector.summarize({ input: tokens.input, output: tokens.output, cacheRead: tokens.cacheRead,
        cacheWrite: tokens.cacheWrite, total: tokens.total }),
      termination: {
        lastMessageRole: (terminalResponse ?? session.messages.at(-1))?.role,
        lastAssistantStopReason: terminalResponse?.stopReason ?? [...session.messages].reverse().find(message => message.role === "assistant")?.stopReason,
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
      terminalResponse = event.message.stopReason === "stop" &&
        !event.message.content.some(part => part.type === "toolCall") ? event.message : undefined;
      collector.outputProduced(event.message.content.filter(part => part.type === "text")
        .reduce((total, part) => total + Buffer.byteLength(part.text, "utf8"), 0));
    }
    if (event.type === "agent_start") { pendingRestart = false; terminalResponse = undefined; }
    if (event.type === "compaction_start") {
      compactionReason = event.reason;
      if (event.reason === "overflow") toolCallsAtOverflowCompaction = toolCalls;
    }
    if (event.type === "compaction_end") {
      if (event.result) compactions++;
      // Silent-overflow recovery may retain an assistant that continue() rejects.
      // Error assistants are removed by the SDK after this event, before retry.
      const retained = session.messages.at(-1);
      pendingRestart = event.willRetry && !terminalResponse &&
        (retained?.role !== "assistant" || retained.stopReason === "error");
      recoveryError = event.errorMessage;
    }
    if (event.type === "turn_end" || event.type === "compaction_end") onProgress(snapshot());
    wake?.(); wake = undefined;
  });
  return {
    snapshot,
    async prompt(promptText, images = []) {
      let promptError: unknown;
      try {
        await session.prompt(promptText, { images, expandPromptTemplates: false });
        for (;;) {
          // Drain the SDK event queue before checking scheduled recovery.
          await new Promise<void>(resolve => setImmediate(resolve));
          await session.agent.waitForIdle();
          if (!session.isCompacting && !session.isRetrying && !session.isStreaming && !pendingRestart) break;
          await new Promise<void>(resolve => { wake = resolve; });
        }
      } catch (error) { promptError = error; }
      const last = terminalResponse ?? session.messages.at(-1);
      const text = last?.role === "assistant" ? last.content.filter(part => part.type === "text").map(part => part.text).join("\n").trim() : "";
      const success = !promptError && last?.role === "assistant" && last.stopReason === "stop" && Boolean(text);
      return {
        outcome: success ? "completed" : "failed",
        summary: promptError ? String(promptError) : last?.role === "assistant" ? last.errorMessage || text || "Pi returned an empty terminal response" : "Pi did not reach a terminal assistant response",
        providerError: promptError ? String(promptError) : last?.role === "assistant" ? last.errorMessage : undefined,
        ...(!promptError && last?.role !== "assistant" ? { terminationReason: "missing_terminal_response" as const } :
          !promptError && last?.role === "assistant" && last.stopReason === "length" ? { terminationReason: "model_length_limit" as const } :
          !promptError && last?.role === "assistant" && last.stopReason === "stop" && !text ? { terminationReason: "empty_terminal_response" as const } : {}),
      };
    },
    dispose() { unsubscribe(); session.dispose(); },
  };
}
