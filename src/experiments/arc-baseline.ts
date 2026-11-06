import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { pickFreePort } from "../adapters/web/ports.js";
import { digest } from "../run-record.js";
import { referenceImagesEnabled, readGatewayConfig } from "../runtime-config.js";
import { resolveModelRates, UsageTotals, usageCost } from "../model-usage.js";
import { npmExecutable } from "../project-spec.js";
import { runProcess, type ProcessRequest } from "./process.js";
import type { CellResult } from "./protocol.js";

export interface ArcBaselineSpec {
  root: string;
  python: string;
  pythonVersion: string;
  packages: Record<string, string>;
  files: Record<string, string>;
}

async function compilerFiles(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (prefix: string): Promise<void> => {
    for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if ([".git", "__pycache__", "node_modules", ".venv"].includes(entry.name) || entry.name.startsWith(".env")) continue;
      const path = `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`ARC source links are unsupported: ${path}`);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && !/\.py[co]$/.test(path)) files[path] = digest(await readFile(join(root, path)));
    }
  };
  await walk("src");
  files["pyproject.toml"] = digest(await readFile(join(root, "pyproject.toml")));
  return files;
}

export async function inspectArcBaseline(root: string, python: string): Promise<ArcBaselineSpec> {
  const files = await compilerFiles(root);
  if (!files["src/main.py"]) throw new Error(`ARC CLI is missing under ${root}/src`);
  const probe = `import sys,json,importlib.metadata as m
assert sys.version_info >= (3,11), 'ARC requires Python 3.11+'
names=['openai','python-dotenv','pyyaml','pydantic','colorama','jsonschema','httpx','socksio']
packages=dict(sorted((d.metadata['Name'].lower().replace('_','-'),d.version) for d in m.distributions()))
missing=[n for n in names if n not in packages]
print(json.dumps({'python':sys.executable,'pythonVersion':sys.version,'packages':packages,'missing':missing}))`;
  try {
    const { stdout } = await promisify(execFile)(python, ["-B", "-c", probe], { windowsHide: true, timeout: 10_000 });
    const { missing, ...runtime } = JSON.parse(stdout);
    if (missing.length) throw new Error(`Missing ARC Python packages: ${missing.join(", ")}`);
    return { root: await realpath(root), ...runtime, files };
  } catch (error) {
    throw new Error(`ARC Python environment is unavailable; install ${root}/pyproject.toml dependencies and select --arc-python. ${String(error)}`);
  }
}

export async function freezeArcBaseline(spec: ArcBaselineSpec, directory: string): Promise<void> {
  if (!spec.files["src/arc-template/templates/web-react-express/backend/package.json"]) {
    throw new Error(`ARC Web template is missing; run git -C "${spec.root}" submodule update --init --recursive before preparing an ARC experiment`);
  }
  for (const [path, expected] of Object.entries(spec.files)) {
    const destination = join(directory, path);
    let content: Buffer;
    try { content = await readFile(destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      content = await readFile(join(spec.root, path));
      if (digest(content) !== expected) throw new Error(`ARC source changed: ${path}`);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(spec.root, path), destination);
      content = await readFile(destination);
    }
    if (digest(content) !== expected) throw new Error(`Frozen ARC source changed: ${path}`);
  }
  if (JSON.stringify(await compilerFiles(directory)) !== JSON.stringify(spec.files)) {
    throw new Error("Frozen ARC source file list changed");
  }
}

export function arcEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const gateway = readGatewayConfig({ ...env,
    ARC_MODEL: env.ARC_MODEL?.trim() || env.SHALLOW_BUILDER_MODEL,
    ARC_BASE_URL: env.ARC_BASE_URL?.trim() || env.SHALLOW_BUILDER_BASE_URL,
    ARC_API_KEY: env.ARC_API_KEY?.trim() || env.SHALLOW_BUILDER_API_KEY,
  }, "ARC");
  const result = { ...env, MODEL: gateway.model, OPENAI_BASE_URL: gateway.baseUrl, OPENAI_API_KEY: gateway.apiKey,
    PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1",
    SHALLOW_REFERENCE_IMAGES: referenceImagesEnabled(env) ? "1" : "0" };
  // ARC's optional visual model follows the same gateway unless explicitly configured.
  return { ...result, VISUAL_MODEL: env.VISUAL_MODEL || gateway.model,
    VISUAL_BASE_URL: env.VISUAL_BASE_URL || gateway.baseUrl, VISUAL_API_KEY: env.VISUAL_API_KEY || gateway.apiKey };
}

export function arcUsage(source: string, env: NodeJS.ProcessEnv) {
  const totals = new UsageTotals();
  let complete = true;
  for (const line of source.split(/\r?\n/).filter(Boolean)) {
    let row;
    try { row = JSON.parse(line); } catch { complete = false; continue; }
    if (!row || typeof row !== "object") { complete = false; continue; }
    const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
    if (![row.input_tokens, row.output_tokens, row.cached_tokens].every(count) || row.cached_tokens > row.input_tokens) {
      complete = false;
    }
    const input = count(row.input_tokens) ? row.input_tokens : 0;
    const output = count(row.output_tokens) ? row.output_tokens : 0;
    const cacheRead = count(row.cached_tokens) && row.cached_tokens <= input ? row.cached_tokens : 0;
    const usage = { input: input - cacheRead, output, cacheRead, cacheWrite: 0 };
    const visual = row.stage === "VISUAL_ANALYSIS";
    const rates = resolveModelRates((visual ? env.VISUAL_BASE_URL : env.OPENAI_BASE_URL)!,
      row.model || (visual ? env.VISUAL_MODEL : env.MODEL)!, { env, component: visual ? "VISUAL" : "ARC" });
    totals.add({ ...usage, ...(rates && [row.input_tokens, row.output_tokens, row.cached_tokens].every(count) && row.cached_tokens <= input
      ? { cost: usageCost(usage, rates) } : {}) });
  }
  return { modelUsage: totals.count ? totals.summary() : null, usageComplete: totals.count > 0 && complete };
}

export async function writeArcProjectSpec(projectDir: string, env: NodeJS.ProcessEnv): Promise<void> {
  // These commands and paths are the ARC web-react-express template's runtime contract.
  const npm = npmExecutable();
  await writeFile(join(projectDir, "shallowcode.config.json"), JSON.stringify({ adapter: "web",
    install: ["backend", "frontend"].map(cwd => ({ executable: npm, args: ["install", "--no-audit", "--no-fund"], cwd })),
    build: [{ executable: npm, args: ["run", "build"], cwd: "frontend" }],
    start: { executable: npm, args: ["run", "start"], cwd: "backend" }, readyPath: "/",
    dependencyPaths: ["backend", "frontend"],
    generatedPaths: ["frontend/dist", "backend/database.db", "backend/database.db-shm", "backend/database.db-wal", "backend/database.db-journal"],
    env: { ARC_TEST_CLOCK_ENABLED: env.ARC_TEST_NOW ? "1" : "0",
      ARC_TEST_NOW: env.ARC_TEST_NOW ?? "" },
  }, null, 2) + "\n");
}

export async function runArcBaseline(options: { spec: ArcBaselineSpec; sourceDir: string; requirementsDir: string;
  projectDir: string; privateDir: string; env: NodeJS.ProcessEnv; timeoutMs: number | null; signal?: AbortSignal },
  run: (request: ProcessRequest) => ReturnType<typeof runProcess> = runProcess): Promise<CellResult["generation"]> {
  const env = arcEnvironment(options.env);
  const reportFile = join(options.privateDir, "arc-result.json");
  // ARC requires its database inside the output workspace; evaluation excludes this generated
  // path when copying the candidate and binds its own fresh data directory.
  env.ARC_DB_FILE = join(options.projectDir, "backend", "database.db");
  env.ARC_WORKSPACE_ROOT = options.projectDir;
  env.ARC_AGENT_TEMPLATES_ROOT = join(options.sourceDir, "src", "arc-template", "templates");
  const processResult = await run({ executable: options.spec.python,
    args: ["-B", fileURLToPath(new URL("arc-bridge.py", import.meta.url)), options.sourceDir,
      options.requirementsDir, options.projectDir, reportFile, String(await pickFreePort())],
    cwd: options.privateDir, env, logFile: join(options.privateDir, "..", "generation.log"),
    timeoutMs: options.timeoutMs, signal: options.signal })
    .finally(() => writeArcProjectSpec(options.projectDir, env));
  let report;
  try { report = JSON.parse(await readFile(reportFile, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let usage = "";
  try { usage = await readFile(join(options.projectDir, ".arc", "model_usage.jsonl"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const counts = arcUsage(usage, env);
  return { status: processResult.timedOut ? "timed_out" : processResult.exitCode !== 0 || !report || report.failed_stage
    ? "failed" : report.ok ? "completed" : report.failed_nodes?.length ? "partial" : "failed",
    exitCode: processResult.exitCode, durationMs: processResult.durationMs, ...counts,
    usageComplete: processResult.exitCode === 0 && !processResult.timedOut && Boolean(report) && counts.usageComplete,
    ...(processResult.error || report?.error ? { error: processResult.error ?? report.error } : {}) };
}
