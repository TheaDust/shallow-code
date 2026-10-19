import { join } from "node:path";
import { matchesKey, ProcessTerminal, Text, TuiMainScreen, type TUI, type Component, type OverlayHandle, type Terminal } from "@earendil-works/pi-tui";
import type { RunSummary } from "../pipeline.js";
import type { RequirementNode, RequirementStatus, RunEvent } from "../types.js";
import type { PiWorkerProgress } from "../builder/pi-worker-client.js";
import { ModelUsageTotals, formatModelUsageSummary, formatUsageSummary, type TokenUsage, type UsageSummary } from "../model-usage.js";
import { setMouseTracking } from "./mouse-wheel.js";
import { clearTerminalScreen, elapsedTime, fitTerminalText, shellArgument, terminalHeader, terminalRow, terminalTheme, type TerminalTheme } from "./theme.js";
import { TextViewer } from "./text-viewer.js";
import { checkerProgressLabel } from "../human-log.js";

const PHASES: Record<string, string> = {
  implementation: "模块实现", audit: "独立验收", repair: "修复与回归", delivery: "最终交付",
};

/** Braille spinner for the activity line; the frame follows wall-clock time. */
const ACTIVITY_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Render cadence while running; also the spinner frame duration. */
const RENDER_INTERVAL_MS = 200;

type TreeStatus = RequirementStatus | "skipped";
interface TreeCounts {
  total: number;
  verified: number;
  failed: number;
  inconclusive: number;
  blocked: number;
  skipped: number;
}

const TREE_STATUS_LABEL: Record<TreeStatus, string> = {
  verified: "已验证", failed: "失败", inconclusive: "证据不足", blocked: "阻塞", skipped: "沿用", todo: "未验收",
};
const TREE_STATUS_ICON: Record<TreeStatus, string> = {
  verified: "✓", failed: "✗", inconclusive: "?", blocked: "⊘", skipped: "·", todo: "○",
};

function treeColour(theme: TerminalTheme, status: TreeStatus): (text: string) => string {
  switch (status) {
    case "verified": return theme.success;
    case "failed": return theme.error;
    case "inconclusive": return theme.warning;
    case "blocked": return theme.blocked;
    case "skipped": return theme.muted;
    default: return theme.faint;
  }
}

function progressBar(done: number, total: number, width: number, theme: TerminalTheme): string {
  const cells = Math.max(5, width);
  const filled = total > 0 ? Math.min(cells, Math.floor(cells * done / total)) : 0;
  return theme.success("█".repeat(filled)) + theme.muted("░".repeat(cells - filled));
}

export interface BuildTuiOptions {
  requirementIds: string[];
  /** 原始需求树；交互页面按子树聚合完成状态。 */
  requirementTree?: RequirementNode;
  /** 本轮实际使用的模型；状态页显式标注来源。 */
  models: { builder: string; checker: string };
  onInterrupt(): void;
}

/** A projection of emitted facts; presentation never grants verification. */
export class BuildView implements Component {
  private readonly statuses: Map<string, RequirementStatus>;
  private scope: Set<string>;
  private readonly skippedIds = new Set<string>();
  private readonly runnable = new Set<string>();
  private readonly recent: string[] = [];
  private phase = "准备运行";
  private module = "等待功能分组";
  private activity = "正在准备需求与执行环境";
  private packetId?: string;
  private builderRunning = false;
  private readonly checkerTasks = new Map<string, { queued: boolean; label: string }>();
  private lastActivityAt = Date.now();
  private readonly startedAt = Date.now();
  private readonly usage = new ModelUsageTotals();
  private live?: TokenUsage;
  private usageExpanded = false;
  private awaitingStart = false;

  constructor(
    private readonly options: BuildTuiOptions,
    private readonly rows: () => number,
    private readonly theme: TerminalTheme = terminalTheme(),
  ) {
    this.statuses = new Map(options.requirementIds.map(id => [id, "todo"]));
    this.scope = new Set(options.requirementIds);
  }

  receive(event: RunEvent, line: string): void {
    const detail = event.detail as Record<string, unknown> | undefined;
    const ids = (key: string) => Array.isArray(detail?.[key]) ? detail![key] as string[] : [];
    if (event.type === "snapshot_sealed" && detail?.authoritative !== false) {
      for (const [id, status] of this.statuses) if (status === "verified") this.statuses.set(id, "inconclusive");
      this.checkerTasks.clear();
    }
    if (event.type === "evolution_scope_selected") {
      if (Array.isArray(detail?.auditRequirementIds)) this.scope = new Set(ids("auditRequirementIds"));
      this.setSkipped(ids("skippedRequirementIds"));
    }
    if (["checkpoint_saved", "module_rescued", "run_resumed"].includes(event.type)) {
      for (const id of ids("requirementIds")) this.runnable.add(id);
    }
    if ((event.type === "module_check_finished" && detail?.published === true) || (event.type === "repair_batch_finished" && detail?.retained === true)) {
      const results = detail?.requirementResults as Record<string, RequirementStatus> | undefined;
      for (const [id, status] of Object.entries(results ?? {})) this.statuses.set(id, status);
    }
    if (event.type === "dependency_gate_blocked" || event.type === "module_failed") {
      for (const id of ids("requirementIds")) this.statuses.set(id, "blocked");
    }
    if (event.type === "pipeline_finished") {
      if (Array.isArray(detail?.auditRequirementIds)) this.scope = new Set(ids("auditRequirementIds"));
      this.setSkipped(ids("skippedRequirementIds"));
      for (const id of this.scope) this.statuses.set(id, "todo");
      for (const [key, status] of [["verifiedRequirementIds", "verified"], ["failedRequirementIds", "failed"],
        ["inconclusiveRequirementIds", "inconclusive"], ["blockedRequirementIds", "blocked"]] as const) {
        for (const id of ids(key)) this.statuses.set(id, status);
      }
    }
    if (event.type === "feature_grouping_usage") {
      this.addUsage("planner", detail);
      return;
    }
    if (event.type === "checker_usage") {
      this.addUsage("checker", detail);
      return;
    }
    if (event.type === "builder_usage") {
      this.addUsage("builder", detail);
      this.live = undefined;
      return;
    }
    if (event.type === "builder_finished") {
      this.live = undefined;
    }
    if (event.type === "builder_started") this.builderRunning = true;
    if (event.type === "builder_finished") this.builderRunning = false;
    if (event.type === "pipeline_finished" || event.type === "pipeline_failed") {
      this.builderRunning = false;
      this.checkerTasks.clear();
    }
    if (event.type.endsWith("_usage") || event.type === "builder_reference_images") return;
    const checkEvent = event.type.startsWith("check_");
    const jobId = typeof detail?.jobId === "string" ? detail.jobId : undefined;
    if (checkEvent && jobId) {
      if (event.type === "check_completed" || event.type === "check_cancelled") this.checkerTasks.delete(jobId);
      if (detail?.archived) return;
      if (event.type === "check_queued") this.checkerTasks.set(jobId, { queued: true, label: "Checker · 等待执行" });
      if (event.type === "check_started" || event.type === "check_progress") {
        // Keep the most recently active job last, independently of opaque packet ids.
        this.checkerTasks.delete(jobId);
        this.checkerTasks.set(jobId, { queued: false, label: event.type === "check_progress"
          ? checkerProgressLabel(event.detail!) : "Checker · 开始检查" });
      }
    }
    const message = line.replace(/^\[[^\]]+\]\s*/, "").replace(/ \[#.*\]$/, "");
    // Packet ids stay in run-log.txt; the progress list reads as user-facing text.
    const readable = event.packetId
      ? message.replaceAll(`（${event.packetId}）`, "").replaceAll(`（${event.packetId}，`, "（").trim()
      : message;
    this.recent.push(event.type === "packet_selected"
      ? `开始处理 ${ids("names").join("、") || "当前需求包"}`
      : readable.split("；", 1)[0]);
    if (this.recent.length > 5) this.recent.shift();
    if (checkEvent) {
      if (!this.builderRunning && !detail?.archived) {
        this.activity = this.checkerActivity() ?? "Checker · 当前任务结束，等待结果汇总";
        this.lastActivityAt = Date.now();
      }
      return;
    }
    if (event.type === "packet_selected") {
      this.packetId = event.packetId;
      this.module = ids("names").join("、") || event.packetId || "当前需求包";
    }
    if (event.packetId && this.packetId && event.packetId !== this.packetId && event.type !== "builder_started" && event.type !== "builder_finished") return;
    const activity = this.describeActivity(event, detail);
    if (activity) { this.activity = activity; this.lastActivityAt = Date.now(); }
  }

  /** 调用中的实时快照（仅呈现，不进入事件账本，也不授予验收）。 */
  liveUsage(progress: { usage: PiWorkerProgress["usage"] }): void {
    const usage = progress.usage;
    this.live = usage.status === "available" && usage.total > 0
      ? usage
      : undefined;
  }

  toggleUsage(): void { this.usageExpanded = !this.usageExpanded; }

  /** 启动前保持静态画面，避免把等待用户确认表现成正在运行。 */
  setAwaitingStart(value: boolean): void {
    this.awaitingStart = value;
    this.activity = value ? "按 Enter 开始运行" : "正在准备需求与执行环境";
    this.lastActivityAt = Date.now();
  }

  /** 需求树页面：按子树聚合状态，新版本结果会直接反映在颜色与计数上。 */
  requirementTreeText(theme: TerminalTheme = this.theme): string {
    const root = this.options.requirementTree;
    const lines: string[] = [];
    const overall = root ? this.treeCounts(root) : this.flatTreeCounts();
    lines.push(` ${theme.label("总体")}  ${this.treeSummary(overall, theme)}`);
    lines.push("");
    if (root) this.appendTree(root, "", true, lines, theme, true);
    else {
      for (const id of [...this.statuses.keys()].sort()) {
        const status = this.treeStatus(id);
        lines.push(treeColour(theme, status)(`${TREE_STATUS_ICON[status]} ${id}`) +
          `  ${theme.muted(`[${TREE_STATUS_LABEL[status]}]`)}`);
      }
    }
    return lines.join("\n");
  }

  invalidate(): void {}

  private setSkipped(ids: string[]): void {
    this.skippedIds.clear();
    for (const id of ids) this.skippedIds.add(id);
  }

  private treeStatus(id: string): TreeStatus {
    const status = this.statuses.get(id) ?? "todo";
    return status === "todo" && this.skippedIds.has(id) ? "skipped" : status;
  }

  private emptyCounts(): TreeCounts {
    return { total: 0, verified: 0, failed: 0, inconclusive: 0, blocked: 0, skipped: 0 };
  }

  private addCounts(target: TreeCounts, source: TreeCounts): void {
    target.total += source.total;
    target.verified += source.verified;
    target.failed += source.failed;
    target.inconclusive += source.inconclusive;
    target.blocked += source.blocked;
    target.skipped += source.skipped;
  }

  private aggregateStatus(counts: TreeCounts): TreeStatus {
    if (counts.failed > 0) return "failed";
    if (counts.blocked > 0) return "blocked";
    if (counts.inconclusive > 0) return "inconclusive";
    if (counts.total > 0 && counts.verified === counts.total) return "verified";
    if (counts.total === 0 && counts.skipped > 0) return "skipped";
    return "todo";
  }

  private addStatus(counts: TreeCounts, status: TreeStatus): void {
    if (status === "skipped") { counts.skipped += 1; return; }
    counts.total += 1;
    switch (status) {
      case "verified": counts.verified += 1; break;
      case "failed": counts.failed += 1; break;
      case "inconclusive": counts.inconclusive += 1; break;
      case "blocked": counts.blocked += 1; break;
    }
  }

  private treeCounts(node: RequirementNode): TreeCounts {
    const counts = this.emptyCounts();
    if (node.type === "ATOMIC") {
      this.addStatus(counts, this.treeStatus(node.id));
      return counts;
    }
    for (const child of node.children) this.addCounts(counts, this.treeCounts(child));
    return counts;
  }

  private flatTreeCounts(): TreeCounts {
    const counts = this.emptyCounts();
    for (const id of this.statuses.keys()) this.addStatus(counts, this.treeStatus(id));
    return counts;
  }

  private treeSuffix(counts: TreeCounts, theme: TerminalTheme): string {
    const parts = [`${counts.verified}/${counts.total}`];
    if (counts.failed) parts.push(`${theme.error(`失败 ${counts.failed}`)}`);
    if (counts.inconclusive) parts.push(`${theme.warning(`证据不足 ${counts.inconclusive}`)}`);
    if (counts.blocked) parts.push(`${theme.blocked(`阻塞 ${counts.blocked}`)}`);
    if (counts.skipped) parts.push(`${theme.muted(`沿用 ${counts.skipped}`)}`);
    return parts.join(theme.muted(" · "));
  }

  private treeSummary(counts: TreeCounts, theme: TerminalTheme): string {
    return [
      counts.verified ? theme.success(`已验证 ${counts.verified}/${counts.total}`) : theme.muted(`已验证 0/${counts.total}`),
      counts.failed ? theme.error(`失败 ${counts.failed}`) : theme.muted("失败 0"),
      counts.inconclusive ? theme.warning(`证据不足 ${counts.inconclusive}`) : theme.muted("证据不足 0"),
      counts.blocked ? theme.blocked(`阻塞 ${counts.blocked}`) : theme.muted("阻塞 0"),
      theme.muted(`未验收 ${counts.total - counts.verified - counts.failed - counts.inconclusive - counts.blocked}`),
      ...(counts.skipped ? [theme.muted(`沿用 ${counts.skipped}`)] : []),
    ].join("  ");
  }

  private appendTree(node: RequirementNode, prefix: string, last: boolean, lines: string[], theme: TerminalTheme, root = false): void {
    const counts = this.treeCounts(node);
    const status = this.aggregateStatus(counts);
    const connector = root ? "" : `${prefix}${last ? "└─ " : "├─ "}`;
    const icon = node.type === "ATOMIC" ? TREE_STATUS_ICON[status] : status === "todo" ? "○" : TREE_STATUS_ICON[status];
    const suffix = node.type === "ATOMIC"
      ? `  ${theme.muted(`[${TREE_STATUS_LABEL[status]}]`)}`
      : `  ${this.treeSuffix(counts, theme)}`;
    lines.push(theme.border(connector) + treeColour(theme, status)(`${icon} ${node.name}`) + suffix);
    const childPrefix = root ? "" : `${prefix}${last ? "   " : "│  "}`;
    node.children.forEach((child, index) => this.appendTree(child, childPrefix, index === node.children.length - 1, lines, theme));
  }

  private usageLines(): string[] {
    const summary = this.usage.summary(this.live);
    const lines = [`总计  ${formatUsageSummary(summary)}`];
    if (this.usageExpanded) {
      const rows: Array<[string, UsageSummary]> = [["Builder", summary.builder], ["Checker", summary.checker], ["Planner", summary.planner]];
      let details = 0;
      for (const [label, usage] of rows) if (usage.total > 0) { lines.push(`${label}  ${formatUsageSummary(usage)}`); details += 1; }
      // 启动前展开时给出明确反馈，避免按键看起来没有响应。
      if (!details) lines.push("花费明细  尚未产生用量");
    }
    return lines;
  }

  private highlightRole(text: string, t: TerminalTheme): { colour: (value: string) => string; text: string } {
    const role = ["Builder", "Checker", "Planner"].find(name => text.startsWith(name));
    if (!role) return { colour: t.accent, text };
    const colour = role === "Builder" ? t.builder : role === "Checker" ? t.checker : t.planner;
    return { colour, text: colour(role) + text.slice(role.length) };
  }

  private progressLines(width: number, counts: { todo: number; verified: number; failed: number; inconclusive: number; blocked: number }, t: TerminalTheme): string[] {
    const total = this.scope.size;
    const bar = progressBar(counts.verified, total, Math.max(5, Math.min(18, Math.floor(width / 8))), t);
    const verified = `已验证 ${counts.verified}/${total}`;
    const progress = `${t.accent("进度")} ${bar} ${counts.verified ? t.strong(t.success(verified)) : t.accent(t.strong(verified))}`;
    const summary = [
      counts.failed ? t.strong(t.error(`失败 ${counts.failed}`)) : t.muted(`失败 ${counts.failed}`),
      counts.inconclusive ? t.strong(t.warning(`证据不足 ${counts.inconclusive}`)) : t.muted(`证据不足 ${counts.inconclusive}`),
      `${t.muted(`阻塞 ${counts.blocked} · `)}${counts.todo ? t.accent(`未验收 ${counts.todo}`) : t.muted("未验收 0")}`,
    ].join("  ");
    return width >= 60 ? [` ${progress}  ${summary}`] : [` ${progress}`, ` ${summary}`];
  }

  render(width: number): string[] {
    const t = this.theme;
    const counts = { todo: 0, verified: 0, failed: 0, inconclusive: 0, blocked: 0 };
    for (const id of this.scope) counts[this.statuses.get(id) ?? "todo"]++;
    const frame = ACTIVITY_FRAMES[Math.floor(Date.now() / RENDER_INTERVAL_MS) % ACTIVITY_FRAMES.length];
    const activityRole = this.highlightRole(this.activity, t);
    const activity = this.awaitingStart
      ? ` ${t.accent("◆")} ${t.strong("按 Enter 开始运行")}`
      : ` ${activityRole.colour(frame)} ${activityRole.text}`;
    const checker = this.builderRunning ? this.checkerActivity() : undefined;
    const checkerLines = checker ? [` ${t.muted("后台")} ${this.highlightRole(checker, t).text}`] : [];
    const models = ` ${t.label("模型")}  ${t.builder("Builder")} ${this.options.models.builder} ${t.faint("·")} ` +
      `${t.checker("Checker")} ${this.options.models.checker}`;
    const keyHint = (key: string, label: string) => `${t.accent(key)} ${t.label(label)}`;
    const footer = this.awaitingStart
      ? ` ${keyHint("Enter", "开始运行")}   ${keyHint("d", "日志")}   ${keyHint("t", "树")}   ` +
        `${keyHint("c", "花费")}   ${keyHint("?", "帮助")}   ${t.muted("^C 中断")}`
      : width >= 60
        ? ` ${keyHint("d", "详细日志")}   ${keyHint("t", "需求树")}   ` +
          `${keyHint("c", this.usageExpanded ? "收起花费" : "花费明细")}   ${keyHint("?", "帮助")}   ${t.muted("Ctrl+C 中断")}`
        : ` ${keyHint("d", "日志")}  ${keyHint("t", "树")}  ${keyHint("c", this.usageExpanded ? "收起" : "花费")}  ` +
          `${keyHint("?", "帮助")}  ${t.muted("^C 中断")}`;
    const usage = this.usageLines();
    const progress = this.progressLines(width, counts, t);
    const compact = () => {
      const head = [terminalHeader("Build Agent", width, t)[0], models, activity, ...checkerLines];
      const tail = [...progress, footer];
      return [...head, ...usage.slice(0, Math.max(0, this.rows() - head.length - tail.length)).map(line => ` ${line}`), ...tail]
        .slice(0, this.rows()).map(line => fitTerminalText(line, width));
    };
    if (this.rows() < 18) return compact();
    const usageLines = usage.flatMap(line => new Text(line, 1, 0).render(width));
    const runState = this.awaitingStart ? t.accent("● 等待开始") : t.success("● 运行中");
    const runnable = [...this.scope].filter(id => this.runnable.has(id)).length;
    const lines = [
      ...terminalHeader("Build Agent", width, t), "",
      terminalRow(` ${t.strong(t.accent(this.phase))}`, `${runState} ${t.muted(elapsedTime(Date.now() - this.startedAt) + " ")}`, width),
      ` ${t.label("模块")}  ${this.module}`,
      models,
      ...usageLines,
      activity,
      ...checkerLines,
      this.awaitingStart
        ? t.muted(" 尚未开始 · Enter 启动本轮运行，其他按键可先查看日志与需求树")
        : t.muted(` 当前活动 ${elapsedTime(Date.now() - this.lastActivityAt)} · 持续等待时可查看详细日志`),
      "", ...progress,
      ` ${t.label("可运行检查点覆盖")} ${runnable ? t.accent(`${runnable} 条需求`) : t.muted("0 条需求")}` +
        (this.skippedIds.size ? ` ${t.muted(`· 沿用跳过 ${this.skippedIds.size}`)}` : ""),
      "", `${t.accent("▌")} ${t.label("最近进展")}`,
    ];
    if (lines.length + 3 > this.rows()) return compact();
    const available = Math.max(0, this.rows() - lines.length - 3);
    for (const message of available ? this.recent.slice(-Math.min(5, available)) : []) {
      lines.push(` ${t.accent("·")} ${message}`);
    }
    lines.push("", t.border("─".repeat(width)), footer);
    return lines.map(line => fitTerminalText(line, width));
  }

  private addUsage(source: "builder" | "checker" | "planner", usage: Record<string, unknown> | undefined): void {
    if (!usage || typeof usage.input !== "number" || typeof usage.output !== "number") return;
    const number = (key: string) => typeof usage[key] === "number" ? usage[key] as number : 0;
    const cost = typeof usage.cost === "number" ? usage.cost : undefined;
    this.usage.add(source, { input: number("input"), output: number("output"), cacheRead: number("cacheRead"),
      cacheWrite: number("cacheWrite"), ...(cost === undefined ? {} : { cost }),
      ...(typeof usage.unpricedTokens === "number" ? { unpricedTokens: usage.unpricedTokens } : {}) });
  }

  private checkerActivity(): string | undefined {
    const tasks = [...this.checkerTasks.values()];
    if (!tasks.length) return undefined;
    const active = tasks.filter(task => !task.queued);
    const queued = tasks.length - active.length;
    return (active.at(-1)?.label ?? "Checker · 等待执行") +
      (active.length > 1 ? ` · 另 ${active.length - 1} 项运行` : "") + (queued ? ` · ${queued} 项排队` : "");
  }

  private describeActivity(event: RunEvent, detail: Record<string, unknown> | undefined): string | undefined {
    switch (event.type) {
      case "initialization_started": this.phase = "初始化工程"; return "选择工程初始化方式";
      case "initialization_attempt": this.phase = "初始化工程"; return `Builder · 初始化工程（第 ${detail?.attempt ?? 1} 次）`;
      case "initialization_verification_started": this.phase = "验证运行"; return "检查工程安装、构建与浏览器入口";
      case "initialization_validation_failed": this.phase = "验证运行"; return "工程运行验证失败，准备修正";
      case "initialization_verified": this.phase = "验证运行"; return "工程运行验证通过，保存基线";
      case "initialization_finished": this.phase = "开始功能开发"; return "工程可运行，准备功能分组与独立验收";
      case "snapshot_sealed": return "源码已封存，Builder 继续下一功能组";
      case "module_check_started": return "Checker · 模块集中重放与确认";
      case "module_check_finished": return detail?.moduleId === "<final>" ? "当前交付范围验收完成" : "模块当前版本检查完成";
      case "feature_grouping_started": return "Planner · 整理功能分组";
      case "feature_grouping_finished": return "功能分组完成，准备实现";
      case "phase_started": this.phase = PHASES[String(detail?.phase)] ?? "运行中"; return this.phase;
      case "packet_selected": return "已选择需求包，准备 Builder";
      case "builder_started": return `Builder · 实现当前模块${detail?.attempt ? ` · 第 ${detail.attempt} 次尝试` : ""}`;
      case "builder_finished": return this.checkerActivity() ?? (detail?.outcome === "completed" ? "Builder 本轮完成，等待运行检查" : "Builder 本轮结束，检查候选与检查点");
      case "candidate_prepared": return "候选构建完成，准备独立验收";
      case "gateway_wait": return `${detail?.source === "builder" ? "Builder" : detail?.source === "checker" ? "Checker" : "Planner"} · 等待模型网关恢复`;
      case "repair_batch_started": return `Builder · 第 ${detail?.round ?? 1} 轮修复`;
      case "delivery_started": this.phase = "最终交付"; return "重新验收当前范围，检查交付入口";
      case "delivery_check_started": return "检查交付运行合同";
      case "delivery_check_finished": return detail?.ok ? "交付运行合同检查通过" : "交付运行合同未通过，准备修复";
      case "delivery_repair_restored": return "交付修复未保留，已恢复检查点";
      case "pipeline_finished": return "本轮结束，正在保存报告与补丁";
      case "pipeline_failed": return "运行异常，正在保存诊断";
      default: return undefined;
    }
  }
}

export class BuildTui {
  readonly tui: TUI;
  readonly view: BuildView;
  private readonly theme = terminalTheme();
  private readonly log: string[] = [];
  private overlay?: OverlayHandle;
  private viewer?: TextViewer;
  private treeViewer?: TextViewer;
  private timer?: ReturnType<typeof setInterval>;
  private started = false;
  private running = false;
  private readonly startedRun: Promise<void>;
  private resolveStart!: () => void;

  constructor(private readonly options: BuildTuiOptions, terminal: Terminal = new ProcessTerminal()) {
    this.tui = new TuiMainScreen(terminal);
    this.tui.setClearOnShrink(true);
    this.view = new BuildView(options, () => terminal.rows, this.theme);
    this.view.setAwaitingStart(true);
    this.startedRun = new Promise(resolve => { this.resolveStart = resolve; });
    this.tui.addChild(this.view);
    this.tui.addInputListener(data => {
      if (matchesKey(data, "ctrl+c")) {
        this.stop(); this.options.onInterrupt(); return { consume: true };
      }
      if (this.overlay) return undefined;
      if (!this.running && matchesKey(data, "enter")) { this.beginRun(); return { consume: true }; }
      if (data === "d") { this.showLog(); return { consume: true }; }
      if (data === "t") { this.showRequirements(); return { consume: true }; }
      if (data === "c") { this.view.toggleUsage(); this.tui.requestRender(); return { consume: true }; }
      if (data === "?") { this.showHelp(); return { consume: true }; }
      return undefined;
    });
  }

  start(): void {
    this.started = true;
    // 每次进入都是全新控制台页面：清空可视区与回滚缓冲后再渲染。
    clearTerminalScreen(this.tui.terminal);
    this.tui.start();
    this.timer = setInterval(() => this.tui.requestRender(), RENDER_INTERVAL_MS);
  }

  /** 等待用户在 TUI 中确认开始；确认前不启动 Builder 或 Checker。 */
  waitForStart(): Promise<void> { return this.startedRun; }

  private beginRun(): void {
    if (this.running) return;
    this.running = true;
    this.view.setAwaitingStart(false);
    this.resolveStart();
    this.tui.requestRender();
  }

  record(rawLine: string, line: string): void {
    const event = JSON.parse(rawLine) as RunEvent;
    this.view.receive(event, line);
    this.log.push(line);
    if (this.log.length > 500) this.log.shift();
    this.viewer?.setText("详细日志 · 最近 500 条", this.log.join("\n"), false);
    this.treeViewer?.setText("需求树 · 完成情况", this.view.requirementTreeText(this.theme), false);
    this.tui.requestRender();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    clearInterval(this.timer);
    setMouseTracking(this.tui.terminal, false);
    this.overlay?.hide();
    this.tui.stop();
  }

  private showLog(): void {
    this.treeViewer = undefined;
    this.viewer = new TextViewer(this.tui, this.theme, "详细日志 · 最近 500 条",
      this.log.join("\n") || "等待运行事件…", () => this.closeViewer());
    this.viewer.scrollToEnd();
    setMouseTracking(this.tui.terminal, true);
    this.overlay = this.tui.showOverlay(this.viewer, { width: "100%", anchor: "top-left" });
  }

  private showRequirements(): void {
    this.viewer = undefined;
    this.treeViewer = new TextViewer(this.tui, this.theme, "需求树 · 完成情况",
      this.view.requirementTreeText(this.theme), () => this.closeViewer());
    setMouseTracking(this.tui.terminal, true);
    this.overlay = this.tui.showOverlay(this.treeViewer, { width: "100%", anchor: "top-left" });
  }

  private showHelp(): void {
    this.treeViewer = undefined;
    const viewer = new TextViewer(this.tui, this.theme, "运行帮助",
      "d  查看详细日志，包含安装、构建与模型用量\nt  查看需求树与每个需求的完成状态\n   子树按聚合状态着色：已验证 / 失败 / 证据不足 / 阻塞 / 未验收\nc  展开或收起花费明细；默认只显示总计\n↑↓ / 滚轮 / PgUp / PgDn  滚动页面\nEsc  返回运行状态\nCtrl+C  中断运行\n\n" +
      "已验证：最近一次独立验收通过，交付前仍会复验\n证据不足：本轮验收无法确定行为结果\n未验收：尚未产出完整验收结果，可能正在实现或验收\n可运行检查点：保存了可运行实现，功能验收单独记录\n沿用跳过：不计入本轮验收通过\n后台 Checker：与 Builder 并行，单独显示检查阶段与排队数量\n程序复核通过：测试程序合格，需求结果仍由当前版本重放确定\n\n完整日志持续保存到 run-log.txt；结束后会显示报告和恢复命令。",
      () => this.closeViewer());
    setMouseTracking(this.tui.terminal, true);
    this.overlay = this.tui.showOverlay(viewer, { width: "100%", anchor: "top-left" });
  }

  private closeViewer(): void {
    this.overlay?.hide(); this.overlay = undefined; this.viewer = undefined; this.treeViewer = undefined;
    setMouseTracking(this.tui.terminal, false);
  }
}


export function buildResult(summary: RunSummary, runDirectory: string, patch: string | undefined,
  projectDirectory: string, elapsedMs: number, colour: boolean, width = 80): string {
  const t = terminalTheme(colour);
  const status = summary.status === "delivered" ? t.success("✓ 交付完成")
    : summary.status === "partial" ? t.warning("◐ 部分完成") : t.error("× 交付失败");
  const lines = ["", ...terminalHeader("Result", width, t), "", " " + t.strong(status),
    ` 已验证 ${summary.verifiedRequirementIds.length} · 业务失败 ${summary.failedRequirementIds?.length ?? 0} · ` +
      `证据不足 ${summary.inconclusiveRequirementIds?.length ?? 0}`,
    ` 阻塞 ${summary.blockedRequirementIds.length} · 待处理 ${summary.pendingRequirementIds?.length ?? 0} · 沿用跳过 ${summary.skippedRequirementIds?.length ?? 0}`,
    ` 总耗时  ${elapsedTime(elapsedMs)}`,
    ...(summary.modelUsage ? formatModelUsageSummary(summary.modelUsage, { includePlanner: false }).map(line => ` ${line}`) : []),
    "", ` 报告  ${join(runDirectory, "report.md")}`, ` 日志  ${join(runDirectory, "run-log.txt")}`,
    ...(patch ? [` 补丁  ${patch}`] : []), "", t.muted(" 下一步")];
  if (patch && summary.status === "delivered") lines.push(` shallow build apply --run-dir ${shellArgument(runDirectory)}`);
  else if (summary.status !== "delivered") lines.push(` shallow build resume --run-dir ${shellArgument(runDirectory)}`);
  else lines.push(` 项目已写入 ${projectDirectory}`);
  lines.push("");
  return lines.join("\n");
}
