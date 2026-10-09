import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AuthStorage, ModelRegistry, SessionManager, SettingsManager, DefaultResourceLoader, createAgentSession } from "@mariozechner/pi-coding-agent";
import { createPiTools } from "./pi-tools.js";
import { installSseCapture } from "./sse-capture.js";
import { installSseResilience } from "./sse-resilience.js";
import { closeSharedBrowser } from "./pi-browser-tool.js";
import { PiExecutionCollector } from "./pi-execution-stats.js";
import { piProviderModel } from "./pi-model-config.js";
import { loadReferenceImages } from "./reference-images.js";
import { isImageUnsupportedMessage } from "./vision-probe.js";
import type { PiWorkerRequest, PiWorkerResult, PiWorkerProgress } from "./pi-worker-client.js";
import { fillTemplate, loadPrompt } from "../prompt-assets.js";
import { classifyGatewayFailure, observeGatewayFailures } from "../gateway-failure.js";

// Wait for ownership to be established by the parent before executing anything.
process.once("message", (request: PiWorkerRequest) => {
  void run(request).then(send, error => send({ sessionId: "unavailable", outcome: "failed", summary: error instanceof Error ? error.message : String(error) }));
});
process.on("disconnect", () => process.exit(1));

function send(result: PiWorkerResult): void {
  // Parent receives a bounded receipt, then kills the owned job/group and awaits cleanup.
  process.send?.(result);
}

async function run(input: PiWorkerRequest): Promise<PiWorkerResult> {
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
  const { session, modelFallbackMessage } = await createAgentSession({ cwd: input.outputDir, agentDir,
    authStorage, modelRegistry, model: modelRegistry.find("shallow-gateway", input.gateway.model),
    settingsManager, resourceLoader, sessionManager: manager,
    tools: ["read", "edit", "write", "shell", "run_tests", "browser", "list_capabilities", "install_capability",
      ...(input.platformContract ? ["app"] : [])],
    customTools: createPiTools(input.outputDir, Boolean(input.platformContract)) });
  if (modelFallbackMessage) throw new Error(modelFallbackMessage);
  let toolCalls = 0;
  let compactions = 0;
  let pendingRestart = false;
  let terminalResponse: Extract<(typeof session.messages)[number], { role: "assistant" }> | undefined;
  let compactionReason: string | undefined;
  // A compaction reason is a historical marker, not a cause: a package can
  // compact once and then work for an hour before the deadline. Record whether
  // the session advanced after the last overflow compaction so the controller
  // can tell a context-bound stop from a clock-bound one.
  let toolCallsAtOverflowCompaction: number | undefined;
  let recoveryError: string | undefined;
  let wake: (() => void) | undefined;
  const collector = new PiExecutionCollector();
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
      // Size only: the summary log reports how much the model produced, never what it said.
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
      // SDK silent-overflow recovery may retain an assistant, which continue()
      // rejects. Keep a completed receipt, or report a truncated terminal as a
      // bounded failure instead of waiting for an agent_start that cannot occur.
      const retained = session.messages.at(-1);
      // Error assistants are removed by the SDK after this event, before retry.
      pendingRestart = event.willRetry && !terminalResponse &&
        (retained?.role !== "assistant" || retained.stopReason === "error");
      recoveryError = event.errorMessage;
    }
    if (event.type === "turn_end" || event.type === "compaction_end") reportProgress();
    wake?.(); wake = undefined;
  });
  const termination = () => ({ lastMessageRole: (terminalResponse ?? session.messages.at(-1))?.role,
    lastAssistantStopReason: terminalResponse?.stopReason ?? [...session.messages].reverse().find(message => message.role === "assistant")?.stopReason,
    compactionPending: session.isCompacting, retryPending: session.isRetrying || pendingRestart,
    ...(compactionReason ? { compactionReason } : {}),
    // Only an overflow compaction that produced no further tool call is
    // evidence that the context window ended the call rather than the clock.
    ...(toolCallsAtOverflowCompaction === undefined ? {} :
      { progressedAfterOverflowCompaction: toolCalls > toolCallsAtOverflowCompaction }),
    ...(recoveryError ? { recoveryError } : {}) });
  const reportProgress = () => {
    process.send?.({ type: "builder_progress", sessionId: manager.getSessionId(), toolCalls, compactions,
      ...collector.summarize(session.getSessionStats().tokens), termination: termination() } satisfies PiWorkerProgress);
  };
  const progressTimer = setInterval(reportProgress, 15_000);
  progressTimer.unref();
  // attachReferences=false is the run's switch: references stay declared for the
  // log, but no image is read off disk and none reaches the model.
  const attach = input.attachReferences !== false;
  const loaded = !attach
    ? { images: [], skipped: [] }
    : !input.textOnly && input.requirementsDir && input.references?.length
      ? await loadReferenceImages(input.requirementsDir, input.references) : { images: [], skipped: input.textOnly ? [] : (input.references ?? []).map(reference => ({ reference, reason: "requirements_unavailable" })) };
  const images = attach && !input.textOnly ? loaded.images.map(image => ({ type: "image" as const, mimeType: image.mime, data: image.dataUrl.slice(image.dataUrl.indexOf(",") + 1) })) : [];
  const promptUntilIdle = async (text: string, promptImages = images) => {
    await session.prompt(text, { images: promptImages, expandPromptTemplates: false });
    for (;;) {
      // AgentSession processes its event queue after Agent.prompt resolves.
      // Drain that queue before checking compaction or its scheduled continuation.
      await new Promise<void>(resolve => setImmediate(resolve));
      await session.agent.waitForIdle();
      if (!session.isCompacting && !session.isRetrying && !session.isStreaming && !pendingRestart) return;
      await new Promise<void>(resolve => { wake = resolve; });
    }
  };
  // Install capture first so it tees the raw body, then resilience outermost so
  // the client reads a repaired stream while diagnostics keep the original bytes.
  const capture = input.sseCaptureDir ? installSseCapture(input.sseCaptureDir, input.sessionKey ?? "builder") : undefined;
  const resilience = installSseResilience(raw => process.stderr.write(`[ShallowCode] 检测到损坏的网关 SSE 事件：${raw}\n`));
  const gateway = observeGatewayFailures(input.gateway.baseUrl);
  try {
    const imageNote = !input.references?.length ? "" : !attach || input.visionUnsupported
      ? loadPrompt("system", "reference-images-text-fallback")
      : input.textOnly ? loadPrompt("system", "reference-images-text-fallback")
      : fillTemplate(loadPrompt("system", "reference-images"), {
        ATTACHED_REFERENCES: loaded.images.map(image => `- ${image.reference}`).join("\n") || "无",
        UNAVAILABLE_REFERENCES: loaded.skipped.map(item => `- ${item.reference}: ${item.reason}`).join("\n") || "无",
      });
    let promptError: unknown;
    try {
      await promptUntilIdle(`${input.taskPrompt}\n\n${imageNote}`);
      const stopped = terminalResponse ?? session.messages.at(-1);
      if (stopped?.role === "assistant" && stopped.stopReason === "stop" &&
        !stopped.content.some(part => part.type === "text" && part.text.trim())) {
        await promptUntilIdle(loadPrompt("system", "completion-receipt"), []);
      }
    }
    catch (error) { promptError = error; }
    const last = terminalResponse ?? session.messages.at(-1);
    const text = last?.role === "assistant" ? last.content.filter(part => part.type === "text").map(part => part.text).join("\n").trim() : "";
    const success = !promptError && last?.role === "assistant" && last.stopReason === "stop" && Boolean(text);
    // Only SDK/provider errors may clarify a gateway status; model content cannot.
    const providerError = promptError ? String(promptError) : last?.role === "assistant" ? last.errorMessage : undefined;
    const summary = promptError ? String(promptError) : last?.role === "assistant" ? last.errorMessage || text || "Pi returned an empty terminal response" : "Pi did not reach a terminal assistant response";
    const stats = collector.summarize(session.getSessionStats().tokens);
    const observedFailure = gateway.failure();
    return { sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(),
      outcome: success ? "completed" : "failed", summary: summary.slice(-8_000), toolCalls, compactions, peakRssBytes: process.resourceUsage().maxRSS * 1024,
      ...(!promptError && last?.role !== "assistant" ? { terminationReason: "missing_terminal_response" as const } :
        !promptError && last?.role === "assistant" && last.stopReason === "length" ? { terminationReason: "model_length_limit" as const } :
        !promptError && last?.role === "assistant" && last.stopReason === "stop" && !text ? { terminationReason: "empty_terminal_response" as const } : {}),
      termination: termination(),
      ...(!success && observedFailure ? { gatewayFailure: classifyGatewayFailure(observedFailure, providerError) } : {}),
      usage: stats.usage, timing: stats.timing,
      imageUnsupported: !success && images.length > 0 && toolCalls === 0 && isImageUnsupportedMessage(summary),
      ...(input.references?.length ? { referenceImages: {
        mode: !attach ? "disabled" : input.visionUnsupported ? "unsupported" : input.textOnly ? "text_fallback" : images.length ? "attached" : "unavailable",
        attachedCount: images.length, skipped: loaded.skipped } as const } : {}),
    };
  } finally { clearInterval(progressTimer); unsubscribe(); session.dispose(); gateway.uninstall(); resilience.uninstall(); await capture?.uninstall(); await closeSharedBrowser(); }
}
