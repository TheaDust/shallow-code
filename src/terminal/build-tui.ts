import { join } from "node:path";
import { matchesKey, ProcessTerminal, Text, TuiMainScreen, type TUI, type Component, type OverlayHandle, type Terminal } from "@earendil-works/pi-tui";
import type { RunSummary } from "../pipeline.js";
import type { RequirementStatus, RunEvent } from "../types.js";
import type { PiWorkerProgress } from "../builder/pi-worker-client.js";
import { ModelUsageTotals, formatModelUsageSummary, type TokenUsage } from "../model-usage.js";
import { setMouseTracking } from "./mouse-wheel.js";
import { clearTerminalScreen, elapsedTime, fitTerminalText, shellArgument, terminalHeader, terminalRow, terminalTheme, type TerminalTheme } from "./theme.js";
import { TextViewer } from "./text-viewer.js";

const PHASES: Record<string, string> = {
  implementation: "模块实现", audit: "独立验收", repair: "修复与回归", delivery: "最终交付",
};

/** Braille spinner for the activity line; the frame follows wall-clock time. */
const ACTIVITY_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Render cadence while running; also the spinner frame duration. */
const RENDER_INTERVAL_MS = 200;

export interface BuildTuiOptions {
  requirementIds: string[];
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
    if (event.type === "evolution_scope_selected") {
      if (Array.isArray(detail?.auditRequirementIds)) this.scope = new Set(ids("auditRequirementIds"));
      this.skipped = ids("skippedRequirementIds").length;
    }
    if (["checkpoint_saved", "module_rescued", "run_resumed"].includes(event.type)) {
      for (const id of ids("requirementIds")) this.runnable.add(id);
    }
    if (event.type === "audit_result") {
      for (const id of ids("requirementIds")) this.statuses.set(id, detail!.status as RequirementStatus);
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
    if (event.type === "feature_grouping_usage" || event.type === "probe_planner_usage") {
      this.addUsage("judge", detail);
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
    if (event.type.endsWith("_usage") || event.type === "builder_reference_images") return;
    const message = line.replace(/^\[[^\]]+\]\s*/, "").replace(/ \[#.*\]$/, "");
    // Packet ids stay in run-log.txt; the progress list reads as user-facing text.
    const readable = event.packetId
      ? message.replaceAll(`（${event.packetId}）`, "").replaceAll(`（${event.packetId}，`, "（").trim()
      : message;
    this.recent.push(event.type === "packet_selected"
      ? `开始处理 ${ids("names").join("、") || "当前需求包"}`
      : readable.split("；", 1)[0]);
    if (this.recent.length > 5) this.recent.shift();
    if (event.type === "packet_selected") {
      this.packetId = event.packetId;
      this.module = ids("names").join("、") || event.packetId || "当前需求包";
    }
    if (event.packetId && this.packetId && event.packetId !== this.packetId) return;
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
      t.muted(`阻塞 ${counts.blocked} · 待处理 ${counts.todo}`),
    ].join("  ");
    const frame = ACTIVITY_FRAMES[Math.floor(Date.now() / RENDER_INTERVAL_MS) % ACTIVITY_FRAMES.length];
    const activity = ` ${t.accent(frame)} ${this.activity}`;
    const footer = t.muted(" d 详细日志   ? 帮助   Ctrl+C 中断");
    const usage = formatModelUsageSummary(this.usage.summary(this.live));
    const compact = () => [terminalHeader("Build Agent", width, t)[0], activity,
      ...usage.map(line => ` ${line}`), " " + status, footer]
      .slice(0, this.rows()).map(line => fitTerminalText(line, width));
    if (this.rows() < 18) return compact();
    const usageLines = usage.flatMap(line => new Text(line, 1, 0).render(width));
    const lines = [
      ...terminalHeader("Build Agent", width, t), "",
      terminalRow(` ${t.strong(this.phase)}`, t.muted(elapsedTime(Date.now() - this.startedAt) + " "), width),
      ` ${t.muted("模块")}  ${this.module}`,
      ...usageLines,
      activity,
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

  private addUsage(source: "builder" | "judge", usage: Record<string, unknown> | undefined): void {
    if (!usage || typeof usage.input !== "number" || typeof usage.output !== "number") return;
    const number = (key: string) => typeof usage[key] === "number" ? usage[key] as number : 0;
    const cost = typeof usage.cost === "number" ? usage.cost : undefined;
    this.usage.add(source, { input: number("input"), output: number("output"), cacheRead: number("cacheRead"),
      cacheWrite: number("cacheWrite"), ...(cost === undefined ? {} : { cost }),
      ...(typeof usage.unpricedTokens === "number" ? { unpricedTokens: usage.unpricedTokens } : {}) });
  }

  private describeActivity(event: RunEvent, detail: Record<string, unknown> | undefined): string | undefined {
    switch (event.type) {
      case "feature_grouping_started": return "Planner · 整理功能分组";
      case "feature_grouping_finished": return "功能分组完成，准备实现";
      case "phase_started": this.phase = PHASES[String(detail?.phase)] ?? "运行中"; return this.phase;
      case "packet_selected": return "已选择需求包，准备 Builder";
      case "builder_started": return `Builder · 实现当前模块${detail?.attempt ? ` · 第 ${detail.attempt} 次尝试` : ""}`;
      case "builder_finished": return detail?.outcome === "completed" ? "Builder 本轮完成，等待运行检查" : "Builder 本轮结束，检查候选与检查点";
      case "candidate_prepared": return "候选构建完成，准备浏览器验收";
      case "probe_planning": return "Judge · 规划验收场景";
      case "probe_planned": return `Judge · 执行 ${detail?.cases ?? ""} 个浏览器场景`;
      case "audit_result": return detail?.status === "verified" ? "独立验收通过" : detail?.status === "failed" ? "验收复现业务失败" : "验收证据不足，保留可运行实现";
      case "gateway_wait": return `${detail?.source === "builder" ? "Builder" : "Planner"} · 等待模型网关恢复`;
      case "repair_batch_started": return `Builder · 第 ${detail?.round ?? 1} 轮修复`;
      case "delivery_started": this.phase = "最终交付"; return "重新验收当前范围，检查交付入口";
      case "verification_started": return "检查交付应用与浏览器入口";
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
      "已验证：当前候选获得独立浏览器验收证据\n证据不足：本轮验收无法确定行为结果\n可运行检查点：保存了可运行实现，功能验收单独记录\n沿用跳过：不计入本轮验收通过\n\n完整日志持续保存到 run-log.txt；结束后会显示报告和恢复命令。",
      () => this.closeViewer());
    setMouseTracking(this.tui.terminal, true);
    this.overlay = this.tui.showOverlay(viewer, { width: "100%", anchor: "top-left" });
  }

  private closeViewer(): void {
    this.overlay?.hide(); this.overlay = undefined; this.viewer = undefined;
    setMouseTracking(this.tui.terminal, false);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
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
