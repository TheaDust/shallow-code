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
  type ChatTurnResult,
} from "./cli.js";
import { loadGatewayEnv, type GatewayEnv } from "./env.js";

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

function piProviderModel(model: string, contextWindow: number = DEFAULT_CONTEXT_WINDOW) {
  return {
    id: model,
    name: model,
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    contextWindow,
    maxTokens: 65_536,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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

interface PiAgentOptions {
  gateway: GatewayEnv;
  systemPrompt: string;
  tool: ReturnType<typeof createRequirementsTool>;
  out: (text: string) => void;
}

async function createPiAgent(options: PiAgentOptions): Promise<ChatAgent> {
  const agentDir = join(tmpdir(), `requirements-agent-${process.pid}`);
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  try {
    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(PROVIDER, options.gateway.apiKey);
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    modelRegistry.registerProvider(PROVIDER, {
      baseUrl: options.gateway.baseUrl,
      api: "openai-completions",
      apiKey: "REQUIREMENTS_RUNTIME_CREDENTIAL",
      models: [piProviderModel(options.gateway.model)],
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
      async send(text: string): Promise<ChatTurnResult> {
        let promptError: unknown;
        try {
          await session.prompt(text, { expandPromptTemplates: false });
        } catch (error) {
          promptError = error;
        }
        // prompt 已等待完整回合；这里兜底等待自动重试与压缩真正结束。
        for (let attempt = 0; attempt < 600; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          try {
            await session.agent.waitForIdle();
          } catch {
            // 忽略空闲等待错误，以消息状态为准。
          }
          if (!session.isCompacting && !session.isRetrying && !session.isStreaming) break;
        }
        if (promptError) {
          return { ok: false, error: String(promptError) };
        }
        const last = session.messages.at(-1);
        if (!last || last.role !== "assistant") {
          return { ok: false, error: "模型没有返回结果" };
        }
        if (last.stopReason === "error") {
          return { ok: false, error: last.errorMessage ?? "模型返回错误" };
        }
        return { ok: true };
      },
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
