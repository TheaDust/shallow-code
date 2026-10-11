import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
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

const DEFAULT_CONTEXT_WINDOW = 256_000;
const PROVIDER = "requirements-gateway";

export async function main(): Promise<number> {
  const gateway = await loadGatewayEnv({
    cwd: process.cwd(),
    // 仓库根目录 .env（与 ShallowCode 的 builder / judge 共用同一份配置）。
    rootEnvFile: fileURLToPath(new URL("../../.env", import.meta.url)),
  });
  const systemPrompt = await readFile(
    fileURLToPath(new URL("../prompts/requirements-agent.md", import.meta.url)),
    "utf8",
  );
  const store = createDraftStore();
  const tool = createRequirementsTool(store);
  const out = (text: string) => process.stdout.write(text);
  const agent = await createPiAgent({ gateway, systemPrompt, tool, out });

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const shutdown = () => {
    agent.dispose();
    process.stdout.write("\n已退出（未生成需求文档）。\n");
  };
  process.once("SIGINT", () => {
    void agent.abort();
    shutdown();
    process.exit(0);
  });

  try {
    await runConversation({
      agent,
      store,
      input: assembleInputLines(rl),
      out,
      baseDir: process.cwd(),
    });
    return 0;
  } finally {
    rl.close();
    agent.dispose();
  }
}

interface PiAgentOptions {
  gateway: GatewayEnv;
  systemPrompt: string;
  tool: ReturnType<typeof createRequirementsTool>;
  out: (text: string) => void;
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

async function createPiAgent(options: PiAgentOptions): Promise<ChatAgent> {
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
    const model = modelRegistry.find(PROVIDER, options.gateway.model);
    if (!model) throw new Error(`网关模型未注册：${options.gateway.model}`);
    const tool = options.tool as ToolDefinition;
    const { session, modelFallbackMessage } = await createAgentSession({
      cwd: process.cwd(),
      agentDir,
      authStorage,
      modelRegistry,
      model,
      settingsManager,
      resourceLoader,
      sessionManager: SessionManager.inMemory(),
      noTools: "builtin",
      tools: [tool.name],
      customTools: [tool],
    });
    if (modelFallbackMessage) {
      session.dispose();
      throw new Error(modelFallbackMessage);
    }

    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        options.out(event.assistantMessageEvent.delta);
      }
      if (event.type === "tool_execution_start" && event.toolName === tool.name) {
        options.out("\n[正在更新需求草案…]\n");
      }
    });

    return {
      send: (text) => runPiTurn(session, text),
      async abort() {
        try {
          await session.abort();
        } catch {
          // 退出路径上的取消失败不阻止关闭。
        }
      },
      dispose() {
        unsubscribe();
        session.dispose();
        void rm(agentDir, { recursive: true, force: true }).catch(() => {});
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
