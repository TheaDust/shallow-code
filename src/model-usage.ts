import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";

/**
 * 模型单价与用量统计。
 *
 * 单价默认来自 `@earendil-works/pi-ai` 内置的模型目录（与 opencode 展示花费
 * 使用的元数据同源），按网关 baseUrl 与模型 id 匹配；`MODEL_COST_*` 或
 * `<组件>_COST_*` 环境变量按字段覆盖，未匹配到价格时只统计 token。
 * 单价单位为 USD / 百万 token。
 */

export interface ModelRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 已知价格时由调用方换算；缺失表示价格未知。 */
  cost?: number;
  /** 已统计 token 中尚未计价的部分；用于合并部分已知的费用。 */
  unpricedTokens?: number;
}

export interface UsageSummary extends TokenUsage {
  total: number;
}

export interface ModelUsageSummary extends UsageSummary {
  builder: UsageSummary;
  checker: UsageSummary;
}

const COST_FIELDS = [
  ["input", "INPUT"],
  ["output", "OUTPUT"],
  ["cacheRead", "CACHE_READ"],
  ["cacheWrite", "CACHE_WRITE"],
] as const;

/**
 * 解析单价：组件环境变量优先、`MODEL_COST_*` 兜底，未覆盖的字段回退内置目录。
 * 三者都没有时返回 null（只统计 token）。
 */
export function resolveModelRates(
  baseUrl: string,
  model: string,
  options: { component?: string; env?: Record<string, string | undefined> } = {},
): ModelRates | null {
  const env = options.env ?? process.env;
  const override = envRates(env, options.component);
  const catalog = catalogRates(baseUrl, model);
  if (!override && !catalog) return null;
  const rates = {
    input: override?.input ?? catalog?.input,
    output: override?.output ?? catalog?.output,
    cacheRead: override?.cacheRead ?? catalog?.cacheRead,
    cacheWrite: override?.cacheWrite ?? catalog?.cacheWrite,
  };
  // 目录缺失时不能将未填写的价格当作免费；免费项应显式设为 0。
  return Object.values(rates).some(rate => rate === undefined) ? null : rates as ModelRates;
}

export function usageCost(usage: TokenUsage, rates: ModelRates): number {
  return (usage.input * rates.input + usage.output * rates.output +
    usage.cacheRead * rates.cacheRead + usage.cacheWrite * rates.cacheWrite) / 1_000_000;
}

/** 累加一次或多次模型调用的 token 与费用；费用只在有价格数据时出现。 */
export class UsageTotals {
  private input = 0;
  private output = 0;
  private cacheRead = 0;
  private cacheWrite = 0;
  private cost = 0;
  private costKnown = false;
  private unpricedTokens = 0;
  private calls = 0;

  add(usage: TokenUsage): void {
    const counts = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
    if (counts.some((value) => !Number.isFinite(value) || value < 0)) return;
    this.input += usage.input;
    this.output += usage.output;
    this.cacheRead += usage.cacheRead;
    this.cacheWrite += usage.cacheWrite;
    const priced = typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0;
    if (priced) {
      this.cost += usage.cost!;
      this.costKnown = true;
    }
    this.unpricedTokens += usage.unpricedTokens ?? (priced ? 0 : counts.reduce((sum, count) => sum + count, 0));
    this.calls += 1;
  }

  /** 已记录的有效调用次数；0 表示尚无用量。 */
  get count(): number {
    return this.calls;
  }

  summary(): UsageSummary {
    return {
      input: this.input, output: this.output, cacheRead: this.cacheRead, cacheWrite: this.cacheWrite,
      total: this.input + this.output + this.cacheRead + this.cacheWrite,
      ...(this.costKnown ? { cost: this.cost } : {}),
      ...(this.unpricedTokens > 0 ? { unpricedTokens: this.unpricedTokens } : {}),
    };
  }
}

/** 按实际调用来源分组；总计由各分组汇总，避免独立累计产生偏差。 */
export class ModelUsageTotals {
  private readonly builder = new UsageTotals();
  private readonly checker = new UsageTotals();

  add(source: "builder" | "checker", usage: TokenUsage): void {
    this[source].add(usage);
  }

  /** 展示时可合入当前 Builder 快照；不改变已经结算的用量。 */
  summary(builderProgress?: TokenUsage): ModelUsageSummary {
    const builder = new UsageTotals();
    builder.add(this.builder.summary());
    if (builderProgress) builder.add(builderProgress);
    const builderSummary = builder.summary();
    const checker = this.checker.summary();
    const total = new UsageTotals();
    total.add(builderSummary);
    total.add(checker);
    return { ...total.summary(), builder: builderSummary, checker };
  }
}

/** `12345` → `12.3k`；供终端一行内展示用量。 */
export function formatTokenCount(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(Math.round(count));
}

/** 小额费用保留更多小数位并去掉尾随零，避免长任务显示成 `$0.00`。 */
export function formatCostUsd(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return "$0";
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  const fixed = (cost >= 0.01 ? cost.toFixed(4) : cost.toFixed(6))
    .replace(/0+$/, "").replace(/\.$/, "");
  return `$${fixed}`;
}

/** 统一的一行用量文本：`tokens 12.3k（入 10.0k / 出 2.0k）· 费用 $0.0037`。 */
export function formatUsageSummary(usage: UsageSummary): string {
  const parts = [`入 ${formatTokenCount(usage.input)}`, `出 ${formatTokenCount(usage.output)}`];
  if (usage.cacheRead > 0) parts.push(`缓存读 ${formatTokenCount(usage.cacheRead)}`);
  if (usage.cacheWrite > 0) parts.push(`缓存写 ${formatTokenCount(usage.cacheWrite)}`);
  const cost = usage.cost === undefined ? " · 费用未知"
    : usage.unpricedTokens ? ` · 已知费用 ${formatCostUsd(usage.cost)}（部分未计价）`
    : ` · 费用 ${formatCostUsd(usage.cost)}`;
  return `tokens ${formatTokenCount(usage.total)}（${parts.join(" / ")}）${cost}`;
}

export function formatModelUsageSummary(usage: ModelUsageSummary): string[] {
  const rows: Array<[string, UsageSummary]> = [["总计", usage], ["Builder", usage.builder], ["Checker", usage.checker]];
  return rows.map(([label, summary]) => `${label}  ${formatUsageSummary(summary)}`);
}

/** OpenAI 兼容网关的用量：输入不含缓存 token，总量为各分项之和。 */
export function parseOpenAIUsage(raw: unknown): UsageSummary | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const usage = raw as Record<string, unknown>;
  const details = typeof usage.prompt_tokens_details === "object" && usage.prompt_tokens_details !== null
    ? usage.prompt_tokens_details as Record<string, unknown> : undefined;
  const finite = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const reported = [usage.prompt_tokens, usage.completion_tokens, details?.cached_tokens,
    usage.prompt_cache_hit_tokens, details?.cache_write_tokens];
  if (!reported.some(value => finite(value) !== undefined)) return undefined;
  const promptTokens = finite(usage.prompt_tokens) ?? 0;
  const reportedCached = finite(details?.cached_tokens) ?? finite(usage.prompt_cache_hit_tokens) ?? 0;
  const cacheWrite = Math.max(0, finite(details?.cache_write_tokens) ?? 0);
  // 部分网关将缓存读与本次缓存写同时计入 cached_tokens。
  const cacheRead = Math.max(0, reportedCached - cacheWrite);
  const output = Math.max(0, finite(usage.completion_tokens) ?? 0);
  const input = Math.max(0, promptTokens - cacheRead - cacheWrite);
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

function envRates(
  env: Record<string, string | undefined>,
  component: string | undefined,
): Partial<ModelRates> | null {
  let present = false;
  const rates: Partial<ModelRates> = {};
  for (const [field, suffix] of COST_FIELDS) {
    const scopedName = component ? `${component}_COST_${suffix}` : undefined;
    const scoped = scopedName ? env[scopedName]?.trim() : undefined;
    const common = env[`MODEL_COST_${suffix}`]?.trim();
    const raw = scoped || common;
    if (!raw) continue;
    present = true;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${scoped ? scopedName : `MODEL_COST_${suffix}`} must be a non-negative number (USD per million tokens), got "${raw}"`);
    }
    rates[field] = value;
  }
  return present ? rates : null;
}

let catalogByGateway: Map<string, ModelRates> | undefined;
let catalogById: Map<string, ModelRates[]> | undefined;

function catalogRates(baseUrl: string, model: string): ModelRates | null {
  buildCatalog();
  const exact = catalogByGateway!.get(`${normalizeBaseUrl(baseUrl)}\n${model}`);
  if (exact) return exact;
  const candidates = catalogById!.get(model);
  if (!candidates?.length) return null;
  // 同一模型 id 出现在多个网关时只接受一致的标价，避免猜错价格。
  const first = JSON.stringify(candidates[0]);
  return candidates.every(rates => JSON.stringify(rates) === first) ? candidates[0] : null;
}

function buildCatalog(): void {
  if (catalogByGateway) return;
  catalogByGateway = new Map();
  catalogById = new Map();
  for (const provider of getBuiltinProviders()) {
    for (const model of getBuiltinModels(provider)) {
      const rates = ratesOf(model.cost);
      if (!rates) continue;
      catalogByGateway.set(`${normalizeBaseUrl(model.baseUrl)}\n${model.id}`, rates);
      const candidates = catalogById.get(model.id) ?? [];
      candidates.push(rates);
      catalogById.set(model.id, candidates);
    }
  }
}

function ratesOf(cost: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined): ModelRates | null {
  if (!cost) return null;
  const rates = { input: cost.input, output: cost.output, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite };
  return Object.values(rates).every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)
    ? rates : null;
}

function normalizeBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).href.replace(/\/+$/, "");
  } catch {
    return baseUrl.trim().replace(/\/+$/, "");
  }
}
