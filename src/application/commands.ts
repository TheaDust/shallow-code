import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { spawnProcess } from "../process-spawn.js";
import { runtimeEnvironment } from "../process-lifecycle.js";
import type { ProcessCommand } from "./port.js";

export async function runCommand(
  outputDir: string,
  command: ProcessCommand,
  timeoutMs: number,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  signal?.throwIfAborted();
  timeoutMs = command.timeoutMs ?? timeoutMs;
  const child = spawnCommand(outputDir, command, runtimeEnvironment(env));
  let abortCleanup: Promise<void> | undefined;
  const onAbort = () => {
    abortCleanup = stopProcess(child);
    void abortCleanup.catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout = (stdout + chunk).slice(-8_000);
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-8_000);
  });

  let timeout: NodeJS.Timeout | undefined;
  let result: { kind: "exit"; code: number } | { kind: "timeout" };
  try {
    result = await Promise.race([
      new Promise<{ kind: "exit"; code: number }>((resolvePromise, reject) => {
        child.once("error", reject);
        child.once("close", (code) =>
          resolvePromise({ kind: "exit", code: code ?? -1 }),
        );
      }),
      new Promise<{ kind: "timeout" }>((resolvePromise) => {
        timeout = setTimeout(() => resolvePromise({ kind: "timeout" }), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
  if (abortCleanup) await abortCleanup;
  signal?.throwIfAborted();
  if (result.kind === "timeout") {
    await stopProcess(child);
    throw new Error(`${renderCommand(command)} timed out after ${timeoutMs}ms`);
  }
  if (result.code !== 0) {
    throw new Error(
      `${renderCommand(command)} exited ${result.code}: ${stderr.trim() || stdout.trim()}`,
    );
  }
}

export function spawnCommand(
  outputDir: string,
  command: ProcessCommand,
  env: NodeJS.ProcessEnv,
): ChildProcess {
  return spawnProcess(command.executable, command.args, {
    cwd: commandCwd(outputDir, command.cwd),
    env,
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function commandCwd(
  outputDir: string,
  cwd: ProcessCommand["cwd"],
): string {
  if (cwd === "output") return resolve(outputDir);
  return resolve(outputDir, cwd);
}

export async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolvePromise) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("error", () => resolvePromise());
      killer.once("close", () => resolvePromise());
    });
  } else {
    signalProcessGroup(child.pid, "SIGTERM");
  }
  let timer: NodeJS.Timeout | undefined;
  let onExit: () => void = () => {};
  try {
    await Promise.race([
      new Promise<void>((resolvePromise) => {
        onExit = resolvePromise;
        if (child.exitCode !== null || child.signalCode !== null) resolvePromise();
        else child.once("exit", onExit);
      }),
      new Promise<void>((resolvePromise) => { timer = setTimeout(resolvePromise, 2_000); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    child.off("exit", onExit);
  }
  if (process.platform !== "win32") signalProcessGroup(child.pid, "SIGKILL");
  else if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function renderCommand(command: ProcessCommand): string {
  return [command.executable, ...command.args].join(" ");
}

