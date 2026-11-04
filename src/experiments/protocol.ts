import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { JSONReport, JSONReportSuite } from "@playwright/test/reporter";
import { normalizeArcRequirements } from "./requirements.js";
import { digest, snapshotFiles } from "../run-record.js";
import type { UsageSummary } from "../model-usage.js";

export const REPOSITORY = fileURLToPath(new URL("../../", import.meta.url));
export const METHODS = ["baseline", "shallow"] as const;
export type Method = typeof METHODS[number];

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
  setupScript: string;
  setupDigest: string;
  codeDigest: string;
  nodeVersion: string;
  playwrightVersion: string;
  settings: Record<string, string | undefined>;
  repeats: number;
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

/** Alternating order reduces systematic baseline-first effects across paired runs. */
export function planCells(tasks: readonly string[], repeats: number): ExperimentPlan["cells"] {
  return Array.from({ length: repeats }, (_, index) => tasks.flatMap((task, taskIndex) =>
    ((index + taskIndex) % 2 ? [...METHODS].reverse() : [...METHODS]).map(method => ({ task, repeat: index + 1, method })))).flat();
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

export function summarize(plan: ExperimentPlan, results: CellResult[]) {
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const byTask = plan.tasks.flatMap(task => METHODS.map(method => {
    const rows = results.filter(row => row.task === task.id && row.method === method);
    return { task: task.id, method, completed: rows.length, planned: plan.repeats,
      passRate: rows.length === plan.repeats ? mean(rows.map(row => row.evaluation.score.passRate)) : null };
  }));
  const byMethod = METHODS.map(method => {
    const rows = results.filter(row => row.method === method), tasks = byTask.filter(row => row.method === method);
    const knownCosts = rows.filter(row => row.generation.modelUsage?.cost !== undefined);
    return { method, completed: rows.length, planned: plan.tasks.length * plan.repeats,
      macroPassRate: tasks.every(task => task.passRate !== null) ? mean(tasks.map(task => task.passRate!)) : null,
      allTestsPassed: rows.filter(row => row.evaluation.status === "completed" && row.evaluation.score.passed === row.evaluation.score.total).length,
      generationFailures: rows.filter(row => !["completed", "partial"].includes(row.generation.status)).length,
      evaluationErrors: rows.filter(row => row.evaluation.status !== "completed").length,
      knownCostUsd: knownCosts.length ? knownCosts.reduce((sum, row) => sum + row.generation.modelUsage!.cost!, 0) : null,
      missingOrPartialUsage: rows.filter(row => !row.generation.usageComplete || !row.generation.modelUsage ||
        row.generation.modelUsage.cost === undefined || Boolean(row.generation.modelUsage.unpricedTokens)).length,
      generationDurationMs: rows.reduce((sum, row) => sum + (row.generation.durationMs ?? 0), 0),
      missingGenerationDurations: rows.filter(row => row.generation.durationMs === null).length };
  });
  return { byMethod, byTask, cells: results };
}

export function csv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const keys = Object.keys(rows[0]);
  const quote = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return [keys.map(quote).join(","), ...rows.map(row => keys.map(key => quote(row[key])).join(","))].join("\n") + "\n";
}
