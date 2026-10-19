import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import {
  ModelRuntime,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";

import {
  assembleInputLines,
  createDraftStore,
  createRequirementsTool,
  createProjectIntentTool,
  createReviewTool,
  runConversation,
  type ChatAgent,
  type RequirementsOutputMode,
} from "./cli.js";
import { loadGatewayEnv, opencodeSessionHeaders, type GatewayEnv } from "./env.js";
import { runPiTurn } from "./pi-turn.js";
import { RequirementsTui } from "./tui.js";
import { shellArgument, terminalTheme } from "../../src/terminal/theme.js";
import { formatUsageSummary, type ModelRates } from "../../src/model-usage.js";

const DEFAULT_CONTEXT_WINDOW = 256_000;
const PROVIDER = "requirements-gateway";
/** Pi 内置 read / ls 工具的名称；通过 createAgentSession 的 tools 白名单启用。 */
const READ_TOOL_NAME = "read";
const LS_TOOL_NAME = "ls";

export async function main(): Promise<number> {
  const baseDir = process.cwd();
  const gateway = await loadGatewayEnv({
    cwd: baseDir,
    // 仓库根目录 .env（与 ShallowCode 的 builder / judge 共用同一份配置）。
    rootEnvFile: fileURLToPath(new URL("../../.env", import.meta.url)),
  });
  const systemPrompt = await readFile(
    fileURLToPath(new URL("../prompts/requirements-agent.md", import.meta.url)),
    "utf8",
  );
  const store = createDraftStore(baseDir);
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const agent = await createPiAgent({
    gateway, systemPrompt, requirementsTool: createRequirementsTool(store), projectIntentTool: createProjectIntentTool(store),
    ...(interactive ? {} : { out: (text: string) => { process.stdout.write(text); } }),
  });
  let tui: RequirementsTui | undefined;
  let rl: ReturnType<typeof createInterface> | undefined;
  let leaving = false;
  const leave = () => {
    if (leaving) return;
    leaving = true;
    tui?.close();
    tui?.stop();
    void agent.abort().catch(() => {}).finally(() => {
      const usage = sessionUsage(agent.session);
      process.stdout.write("\n已退出（未生成需求文档）。" +
        (store.tree || store.pendingInputs.length ? `草稿已保留：${store.file}。\n` : "\n") +
        (usage ? `${usage}\n` : ""));
      process.exit(0);
    });
  };
  try {
    if (interactive) {
      tui = new RequirementsTui({
        model: gateway.model,
        onAbort: () => { void agent.abort().catch(() => {}); },
        onExit: leave,
      });
      tui.watchSession(agent.session);
    } else {
      rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    }
    process.once("SIGINT", leave);
    process.once("SIGTERM", leave);
    tui?.start();
    const result = await runConversation({
      agent, store, baseDir,
      input: tui ? tui.input : assembleInputLines(rl!),
      out: tui ? tui.out.bind(tui) : (text) => { process.stdout.write(text); },
      ...(tui ? { onView: tui.present.bind(tui) } : {}),
    });
    tui?.stop();
    // 终端恢复后先补一行累计用量，再打印最终产物路径，避免被最后一帧覆盖。
    const usage = sessionUsage(agent.session);
    if (usage) process.stdout.write(`${usage}\n`);
    if (tui && result.status !== "ended") {
      const theme = terminalTheme();
      process.stdout.write(`\n${theme.success(result.status === "updated" ? "✓ 已更新需求文档" : "✓ 已生成需求文档")}\n  ${result.file}\n\n` +
        `${theme.muted("下一步")}\n  shallow build --requirements-dir ${shellArgument(dirname(result.file))}\n\n`);
    }
    return 0;
  } finally {
    process.off("SIGINT", leave);
    process.off("SIGTERM", leave);
    rl?.close();
    tui?.close();
    tui?.stop();
    await agent.dispose();
  }
}

interface PiAgentOptions {
  gateway: GatewayEnv;
  systemPrompt: string;
  requirementsTool: ReturnType<typeof createRequirementsTool>;
  projectIntentTool: ReturnType<typeof createProjectIntentTool>;
  /** 纯文本模式的流式输出；TUI 模式由界面自行订阅会话事件。 */
  out?: (text: string) => void;
}

interface PiAgent extends ChatAgent {
  readonly session: AgentSession;
  abort(): Promise<void>;
  dispose(): Promise<void>;
}

/** 会话累计用量；价格已知时带费用，未发生调用时返回 null。 */
function sessionUsage(session: AgentSession): string | null {
  try {
    const stats = session.getSessionStats();
    const tokens = stats.tokens;
    if (tokens.total <= 0) return null;
    return `【模型用量】${formatUsageSummary({
      input: tokens.input, output: tokens.output, cacheRead: tokens.cacheRead, cacheWrite: tokens.cacheWrite,
      total: tokens.total, ...(stats.cost > 0 ? { cost: stats.cost } : {}),
    })}`;
  } catch {
    return null;
  }
}

function piProviderModel(model: string, contextWindow: number = DEFAULT_CONTEXT_WINDOW,
  headers?: Record<string, string>, cost?: ModelRates | null) {
  return {
    id: model,
    name: model,
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    contextWindow,
    maxTokens: 65_536,
    cost: cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(headers && Object.keys(headers).length ? { headers } : {}),
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens" as const,
      supportsStrictMode: false,
      requiresReasoningContentOnAssistantMessages: true,
    },
  };
}

async function createPiAgent(options: PiAgentOptions): Promise<PiAgent> {
  const agentDir = join(tmpdir(), `requirements-agent-${process.pid}`);
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  try {
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
    });
    // 整个对话复用一个会话标识，满足 opencode 网关的路由要求。
    const sessionId = randomUUID();
    modelRuntime.registerProvider(PROVIDER, {
      baseUrl: options.gateway.baseUrl,
      api: "openai-completions",
      apiKey: "REQUIREMENTS_RUNTIME_CREDENTIAL",
      models: [piProviderModel(options.gateway.model, DEFAULT_CONTEXT_WINDOW,
        opencodeSessionHeaders(options.gateway.baseUrl, sessionId), options.gateway.cost)],
    });
    await modelRuntime.setRuntimeApiKey(PROVIDER, options.gateway.apiKey);
    const settingsManager = SettingsManager.inMemory({
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 1_000 },
      compaction: { enabled: true },
      enableInstallTelemetry: false,
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: options.systemPrompt,
    });
    await resourceLoader.reload();
    const model = modelRuntime.getModel(PROVIDER, options.gateway.model);
    if (!model) throw new Error(`网关模型未注册：${options.gateway.model}`);
    let requestedOutput: RequirementsOutputMode | undefined;
    const reviewTool = createReviewTool((mode) => { requestedOutput = mode; });
    const customTools = [options.requirementsTool, options.projectIntentTool, reviewTool] as ToolDefinition[];
    const { session, modelFallbackMessage } = await createAgentSession({
      cwd: process.cwd(),
      agentDir,
      modelRuntime,
      model,
      settingsManager,
      resourceLoader,
      sessionManager: SessionManager.inMemory(),
      // tools 白名单只放行内置 read / ls 与需求工具；noTools 是白名单缺省时的兜底。
      noTools: "builtin",
      tools: [READ_TOOL_NAME, LS_TOOL_NAME, ...customTools.map((tool) => tool.name)],
      customTools,
    });
    if (modelFallbackMessage) {
      session.dispose();
      throw new Error(modelFallbackMessage);
    }

    const output = options.out;
    const unsubscribe = output ? session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        output(event.assistantMessageEvent.delta);
      }
      if (event.type === "tool_execution_start") {
        if (event.toolName === options.requirementsTool.name) {
          output("\n[正在更新需求草案…]\n");
        }
        if (event.toolName === reviewTool.name) output("\n[正在准备需求审阅…]\n");
        if (event.toolName === READ_TOOL_NAME) {
          const requested = typeof event.args?.path === "string" ? event.args.path : "";
          output(requested ? `\n[正在读取文件：${requested}]\n` : "\n[正在读取文件…]\n");
        }
        if (event.toolName === LS_TOOL_NAME) {
          const requested = typeof event.args?.path === "string" ? event.args.path : "";
          output(requested ? `\n[正在查看目录：${requested}]\n` : "\n[正在查看目录…]\n");
        }
      }
    }) : undefined;

    return {
      session,
      async send(text) {
        requestedOutput = undefined;
        const result = await runPiTurn(session, text);
        return result.ok && requestedOutput ? { ...result, output: requestedOutput } : result;
      },
      async abort() {
        try {
          session.abortCompaction();
          await session.abort();
        } catch {
          // 退出路径上的取消失败不阻止关闭。
        }
      },
      async dispose() {
        unsubscribe?.();
        session.dispose();
        await rm(agentDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(agentDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`启动失败：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
