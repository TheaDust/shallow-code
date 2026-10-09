/**
 * In-process gateway provider descriptor. The context window is the only
 * per-run tunable. Mainline packets are deliberately bounded so long tool
 * histories are compacted before they dominate token cost; the raw baseline
 * pins its own larger single-session window.
 */
export const DEFAULT_CONTEXT_WINDOW = 256_000;

export function piProviderModel(model: string, contextWindow: number = DEFAULT_CONTEXT_WINDOW) {
  return {
    id: model, name: model, reasoning: true, input: ["text", "image"] as ("text" | "image")[],
    contextWindow, maxTokens: 65_536,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false,
      maxTokensField: "max_tokens" as const, supportsStrictMode: false, requiresReasoningContentOnAssistantMessages: true },
  };
}
