import assert from "node:assert/strict";
import { test } from "node:test";

import {
  UsageTotals,
  ModelUsageTotals,
  formatCostUsd,
  formatModelUsageSummary,
  formatTokenCount,
  formatUsageSummary,
  resolveModelRates,
  usageCost,
} from "../src/model-usage.js";

const GATEWAY = "https://opencode.ai/zen/go/v1";
const MODEL = "deepseek-v4.1-flash";

test("Model rates resolve from the built-in catalog by gateway and model id", () => {
  const rates = resolveModelRates(GATEWAY, MODEL, { env: {} });
  assert.deepEqual(rates, { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 });
  // 结尾斜杠不影响匹配；目录未收录的模型与网关返回 null（只统计 token）。
  assert.deepEqual(resolveModelRates(`${GATEWAY}/`, MODEL, { env: {} }), rates);
  assert.equal(resolveModelRates("https://gateway.example.com/v1", "provider/unknown-model", { env: {} }), null);
});

test("Cost overrides fall back field by field and win over the catalog", () => {
  const scoped = resolveModelRates(GATEWAY, MODEL, {
    component: "SHALLOW_BUILDER", env: { SHALLOW_BUILDER_COST_OUTPUT: "9" },
  });
  assert.deepEqual(scoped, { input: 0.15, output: 9, cacheRead: 0.003, cacheWrite: 0 });
  const common = resolveModelRates(GATEWAY, MODEL, {
    env: { MODEL_COST_INPUT: "1.5", MODEL_COST_CACHE_WRITE: "2" },
  });
  assert.deepEqual(common, { input: 1.5, output: 0.6, cacheRead: 0.003, cacheWrite: 2 });
  // 目录未收录时需完整配置，免费项显式填 0。
  const custom = resolveModelRates("https://gateway.example.com/v1", "custom/model", {
    env: { MODEL_COST_INPUT: "1", MODEL_COST_OUTPUT: "2", MODEL_COST_CACHE_READ: "0", MODEL_COST_CACHE_WRITE: "0" },
  });
  assert.deepEqual(custom, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
  assert.equal(resolveModelRates("https://gateway.example.com/v1", "custom/model", {
    env: { MODEL_COST_INPUT: "1", MODEL_COST_OUTPUT: "2" },
  }), null, "未填写的缓存价格保持未知，不能按免费计价");
  assert.throws(() => resolveModelRates(GATEWAY, MODEL, { env: { MODEL_COST_INPUT: "abc" } }), /MODEL_COST_INPUT/);
});

test("Usage cost converts per-million rates and totals keep unknown prices out", () => {
  const rates = resolveModelRates(GATEWAY, MODEL, { env: {} })!;
  assert.equal(usageCost({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, rates), 0.15);
  assert.equal(usageCost({ input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }, rates), 0.6);
  const totals = new UsageTotals();
  totals.add({ input: 1000, output: 200, cacheRead: 100, cacheWrite: 0, cost: 0.001 });
  totals.add({ input: 500, output: 100, cacheRead: 0, cacheWrite: 0 });
  assert.equal(totals.count, 2);
  assert.deepEqual(totals.summary(), { input: 1500, output: 300, cacheRead: 100, cacheWrite: 0, total: 1900, cost: 0.001, unpricedTokens: 600 });
  const unknown = new UsageTotals();
  unknown.add({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(unknown.summary(), { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, unpricedTokens: 15 });
  // 非法数值不进入统计。
  unknown.add({ input: -1, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(unknown.count, 1);
});

test("Model totals separate Builder, Judge and Checker, preserve partial prices and include progress without settling it", () => {
  const totals = new ModelUsageTotals();
  totals.add("builder", { input: 100, output: 20, cacheRead: 10, cacheWrite: 5, cost: 0.002 });
  totals.add("judge", { input: 50, output: 5, cacheRead: 0, cacheWrite: 0 });
  totals.add("checker", { input: 30, output: 3, cacheRead: 0, cacheWrite: 0 });
  const settled = totals.summary();
  assert.deepEqual(settled.builder, { input: 100, output: 20, cacheRead: 10, cacheWrite: 5, total: 135, cost: 0.002 });
  assert.deepEqual(settled.judge, { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, total: 55, unpricedTokens: 55 });
  assert.deepEqual(settled.checker, { input: 30, output: 3, cacheRead: 0, cacheWrite: 0, total: 33, unpricedTokens: 33 });
  assert.equal(settled.total, settled.builder.total + settled.judge.total + settled.checker.total);
  assert.equal(settled.cost, 0.002);
  assert.equal(settled.unpricedTokens, 88);
  assert.match(formatUsageSummary(settled), /已知费用 \$0\.002（部分未计价）/);
  assert.ok(formatModelUsageSummary(settled).some(line => /^Checker\s+tokens 33/.test(line)), "Checker 用量单独成行");
  const zero = new ModelUsageTotals();
  zero.add("judge", { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 });
  assert.ok(!formatModelUsageSummary(zero.summary()).some(line => line.startsWith("Checker")), "零用量的 Checker 不占一行");
  const live = totals.summary({ input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0 });
  assert.equal(live.builder.total, 147);
  assert.equal(live.total, 235);
  assert.equal(live.unpricedTokens, 88);
  assert.deepEqual(totals.summary(), settled, "显示实时快照不会重复累计用量");
});

test("Unpriced usage stays unknown and a known zero price is distinct from an unknown price", () => {
  const totals = new ModelUsageTotals();
  totals.add("judge", { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 });
  assert.match(formatUsageSummary(totals.summary()), /费用未知$/);
  assert.equal(totals.summary().cost, undefined);
  const free = new UsageTotals();
  free.add({ input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0 });
  assert.match(formatUsageSummary(free.summary()), /费用 \$0$/);
  assert.equal(free.summary().unpricedTokens, undefined);
});

test("Usage formatting stays readable for tiny and large numbers", () => {
  assert.equal(formatTokenCount(0), "0");
  assert.equal(formatTokenCount(999), "999");
  assert.equal(formatTokenCount(12_345), "12.3k");
  assert.equal(formatTokenCount(2_500_000), "2.50M");
  assert.equal(formatCostUsd(0), "$0");
  assert.equal(formatCostUsd(2.5), "$2.50");
  assert.equal(formatCostUsd(0.1234), "$0.1234");
  assert.equal(formatCostUsd(0.0021), "$0.0021");
  assert.equal(formatCostUsd(0.000123), "$0.000123");
  assert.equal(
    formatUsageSummary({ input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, total: 1200, cost: 0.000456 }),
    "tokens 1.2k（入 1.0k / 出 200） · 费用 $0.000456",
  );
});
