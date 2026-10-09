import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { resolveCgroupMemoryMount, type CgroupMemoryMount } from "./memory-snapshot.js";

export interface MemoryUsage {
  current: number;
  /** Undefined when the cgroup has no finite limit. */
  max?: number;
}

export interface MemoryGateWaitInfo {
  expectedBytes: number;
  waitedMs: number;
  timedOut: boolean;
}

export interface MemoryGate {
  /**
   * Resolve once the cgroup can absorb an expected allocation without crossing
   * the threshold. Never rejects: missing counters or limits mean "no gate",
   * and an over-long wait proceeds anyway (pressure may come from a peer that
   * will not release; stalling forever is worse than trying). A set `signal`
   * ends the wait immediately so an aborted run is not delayed by the gate.
   */
  waitForHeadroom(expectedBytes: number, signal?: AbortSignal): Promise<void>;
}

export interface MemoryGateOptions {
  /** Fraction of the cgroup limit that must remain reachable. Default 0.8. */
  thresholdRatio?: number;
  /** Poll interval while waiting. Default 1s. */
  pollMs?: number;
  /** Give up waiting and proceed after this long. Default 60s or SHALLOW_MEMORY_GATE_MAX_WAIT_MS. */
  maxWaitMs?: number;
  readUsage?: () => Promise<MemoryUsage | undefined>;
  onWait?: (info: MemoryGateWaitInfo) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_WAIT_MS = 60_000;

/** `0` disables waiting entirely; unset or malformed falls back to the default. */
function configuredMaxWaitMs(): number {
  const raw = process.env.SHALLOW_MEMORY_GATE_MAX_WAIT_MS?.trim();
  if (!raw) return DEFAULT_MAX_WAIT_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_MAX_WAIT_MS;
}

export function createMemoryGate(options: MemoryGateOptions = {}): MemoryGate {
  const threshold = options.thresholdRatio ?? 0.8;
  const pollMs = options.pollMs ?? 1_000;
  const maxWaitMs = options.maxWaitMs ?? configuredMaxWaitMs();
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const readUsage = options.readUsage ?? defaultReadUsage();
  const onWait = options.onWait ?? defaultOnWait;
  return {
    async waitForHeadroom(expectedBytes: number, signal?: AbortSignal): Promise<void> {
      const started = now();
      let polled = false;
      let timedOut = false;
      let aborted = false;
      try {
        while (true) {
          if (signal?.aborted) { aborted = true; break; }
          const usage = await readUsage().catch(() => undefined);
          if (!usage || usage.max === undefined || !Number.isFinite(usage.max) || usage.max <= 0) return;
          if (usage.current + expectedBytes <= threshold * usage.max) break;
          if (maxWaitMs <= 0) break;
          if (now() - started >= maxWaitMs) { timedOut = true; break; }
          polled = true;
          await sleep(pollMs);
        }
      } finally {
        if (!aborted && (polled || timedOut)) onWait({ expectedBytes, waitedMs: Math.max(0, now() - started), timedOut });
      }
    },
  };
}

let shared: MemoryGate | undefined;

/** Process-wide gate: the cgroup is process-global state, so one shared instance. */
export function sharedMemoryGate(): MemoryGate {
  return (shared ??= createMemoryGate());
}

function defaultReadUsage(): () => Promise<MemoryUsage | undefined> {
  let mountPromise: Promise<CgroupMemoryMount | undefined> | undefined;
  return async () => {
    mountPromise ??= resolveCgroupMemoryMount();
    const mount = await mountPromise;
    if (!mount) return undefined;
    const [currentName, maxName] = mount.version === 2
      ? ["memory.current", "memory.max"]
      : ["memory.usage_in_bytes", "memory.limit_in_bytes"];
    const [currentRaw, maxRaw] = await Promise.all([
      readFile(posix.join(mount.directory, currentName), "utf8"),
      readFile(posix.join(mount.directory, maxName), "utf8"),
    ]);
    const current = Number.parseInt(currentRaw.trim(), 10);
    if (!Number.isFinite(current)) return undefined;
    const maxText = maxRaw.trim();
    const max = maxText === "max" ? undefined : Number.parseInt(maxText, 10);
    // cgroup v1 reports ~2^63-page sentinels when no limit is set.
    if (max === undefined || !Number.isFinite(max) || max > 2 ** 60) return { current, max: undefined };
    return { current, max };
  };
}

function defaultOnWait(info: MemoryGateWaitInfo): void {
  const mb = Math.round(info.expectedBytes / 1_048_576);
  process.stderr.write(`[shallowcode] memory gate waited ${info.waitedMs}ms for ${mb}MB headroom${info.timedOut ? " (timed out, proceeding)" : ""}\n`);
}
