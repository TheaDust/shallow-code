import type { ModelRates } from "../model-usage.js";

/**
 * In-process gateway provider descriptor. The context window is the only
 * per-run tunable. Mainline packets are deliberately bounded so long tool
 * histories are compacted before they dominate token cost; the raw baseline
 * pins its own larger single-session window. Cost rates (USD per million
 * tokens) come from the controller's price resolution so the SDK can report
 * per-session spend; an unset price keeps the historical zero rates.
 */
export const DEFAULT_CONTEXT_WINDOW = 256_000;

export function piProviderModel(model: string, contextWindow: number = DEFAULT_CONTEXT_WINDOW,
  headers?: Record<string, string>, cost?: ModelRates | null) {
  return {
    id: model, name: model, reasoning: true, input: ["text", "image"] as ("text" | "image")[],
    contextWindow, maxTokens: 65_536,
    cost: cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(headers && Object.keys(headers).length ? { headers } : {}),
    compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false,
      maxTokensField: "max_tokens" as const, supportsStrictMode: false, requiresReasoningContentOnAssistantMessages: true },
  };
}
