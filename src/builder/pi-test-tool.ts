import { type spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Type } from "typebox";
import type { BuilderTool } from "./tool-contract.js";
import { toolEnvironment } from "../process-lifecycle.js";
import { spawnProcess } from "../process-spawn.js";
import { stopProcess } from "../final-verifier.js";
import { minimalWebProjectSpec, DEFAULT_TEST_TIMEOUT_MS } from "../project-spec.js";
import type { PlatformContract } from "../types.js";
import { PROGRESS_DIR_NAME } from "../progress-journal.js";

const MAX_OUTPUT_CHARS = 30_000;
const MAX_SUCCESS_OUTPUT_CHARS = 2_000;
const parameters = Type.Object({
  target: Type.String({ description: "Declared project test target id, or all to run every target sequentially" }),
  filter: Type.Optional(Type.String({ description: "Optional single test-file name or pattern, appended as one argument to the declared command" })),
  reuse: Type.Optional(Type.Boolean({ description: "Explicitly reuse a successful deterministic test run independent of runtime data and generated output; defaults to false" })),
});
export interface TestToolOptions {
  spawnFn?: typeof spawn;
  frontendTimeoutMs?: number;
  backendTimeoutMs?: number;
  contract?: PlatformContract;
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
const DIGEST_IGNORED_DIRECTORIES = new Set(["node_modules", ".git", ".arc", PROGRESS_DIR_NAME]);

/** Execute the frozen project declaration; template tests use single-worker commands. */
export function createTestTool(cwd: string, options: TestToolOptions = {}): BuilderTool<typeof parameters> {
  const targets = options.contract ? options.contract.testTargets ?? [] : minimalWebProjectSpec(process.execPath).tests!;
  const successful = new Map<string, SuiteResult>();
  const environment = { ...toolEnvironment(), ...options.contract?.env, CI: "1",
    ...(options.contract?.dataDirectory ? { [options.contract.dataEnvVar ?? "SHALLOW_DATA_DIR"]: options.contract.dataDirectory } : {}) };
  return {
    name: "run_tests",
    label: "Run project tests",
    description: `Run declared project tests sequentially with timeouts and no watch mode. Targets: ${targets.map(t => t.id).join(", ") || "(none declared)"}. ` +
      "all runs every declared target. filter is appended as one argument. Tests execute by default; reuse=true requires deterministic tests independent of runtime/generated data, unchanged project inputs and an identical successful command.",
    promptSnippet: "run_tests: run a declared project target or all",
    parameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      if (params.filter && (isAbsolute(params.filter) || /^[A-Za-z]:/.test(params.filter) || params.filter.split(/[\\/]/).includes(".."))) {
        throw new Error("Test filters must stay inside the project");
      }
      const selected = params.target === "all" ? targets : targets.filter(target => target.id === params.target);
      if (!selected.length) throw new Error(`No declared test target ${params.target}; configure tests in shallowcode.config.json`);
      const results: SuiteResult[] = [];
      for (const target of selected) {
        const digest = params.reuse ? await suiteDigest(cwd, { target, filter: params.filter, environment }, options.contract?.generatedPaths) : undefined;
        signal?.throwIfAborted();
        const cached = digest ? successful.get(digest) : undefined;
        if (cached) { results.push({ ...cached, durationMs: 0, cached: true }); continue; }
        const timeout = target.timeoutMs ?? (target.id === "frontend" ? options.frontendTimeoutMs : target.id === "backend" ? options.backendTimeoutMs : undefined) ?? DEFAULT_TEST_TIMEOUT_MS;
        const result = await runSuite(cwd, target, timeout, params.filter, signal, environment, options.spawnFn);
        results.push(result);
        if (digest && result.exitCode === 0 && !result.timedOut) successful.set(digest, result);
      }
      return {
        content: [{ type: "text" as const, text: results.map(formatResult).join("\n\n") }],
        details: { results: results.map(result => ({ target: result.target, command: result.command, exitCode: result.exitCode,
          durationMs: result.durationMs, timedOut: result.timedOut, cached: result.cached === true })) },
      };
    },
  };
}

async function suiteDigest(root: string, invocation: unknown, generatedPaths: readonly string[] = []): Promise<string> {
  const hash = createHash("sha256").update(JSON.stringify(invocation)).update("\0");
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const rel = relative(root, path).replaceAll("\\", "/");
      if (DIGEST_IGNORED_DIRECTORIES.has(entry.name) || generatedPaths.some(p => rel === p || rel.startsWith(p + "/"))) continue;
      if (entry.isSymbolicLink()) throw new Error(`Test input links are not supported: ${rel}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) { hash.update(rel).update("\0"); hash.update(await readFile(path)).update("\0"); }
    }
  }
  await visit(root);
  return hash.digest("hex");
}

async function runSuite(root: string, target: { id: string; executable: string; args?: string[]; cwd?: string }, timeoutMs: number,
  filter: string | undefined, signal: AbortSignal | undefined, environment: NodeJS.ProcessEnv, spawnFn?: typeof spawn): Promise<SuiteResult> {
  const directory = resolve(root, !target.cwd || target.cwd === "output" ? "." : target.cwd);
  const rel = relative(resolve(root), directory);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) throw new Error("Test working directory must stay inside the project");
  await access(directory).catch(() => { throw new Error(`Test working directory ${directory} does not exist; create it and run the project install command first`); });
  const args = [...(target.args ?? [])];
  if ((target.executable === process.execPath || /^node(?:\.exe)?$/i.test(target.executable)) && args[0] && !args[0].startsWith("-")) {
    args[0] = resolve(directory, args[0]);
    await access(args[0]).catch(() => { throw new Error(`Test entry ${args[0]} is not installed; run the project install command first`); });
  }
  if (filter) args.push(filter);
  const command = [target.executable, ...(target.args ?? []), ...(filter ? [filter] : [])].join(" ");
  signal?.throwIfAborted();
  const started = Date.now();
  const child = (spawnFn ?? spawnProcess)(target.executable, args, { cwd: directory, env: environment, windowsHide: true,
    detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  const registered = process.platform !== "win32" && process.send !== undefined && child.pid !== undefined;
  if (registered) process.send!({ type: "builder_tool_process", pid: child.pid, active: true });
  let output = "", truncated = false, timedOut = false;
  const onData = (chunk: Buffer | string) => {
    output += chunk.toString();
    if (output.length > MAX_OUTPUT_CHARS) { output = output.slice(-MAX_OUTPUT_CHARS); truncated = true; }
  };
  child.stdout!.on("data", onData); child.stderr!.on("data", onData);
  let stopping: Promise<void> | undefined;
  const abort = () => {
    stopping ??= spawnFn ? Promise.resolve().then(() => { child.kill(); }) : stopProcess(child);
    void stopping.catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
  try {
    const exitCode = await new Promise<number | null>((res, reject) => { child.once("error", reject); child.once("close", res); });
    if (stopping) await stopping;
    signal?.throwIfAborted();
    return { target: target.id, command, exitCode, durationMs: Date.now() - started, timedOut,
      output: (truncated ? `[output truncated to the last ${MAX_OUTPUT_CHARS} characters]\n` : "") + output.trim() };
  } finally {
    clearTimeout(timer); signal?.removeEventListener("abort", abort);
    if (stopping) await stopping;
    if (!spawnFn && process.platform !== "win32") await stopProcess(child);
    child.stdout!.destroy(); child.stderr!.destroy();
    if (registered && process.connected) process.send!({ type: "builder_tool_process", pid: child.pid, active: false });
  }
}
function formatResult(result: SuiteResult): string {
  const outcome = result.timedOut ? "timed out" : `exit code ${result.exitCode ?? "unknown"}`;
  const output = result.exitCode === 0 && !result.timedOut && result.output.length > MAX_SUCCESS_OUTPUT_CHARS
    ? `[successful output abbreviated to the last ${MAX_SUCCESS_OUTPUT_CHARS} characters]\n${result.output.slice(-MAX_SUCCESS_OUTPUT_CHARS)}` : result.output;
  return `[${result.target}] ${result.command}\n${outcome}, duration ${(result.durationMs / 1_000).toFixed(1)}s${result.cached ? "\nreused successful result: source digest unchanged" : ""}\n${output || "(no output)"}`;
}
