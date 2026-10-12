import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import {
  AuthStorage,
  InteractiveMode,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type AgentSessionRuntime,
  type ExtensionFactory,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";

import {
  assembleInputLines,
  createDraftStore,
  createRequirementsTool,
  runConversation,
  type ChatAgent,
} from "./cli.js";
import { loadGatewayEnv, opencodeSessionHeaders, type GatewayEnv } from "./env.js";
import { runPiTurn } from "./pi-turn.js";
import { createRequirementsUi } from "./tui.js";

const DEFAULT_CONTEXT_WINDOW = 256_000;
const PROVIDER = "requirements-gateway";
/** Pi 内置 read 工具的名称；通过 session 的 tools 白名单启用。 */
const READ_TOOL_NAME = "read";

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
  const store = createDraftStore();
  const ui = process.stdin.isTTY && process.stdout.isTTY ? createRequirementsUi(store) : undefined;
  const out = ui ? ui.out : (text: string) => { process.stdout.write(text); };
  const agent = await createPiAgent({
    gateway, systemPrompt, requirementsTool: createRequirementsTool(store),
    ...(ui ? { extension: ui.extension } : { out }),
  });
  const mode = ui ? new InteractiveMode(agent.runtime) : undefined;
  const rl = ui ? undefined : createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const onSigint = () => {
    mode?.stop();
    ui?.close();
    void agent.abort().then(() => agent.dispose()).finally(() => {
      process.stdout.write("\n已退出（未生成需求文档）。\n");
      process.exit(0);
    });
  };
  process.once("SIGINT", onSigint);
  let reading = true;
  try {
    if (mode) {
      await mode.init();
      // Pi owns editing, commands and streaming input. Its input hook routes
      // requirement submissions into runConversation rather than its own loop.
      const readInput = async () => {
        while (reading) {
          const text = await mode.getUserInput();
          if (reading) await agent.runtime.session.prompt(text);
        }
      };
      void readInput().catch((error) => {
        mode.showError(String(error));
        ui!.close();
      });
    }
    const result = await runConversation({
      agent, store, input: ui ? ui.input : assembleInputLines(rl!), out, baseDir,
      ...(ui ? { inputHelp: "Enter 提交；Shift+Enter 换行；Esc 中止；Ctrl+C 两次或空输入时 Ctrl+D 退出。" } : {}),
    });
    mode?.stop();
    // Pi's deferred rendering may still have a final frame queued when the
    // workflow finishes; print the receipt after terminal restoration.
    if (ui && result.status === "generated") process.stdout.write(`已生成 ${result.file}\n`);
    return 0;
  } finally {
    reading = false;
    process.off("SIGINT", onSigint);
    rl?.close();
    ui?.close();
    mode?.stop();
    await agent.dispose();
  }
}

interface PiAgentOptions {
  gateway: GatewayEnv;
  systemPrompt: string;
  requirementsTool: ReturnType<typeof createRequirementsTool>;
  extension?: ExtensionFactory;
  out?: (text: string) => void;
}

interface PiAgent extends ChatAgent {
  readonly runtime: AgentSessionRuntime;
  abort(): Promise<void>;
  dispose(): Promise<void>;
}

function piProviderModel(model: string, contextWindow: number = DEFAULT_CONTEXT_WINDOW,
  headers?: Record<string, string>) {
  return {
    id: model,
    name: model,
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    contextWindow,
    maxTokens: 65_536,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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
    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(PROVIDER, options.gateway.apiKey);
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    // 整个对话复用一个会话标识，满足 opencode 网关的路由要求。
    const sessionId = randomUUID();
    modelRegistry.registerProvider(PROVIDER, {
      baseUrl: options.gateway.baseUrl,
      api: "openai-completions",
      apiKey: "REQUIREMENTS_RUNTIME_CREDENTIAL",
      models: [piProviderModel(options.gateway.model, DEFAULT_CONTEXT_WINDOW,
        opencodeSessionHeaders(options.gateway.baseUrl, sessionId))],
    });
    const settingsManager = SettingsManager.inMemory({
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 1_000 },
      compaction: { enabled: true },
      enableInstallTelemetry: false,
      quietStartup: true, doubleEscapeAction: "none",
    });
    const model = modelRegistry.find(PROVIDER, options.gateway.model);
    if (!model) throw new Error(`网关模型未注册：${options.gateway.model}`);
    const cleanup: ExtensionFactory = (pi) => {
      pi.on("session_shutdown", async (event) => {
        if (event.reason === "quit") await rm(agentDir, { recursive: true, force: true });
      });
    };
    const runtime = await createAgentSessionRuntime(async ({ cwd, sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({
        cwd, agentDir, authStorage, modelRegistry, settingsManager,
        resourceLoaderOptions: {
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          systemPrompt: options.systemPrompt,
          extensionFactories: [...(options.extension ? [options.extension] : []), cleanup],
        },
      });
      const created = await createAgentSessionFromServices({
        services, sessionManager, sessionStartEvent, model,
        noTools: "builtin", tools: [READ_TOOL_NAME, options.requirementsTool.name],
        customTools: [options.requirementsTool as ToolDefinition],
      });
      if (created.modelFallbackMessage) {
        created.session.dispose();
        throw new Error(created.modelFallbackMessage);
      }
      return { ...created, services, diagnostics: services.diagnostics };
    }, { cwd: process.cwd(), agentDir, sessionManager: SessionManager.inMemory() });
    const output = options.out;
    const unsubscribe = output ? runtime.session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        output(event.assistantMessageEvent.delta);
      }
      if (event.type === "tool_execution_start") {
        if (event.toolName === options.requirementsTool.name) {
          output("\n[正在更新需求草案…]\n");
        }
        if (event.toolName === READ_TOOL_NAME) {
          const requested = typeof event.args?.path === "string" ? event.args.path : "";
          output(requested ? `\n[正在读取文件：${requested}]\n` : "\n[正在读取文件…]\n");
        }
      }
    }) : undefined;
    return {
      runtime,
      send: (text, userInput) => options.extension
        ? runPiTurn(runtime.session, userInput ?? text, { source: "extension" })
        : runPiTurn(runtime.session, text),
      async abort() { await runtime.session.abort(); },
      async dispose() {
        unsubscribe?.();
        await runtime.dispose();
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
