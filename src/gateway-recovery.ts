import { GatewayRequestError, type GatewayFailure } from "./gateway-failure.js";
import { setTimeout as sleep } from "node:timers/promises";

const MAX_CONCURRENT_PLANNERS = 2;

interface PlannerWaiter {
  resume(): void;
  signal?: AbortSignal;
  abort?: () => void;
}

export interface GatewayWait {
  source: "builder" | "planner";
  packetId: string;
  retry: number;
  delayMs: number;
  failure: GatewayFailure;
  reason?: string;
}

export class GatewayUnavailableError extends GatewayRequestError {}

/**
 * One recovery window shared by Builder and Planner, scoped to a pipeline run.
 *
 * Retryable transport failures are retried with capped exponential backoff for
 * as long as the caller's own window (`remainingMs`) lasts; when the window is
 * spent the last failed response is returned as a `GatewayRequestError` so the
 * caller can retry the same work with a fresh window. Waiting never disables
 * later calls. Only Builder authentication failures stop the run, because
 * rejected credentials cannot recover by waiting.
 */
export class GatewayRecovery {
  private blockedUntil = 0;
  private failures = 0;
  private version = 0;
  private stopped?: GatewayUnavailableError;
  private activePlanners = 0;
  private readonly plannerQueue: PlannerWaiter[] = [];
  private recorder?: (event: GatewayWait) => Promise<void>;
  private lastFailure?: GatewayFailure;
  private lastReason?: string;

  constructor(private readonly time = {
    now: () => Date.now(),
    sleep: (ms: number, signal?: AbortSignal): Promise<void> => sleep(ms, undefined, { signal }),
  }) {}

  get exhausted(): boolean { return this.stopped !== undefined; }
  setRecorder(recorder: (event: GatewayWait) => Promise<void>): void { this.recorder = recorder; }

  async run<T>(source: GatewayWait["source"], packetId: string, remainingMs: () => number,
    operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = source === "planner" ? await this.acquirePlanner(signal) : undefined;
    try {
      for (let retry = 0; ; retry++) {
        signal?.throwIfAborted();
        if (this.stopped) throw this.stopped;
        while (this.blockedUntil > this.time.now()) {
          // Waiting never outlives the caller's window: a fresh window is the
          // caller's decision.
          const delayMs = Math.min(this.blockedUntil - this.time.now(), remainingMs());
          if (delayMs <= 0) throw this.gatewayError();
          await this.recorder?.({ source, packetId, retry, delayMs, failure: this.lastFailure!,
            ...(this.lastReason ? { reason: this.lastReason } : {}) });
          await this.time.sleep(Math.min(delayMs, 30_000), signal);
          signal?.throwIfAborted();
          if (this.stopped) throw this.stopped;
        }
        if (remainingMs() <= 0) throw this.gatewayError();
        const version = this.version;
        try {
          const result = await operation();
          // An already-running success must not erase a newer 429 cooldown.
          if (version === this.version) this.failures = 0;
          return result;
        } catch (error) {
          if (signal?.aborted) throw error;
          const failure = error instanceof GatewayRequestError ? error.gatewayFailure
            : (error as { gatewayFailure?: GatewayFailure } | null)?.gatewayFailure;
          if (!failure || error instanceof GatewayUnavailableError) throw error;
          if (!failure.retryable) {
            // A Planner-specific rejection must not disable a working Builder.
            if (failure.kind === "authentication" && source === "builder") this.stopped = new GatewayUnavailableError(failure, { cause: error });
            throw error;
          }
          if (this.lastFailure?.kind !== failure.kind) this.failures = 0;
          this.lastFailure = failure;
          this.lastReason = source === "planner" ? transportCause(error) : undefined;
          const delay = Math.max(failure.retryAfterMs ?? 0, backoffDelay(failure.kind, this.failures));
          this.failures++;
          this.version++;
          this.blockedUntil = Math.max(this.blockedUntil, this.time.now() + delay);
        }
      }
    } finally { release?.(); }
  }

  private async acquirePlanner(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.activePlanners < MAX_CONCURRENT_PLANNERS) {
      this.activePlanners++;
    } else {
      await new Promise<void>((resolve, reject) => {
        const waiter: PlannerWaiter = { resume: resolve, signal };
        if (signal) {
          waiter.abort = () => {
            this.plannerQueue.splice(this.plannerQueue.indexOf(waiter), 1);
            reject(signal.reason);
          };
          signal.addEventListener("abort", waiter.abort, { once: true });
        }
        this.plannerQueue.push(waiter);
      });
    }
    return () => {
      const next = this.plannerQueue.shift();
      if (next) {
        if (next.abort) next.signal!.removeEventListener("abort", next.abort);
        next.resume();
      } else this.activePlanners--;
    };
  }

  private gatewayError(): GatewayRequestError {
    return new GatewayRequestError(this.lastFailure ?? { kind: "unavailable", retryable: true });
  }
}

/** Retry-After can extend either schedule. */
function backoffDelay(kind: GatewayFailure["kind"], failures: number): number {
  const [base, cap] = kind === "rate_limit" ? [30_000, 300_000] : [5_000, 60_000];
  return Math.min(base * 2 ** failures, cap);
}

function transportCause(error: unknown): string | undefined {
  let cause = error instanceof Error ? error.cause : undefined;
  const parts: string[] = [];
  for (let depth = 0; depth < 3 && cause !== undefined; depth++) {
    if (cause instanceof Error) {
      const code = (cause as Error & { code?: unknown }).code;
      parts.push(`${cause.name}: ${cause.message}${typeof code === "string" ? ` [${code}]` : ""}`);
      cause = cause.cause;
    } else {
      if (typeof cause === "string") parts.push(cause);
      break;
    }
  }
  return parts.length ? parts.join(" → ") : undefined;
}
