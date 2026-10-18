import { join } from "node:path";
import { matchesKey, ProcessTerminal, Text, TuiMainScreen, type TUI, type Component, type OverlayHandle, type Terminal } from "@earendil-works/pi-tui";
import type { RunSummary } from "../pipeline.js";
import type { RequirementStatus, RunEvent } from "../types.js";
import type { PiWorkerProgress } from "../builder/pi-worker-client.js";
import { ModelUsageTotals, formatModelUsageSummary, type TokenUsage } from "../model-usage.js";
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

export interface BuildTuiOptions {
  requirementIds: string[];
  /** 本轮实际使用的模型；状态页显式标注来源。 */
  models: { builder: string; checker: string };
  onInterrupt(): void;
}

/** A projection of emitted facts; presentation never grants verification. */
export class BuildView implements Component {
  private readonly statuses: Map<string, RequirementStatus>;
  private scope: Set<string>;
  private skipped = 0;
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
      this.skipped = ids("skippedRequirementIds").length;
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
      this.skipped = ids("skippedRequirementIds").length;
      for (const id of this.scope) this.statuses.set(id, "todo");
      for (const [key, status] of [["verifiedRequirementIds", "verified"], ["failedRequirementIds", "failed"],
        ["inconclusiveRequirementIds", "inconclusive"], ["blockedRequirementIds", "blocked"]] as const) {
        for (const id of ids(key)) this.statuses.set(id, status);
      }
    }
    if (event.type === "feature_grouping_usage") {
      this.addUsage("checker", detail);
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

  invalidate(): void {}

  render(width: number): string[] {
    const t = this.theme;
    const counts = { todo: 0, verified: 0, failed: 0, inconclusive: 0, blocked: 0 };
    for (const id of this.scope) counts[this.statuses.get(id) ?? "todo"]++;
    const status = [
      t.strong(t.success(`已验证 ${counts.verified}/${this.scope.size}`)),
      counts.failed ? t.strong(t.error(`失败 ${counts.failed}`)) : t.muted(`失败 ${counts.failed}`),
      counts.inconclusive ? t.strong(t.warning(`证据不足 ${counts.inconclusive}`)) : t.muted(`证据不足 ${counts.inconclusive}`),
      t.muted(`阻塞 ${counts.blocked} · 未验收 ${counts.todo}`),
    ].join("  ");
    const frame = ACTIVITY_FRAMES[Math.floor(Date.now() / RENDER_INTERVAL_MS) % ACTIVITY_FRAMES.length];
    const activity = ` ${t.accent(frame)} ${this.activity}`;
    const checker = this.builderRunning ? this.checkerActivity() : undefined;
    const checkerLines = checker ? [` ${t.muted("后台")} ${checker}`] : [];
    const models = ` ${t.muted("模型")}  Builder ${this.options.models.builder} ${t.muted("·")} Checker ${this.options.models.checker}`;
    const footer = t.muted(" d 详细日志   ? 帮助   Ctrl+C 中断");
    const usage = formatModelUsageSummary(this.usage.summary(this.live));
    const compact = () => {
      const head = [terminalHeader("Build Agent", width, t)[0], models, activity, ...checkerLines];
      const tail = [" " + status, footer];
      return [...head, ...usage.slice(0, Math.max(0, this.rows() - head.length - tail.length)).map(line => ` ${line}`), ...tail]
        .slice(0, this.rows()).map(line => fitTerminalText(line, width));
    };
    if (this.rows() < 18) return compact();
    const usageLines = usage.flatMap(line => new Text(line, 1, 0).render(width));
    const lines = [
      ...terminalHeader("Build Agent", width, t), "",
      terminalRow(` ${t.strong(this.phase)}`, t.muted(elapsedTime(Date.now() - this.startedAt) + " "), width),
      ` ${t.muted("模块")}  ${this.module}`,
      models,
      ...usageLines,
      activity,
      ...checkerLines,
      t.muted(` 当前活动 ${elapsedTime(Date.now() - this.lastActivityAt)} · 持续等待时可查看详细日志`),
      "", " " + status,
      t.muted(` 可运行检查点覆盖 ${[...this.scope].filter(id => this.runnable.has(id)).length} 条需求` +
        (this.skipped ? ` · 沿用跳过 ${this.skipped}` : "")),
      "", t.muted(" 最近进展"),
    ];
    if (lines.length + 3 > this.rows()) return compact();
    const available = Math.max(0, this.rows() - lines.length - 3);
    for (const message of available ? this.recent.slice(-Math.min(5, available)) : []) {
      lines.push(` ${t.muted("·")} ${message}`);
    }
    lines.push("", t.muted("─".repeat(width)), footer);
    return lines.map(line => fitTerminalText(line, width));
  }

  private addUsage(source: "builder" | "checker", usage: Record<string, unknown> | undefined): void {
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
      case "gateway_wait": return `${detail?.source === "builder" ? "Builder" : "Planner"} · 等待模型网关恢复`;
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
  private timer?: ReturnType<typeof setInterval>;
  private started = false;

  constructor(private readonly options: BuildTuiOptions, terminal: Terminal = new ProcessTerminal()) {
    this.tui = new TuiMainScreen(terminal);
    this.tui.setClearOnShrink(true);
    this.view = new BuildView(options, () => terminal.rows, this.theme);
    this.tui.addChild(this.view);
    this.tui.addInputListener(data => {
      if (matchesKey(data, "ctrl+c")) {
        this.stop(); this.options.onInterrupt(); return { consume: true };
      }
      if (this.overlay) return undefined;
      if (data === "d") { this.showLog(); return { consume: true }; }
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

  record(rawLine: string, line: string): void {
    const event = JSON.parse(rawLine) as RunEvent;
    this.view.receive(event, line);
    this.log.push(line);
    if (this.log.length > 500) this.log.shift();
    this.viewer?.setText("详细日志 · 最近 500 条", this.log.join("\n"), false);
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
    this.viewer = new TextViewer(this.tui, this.theme, "详细日志 · 最近 500 条",
      this.log.join("\n") || "等待运行事件…", () => this.closeViewer());
    this.viewer.scrollToEnd();
    setMouseTracking(this.tui.terminal, true);
    this.overlay = this.tui.showOverlay(this.viewer, { width: "100%", anchor: "top-left" });
  }

  private showHelp(): void {
    const viewer = new TextViewer(this.tui, this.theme, "运行帮助",
      "d  查看详细日志，包含安装、构建与模型用量\n↑↓ / 滚轮 / PgUp / PgDn  滚动日志\nEsc  返回运行状态\nCtrl+C  中断运行\n\n" +
      "已验证：最近一次独立验收通过，交付前仍会复验\n证据不足：本轮验收无法确定行为结果\n未验收：尚未产出完整验收结果，可能正在实现或验收\n可运行检查点：保存了可运行实现，功能验收单独记录\n沿用跳过：不计入本轮验收通过\n后台 Checker：与 Builder 并行，单独显示检查阶段与排队数量\n程序复核通过：测试程序合格，需求结果仍由当前版本重放确定\n\n完整日志持续保存到 run-log.txt；结束后会显示报告和恢复命令。",
      () => this.closeViewer());
    setMouseTracking(this.tui.terminal, true);
    this.overlay = this.tui.showOverlay(viewer, { width: "100%", anchor: "top-left" });
  }

  private closeViewer(): void {
    this.overlay?.hide(); this.overlay = undefined; this.viewer = undefined;
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
    ...(summary.modelUsage ? formatModelUsageSummary(summary.modelUsage).map(line => ` ${line}`) : []),
    "", ` 报告  ${join(runDirectory, "report.md")}`, ` 日志  ${join(runDirectory, "run-log.txt")}`,
    ...(patch ? [` 补丁  ${patch}`] : []), "", t.muted(" 下一步")];
  if (patch && summary.status === "delivered") lines.push(` shallow build apply --run-dir ${shellArgument(runDirectory)}`);
  else if (summary.status !== "delivered") lines.push(` shallow build resume --run-dir ${shellArgument(runDirectory)}`);
  else lines.push(` 项目已写入 ${projectDirectory}`);
  lines.push("");
  return lines.join("\n");
}
