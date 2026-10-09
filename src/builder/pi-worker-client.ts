import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import type { GatewayConfig } from "../runtime-config.js";
import type { CodingAgentRequest, CodingAgentResult, CodingAgentPort } from "./execution-port.js";
import type { ExecutionTiming, ExecutionUsage } from "./pi-execution-stats.js";
import { ownProcessTree, toolEnvironment } from "../process-lifecycle.js";
import { ExecutionFault } from "../execution-fault.js";
import { sanitizeDiagnosticText } from "../diagnostics.js";
import { copyInheritedData } from "../inherited-data.js";
import { BuilderApp, type AppAction } from "./builder-app.js";
import type { BuilderTermination } from "./port.js";

export interface PiWorkerRequest extends CodingAgentRequest {
  gateway: GatewayConfig;
  sessionDir: string;
  sessionFile?: string;
  /** Debug-only destination for raw SSE bodies; see `SHALLOW_CAPTURE_SSE`. */
  sseCaptureDir?: string;
}
export interface PiWorkerResult extends CodingAgentResult {
  sessionFile?: string;
  imageUnsupported?: boolean;
  toolCalls?: number;
  compactions?: number;
  peakRssBytes?: number;
  usage?: ExecutionUsage;
  timing?: ExecutionTiming;
  termination?: BuilderTermination;
}
export interface PiWorkerProgress {
  type: "builder_progress";
  sessionId: string;
  toolCalls: number;
  compactions: number;
  usage: ExecutionUsage;
  timing: ExecutionTiming;
  termination: BuilderTermination;
}

/** One child per prompt. Never imports the SDK in the long-lived controller. */
export class PiWorkerClient implements CodingAgentPort {
  private sessions = new Map<string, { file: string; cwd: string }>();
  private active?: { child: ChildProcess; finished: Promise<void> };
  private closed = false;
  constructor(private gateway: GatewayConfig, private sessionDir: string, private sseCaptureDir?: string) {}

  async run(input: CodingAgentRequest): Promise<PiWorkerResult> {
    const started = Date.now();
    if (this.closed || this.active) throw new Error("Pi client is closed or already running");
    await mkdir(this.sessionDir, { recursive: true, mode: 0o700 });
    const prior = input.sessionKey ? this.sessions.get(input.sessionKey) : undefined;
    if (prior && prior.cwd !== resolve(input.outputDir)) throw new Error("Pi session workspace mismatch");
    const fallback: PiWorkerResult = { sessionId: randomUUID(), outcome: "failed", summary: "Pi worker exited before producing a result" };
    const dataDirectory = await mkdtemp(join(resolve(this.sessionDir), "data-"));
    try { await copyInheritedData(input.outputDir, dataDirectory); }
    catch (error) {
      await rm(dataDirectory, { recursive: true, force: true });
      throw new ExecutionFault("builder", "builder_start", false, { cause: error });
    }
    const application = input.platformContract ? new BuilderApp(input.outputDir, { ...input.platformContract, dataDirectory }) : undefined;
    const child = fork(fileURLToPath(new URL("./pi-worker.ts", import.meta.url)), [], {
      cwd: input.outputDir, execArgv: ["--import", import.meta.resolve("tsx")],
      env: { ...toolEnvironment(), SHALLOW_DATA_DIR: dataDirectory }, detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let finish!: () => void;
    const finished = new Promise<void>(res => { finish = res; });
    this.active = { child, finished };
    const onAppRequest = (message: unknown) => {
      const request = message as { type?: string; id?: string; action?: string } | null;
      if (request?.type !== "builder_app" || typeof request.id !== "string" || !["start", "stop", "status"].includes(request.action ?? "")) return;
      const respond = (detail: object) => {
        if (child.connected) child.send({ type: "builder_app_result", id: request.id, ...detail }, () => {});
      };
      if (!application) { respond({ error: "No application contract provided" }); return; }
      void application.run(request.action as AppAction).then(status => respond({ status }),
        error => respond({ error: sanitizeDiagnosticText(String(error), [this.gateway.apiKey]) }));
    };
    child.on("message", onAppRequest);
    let timer: NodeJS.Timeout | undefined;
    let tree: Awaited<ReturnType<typeof ownProcessTree>> | undefined;
    let stderr = "";
    let progress: PiWorkerProgress | undefined;
    child.stderr?.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-4_000); });
    let result: PiWorkerResult;
    let cleanupMs = 0;
    // The evaluation runner kills silent processes: keep a heartbeat on stderr
    // for the whole call (worker output stays buffered for diagnostics only).
    const heartbeat = setInterval(() => {
      process.stderr.write(`[ShallowCode] builder call still running (${Math.floor((Date.now() - started) / 1000)}s elapsed)\n`);
    }, 30_000);
    heartbeat.unref();
    try {
      const completed = new Promise<PiWorkerResult>((res, rej) => {
        child.once("error", rej);
        child.once("exit", () => res({ ...fallback, ...progress, summary: stderr || fallback.summary }));
        child.on("message", message => {
          if (message && typeof message === "object" && "type" in message && message.type === "builder_progress") progress = message as PiWorkerProgress;
          if (message && typeof message === "object" && "outcome" in message) res(message as PiWorkerResult);
        });
        timer = setTimeout(() => res({ ...fallback, ...progress, outcome: "timed_out", summary: "Pi call deadline reached" }), Math.max(1, input.timeoutMs));
      });
      tree = await ownProcessTree(child);
      child.send({ ...input, gateway: this.gateway, sessionDir: this.sessionDir, sessionFile: prior?.file,
        ...(this.sseCaptureDir ? { sseCaptureDir: this.sseCaptureDir } : {}) } satisfies PiWorkerRequest);
      result = await completed;
    } catch (error) {
      throw new ExecutionFault("builder", "builder_start", false, { cause: error });
    } finally {
      clearInterval(heartbeat);
      if (timer) clearTimeout(timer);
      const cleanupStarted = Date.now();
      try {
        child.off("message", onAppRequest);
        try {
          if (tree) await tree.stop();
          else child.kill("SIGKILL");
        } finally { await application?.close(); }
        await rm(dataDirectory, { recursive: true, force: true });
      } catch (error) {
        throw new ExecutionFault("builder", "builder_cleanup", false, { cause: error });
      } finally { cleanupMs = Date.now() - cleanupStarted; this.active = undefined; finish(); }
    }
    result.summary = sanitizeDiagnosticText(result.summary, [this.gateway.apiKey]);
    if (result.termination?.recoveryError) {
      result.termination.recoveryError = sanitizeDiagnosticText(result.termination.recoveryError, [this.gateway.apiKey], 1000);
    }
    result.execution = { engine: "pi", version: "0.73.1", nodeVersion: process.version, workerPid: child.pid!,
      resumed: Boolean(prior), durationMs: Date.now() - started, cleanupMs, toolCalls: result.toolCalls,
      compactions: result.compactions, peakRssBytes: result.peakRssBytes,
      usage: result.usage ?? { status: "unavailable" }, ...(result.timing ? { timing: result.timing } : {}),
      ...(result.termination ? { termination: result.termination } : {}) };
    if (input.sessionKey) {
      if (result.outcome === "completed" && result.sessionFile) this.sessions.set(input.sessionKey, { file: result.sessionFile, cwd: resolve(input.outputDir) });
      else this.sessions.delete(input.sessionKey);
    }
    return result;
  }

  async close(): Promise<void> {
    this.closed = true;
    const active = this.active;
    if (active) { active.child.kill(); await active.finished; }
    this.sessions.clear();
  }
}
