import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { JSONReport, JSONReportSuite } from "@playwright/test/reporter";
import { normalizeArcRequirements } from "./requirements.js";
import { digest, snapshotFiles } from "../run-record.js";
import { formatCostUsd, type UsageSummary } from "../model-usage.js";
import type { ArcBaselineSpec } from "./arc-baseline.js";

export const REPOSITORY = fileURLToPath(new URL("../../", import.meta.url));
export const METHODS = ["baseline", "arc", "shallow"] as const;
export type Method = typeof METHODS[number];
export const DEFAULT_METHODS: readonly Method[] = ["baseline", "shallow"];

export interface ArcTask {
  id: string;
  requirementsDir: string;
  testsDir: string;
  requirementFiles: Record<string, string>;
  testFiles: Record<string, string>;
  normalizedRequirementsDigest: string;
  requirements: number;
  scenarios: number;
}

export interface ExperimentPlan {
  version: 1;
  benchRoot: string;
  outputDir: string;
  setupScript: string;
  setupDigest: string;
  codeDigest: string;
  nodeVersion: string;
  playwrightVersion: string;
  settings: Record<string, string | undefined>;
  repeats: number;
  /** Selected methods; absent in manifests written before method filtering. */
  methods?: Method[];
  arc?: ArcBaselineSpec;
  concurrency: number;
  /** null means no experiment-level wall deadline; internal stage limits still apply. */
  generationTimeoutMs: number | null;
  evaluationTimeoutMs: number | null;
  tasks: ArcTask[];
  cells: Array<{ task: string; repeat: number; method: Method }>;
}

export interface TestEntry { id: string; title: string; status: string }
export interface Score {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  notRun: number;
  passRate: number;
  errors: string[];
}

export interface CellResult {
  task: string;
  repeat: number;
  method: Method;
  generation: { status: string; exitCode: number | null; durationMs: number | null;
    modelUsage: UsageSummary | null; usageComplete: boolean; error?: string };
  evaluation: { status: string; durationMs: number; score: Score; directory: string; error?: string };
  finalDigest: string;
}

export function inside(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\"));
}

/** Persist paths relative to the experiment directory; cross-drive paths keep their absolute form. */
export function storedPath(base: string, target: string): string {
  if (!isAbsolute(target)) return target.replaceAll("\\", "/");
  const path = relative(resolve(base), resolve(target));
  return (isAbsolute(path) ? target : path || ".").replaceAll("\\", "/");
}

export function resolveStoredPath(base: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(base, value);
}

export function serializePlan(plan: ExperimentPlan, base: string): ExperimentPlan {
  const path = (value: string) => storedPath(base, value);
  return { ...plan, benchRoot: path(plan.benchRoot), outputDir: path(plan.outputDir), setupScript: path(plan.setupScript),
    ...(plan.arc ? { arc: { ...plan.arc, root: path(plan.arc.root), python: path(plan.arc.python) } } : {}),
    tasks: plan.tasks.map(task => ({ ...task, requirementsDir: path(task.requirementsDir), testsDir: path(task.testsDir) })) };
}

export function deserializePlan(plan: ExperimentPlan, base: string): ExperimentPlan {
  const path = (value: string) => resolveStoredPath(base, value);
  return { ...plan, benchRoot: path(plan.benchRoot), outputDir: path(plan.outputDir), setupScript: path(plan.setupScript),
    ...(plan.arc ? { arc: { ...plan.arc, root: path(plan.arc.root), python: path(plan.arc.python) } } : {}),
    tasks: plan.tasks.map(task => ({ ...task, requirementsDir: path(task.requirementsDir), testsDir: path(task.testsDir) })) };
}

export function serializeResult(result: CellResult, base: string): CellResult {
  return { ...result, evaluation: { ...result.evaluation, directory: storedPath(base, result.evaluation.directory) } };
}

export function deserializeResult(result: CellResult, base: string): CellResult {
  return { ...result, evaluation: { ...result.evaluation, directory: resolveStoredPath(base, result.evaluation.directory) } };
}

export async function discoverArcTasks(benchRoot: string): Promise<ArcTask[]> {
  const root = join(resolve(benchRoot), "arc-bench");
  const tasks: ArcTask[] = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const requirementsDir = join(root, entry.name, "requirements"), testsDir = join(root, entry.name, "tests");
    const normalized = normalizeArcRequirements(await readFile(join(requirementsDir, "requirements.yaml"), "utf8"));
    const requirementFiles = await snapshotFiles(requirementsDir);
    for (const image of normalized.sourceMap?.images ?? []) {
      const target = resolve(requirementsDir, image.reference.replaceAll("\\", "/"));
      const path = relative(requirementsDir, target).replaceAll("\\", "/");
      if (win32.isAbsolute(image.reference) || !inside(requirementsDir, target) || !(path in requirementFiles)) {
        throw new Error(`ARC image must name a bundled requirement file: ${entry.name}/${image.reference}`);
      }
    }
    tasks.push({ id: entry.name, requirementsDir, testsDir,
      requirementFiles, testFiles: await snapshotFiles(testsDir),
      normalizedRequirementsDigest: digest(normalized.yaml), requirements: normalized.requirements, scenarios: normalized.scenarios });
  }
  if (!tasks.length) throw new Error(`No ARC tasks found under ${root}`);
  return tasks;
}

export async function implementationDigest(): Promise<string> {
  const files = { src: await snapshotFiles(join(REPOSITORY, "src")), prompts: await snapshotFiles(join(REPOSITORY, "prompts")),
    index: digest(await readFile(join(REPOSITORY, "index.ts"))),
    package: digest(await readFile(join(REPOSITORY, "package.json"))),
    lock: digest(await readFile(join(REPOSITORY, "package-lock.json"))) };
  return digest(JSON.stringify(files));
}

/** Rotate methods across tasks/repeats; two-method runs retain their alternating order. */
export function planCells(tasks: readonly string[], repeats: number, methods: readonly Method[] = DEFAULT_METHODS): ExperimentPlan["cells"] {
  const selected = METHODS.filter(method => methods.includes(method));
  if (!selected.length) throw new Error("At least one method is required");
  return Array.from({ length: repeats }, (_, index) => tasks.flatMap((task, taskIndex) => {
    const offset = (index + taskIndex) % selected.length;
    return [...selected.slice(offset), ...selected.slice(0, offset)].map(method => ({ task, repeat: index + 1, method }));
  })).flat();
}

export function reportEntries(report: JSONReport): TestEntry[] {
  const visit = (suites: JSONReportSuite[]): TestEntry[] => suites.flatMap(suite => [
    ...suite.specs.flatMap(spec => spec.tests.map(test => ({
      id: JSON.stringify([spec.file.replaceAll("\\", "/"), spec.line, spec.column, spec.title, test.projectName]),
      title: spec.title, status: test.results.at(-1)?.status ?? "not_run",
    }))), ...visit(suite.suites ?? []),
  ]);
  return visit(report.suites);
}

export function scoreReport(expected: readonly TestEntry[], report?: JSONReport): Score {
  if (!expected.length || new Set(expected.map(test => test.id)).size !== expected.length) throw new Error("Invalid or empty test catalog");
  const observed = report ? reportEntries(report) : [];
  const expectedIds = new Set(expected.map(test => test.id));
  if (observed.some(test => !expectedIds.has(test.id)) || new Set(observed.map(test => test.id)).size !== observed.length) {
    throw new Error("Evaluation test identities differ from the frozen catalog");
  }
  const byId = new Map(observed.map(test => [test.id, test.status]));
  const statuses = expected.map(test => byId.get(test.id) ?? "not_run");
  const count = (value: string) => statuses.filter(status => status === value).length;
  const passed = count("passed"), skipped = count("skipped"), notRun = count("not_run") + count("interrupted");
  return { total: expected.length, passed, skipped, notRun, failed: expected.length - passed - skipped - notRun,
    passRate: passed / expected.length, errors: (report?.errors ?? []).map(error => error.message ?? String(error)) };
}

/** Cache hits are measured against prompt tokens; output tokens are not part of the denominator. */
export function cacheHitRate(usage: Pick<UsageSummary, "input" | "cacheRead" | "cacheWrite">): number | null {
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  return promptTokens > 0 ? usage.cacheRead / promptTokens : null;
}

function usageAggregate(rows: readonly CellResult[]) {
  const usages = rows.flatMap(row => row.generation.modelUsage ? [row.generation.modelUsage] : []);
  if (!usages.length) {
    return { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
      totalTokens: null, cacheHitRate: null, knownCostUsd: null };
  }
  const input = usages.reduce((sum, usage) => sum + usage.input, 0);
  const output = usages.reduce((sum, usage) => sum + usage.output, 0);
  const cacheRead = usages.reduce((sum, usage) => sum + usage.cacheRead, 0);
  const cacheWrite = usages.reduce((sum, usage) => sum + usage.cacheWrite, 0);
  const knownCosts = usages.filter(usage => usage.cost !== undefined);
  return { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite, cacheHitRate: cacheHitRate({ input, cacheRead, cacheWrite }),
    knownCostUsd: knownCosts.length ? knownCosts.reduce((sum, usage) => sum + usage.cost!, 0) : null };
}

function durationAggregate(rows: readonly CellResult[]) {
  const generationDurationMs = rows.reduce((sum, row) => sum + (row.generation.durationMs ?? 0), 0);
  const evaluationDurationMs = rows.reduce((sum, row) => sum + row.evaluation.durationMs, 0);
  const totalDurationMs = generationDurationMs + evaluationDurationMs;
  return { generationDurationMs, evaluationDurationMs, totalDurationMs,
    generationMinutes: generationDurationMs / 60_000, evaluationMinutes: evaluationDurationMs / 60_000,
    totalMinutes: totalDurationMs / 60_000 };
}

export function summarize(plan: ExperimentPlan, results: CellResult[]) {
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const selected = plan.methods ?? DEFAULT_METHODS;
  const methods = METHODS.filter(method => selected.includes(method));
  const byTask = plan.tasks.flatMap(task => methods.map(method => {
    const rows = results.filter(row => row.task === task.id && row.method === method);
    const usage = usageAggregate(rows), durations = durationAggregate(rows);
    return { task: task.id, method, completed: rows.length, planned: plan.repeats,
      passRate: rows.length === plan.repeats ? mean(rows.map(row => row.evaluation.score.passRate)) : null,
      knownCostUsd: usage.knownCostUsd, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens, totalTokens: usage.totalTokens,
      cacheHitRate: usage.cacheHitRate, ...durations };
  }));
  const byMethod = methods.map(method => {
    const rows = results.filter(row => row.method === method), tasks = byTask.filter(row => row.method === method);
    const usage = usageAggregate(rows), durations = durationAggregate(rows);
    return { method, completed: rows.length, planned: plan.tasks.length * plan.repeats,
      macroPassRate: tasks.every(task => task.passRate !== null) ? mean(tasks.map(task => task.passRate!)) : null,
      allTestsPassed: rows.filter(row => row.evaluation.status === "completed" && row.evaluation.score.passed === row.evaluation.score.total).length,
      generationFailures: rows.filter(row => !["completed", "partial"].includes(row.generation.status)).length,
      evaluationErrors: rows.filter(row => row.evaluation.status !== "completed").length,
      knownCostUsd: usage.knownCostUsd,
      missingOrPartialUsage: rows.filter(row => !row.generation.usageComplete || !row.generation.modelUsage ||
        row.generation.modelUsage.cost === undefined || Boolean(row.generation.modelUsage.unpricedTokens)).length,
      generationDurationMs: durations.generationDurationMs,
      missingGenerationDurations: rows.filter(row => row.generation.durationMs === null).length,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens, totalTokens: usage.totalTokens, cacheHitRate: usage.cacheHitRate,
      evaluationDurationMs: durations.evaluationDurationMs, totalDurationMs: durations.totalDurationMs,
      generationMinutes: durations.generationMinutes, evaluationMinutes: durations.evaluationMinutes,
      totalMinutes: durations.totalMinutes };
  });
  return { byMethod, byTask, cells: results };
}

export type ExperimentSummary = ReturnType<typeof summarize>;

const MISSING = "-";
const percent = (value: number | null) => value === null ? MISSING : `${(value * 100).toFixed(1)}%`;
const integer = (value: number | null) => value === null ? MISSING : value.toLocaleString("en-US");
const minutes = (value: number | null) => value === null ? MISSING : value.toFixed(1);
const cost = (value: number | null) => value === null ? MISSING : formatCostUsd(value);

function usageState(completed: number, missing: number): string {
  if (!completed) return MISSING;
  return missing ? `部分缺失 (${missing})` : "完整";
}

function cellUsageState(cell: CellResult): string {
  const usage = cell.generation.modelUsage;
  if (!usage || !cell.generation.usageComplete) return "缺失";
  return usage.cost === undefined || usage.unpricedTokens ? "部分" : "完整";
}

/** Human-readable experiment summary; the CSVs retain machine-readable values. */
export function summaryMarkdown(plan: ExperimentPlan, summary: ExperimentSummary): string {
  const planned = plan.cells?.length ?? plan.tasks.length * plan.repeats * Math.max(summary.byMethod.length, 1);
  const lines = [
    "# 实验汇总",
    "",
    `- 题目：${plan.tasks.map(task => `\`${task.id}\``).join("、") || MISSING}`,
    `- 方法：${summary.byMethod.map(row => `\`${row.method}\``).join("、") || MISSING}`,
    `- 重复：${plan.repeats}`,
    `- 并发：${plan.concurrency}`,
    `- 已完成：${summary.cells.length} / ${planned} 个单元`,
    "",
    "## 方法汇总",
    "",
    "| 方法 | 完成/计划 | 宏平均通过率 | 全量通过 | 生成失败 | 评测异常 | 生成（分钟） | 评测（分钟） | 合计（分钟） |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...summary.byMethod.map(row => `| ${row.method} | ${row.completed}/${row.planned} | ${percent(row.macroPassRate)} | ` +
      `${row.allTestsPassed} | ${row.generationFailures} | ${row.evaluationErrors} | ${minutes(row.generationMinutes)} | ` +
      `${minutes(row.evaluationMinutes)} | ${minutes(row.totalMinutes)} |`),
    "",
    "## Token 与费用",
    "",
    "| 方法 | 输入 | 输出 | 缓存读 | 缓存写 | 总 Token | 缓存命中率 | 花费（USD） | 用量 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...summary.byMethod.map(row => `| ${row.method} | ${integer(row.inputTokens)} | ${integer(row.outputTokens)} | ` +
      `${integer(row.cacheReadTokens)} | ${integer(row.cacheWriteTokens)} | ${integer(row.totalTokens)} | ` +
      `${percent(row.cacheHitRate)} | ${cost(row.knownCostUsd)} | ${usageState(row.completed, row.missingOrPartialUsage)} |`),
    "",
    "## 每次运行",
    "",
    "| 题目 | 重复 | 方法 | 通过/总数 | 通过率 | 生成状态 | 评测状态 | 生成（分钟） | 评测（分钟） | 合计（分钟） | " +
      "输入 | 输出 | 缓存读 | 缓存写 | 总 Token | 缓存命中率 | 花费（USD） | 用量 |",
    "| --- | ---: | --- | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...summary.cells.map(cell => {
      const usage = cell.generation.modelUsage;
      const totalDurationMs = cell.generation.durationMs === null
        ? null : cell.generation.durationMs + cell.evaluation.durationMs;
      return `| ${cell.task} | ${cell.repeat} | ${cell.method} | ${cell.evaluation.score.passed}/${cell.evaluation.score.total} | ` +
        `${percent(cell.evaluation.score.passRate)} | ${cell.generation.status} | ${cell.evaluation.status} | ` +
        `${minutes(cell.generation.durationMs === null ? null : cell.generation.durationMs / 60_000)} | ` +
        `${minutes(cell.evaluation.durationMs / 60_000)} | ${minutes(totalDurationMs === null ? null : totalDurationMs / 60_000)} | ` +
        `${integer(usage?.input ?? null)} | ${integer(usage?.output ?? null)} | ${integer(usage?.cacheRead ?? null)} | ` +
        `${integer(usage?.cacheWrite ?? null)} | ${integer(usage?.total ?? null)} | ` +
        `${percent(usage ? cacheHitRate(usage) : null)} | ${cost(usage?.cost ?? null)} | ${cellUsageState(cell)} |`;
    }),
    "",
    "> 缓存命中率 = cacheRead / (input + cacheRead + cacheWrite)。",
    "> 花费仅统计生成阶段的模型用量；评测由外部 Playwright 执行，不消耗模型 token。",
    "",
  ];
  return lines.join("\n");
}

export function csv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const keys = Object.keys(rows[0]);
  const quote = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return [keys.map(quote).join(","), ...rows.map(row => keys.map(key => quote(row[key])).join(","))].join("\n") + "\n";
}
