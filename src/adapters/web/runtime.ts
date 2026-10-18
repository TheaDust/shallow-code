import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeEnvironment } from "../../process-lifecycle.js";
import { copyInheritedData } from "../../inherited-data.js";
import { spawnCommand, stopProcess } from "../../application/commands.js";
import { CandidatePreparationError, type ApplicationContract, type ApplicationLifecycle, type DeliveryReport } from "../../application/port.js";
import { webRuntimeConfig, type WebRuntimeConfig } from "./project-spec.js";

const EXTRA_PORT_TIMEOUT_MS = 5_000;
/** Requests must receive an HTTP response while the server stays alive. */
const ROBUSTNESS_PATHS = ["/favicon.ico", "/this-path-does-not-exist", "/api/this-route-does-not-exist"];

/**
 * Verify additional services declared by the project, with the same environment
 * and isolated inherited data used by the main application.
 */
export async function verifyDeclaredPorts(
  outputDir: string,
  application: ApplicationContract,

): Promise<DeliveryReport> {
  const contract = { ...application, ...webRuntimeConfig(application) };
  const extraPorts = contract.extraPorts ?? [];
  if (extraPorts.length === 0) {
    return { ok: true, stage: "complete", message: "Additional service ports not configured" };
  }
  const dataDirectory = contract.dataDirectory ?? await mkdtemp(join(tmpdir(), "shallow-delivery-"));
  if (!contract.dataDirectory) {
    try { await copyInheritedData(outputDir, dataDirectory, contract.dataPaths); }
    catch (error) {
      await rm(dataDirectory, { recursive: true, force: true });
      return { ok: false, stage: "readiness", message: `Inherited data preparation failed: ${compactError(error)}` };
    }
  }
  const environment = runtimeEnvironment({ ...contract.env, PORT: String(contract.port),
    [contract.dataEnvVar ?? "SHALLOW_DATA_DIR"]: dataDirectory });
  delete environment.SHALLOW_EXTRA_PORTS;
  const child = spawnCommand(outputDir, contract.startCommand, environment);
  let spawnError: Error | undefined;
  let stderr = "";
  child.on("error", (error) => { spawnError = error; });
  // Drain both pipes: a verbose server can otherwise block before readiness.
  child.stdout?.resume();
  child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8_000); });
  const failure = (): string | undefined => spawnError?.message ?? (child.exitCode !== null || child.signalCode !== null
    ? `Application exited during delivery startup: ${stderr || child.exitCode || child.signalCode}` : undefined);
  try {
    await waitForReadiness(`${contract.baseUrl}${contract.healthPath}`, contract.startTimeoutMs, failure);
    const missing = await waitForExtraPorts(extraPorts, contract, failure);
    if (missing.length) {
      return { ok: false, stage: "readiness", message:
        `Project port declaration violated: application started with PORT=${contract.port} but declared services did not respond on ${missing.join(", ")}.` };
    }
    await robustnessProbe(contract, failure);
    return { ok: true, stage: "complete", message: "Declared service ports verified" };
  } catch (error) {
    return { ok: false, stage: "readiness", message: compactError(error) };
  } finally {
    await stopProcess(child);
    if (!contract.dataDirectory) await rm(dataDirectory, { recursive: true, force: true });
  }
}

async function waitForExtraPorts(
  ports: number[],
  contract: WebRuntimeConfig,
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

async function robustnessProbe(contract: WebRuntimeConfig,
 failure: () => string | undefined): Promise<void> {
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

export class WebAppLifecycle implements ApplicationLifecycle {
  async start(outputDir: string, application: ApplicationContract) {
    const contract = { ...application, ...webRuntimeConfig(application) };
    await assertPortFree(contract);
    const child = spawnCommand(outputDir, contract.startCommand, runtimeEnvironment({
      ...contract.env,
      // Candidate cases run independently on their private application port.
      PORT: String(contract.port),
      SHALLOW_EXTRA_PORTS: "0",
      ...(contract.dataDirectory ? { [contract.dataEnvVar ?? "SHALLOW_DATA_DIR"]: contract.dataDirectory } : {}),
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
      metadata: { baseUrl: contract.baseUrl },
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

function compactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .slice(0, 1_500);
}

async function assertPortFree(contract: WebRuntimeConfig): Promise<void> {
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
async function waitForPortFree(contract: WebRuntimeConfig,
 timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canBind(contract)) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  return canBind(contract);
}

async function canBind(contract: WebRuntimeConfig): Promise<boolean> {
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
