import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager,
  type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { FEATURE_GROUPING_SCHEMA, type FeatureGrouper, type FeatureGroupingOptions } from "./feature-grouper.js";
import { validateGrouping } from "./feature-grouping-tools.js";
import { piProviderModel } from "./builder/pi-model-config.js";
import { createPiGateway, piGatewaySettings } from "./pi-gateway.js";
import { GatewayRecovery } from "./gateway-recovery.js";
import { opencodeSessionHeaders } from "./gateway-headers.js";
import { loadPrompt } from "./prompt-assets.js";
import { DEFAULT_FEATURE_GROUP_THRESHOLDS, featureGroupPackets, requirementTextChars } from "./scheduler.js";
import { requirementScenarioFacts } from "./requirement-analysis.js";
import type { GatewayConfig } from "./runtime-config.js";
import type { ModelRates } from "./model-usage.js";
import type { RequirementCatalog } from "./types.js";

const MAX_AGENT_TURNS = 6;
const CONTINUE = "沿用当前需求、分组方案和工具反馈继续规划。需要修订时调用 validate_grouping，确认已校验的方案后调用 finish 提交。";

/** Restricted Pi session; its files and tools remain outside the application workspace. */
export class PiFeatureGrouper implements FeatureGrouper {
  private readonly recovery: GatewayRecovery;
  constructor(private readonly config: {
    gateway: GatewayConfig;
    sessionDir: string;
    modelCost?: ModelRates;
    recovery?: GatewayRecovery;
  }) { this.recovery = config.recovery ?? new GatewayRecovery(); }

  async group(catalog: RequirementCatalog, options: FeatureGroupingOptions): Promise<unknown> {
    options.signal?.throwIfAborted();
    const deadlineAt = Date.now() + options.timeoutMs;
    const timeout = Number.isFinite(options.timeoutMs)
      ? AbortSignal.timeout(Math.max(1, Math.min(2_147_483_647, Math.floor(options.timeoutMs)))) : undefined;
    const signal = timeout && options.signal ? AbortSignal.any([timeout, options.signal])
      : timeout ?? options.signal ?? new AbortController().signal;
    const assertActive = () => {
      signal.throwIfAborted();
      if (Date.now() >= deadlineAt) throw new Error("Planner deadline exhausted");
    };
    assertActive();
    const cwd = join(this.config.sessionDir, randomUUID());
    const agentDir = join(cwd, "config");
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    const { gateway, modelCost } = this.config;
    runtime.registerProvider("planner-gateway", { baseUrl: gateway.baseUrl, api: "openai-completions", apiKey: "PLANNER_RUNTIME_CREDENTIAL",
      models: [piProviderModel(gateway.model, undefined, opencodeSessionHeaders(gateway.baseUrl, randomUUID()), modelCost)] });
    await runtime.setRuntimeApiKey("planner-gateway", gateway.apiKey);
    const settingsManager = piGatewaySettings(deadlineAt - Date.now());
    const resources = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true,
      disabledBuiltinExtensions: ["mcp"], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: loadPrompt("planning", "feature-grouping") });
    await resources.reload();
    let turns = 0;
    let validated: { key: string; turn: number } | undefined;
    let proposal: unknown;
    const tools: ToolDefinition[] = [
      { name: "validate_grouping", label: "Validate grouping", description: "校验完整候选，并观察容量、跨组依赖、相邻组合并可行性及模块往返。",
        parameters: Type.Object({ grouping: Type.Unsafe(FEATURE_GROUPING_SCHEMA) }), executionMode: "sequential",
        async execute(_id, input) {
          assertActive();
          if (proposal !== undefined) throw new Error("Planner already finished");
          try {
            const candidate = (input as { grouping: unknown }).grouping;
            const result = validateGrouping(catalog, candidate);
            validated = { key: groupingKey(candidate), turn: turns };
            return toolResult({ ...result, turnsRemaining: MAX_AGENT_TURNS - turns });
          } catch (error) { return toolResult({ valid: false, error: error instanceof Error ? error.message : String(error),
            turnsRemaining: MAX_AGENT_TURNS - turns }); }
        } },
      { name: "finish", label: "Submit grouping", description: "提交已读取校验反馈的最终完整分组；成员、顺序和目的必须与已校验候选一致。",
        parameters: Type.Unsafe(FEATURE_GROUPING_SCHEMA), executionMode: "sequential",
        async execute(_id, input) {
          assertActive();
          if (proposal !== undefined) throw new Error("Planner already finished");
          validateGrouping(catalog, input);
          if (!validated || validated.key !== groupingKey(input) || validated.turn >= turns) {
            throw new Error("Call validate_grouping for this exact proposal, then read its feedback in a subsequent turn before finish");
          }
          proposal = input;
          return toolResult({ accepted: true });
        } },
    ];
    const { session, modelFallbackMessage } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime,
      model: runtime.getModel("planner-gateway", gateway.model), settingsManager, resourceLoader: resources,
      sessionManager: SessionManager.create(cwd, cwd), noTools: "builtin", tools: tools.map(tool => tool.name), customTools: tools });
    if (modelFallbackMessage) { session.dispose(); throw new Error(modelFallbackMessage); }
    const finishTurn = session.agent.finishTurn;
    session.agent.finishTurn = async (turn, abortSignal) => {
      const decision = await finishTurn?.(turn, abortSignal);
      if (proposal !== undefined || turns >= MAX_AGENT_TURNS) return { action: "end" };
      if (decision) return decision;
      return undefined;
    };
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
    const unsubscribe = session.subscribe(event => {
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      const message = event.message;
      for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) usage[field] += message.usage[field];
      usage.cost += message.usage.cost?.total ?? 0;
      if (!["error", "aborted", "length"].includes(message.stopReason)) turns++;
    });
    const transport = createPiGateway(gateway.baseUrl);
    let prompt = groupingPrompt(catalog, options);
    try {
      await this.recovery.run("planning", "feature-grouping", () => Math.max(0, deadlineAt - Date.now()),
        async () => {
          while (proposal === undefined && turns < MAX_AGENT_TURNS) {
            assertActive();
            const nextPrompt = prompt;
            prompt = CONTINUE;
            await transport.prompt(session, nextPrompt, { signal });
            assertActive();
          }
          if (proposal === undefined) throw new Error(`Planner did not finish a validated grouping within ${MAX_AGENT_TURNS} turns`);
        }, signal);
      return proposal;
    } finally {
      await session.abort();
      await session.waitForIdle();
      unsubscribe();
      session.dispose();
      transport.dispose();
      usage.total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
      if (usage.total > 0 && options.onUsage) {
        try { await options.onUsage({ input: usage.input, output: usage.output, cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite, total: usage.total, ...(modelCost ? { cost: usage.cost } : {}) }); }
        catch { /* Usage diagnostics cannot change the grouping decision. */ }
      }
    }
  }
}

function toolResult(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value }; }

/** Called only after the Catalog validator has accepted the proposal. */
function groupingKey(proposal: unknown): string {
  return JSON.stringify((proposal as { groups: Array<{ requirementIds: string[]; purpose: string }> }).groups
    .map(({ requirementIds, purpose }) => ({ requirementIds, purpose })));
}

function groupingPrompt(catalog: RequirementCatalog, options: FeatureGroupingOptions): string {
  const ancestors = new Map(catalog.requirements.flatMap(requirement => requirement.ancestors).map(ancestor => [ancestor.id, ancestor]));
  const requirements = catalog.requirements.map(requirement => ({
    id: requirement.id, name: requirement.name, moduleId: requirement.folderPath[1] ?? requirement.id,
    folderPath: requirement.folderPath, dependencyIds: requirement.dependencyIds,
    externalDependencyIds: requirement.externalDependencyIds ?? [], text: requirement.text,
    scenarioCount: requirement.scenarios.length, scenarioFacts: requirementScenarioFacts(requirement), textChars: requirementTextChars(requirement),
  }));
  const modules = new Map<string, string[]>();
  for (const requirement of requirements) {
    const ids = modules.get(requirement.moduleId) ?? [];
    ids.push(requirement.id); modules.set(requirement.moduleId, ids);
  }
  return JSON.stringify({ limits: DEFAULT_FEATURE_GROUP_THRESHOLDS, product: catalog.requirements[0]?.product,
    ancestors: [...ancestors.values()], modules: [...modules].map(([moduleId, requirementIds]) => ({ moduleId, requirementIds })),
    referenceGroups: featureGroupPackets(catalog).packets.map(packet => packet.requirementIds), agentBudget: { maxTurns: MAX_AGENT_TURNS },
    scenarioInput: "scenarioFacts 按 GIVEN/WHEN/THEN 阶段保留原文摘录与全部来源；重复原文只在同一阶段合并。容量仍用原始场景计数与完整文本长度。",
    requirements, ...(options.feedback ? { previousAttempt: options.feedback } : {}) });
}
