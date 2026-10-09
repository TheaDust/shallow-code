import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CandidateRuntime } from "./candidate-runtime.js";
import type { CandidateEvidence } from "./types.js";

import type { AppLifecycle } from "./pipeline.js";
import { spawnProcess } from "./process-spawn.js";
import { runtimeEnvironment } from "./process-lifecycle.js";
import { PlaywrightProbeRunner } from "./judge/playwright-probe-runner.js";
import { copyInheritedData } from "./inherited-data.js";
import type { PlatformContract, ProcessCommand } from "./types.js";

export interface FinalVerificationReport {
  ok: boolean;
  stage: "install" | "build" | "readiness" | "browser" | "candidate" | "complete";
  message: string;
  candidate?: CandidateEvidence;
}

export class CandidatePreparationError extends Error {
  constructor(readonly stage: "install" | "build" | "candidate", message: string) { super(message); }
}

export interface FinalVerifierPort {
  verify(outputDir: string, contract: PlatformContract): Promise<FinalVerificationReport>;
}

export class FinalVerifier implements FinalVerifierPort {
  constructor(
    private readonly runner: Pick<PlaywrightProbeRunner, "run"> = new PlaywrightProbeRunner(),
    private readonly lifecycle: AppLifecycle = new CommandAppLifecycle(),
    private readonly candidate?: CandidateRuntime,
  ) {}

  async verify(
    outputDir: string,
    contract: PlatformContract,
  ): Promise<FinalVerificationReport> {
    if (!this.candidate) {
      const failure = await this.prepareOutputDirectory(outputDir, contract);
      if (failure) return failure;
    }
    let application: Awaited<ReturnType<AppLifecycle["start"]>>;
    try {
      application = await this.lifecycle.start(outputDir, contract);
    } catch (error) {
      return { ok: false, stage: error instanceof CandidatePreparationError ? error.stage : "readiness", message: compactError(error) };
    }

    try {
      const report = await this.runner.run(
        {
          packetId: "final-verification",
          cases: [
            {
              id: "root-page",
              requirementIds: ["delivery"],
              purpose: "happy_path",
              expectationBasis: ["The delivered application serves the root page."],
              steps: [
                { op: "goto", path: "/" },
                {
                  op: "expectVisible",
                  locator: { by: "role", role: "main" },
                },
              ],
            },
          ],
        },
        {
          baseUrl: application.baseUrl,
          stepTimeoutMs: contract.startTimeoutMs,
          caseTimeoutMs: contract.startTimeoutMs,
        },
      );
      if (report.verdict !== "pass") {
        return {
          ok: false,
          stage: "browser",
          message: report.failures.map((failure) => failure.message).join("; "),
        };
      }
      await application.assertUnchanged?.();
    } catch (error) {
      if (!(error instanceof CandidatePreparationError)) throw error;
      return { ok: false, stage: "candidate", message: compactError(error) };
    } finally {
      // Stop before the grader-like start and the final identity check, since
      // shutdown hooks may write files and the probe port must be free again.
      await application.stop();
    }

    // The grader runs install/build in the delivery directory before starting
    // it. The candidate probe above ran against a private copy, so the real
    // output directory is still unprepared; run the contract commands there too
    // so the grader-like start sees the same state the grader will.
    if (this.candidate && (contract.extraPorts?.length ?? 0) > 0) {
      const failure = await this.prepareOutputDirectory(outputDir, contract);
      if (failure) return failure;
    }
    // The platform sets only PORT, so ports the acceptance specs hard-code are
    // bound during grading; verify that layout separately from the private probe.
    const grader = await verifyGraderLikeStart(outputDir, contract);
    if (!grader.ok) return grader;
    try {
      await application.assertUnchanged?.();
    } catch (error) {
      if (!(error instanceof CandidatePreparationError)) throw error;
      return { ok: false, stage: "candidate", message: compactError(error) };
    }
    return { ok: true, stage: "complete", message: "Final verification passed",
      ...(application.candidate ? { candidate: application.candidate } : {}) };
  }

  /** Run the platform install/build commands in the delivery directory. */
  private async prepareOutputDirectory(
    outputDir: string,
    contract: PlatformContract,
  ): Promise<FinalVerificationReport | undefined> {
    try {
      for (const command of contract.installCommands) {
        await runCommand(outputDir, command, contract.buildTimeoutMs);
      }
    } catch (error) {
      return { ok: false, stage: "install", message: compactError(error) };
    }
    try {
      for (const command of contract.buildCommands) {
        await runCommand(outputDir, command, contract.buildTimeoutMs);
      }
    } catch (error) {
      return { ok: false, stage: "build", message: compactError(error) };
    }
    return undefined;
  }
}

const EXTRA_PORT_TIMEOUT_MS = 5_000;
/** Paths a browser or grader may request; the server must answer and stay alive. */
const ROBUSTNESS_PATHS = ["/favicon.ico", "/this-path-does-not-exist", "/api/this-route-does-not-exist"];

/**
 * Start the application exactly as the platform does: only PORT is set, so any
 * port the acceptance specs hard-code (for example 3301) is bound too, unknown
 * paths must return a response, and the process must never die on them.
 */
export async function verifyGraderLikeStart(
  outputDir: string,
  contract: PlatformContract,
): Promise<FinalVerificationReport> {
  const extraPorts = contract.extraPorts ?? [];
  if (extraPorts.length === 0) {
    return { ok: true, stage: "complete", message: "Grader-like extra ports not configured" };
  }
  const dataDirectory = contract.dataDirectory ?? await mkdtemp(join(tmpdir(), "shallow-grader-"));
  if (!contract.dataDirectory) {
    try { await copyInheritedData(outputDir, dataDirectory); }
    catch (error) {
      await rm(dataDirectory, { recursive: true, force: true });
      return { ok: false, stage: "readiness", message: `Inherited data preparation failed: ${compactError(error)}` };
    }
  }
  const environment = runtimeEnvironment({ PORT: String(contract.port), SHALLOW_DATA_DIR: dataDirectory });
  // The grader never sets ARC_EXTRA_PORTS, so the extra listeners must bind.
  delete environment.ARC_EXTRA_PORTS;
  const child = spawnCommand(outputDir, contract.startCommand, environment);
  let spawnError: Error | undefined;
  let stderr = "";
  child.on("error", (error) => { spawnError = error; });
  // Drain both pipes: a verbose server can otherwise block before readiness.
  child.stdout?.resume();
  child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8_000); });
  const failure = (): string | undefined => spawnError?.message ?? (child.exitCode !== null || child.signalCode !== null
    ? `Application exited during grader-like startup: ${stderr || child.exitCode || child.signalCode}` : undefined);
  try {
    await waitForReadiness(`${contract.baseUrl}${contract.healthPath}`, contract.startTimeoutMs, failure);
    const missing = await waitForExtraPorts(extraPorts, contract, failure);
    if (missing.length) {
      return { ok: false, stage: "readiness", message:
        `PORT CONTRACT violated: the acceptance specs default to http://127.0.0.1:${missing.join(", ")} while the ` +
        `grader starts the backend with only PORT=${contract.port}; the backend bound PORT but not ${missing.join(", ")}. ` +
        "Serve the same handler on each port with a separate http.createServer(handler).listen(port) unless ARC_EXTRA_PORTS=0." };
    }
    await robustnessProbe(contract, failure);
    return { ok: true, stage: "complete", message: "Grader-like startup verified" };
  } catch (error) {
    return { ok: false, stage: "readiness", message: compactError(error) };
  } finally {
    await stopProcess(child);
    if (!contract.dataDirectory) await rm(dataDirectory, { recursive: true, force: true });
  }
}

async function waitForExtraPorts(
  ports: number[],
  contract: PlatformContract,
  failure: () => string | undefined,
): Promise<number[]> {
  const deadline = Date.now() + EXTRA_PORT_TIMEOUT_MS;
  let missing = [...ports];
  while (missing.length && Date.now() < deadline) {
    const message = failure();
    if (message) throw new Error(message);
    const stillMissing: number[] = [];
    for (const port of missing) if (!await answersHttp(port, contract.healthPath)) stillMissing.push(port);
    missing = stillMissing;
    if (missing.length) await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  return missing;
}

async function robustnessProbe(contract: PlatformContract, failure: () => string | undefined): Promise<void> {
  for (const path of ROBUSTNESS_PATHS) {
    const before = failure();
    if (before) throw new Error(before);
    try {
      await fetch(`${contract.baseUrl}${path}`, { signal: AbortSignal.timeout(2_000) });
    } catch {
      const after = failure();
      throw new Error(`GET ${path} got no HTTP response; unknown paths must return 404 and the process must stay alive${after ? ` (${after})` : ""}`);
    }
    const after = failure();
    if (after) throw new Error(`GET ${path} killed the application: ${after}`);
  }
}

async function answersHttp(port: number, path: string): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(1_000) });
    return true;
  } catch { return false; }
}

export class CommandAppLifecycle implements AppLifecycle {
  async start(outputDir: string, contract: PlatformContract) {
    await assertPortFree(contract);
    const child = spawnCommand(outputDir, contract.startCommand, runtimeEnvironment({
      // Probes run on the private probe port only: never bind the evaluation
      // port (or spec-hardcoded extra ports like 3301) during generation.
      PORT: String(contract.port),
      ARC_EXTRA_PORTS: "0",
      ...(contract.dataDirectory ? { SHALLOW_DATA_DIR: contract.dataDirectory } : {}),
    }));
    let spawnError: Error | undefined;
    let stderr = "";
    child.on("error", (error) => { spawnError = error; });
    // Drain both pipes: a verbose server can otherwise block before readiness.
    child.stdout?.resume();
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8_000); });
    try {
      await waitForReadiness(
        `${contract.baseUrl}${contract.healthPath}`,
        contract.startTimeoutMs,
        () => spawnError?.message ?? (child.exitCode !== null || child.signalCode !== null
          ? `Application exited before readiness: ${stderr || child.exitCode || child.signalCode}`
          : undefined),
      );
    } catch (error) {
      await stopProcess(child);
      throw error;
    }
    let stopped = false;
    return {
      baseUrl: contract.baseUrl,
      assertUnchanged: async () => {
        if (!stopped && (spawnError || child.exitCode !== null || child.signalCode !== null)) throw new CandidatePreparationError("candidate", "Owned application process exited during verification");
      },
      stop: async () => {
        if (stopped) return;
        // Mark stopped first so a slow socket release can never wedge shutdown
        // into a retry loop or turn a completed probe into an inconclusive one.
        stopped = true;
        await stopProcess(child);
        // The kernel may release the listening socket a few milliseconds after
        // the process exits (SIGTERM handling, keep-alive sockets). Wait for the
        // port to actually become free instead of asserting once, so the next
        // start on this port does not race a lingering listener. Enforcement of
        // a free port stays with the next start(); shutdown only best-effort waits.
        await waitForPortFree(contract, PORT_RELEASE_TIMEOUT_MS);
      },
    };
  }
}

export async function runCommand(
  outputDir: string,
  command: ProcessCommand,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const child = spawnCommand(outputDir, command, runtimeEnvironment());
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

function spawnCommand(
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

async function waitForReadiness(
  url: string,
  timeoutMs: number,
  failure: () => string | undefined,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = failure();
    if (message) throw new Error(message);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok && !failure()) return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`Application did not become ready at ${url}`);
}

async function stopProcess(child: ChildProcess): Promise<void> {
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

function compactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .slice(0, 1_500);
}

async function assertPortFree(contract: PlatformContract): Promise<void> {
  const server = createServer();
  const host = new URL(contract.baseUrl).hostname.replace(/^\[|\]$/g, "");
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", () => reject(new Error(`Application port ${contract.port} is already occupied`)));
    server.listen(contract.port, host, () => server.close((error) => error ? reject(error) : resolvePromise()));
  });
}

/** Upper bound for the kernel to release a candidate's listening socket after shutdown. */
const PORT_RELEASE_TIMEOUT_MS = 2_000;

/**
 * Best-effort wait until the application port can be bound again after stop.
 * Returns false on timeout instead of throwing: shutdown must not fail just
 * because the socket is released slightly after the process exited.
 */
async function waitForPortFree(contract: PlatformContract, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canBind(contract)) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  return canBind(contract);
}

async function canBind(contract: PlatformContract): Promise<boolean> {
  const server = createServer();
  const host = new URL(contract.baseUrl).hostname.replace(/^\[|\]$/g, "");
  try {
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(contract.port, host, () => server.close((error) => error ? reject(error) : resolvePromise()));
    });
    return true;
  } catch { return false; }
}
