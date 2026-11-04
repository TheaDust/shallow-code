import { copyFile, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sanitizeDiagnosticText } from "../diagnostics.js";
import { parseBuilderContextWindow, parseVerifierConfig, readEnvFile, readGatewayConfig, referenceImagesEnabled } from "../runtime-config.js";
import { assertPrivateRunDirectory, digest, lockWorkspace, snapshotFiles } from "../run-record.js";
import { atomicWrite } from "../verifier/artifacts.js";
import { runProcess, type ProcessRequest, type ProcessResult } from "./process.js";
import { csv, discoverArcTasks, implementationDigest, inside, METHODS, planCells, REPOSITORY, scoreReport, summarize,
  type CellResult, type ExperimentPlan, type TestEntry } from "./protocol.js";
import type { WorkerRequest } from "./worker.js";
import { normalizeArcRequirements } from "./requirements.js";
import { loadRequirementCatalog } from "../catalog.js";

const HELP = `ARC two-method experiments

npm run experiment -- list [--bench-root ../arc-bench]
npm run experiment -- plan --tasks keep,bookstack --repeats 1
npm run experiment -- prepare --tasks keep,bookstack --repeats 1 --output-dir outputs/arc-pilot
npm run experiment -- run --tasks keep,bookstack --repeats 1 --output-dir outputs/arc-pilot
npm run experiment -- run --tasks keep,bookstack --repeats 1 --output-dir outputs/arc-pilot --resume
npm run experiment -- summarize --output-dir outputs/arc-pilot

Options:
  --bench-root <dir>               ARC repository (default: ../arc-bench relative to ShallowCode)
  --tasks <id,id>                  Selected tasks (default: all discovered tasks)
  --repeats <n>                    Independent paired repetitions (default: 2)
  --output-dir <dir>               Experiment artifacts (default: outputs/arc-experiment)
  --generation-timeout-ms <n>      Optional total generation wall limit for both methods (default: no limit)
  --evaluation-timeout-ms <n>      Optional per evaluation phase wall limit (default: no limit)
  --resume                        Continue this frozen experiment; retain all completed results
`;

export function parseExperimentArgs(argv: string[], cwd = process.cwd()) {
  const command = argv[0] ?? "help";
  if (!["help", "--help", "-h", "list", "plan", "prepare", "run", "summarize"].includes(command)) throw new Error(`Unknown command: ${command}`);
  const values = new Map<string, string>();
  let resume = false;
  const names = ["--bench-root", "--tasks", "--repeats", "--output-dir", "--generation-timeout-ms", "--evaluation-timeout-ms"];
  for (let index = 1; index < argv.length; index++) {
    const key = argv[index];
    if (key === "--resume") { resume = true; continue; }
    if (!names.includes(key) || values.has(key)) throw new Error(`Unknown or duplicate argument: ${key}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    values.set(key, value);
  }
  const integer = (name: string, fallback: number, maximum = 2_147_483_647) => {
    const value = Number(values.get(name) ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be an integer from 1 to ${maximum}`);
    return value;
  };
  const tasks = values.get("--tasks")?.split(",");
  if (tasks && (tasks.some(task => !/^[a-zA-Z0-9_-]+$/.test(task)) || new Set(tasks).size !== tasks.length)) {
    throw new Error("--tasks must contain unique task IDs separated by commas");
  }
  return { command, tasks, resume,
    benchRoot: values.has("--bench-root") ? resolve(cwd, values.get("--bench-root")!) : resolve(REPOSITORY, "../arc-bench"),
    outputDir: resolve(cwd, values.get("--output-dir") ?? "outputs/arc-experiment"),
    repeats: integer("--repeats", 2, 100),
    generationTimeoutMs: values.has("--generation-timeout-ms") ? integer("--generation-timeout-ms", 0) : null,
    evaluationTimeoutMs: values.has("--evaluation-timeout-ms") ? integer("--evaluation-timeout-ms", 0) : null };
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function createPlan(options: ReturnType<typeof parseExperimentArgs>, env: NodeJS.ProcessEnv): Promise<ExperimentPlan> {
  const tasks = await discoverArcTasks(options.benchRoot);
  for (const id of options.tasks ?? []) if (!tasks.some(task => task.id === id)) throw new Error(`Unknown ARC task: ${id}`);
  const selected = options.tasks ? options.tasks.map(id => tasks.find(task => task.id === id)!) : tasks;
  if (inside(options.benchRoot, options.outputDir)) throw new Error("Experiment output must be outside arc-bench");
  const settingEntries = Object.entries(env).filter(([key]) =>
    /^(MODEL$|MODEL_COST_|OPENAI_BASE_URL$|SHALLOW_)/.test(key) &&
    !/API_KEY|SECRET|PASSWORD|TOKEN|SHALLOW_RUN_DIR|SHALLOW_CAPTURE_SSE|SHALLOW_PROBE_PORT|SHALLOW_EVAL_PORT/i.test(key));
  const settings = Object.fromEntries(settingEntries.sort(([a], [b]) => a.localeCompare(b)));
  const setupScript = join(await realpath(options.benchRoot), "setup-playwright.cjs");
  const playwright = JSON.parse(await readFile(join(REPOSITORY, "node_modules/@playwright/test/package.json"), "utf8"));
  return { version: 1, benchRoot: await realpath(options.benchRoot), setupScript, setupDigest: digest(await readFile(setupScript)),
    codeDigest: await implementationDigest(), nodeVersion: process.version, playwrightVersion: playwright.version, settings,
    repeats: options.repeats, generationTimeoutMs: options.generationTimeoutMs, evaluationTimeoutMs: options.evaluationTimeoutMs,
    tasks: selected, cells: planCells(selected.map(task => task.id), options.repeats) };
}

async function saveJson(path: string, value: unknown) { await atomicWrite(path, JSON.stringify(value, null, 2) + "\n"); }
const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, "utf8")) as T;

export async function writeSummary(outputDir: string, plan: ExperimentPlan) {
  const results: CellResult[] = [];
  for (const cell of plan.cells) {
    const path = join(outputDir, cell.task, `repeat-${cell.repeat}`, cell.method, "result.json");
    if (await exists(path)) results.push(await readJson<CellResult>(path));
  }
  const summary = summarize(plan, results);
  await saveJson(join(outputDir, "summary.json"), summary);
  await writeFile(join(outputDir, "summary.csv"), csv(summary.byMethod));
  await writeFile(join(outputDir, "tasks.csv"), csv(summary.byTask));
  await writeFile(join(outputDir, "runs.csv"), csv(results.map(row => ({ task: row.task, repeat: row.repeat, method: row.method,
    generationStatus: row.generation.status, evaluationStatus: row.evaluation.status,
    ...row.evaluation.score, errors: row.evaluation.score.errors.join("; "),
    generationDurationMs: row.generation.durationMs, evaluationDurationMs: row.evaluation.durationMs,
    tokens: row.generation.modelUsage?.total, knownCostUsd: row.generation.modelUsage?.cost,
    usageComplete: row.generation.usageComplete, finalDigest: row.finalDigest }))));
  return summary;
}

export interface ExperimentDependencies {
  runProcess?: (request: ProcessRequest) => Promise<ProcessResult>;
  signal?: AbortSignal;
  prepareOnly?: boolean;
}

export async function runExperiment(plan: ExperimentPlan, outputDir: string, env: NodeJS.ProcessEnv, resume: boolean,
  dependencies: ExperimentDependencies = {}) {
  const run = dependencies.runProcess ?? runProcess;
  // Keep both benchmark and implementation sources intact, including directory aliases.
  await assertPrivateRunDirectory(plan.benchRoot, outputDir);
  const manifestFile = join(outputDir, "experiment.json");
  if (await exists(manifestFile)) {
    if (!resume) throw new Error("Experiment already exists; use --resume with identical options or choose a new output directory");
    if (JSON.stringify(await readJson(manifestFile)) !== JSON.stringify(plan)) throw new Error("Experiment inputs, code or settings changed; choose a new output directory");
  } else {
    if ((await readdir(outputDir)).length) throw new Error("New experiment output directory must be empty");
    await writeFile(manifestFile, JSON.stringify(plan, null, 2) + "\n", { flag: "wx" });
  }
  const release = await lockWorkspace(outputDir);
  const childEnv: NodeJS.ProcessEnv = { ...env, SHALLOW_CAPTURE_SSE: "0" };
  delete childEnv.SHALLOW_PROBE_PORT;
  delete childEnv.SHALLOW_EVAL_PORT;
  const worker = async (message: WorkerRequest, logFile: string, timeoutMs: number | null, generation = false) => run({
    executable: process.execPath, args: ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("worker.ts", import.meta.url))],
    cwd: REPOSITORY, env: generation ? childEnv : Object.fromEntries(Object.entries(childEnv).filter(([key]) => !/API_KEY|TOKEN|SECRET|PASSWORD/i.test(key))),
    logFile, timeoutMs, message, signal: dependencies.signal });
  try {
    const setupScript = join(outputDir, "private", "setup-playwright.cjs");
    if (!await exists(setupScript)) {
      const source = await readFile(plan.setupScript);
      if (digest(source) !== plan.setupDigest) throw new Error("ARC setup script changed");
      await mkdir(dirname(setupScript), { recursive: true });
      await writeFile(setupScript, source);
    }
    if (digest(await readFile(setupScript)) !== plan.setupDigest) throw new Error("Frozen ARC setup script changed");
    const catalogs = new Map<string, TestEntry[]>();
    for (const task of plan.tasks) {
      const normalizedFile = join(outputDir, "private", "inputs", task.id, "requirements.yaml");
      await mkdir(dirname(normalizedFile), { recursive: true });
      const normalized = normalizeArcRequirements(await readFile(join(task.requirementsDir, "requirements.yaml"), "utf8"));
      if (digest(normalized.yaml) !== task.normalizedRequirementsDigest) throw new Error(`ARC requirements changed: ${task.id}`);
      await writeFile(normalizedFile, normalized.yaml);
      await loadRequirementCatalog(normalizedFile);
      const directory = join(outputDir, "private", "catalog", task.id);
      const catalogFile = join(directory, "catalog.json");
      if (!await exists(catalogFile)) {
        // A previous interrupted catalog remains intact; use a fresh private attempt.
        await mkdir(directory, { recursive: true });
        const attempt = join(directory, `attempt-${(await readdir(directory)).filter(name => name.startsWith("attempt-")).length + 1}`);
        process.stderr.write(`[ARC experiment] enumerate ${task.id}\n`);
        const result = await worker({ action: "catalog", task, setupScript, directory: attempt,
          timeoutMs: plan.evaluationTimeoutMs }, join(attempt, "worker.log"), plan.evaluationTimeoutMs);
        if (result.exitCode !== 0 || !await exists(join(attempt, "catalog.json"))) throw new Error(`Cannot enumerate ${task.id}; see ${attempt}`);
        await saveJson(catalogFile, await readJson(join(attempt, "catalog.json")));
      }
      catalogs.set(task.id, await readJson<TestEntry[]>(catalogFile));
    }
    if (dependencies.prepareOnly) return await writeSummary(outputDir, plan);
    for (const cell of plan.cells) {
      dependencies.signal?.throwIfAborted();
      const task = plan.tasks.find(task => task.id === cell.task)!;
      const directory = join(outputDir, task.id, `repeat-${cell.repeat}`, cell.method);
      if (await exists(join(directory, "result.json"))) continue;
      process.stderr.write(`[ARC experiment] ${task.id} repeat=${cell.repeat} ${cell.method}\n`);
      await mkdir(directory, { recursive: true });
      const projectDir = join(directory, "app"), privateDir = join(directory, "private");
      const generationFile = join(directory, "generation.json");
      let generation: CellResult["generation"];
      if (await exists(generationFile)) generation = await readJson(generationFile);
      else if (await exists(join(directory, "started.json"))) {
        generation = { status: "interrupted", exitCode: null, durationMs: null, modelUsage: null, usageComplete: false };
        await saveJson(generationFile, generation);
      } else {
        await saveJson(join(directory, "started.json"), { startedAt: new Date().toISOString() });
        const requirementsDir = join(privateDir, "requirements");
        const sourceDirectory = join(privateDir, "source-requirements");
        for (const path of Object.keys(task.requirementFiles)) {
          await mkdir(dirname(join(requirementsDir, path)), { recursive: true });
          await copyFile(join(task.requirementsDir, path), join(requirementsDir, path));
        }
        if (JSON.stringify(await snapshotFiles(requirementsDir)) !== JSON.stringify(task.requirementFiles)) throw new Error("ARC requirements changed while copying");
        await mkdir(sourceDirectory, { recursive: true });
        await copyFile(join(requirementsDir, "requirements.yaml"), join(sourceDirectory, "requirements.yaml"));
        const normalized = normalizeArcRequirements(await readFile(join(requirementsDir, "requirements.yaml"), "utf8"));
        if (digest(normalized.yaml) !== task.normalizedRequirementsDigest) throw new Error("ARC input conversion changed");
        await writeFile(join(requirementsDir, "requirements.yaml"), normalized.yaml);
        await mkdir(projectDir, { recursive: true });
        const processResult = await worker({ action: "generate", method: cell.method, requirementsDir, projectDir, privateDir,
          timeoutMs: plan.generationTimeoutMs }, join(directory, "generation.log"), plan.generationTimeoutMs, true);
        const runRoot = join(privateDir, "runs");
        const runDirs = await exists(runRoot) ? await readdir(runRoot) : [];
        const reportPaths = runDirs.map(name => join(runRoot, name, "result.json"));
        let report: { status: string; modelUsage?: CellResult["generation"]["modelUsage"]; usageComplete?: boolean } | undefined;
        for (const path of reportPaths) if (await exists(path)) report = await readJson(path);
        generation = { status: processResult.timedOut ? "timed_out" : ![0, 2].includes(processResult.exitCode ?? -1) ? "failed"
          : report?.status === "delivered" ? "completed" : report?.status ?? "failed",
          exitCode: processResult.exitCode, durationMs: processResult.durationMs,
          modelUsage: report?.modelUsage ?? null, usageComplete: !processResult.timedOut && Boolean(report?.modelUsage) && report?.usageComplete !== false,
          ...(processResult.error ? { error: processResult.error } : {}) };
        await saveJson(generationFile, generation);
      }
      const catalog = catalogs.get(task.id)!;
      await mkdir(projectDir, { recursive: true });
      const before = await snapshotFiles(projectDir);
      const evaluations = (await readdir(directory)).filter(name => /^evaluation-\d+$/.test(name));
      const evaluationDir = join(directory, `evaluation-${evaluations.length + 1}`);
      const evaluated = await worker({ action: "evaluate", task, setupScript, projectDir,
        directory: evaluationDir, catalog, timeoutMs: plan.evaluationTimeoutMs }, join(evaluationDir, "worker.log"), plan.evaluationTimeoutMs);
      const evaluationFile = join(evaluationDir, "evaluation.json");
      const evaluation: CellResult["evaluation"] = await exists(evaluationFile) ? await readJson(evaluationFile)
        : { status: evaluated.timedOut ? "timed_out" : "error", durationMs: evaluated.durationMs,
          score: scoreReport(catalog), directory: evaluationDir, error: evaluated.error ?? "Evaluation did not produce a report; see worker.log" };
      if (evaluated.timedOut) evaluation.status = "timed_out";
      evaluation.durationMs = evaluated.durationMs;
      if (JSON.stringify(await snapshotFiles(projectDir)) !== JSON.stringify(before)) throw new Error("Final application changed during external evaluation");
      const result: CellResult = { ...cell, generation, evaluation, finalDigest: digest(JSON.stringify(before)) };
      await saveJson(join(directory, "result.json"), result);
      await writeSummary(outputDir, plan);
    }
    return await writeSummary(outputDir, plan);
  } finally { await release(); }
}

export async function experimentMain(argv = process.argv.slice(2), environment: NodeJS.ProcessEnv = process.env,
  dependencies: ExperimentDependencies = {}, envFile: string | null = join(REPOSITORY, ".env")): Promise<number> {
  const options = parseExperimentArgs(argv);
  if (["help", "--help", "-h"].includes(options.command)) { process.stdout.write(HELP); return 0; }
  if (options.command === "summarize") {
    const summary = await writeSummary(options.outputDir, await readJson<ExperimentPlan>(join(options.outputDir, "experiment.json")));
    process.stdout.write(JSON.stringify(summary.byMethod, null, 2) + "\n"); return 0;
  }
  const env: NodeJS.ProcessEnv = { ...(envFile ? await readEnvFile(envFile) : {}) };
  for (const [key, value] of Object.entries(environment)) if (value !== undefined) env[key] = value;
  // Resolve defaults into the frozen protocol; no hidden benchmark metadata enters generation.
  env.SHALLOW_REFERENCE_IMAGES = referenceImagesEnabled(env) ? "1" : "0";
  env.SHALLOW_BUILDER_CONTEXT_WINDOW = String(parseBuilderContextWindow(env));
  const verifier = parseVerifierConfig(env);
  env.SHALLOW_VERIFIER_SEMANTIC_REVIEW = verifier.semanticReview ? "1" : "0";
  env.SHALLOW_VERIFIER_REPLAY = verifier.replay ? "1" : "0";
  env.SHALLOW_VERIFIER_CONCURRENCY = String(verifier.concurrency);
  const plan = await createPlan(options, env);
  if (options.command === "list") {
    process.stdout.write(plan.tasks.map(task => `${task.id}\t${task.requirements} atomic requirements\t${task.scenarios} scenarios`).join("\n") + "\n");
    return 0;
  }
  if (options.command === "plan") {
    process.stdout.write(JSON.stringify({ ...plan, tasks: plan.tasks.map(({ requirementFiles, testFiles, ...task }) => task), outputDir: options.outputDir }, null, 2) + "\n");
    return 0;
  }
  if (options.command === "run") for (const role of ["builder", "grouper", "verifier"]) readGatewayConfig(env, role);
  const summary = await runExperiment(plan, options.outputDir, env, options.resume,
    { ...dependencies, prepareOnly: options.command === "prepare" });
  process.stdout.write(JSON.stringify(summary.byMethod, null, 2) + "\n");
  return summary.byMethod.some(method => method.generationFailures || method.evaluationErrors) ? 2 : 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("Experiment interrupted; use --resume to retain this attempt and continue"));
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  void experimentMain(undefined, undefined, { signal: controller.signal }).then(code => { process.exitCode = code; }, error => {
    console.error(sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }).finally(() => { process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); });
}
