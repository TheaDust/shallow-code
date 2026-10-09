import { FEATURE_GROUPING_SCHEMA, type FeatureGrouper, type FeatureGroupingOptions } from "./feature-grouper.js";
import { PlannerJsonClient, PlannerRequestError, extractJsonPayload, type PlannerJsonConfig } from "./planner-json-client.js";
import { loadPrompt } from "./prompt-assets.js";
import { DEFAULT_FEATURE_GROUP_THRESHOLDS, featureGroupPackets, requirementTextChars } from "./scheduler.js";
import type { RequirementCatalog } from "./types.js";

export class LlmFeatureGrouper implements FeatureGrouper {
  private readonly client: PlannerJsonClient;
  constructor(private readonly config: PlannerJsonConfig, fetchFn: typeof fetch = globalThis.fetch) {
    this.client = new PlannerJsonClient(config, fetchFn, "Feature grouper");
  }

  async group(catalog: RequirementCatalog, options: FeatureGroupingOptions): Promise<unknown> {
    const ancestors = new Map(catalog.requirements.flatMap(requirement => requirement.ancestors)
      .map(ancestor => [ancestor.id, ancestor]));
    const requirements = catalog.requirements.map(requirement => ({
      id: requirement.id, name: requirement.name,
      moduleId: requirement.folderPath[1] ?? requirement.id,
      folderPath: requirement.folderPath, dependencyIds: requirement.dependencyIds,
      externalDependencyIds: requirement.externalDependencyIds ?? [],
      text: requirement.text, scenarioCount: requirement.scenarios.length,
      textChars: requirementTextChars(requirement),
    }));
    const modules = new Map<string, string[]>();
    for (const requirement of requirements) {
      const ids = modules.get(requirement.moduleId) ?? [];
      ids.push(requirement.id);
      modules.set(requirement.moduleId, ids);
    }
    const content = await this.client.complete([
      { role: "system", content: loadPrompt("planning", "feature-grouping") },
      { role: "user", content: JSON.stringify({
        limits: DEFAULT_FEATURE_GROUP_THRESHOLDS,
        product: catalog.requirements[0]?.product,
        ancestors: [...ancestors.values()],
        modules: [...modules].map(([moduleId, requirementIds]) => ({ moduleId, requirementIds })),
        referenceGroups: featureGroupPackets(catalog).packets.map(packet => packet.requirementIds),
        scenarioInput: "本次省略场景正文；容量仍用原始场景计数。需求描述完整提供。",
        requirements,
        ...(options.feedback ? { previousAttempt: options.feedback,
          instruction: "根据上次错误重新返回完整分组。保留全部需求且只输出 ID 与简短目的，省略额外解释。" } : {}),
      }) },
    ], FEATURE_GROUPING_SCHEMA, { ...options, maxTokens: options.feedback?.cutOffByModel ? 131_072 : 65_536 });
    try { return JSON.parse(extractJsonPayload(content)) as unknown; }
    catch (error) {
      throw new PlannerRequestError("json", "Feature grouper content is not JSON", { cause: error, apiKey: this.config.apiKey });
    }
  }
}
