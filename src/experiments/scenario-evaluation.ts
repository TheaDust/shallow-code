import type { JSONReport } from "@playwright/test/reporter";
import type { ApplicationSession } from "../application/port.js";
import type { CandidateEvidence } from "../types.js";
import { reportEntries, scoreReport, type TestEntry } from "./protocol.js";
import type { ProcessResult } from "./process.js";

export interface ScenarioExecution {
  id: string;
  title: string;
  status: "not_run" | "running" | "completed";
  durationMs: number;
  candidate?: CandidateEvidence;
  error?: string;
}

/** Select one frozen case, including parameterized cases sharing a source line. */
export function scenarioArguments(entry: TestEntry): string[] {
  const [file, line, , title, project] = JSON.parse(entry.id) as [string, number, number, string, string];
  if (typeof file !== "string" || !Number.isInteger(line) || line < 1 || title !== entry.title) {
    throw new Error("Invalid frozen scenario identity");
  }
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [`${file}:${line}`, "--grep", `${escaped}$`, ...(project ? ["--project", project] : [])];
}

/** Reuse the build, while each case gets a new application process and inherited-data copy. */
export async function evaluateScenarios(options: {
  catalog: readonly TestEntry[];
  start(): Promise<ApplicationSession>;
  execute(entry: TestEntry, index: number): Promise<{ report: JSONReport; process: ProcessResult }>;
  record?(cases: readonly ScenarioExecution[]): Promise<void>;
}) {
  const started = Date.now();
  const cases: ScenarioExecution[] = options.catalog.map(entry => ({ id: entry.id, title: entry.title,
    status: "not_run", durationMs: 0 }));
  const reports: JSONReport[] = [];
  const errors: string[] = [];
  const runtimeIds = new Set<string>();
  let baseline: CandidateEvidence | undefined;
  for (const [index, entry] of options.catalog.entries()) {
    const item = cases[index];
    const at = Date.now();
    let app: ApplicationSession | undefined;
    let report: JSONReport | undefined;
    item.status = "running";
    try {
      await options.record?.(cases);
      app = await options.start();
      const candidate = app.candidate;
      if (!candidate || runtimeIds.has(candidate.runtimeId)) throw new Error("Scenario needs a fresh candidate runtime");
      runtimeIds.add(candidate.runtimeId);
      item.candidate = candidate;
      baseline ??= candidate;
      if (candidate.inputDigest !== baseline.inputDigest || candidate.applicationDigest !== baseline.applicationDigest) {
        throw new Error("Application or build changed between scenarios");
      }
      await options.record?.(cases);
      const result = await options.execute(entry, index);
      if (result.process.timedOut || ![0, 1].includes(result.process.exitCode ?? -1)) {
        throw new Error(result.process.error ?? "Scenario runner did not complete");
      }
      if (reportEntries(result.report).length !== 1) throw new Error("Runner must select exactly one frozen scenario");
      const score = scoreReport([entry], result.report);
      if (score.errors.length || score.notRun || score.skipped) {
        throw new Error(score.errors.join("; ") || "Selected scenario was not executed");
      }
      await app.assertUnchanged?.();
      report = result.report;
    } catch (error) {
      item.error = String(error);
    } finally {
      try { await app?.stop(); }
      catch (error) { item.error = [item.error, `Application cleanup failed: ${String(error)}`].filter(Boolean).join("; "); }
      item.status = item.error ? "not_run" : "completed";
      item.durationMs = Date.now() - at;
      await options.record?.(cases);
    }
    if (item.error) {
      errors.push(`${entry.title}: ${item.error}`);
      // A broken initializer, candidate or cleanup cannot authorize subsequent cases.
      break;
    }
    reports.push(report!);
  }
  const aggregate = { ...reports[0], suites: reports.flatMap(report => report.suites),
    errors: errors.map(message => ({ message })) } as JSONReport;
  const score = scoreReport(options.catalog, aggregate);
  aggregate.stats = { startTime: new Date(started).toISOString(), duration: Date.now() - started,
    expected: score.passed, unexpected: score.failed, skipped: score.skipped, flaky: 0 };
  return { report: aggregate, cases, score };
}
