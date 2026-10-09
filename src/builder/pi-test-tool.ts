import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { toolEnvironment } from "../process-lifecycle.js";
import { PROGRESS_DIR_NAME } from "../progress-journal.js";

const FRONTEND_TIMEOUT_MS = 600_000;
const BACKEND_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 30_000;
const MAX_SUCCESS_OUTPUT_CHARS = 2_000;

const parameters = Type.Object({
  target: Type.Union([Type.Literal("frontend"), Type.Literal("backend"), Type.Literal("all")], {
    description: "Which application test suite to run: frontend Vitest, backend node:test, or both in sequence",
  }),
  filter: Type.Optional(Type.String({
    description: "Optional single test-file name or substring pattern; run only matching tests",
  })),
  reuse: Type.Optional(Type.Boolean({
    description: "Explicitly reuse a successful deterministic test run independent of runtime data and generated output; defaults to false",
  })),
});

export interface TestToolOptions {
  spawnFn?: typeof spawn;
  frontendTimeoutMs?: number;
  backendTimeoutMs?: number;
}

interface SuiteResult {
  target: string;
  command: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  output: string;
  cached?: boolean;
}

const DIGEST_IGNORED_DIRECTORIES = new Set(["node_modules", "dist", "build", "coverage", ".data", ".git", ".arc", PROGRESS_DIR_NAME]);

/**
 * Bounded-memory test runner for the Builder: tests run single-worker so the
 * suite's peak RSS stays small inside the evaluation cgroup. Spawning uses the
 * current Node executable and the project's own Vitest entry, so no npm shim
 * processes or watch modes are involved.
 */
export function createTestTool(cwd: string, options: TestToolOptions = {}): ToolDefinition<typeof parameters> {
  const spawnFn = options.spawnFn ?? spawn;
  const timeouts = { frontend: options.frontendTimeoutMs ?? FRONTEND_TIMEOUT_MS, backend: options.backendTimeoutMs ?? BACKEND_TIMEOUT_MS };
  const successful = new Map<string, SuiteResult>();
  return {
    name: "run_tests",
    label: "Run tests (bounded memory)",
    description:
      "Run the application's traditional tests with bounded memory (single worker, no watch mode). " +
      "frontend runs the Vitest suite in frontend/, backend runs node:test in backend/, all runs both in sequence. " +
      "Pass filter to run only one test file/pattern. Tests execute by default; reuse=true is only for deterministic tests independent of runtime data and generated output. " +
      "Explicit reuse requires an identical successful target/filter and unchanged project source, test, configuration and lockfile inputs. " +
      "Returns exit code, duration and the output tail (failures print at the end).",
    promptSnippet: "run_tests: bounded-memory test runner (frontend/backend/all, single worker)",
    parameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      const targets = params.target === "all" ? (["frontend", "backend"] as const) : ([params.target] as const);
      const results: SuiteResult[] = [];
      for (const target of targets) {
        const digest = params.reuse ? await suiteDigest(cwd, target, params.filter) : undefined;
        signal?.throwIfAborted();
        const cached = digest ? successful.get(digest) : undefined;
        if (cached) {
          results.push({ ...cached, durationMs: 0, cached: true });
          continue;
        }
        const result = await runSuite(spawnFn, cwd, target, timeouts[target], params.filter, signal);
        results.push(result);
        if (digest && result.exitCode === 0 && !result.timedOut) successful.set(digest, result);
      }
      return {
        content: [{ type: "text" as const, text: results.map(formatResult).join("\n\n") }],
        details: {
          results: results.map(result => ({ target: result.target, command: result.command,
            exitCode: result.exitCode, durationMs: result.durationMs, timedOut: result.timedOut,
            cached: result.cached === true })),
        },
      };
    },
  };
}

/** Explicit reuse covers project inputs across suites; generated/runtime tests execute normally. */
async function suiteDigest(cwd: string, target: "frontend" | "backend", filter: string | undefined): Promise<string> {
  const root = cwd;
  const hash = createHash("sha256").update(`${target}\0${filter ?? ""}\0`);
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isDirectory() && DIGEST_IGNORED_DIRECTORIES.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        hash.update(relative(root, path).replaceAll("\\", "/")).update("\0");
        hash.update(await readFile(path)).update("\0");
      }
    }
  };
  try { await visit(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    hash.update("<missing-suite-directory>");
  }
  return hash.digest("hex");
}

async function runSuite(spawnFn: typeof spawn, cwd: string, target: "frontend" | "backend", timeoutMs: number,
  filter: string | undefined, signal: AbortSignal | undefined): Promise<SuiteResult> {
  const directory = join(cwd, target);
  let file: string;
  let args: string[];
  let command: string;
  if (target === "frontend") {
    const vitestEntry = join(directory, "node_modules", "vitest", "vitest.mjs");
    await access(vitestEntry).catch(() => {
      throw new Error("frontend Vitest is not installed (frontend/node_modules/vitest missing); run the platform install command first, then retry run_tests");
    });
    file = process.execPath;
    args = [vitestEntry, "run", "--maxWorkers=1", ...(filter ? [filter] : [])];
    command = `vitest run --maxWorkers=1${filter ? ` ${filter}` : ""}`;
  } else {
    await access(directory).catch(() => {
      throw new Error("backend/ directory does not exist yet; create the backend before running backend tests");
    });
    file = process.execPath;
    args = ["--test", "--test-concurrency=1", ...(filter ? [filter] : [])];
    command = `node --test --test-concurrency=1${filter ? ` ${filter}` : ""}`;
  }
  const started = Date.now();
  const child = spawnFn(file, args, { cwd: directory, env: { ...toolEnvironment(), CI: "1" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let truncated = false;
  const onData = (chunk: Buffer | string) => {
    output += chunk.toString();
    if (output.length > MAX_OUTPUT_CHARS) { output = output.slice(-MAX_OUTPUT_CHARS); truncated = true; }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  let timedOut = false;
  const abort = () => { child.kill(); };
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
  try {
    const exitCode = await new Promise<number | null>((resolvePromise, reject) => { child.once("error", reject); child.once("exit", resolvePromise); });
    signal?.throwIfAborted();
    return { target, command, exitCode, durationMs: Date.now() - started, timedOut,
      output: (truncated ? `[output truncated to the last ${MAX_OUTPUT_CHARS} characters]\n` : "") + output.trim() };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    child.stdout.destroy();
    child.stderr.destroy();
  }
}

function formatResult(result: SuiteResult): string {
  const outcome = result.timedOut ? "timed out" : `exit code ${result.exitCode ?? "unknown"}`;
  const successful = result.exitCode === 0 && !result.timedOut;
  const output = successful && result.output.length > MAX_SUCCESS_OUTPUT_CHARS
    ? `[successful output abbreviated to the last ${MAX_SUCCESS_OUTPUT_CHARS} characters]\n${result.output.slice(-MAX_SUCCESS_OUTPUT_CHARS)}`
    : result.output;
  const reuse = result.cached ? "\nreused successful result: source digest unchanged" : "";
  return `[${result.target}] ${result.command}\n${outcome}, duration ${(result.durationMs / 1_000).toFixed(1)}s${reuse}\n${output || "(no output)"}`;
}
