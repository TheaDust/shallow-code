export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  /** USD，按注册的模型单价换算；价格未知时缺省。 */
  cost?: number;
}

export type ExecutionUsage =
  | { status: "available"; input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost?: number }
  | { status: "unavailable" };

export interface ToolDuration {
  name: string;
  durationMs: number;
}

export interface ToolCallCount {
  name: string;
  count: number;
}

export interface ExecutionTiming {
  turns: number;
  /** Time between SDK stream-start and message-end; excludes waiting for stream-start. */
  modelMsTotal: number;
  /** Full conversational requests, including pre-stream waiting and failed attempts. */
  modelRequestMsTotal: number;
  modelWaitMsTotal: number;
  modelRequestCount: number;
  modelErrorCount: number;
  modelErrorMsTotal: number;
  toolMsTotal: number;
  longestTools: ToolDuration[];
  /** Per-tool invocation counts, highest first. Names only, never arguments or output. */
  toolCounts: ToolCallCount[];
  /** Bytes of assistant text produced this run. Size only, never the content. */
  outputBytes: number;
}

export interface ExecutionSummary {
  usage: ExecutionUsage;
  timing: ExecutionTiming;
}

/** Aggregates Pi session events into bounded token/duration diagnostics. */
export class PiExecutionCollector {
  private requestStartMs: number | undefined;
  private modelStartMs: number | undefined;
  private readonly runningTools = new Map<string, { name: string; startMs: number }>();
  private readonly toolDurations: ToolDuration[] = [];
  private readonly toolCounts = new Map<string, number>();
  private turns = 0;
  private modelMsTotal = 0;
  private modelRequestMsTotal = 0;
  private modelRequestCount = 0;
  private modelErrorCount = 0;
  private modelErrorMsTotal = 0;
  private toolMsTotal = 0;
  private outputBytes = 0;

  requestStarted(atMs: number): void {
    if (this.requestStartMs !== undefined) return;
    this.requestStartMs = atMs;
    this.modelRequestCount += 1;
  }

  modelStarted(atMs: number): void {
    this.requestStarted(atMs);
    if (this.modelStartMs !== undefined) return;
    this.modelStartMs = atMs;
  }

  modelEnded(atMs: number, requestDurationMs?: number, failed = false): void {
    if (this.requestStartMs === undefined) return;
    const streamedMs = this.modelStartMs === undefined ? 0 : Math.max(0, atMs - this.modelStartMs);
    // SDK duration starts when the provider stream is created, before network waiting.
    const requestMs = Math.max(streamedMs, requestDurationMs ?? Math.max(0, atMs - this.requestStartMs));
    this.modelMsTotal += streamedMs;
    this.modelRequestMsTotal += requestMs;
    if (failed) { this.modelErrorCount += 1; this.modelErrorMsTotal += requestMs; }
    this.requestStartMs = undefined;
    this.modelStartMs = undefined;
  }

  toolStarted(toolCallId: string, toolName: string, atMs: number): void {
    if (this.runningTools.has(toolCallId)) return;
    this.runningTools.set(toolCallId, { name: toolName, startMs: atMs });
    this.toolCounts.set(toolName, (this.toolCounts.get(toolName) ?? 0) + 1);
  }

  /** Counts assistant text size for the run summary; the text itself is never retained here. */
  outputProduced(bytes: number): void {
    if (Number.isFinite(bytes) && bytes > 0) this.outputBytes += bytes;
  }

  toolEnded(toolCallId: string, atMs: number): void {
    const pending = this.runningTools.get(toolCallId);
    if (!pending) return;
    this.runningTools.delete(toolCallId);
    const durationMs = Math.max(0, atMs - pending.startMs);
    this.toolDurations.push({ name: pending.name, durationMs });
    this.toolMsTotal += durationMs;
  }

  turnEnded(): void {
    this.turns += 1;
  }

  summarize(tokens?: TokenCounts, longestLimit = 5, atMs = Date.now()): ExecutionSummary {
    // Heartbeats also account for a request still waiting when the worker is interrupted.
    const requestMs = this.modelRequestMsTotal + (this.requestStartMs === undefined ? 0 : Math.max(0, atMs - this.requestStartMs));
    const streamedMs = this.modelMsTotal + (this.modelStartMs === undefined ? 0 : Math.max(0, atMs - this.modelStartMs));
    const longestTools = [...this.toolDurations]
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, Math.max(0, longestLimit));
    const toolCounts = [...this.toolCounts]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    return {
      usage: tokens ? { status: "available", ...tokens } : { status: "unavailable" },
      timing: {
        turns: this.turns,
        modelMsTotal: streamedMs,
        modelRequestMsTotal: requestMs,
        modelWaitMsTotal: Math.max(0, requestMs - streamedMs),
        modelRequestCount: this.modelRequestCount,
        modelErrorCount: this.modelErrorCount,
        modelErrorMsTotal: this.modelErrorMsTotal,
        toolMsTotal: this.toolMsTotal,
        longestTools,
        toolCounts,
        outputBytes: this.outputBytes,
      },
    };
  }
}

/**
 * 同一会话续做时统计是累计值；上报前减去调用开始时的基线，得到本次调用增量。
 * cost 只在两侧都有值时相减，避免把未知价格当作 0。
 */
export function subtractUsage(after: ExecutionUsage, before: ExecutionUsage): ExecutionUsage {
  if (after.status !== "available" || before.status !== "available") return after;
  const delta = (current: number, baseline: number) => Math.max(0, current - baseline);
  const cost = after.cost !== undefined && before.cost !== undefined ? delta(after.cost, before.cost) : after.cost;
  return {
    status: "available",
    input: delta(after.input, before.input),
    output: delta(after.output, before.output),
    cacheRead: delta(after.cacheRead, before.cacheRead),
    cacheWrite: delta(after.cacheWrite, before.cacheWrite),
    total: delta(after.total, before.total),
    ...(cost === undefined ? {} : { cost }),
  };
}
