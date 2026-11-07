import { open, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ownProcessTree, withoutInheritedNpmPolicy } from "../process-lifecycle.js";
import { spawnProcess } from "../process-spawn.js";

export interface ProcessRequest {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logFile: string;
  /** null disables the wall timer while preserving cancellation and process-tree cleanup. */
  timeoutMs: number | null;
  message?: object;
  signal?: AbortSignal;
}

export interface ProcessResult {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  error?: string;
}

async function stopDetachedDescendants(pid: number): Promise<void> {
  // Pi workers and application commands can create new process groups on POSIX.
  // Freeze the owner before enumerating descendants so deadline cleanup includes those groups.
  try { process.kill(pid, "SIGSTOP"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw error; }
  const { stdout } = await promisify(execFile)("ps", ["-eo", "pid=,ppid="]);
  const rows = stdout.trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
  const descendants: number[] = [];
  const visit = (parent: number) => {
    for (const [child, owner] of rows) if (owner === parent) { visit(child); descendants.push(child); }
  };
  visit(pid);
  for (const child of descendants) {
    try { process.kill(child, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
}

/** An IPC worker waits until its process tree is owned before starting a phase. */
export async function runProcess(request: ProcessRequest): Promise<ProcessResult> {
  request.signal?.throwIfAborted();
  await mkdir(dirname(request.logFile), { recursive: true });
  const log = await open(request.logFile, "a");
  const started = Date.now();
  let tree: Awaited<ReturnType<typeof ownProcessTree>> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let outcome: ProcessResult | undefined;
  let abort = () => {};
  const child = spawnProcess(request.executable, request.args, { cwd: request.cwd, env: withoutInheritedNpmPolicy(request.env),
    detached: process.platform !== "win32", windowsHide: true,
    stdio: request.message === undefined ? ["ignore", log.fd, log.fd] : ["ignore", log.fd, log.fd, "ipc"] });
  const exited = new Promise<ProcessResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => resolve({ exitCode: code, timedOut: false, durationMs: Date.now() - started }));
  });
  // Install the rejection handler before waiting for process ownership.
  void exited.catch(() => {});
  try {
    tree = await ownProcessTree(child);
    if (request.message !== undefined) child.send!(request.message);
    outcome = await Promise.race([exited, new Promise<ProcessResult>((resolve, reject) => {
      if (request.timeoutMs !== null) timer = setTimeout(() => resolve({ exitCode: null, timedOut: true, durationMs: Date.now() - started }), Math.max(1, request.timeoutMs - (Date.now() - started)));
      abort = () => reject(request.signal?.reason ?? new Error("Experiment interrupted"));
      request.signal?.addEventListener("abort", abort, { once: true });
      if (request.signal?.aborted) abort();
    })]);
    return outcome;
  } catch (error) {
    if (request.signal?.aborted) throw error;
    outcome = { exitCode: null, timedOut: false, durationMs: Date.now() - started, error: String(error) };
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
    request.signal?.removeEventListener("abort", abort);
    try {
      try {
        if (process.platform !== "win32" && child.pid) await stopDetachedDescendants(child.pid);
      } finally { if (tree) await tree.stop(); else child.kill("SIGKILL"); }
    } finally {
      await log.close();
      if (outcome) outcome.durationMs = Date.now() - started;
    }
  }
}
