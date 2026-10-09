export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export type ExecutionUsage =
  | { status: "available"; input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
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
  /** Time the model spent producing assistant messages, excluding tool execution. */
  modelMsTotal: number;
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
  private modelStartMs: number | undefined;
  private readonly runningTools = new Map<string, { name: string; startMs: number }>();
  private readonly toolDurations: ToolDuration[] = [];
  private readonly toolCounts = new Map<string, number>();
  private turns = 0;
  private modelMsTotal = 0;
  private toolMsTotal = 0;
  private outputBytes = 0;

  modelStarted(atMs: number): void {
    if (this.modelStartMs !== undefined) return;
    this.modelStartMs = atMs;
  }

  modelEnded(atMs: number): void {
    if (this.modelStartMs === undefined) return;
    this.modelMsTotal += Math.max(0, atMs - this.modelStartMs);
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

  summarize(tokens?: TokenCounts, longestLimit = 5): ExecutionSummary {
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
        modelMsTotal: this.modelMsTotal,
        toolMsTotal: this.toolMsTotal,
        longestTools,
        toolCounts,
        outputBytes: this.outputBytes,
      },
    };
  }
}
