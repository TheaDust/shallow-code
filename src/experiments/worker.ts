import { copyFile, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JSONReport } from "@playwright/test/reporter";
import { applications } from "../adapters/index.js";
import { webRuntimeConfig } from "../adapters/web/project-spec.js";
import { CandidateRuntime } from "../application/candidate-runtime.js";
import { runBaseline } from "../baseline.js";
import { loadProjectSpec } from "../project-spec.js";
import { snapshotFiles } from "../run-record.js";
import { runtimeEnvironment } from "../process-lifecycle.js";
import { runProcess } from "./process.js";
import { REPOSITORY, reportEntries, scoreReport, type ArcTask, type Method, type TestEntry } from "./protocol.js";

export type WorkerRequest =
  | { action: "generate"; method: Method; requirementsDir: string; projectDir: string; privateDir: string; timeoutMs: number | null }
  | { action: "catalog" | "evaluate"; method?: Method; task: ArcTask; setupScript: string; directory: string; projectDir?: string;
      catalog?: TestEntry[]; timeoutMs: number | null };

async function copyInputs(source: string, files: Record<string, string>, target: string): Promise<void> {
  for (const path of Object.keys(files)) {
    await mkdir(dirname(join(target, path)), { recursive: true });
    await copyFile(join(source, path), join(target, path));
  }
  if (JSON.stringify(await snapshotFiles(target)) !== JSON.stringify(files)) throw new Error("ARC tests changed while copying");
}

export async function executeWorker(request: WorkerRequest): Promise<void> {
  if (request.action === "generate") {
    if (request.method === "arc") throw new Error("ARC generation must use the experiment's frozen compiler runner");
    process.env.SHALLOW_RUN_DIR = join(request.privateDir, "runs");
    process.env.SHALLOW_CAPTURE_SSE = "0";
    if (request.method === "baseline") {
      const result = await runBaseline({ requirementsDir: request.requirementsDir, outputDir: request.projectDir,
        runDirectory: join(process.env.SHALLOW_RUN_DIR, "baseline"), env: process.env, timeoutMs: request.timeoutMs });
      process.exitCode = result.status === "completed" ? 0 : 1;
    } else {
      const { main } = await import("../../index.js");
      process.exitCode = await main(["--requirements-dir", request.requirementsDir, "--output-dir", request.projectDir],
        process.env, undefined, null, request.projectDir);
    }
    return;
  }
  const { directory } = request;
  await mkdir(directory, { recursive: true });
  await copyInputs(request.task.testsDir, request.task.testFiles, join(directory, "tests"));
  // Reuse the installed, pinned benchmark dependency without installing into the application.
  await symlink(join(REPOSITORY, "node_modules"), join(directory, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const setup = join(directory, "setup-playwright.cjs");
  await copyFile(request.setupScript, setup);
  const command = async (args: string[], name: string, extra: NodeJS.ProcessEnv = {}) => runProcess({ executable: process.execPath,
    args, cwd: directory, env: runtimeEnvironment(extra), logFile: join(directory, `${name}.log`), timeoutMs: request.timeoutMs });
  const configure = async (url: string) => {
    const result = await command([setup, directory, url], "setup");
    if (result.exitCode !== 0) throw new Error("ARC Playwright configuration failed; see setup.log");
  };
  await configure("http://127.0.0.1:1");
  const cli = join(REPOSITORY, "node_modules", "@playwright", "test", "cli.js");
  if (request.action === "catalog") {
    const reportFile = join(directory, "list.json");
    const result = await command([cli, "test", "--list", "--reporter=json"], "list", { PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile });
    if (result.exitCode !== 0) throw new Error("Cannot enumerate ARC tests; see list.log");
    const report = JSON.parse(await readFile(reportFile, "utf8")) as JSONReport;
    const entries = reportEntries(report);
    scoreReport(entries); // Validate identities and reject an empty suite before generation.
    await writeFile(join(directory, "catalog.json"), JSON.stringify(entries, null, 2) + "\n");
    return;
  }
  let runtime: CandidateRuntime | undefined;
  const started = Date.now();
  let evaluation;
  try {
    const spec = await loadProjectSpec(request.projectDir!, undefined, (raw, origin) =>
      applications.get((raw as { adapter?: string }).adapter ?? "web").parseSpec(raw, origin));
    const adapter = applications.get(spec.adapter ?? "web");
    const contract = await adapter.configure(spec, {});
    await configure(new URL(webRuntimeConfig(contract).browserPath, webRuntimeConfig(contract).baseUrl).href);
    const lifecycle = request.method === "arc" ? {
      start: (appDir: string, app: typeof contract) => adapter.lifecycle.start(appDir, { ...app,
        env: { ...app.env, ARC_DB_FILE: join(app.dataDirectory!, "database.db") } }),
    } : adapter.lifecycle;
    runtime = new CandidateRuntime(request.projectDir!, join(directory, "candidate"), contract, lifecycle);
    const app = await runtime.start(request.projectDir!, contract);
    const reportFile = join(directory, "playwright.json");
    const result = await command([cli, "test", "--reporter=json"], "tests", { PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile });
    await app.assertUnchanged?.();
    const report = JSON.parse(await readFile(reportFile, "utf8")) as JSONReport;
    const score = scoreReport(request.catalog!, report);
    evaluation = { status: !result.timedOut && (result.exitCode === 0 || result.exitCode === 1) && !score.errors.length ? "completed" : "error",
      score, durationMs: Date.now() - started, directory: ".", candidate: app.candidate };
  } catch (error) {
    evaluation = { status: "error", score: scoreReport(request.catalog!), durationMs: Date.now() - started, directory: ".", error: String(error) };
  } finally { await runtime?.dispose(); }
  await writeFile(join(directory, "evaluation.json"), JSON.stringify(evaluation, null, 2) + "\n");
}

// A spawned worker must not execute a phase before the parent owns its process tree.
if (process.send) process.once("message", (request: WorkerRequest) => {
  void executeWorker(request).then(() => process.disconnect(), error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    process.disconnect();
  });
});
