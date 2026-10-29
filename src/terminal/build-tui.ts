import { join } from "node:path";
import { matchesKey, ProcessTerminal, Text, TuiMainScreen, visibleWidth, type TUI, type Component, type OverlayHandle, type Terminal } from "@earendil-works/pi-tui";
import type { RunSummary } from "../pipeline.js";
import type { RequirementNode, RequirementStatus, RunEvent, RunScenarioResult } from "../types.js";
import { AGENT_LABELS, AGENT_ROLES, type AgentRole } from "../agent-config.js";
import type { PiWorkerProgress } from "../builder/pi-worker-client.js";
import { ModelUsageTotals, UsageTotals, formatModelUsageSummary, formatUsageSummary, type TokenUsage, type UsageSummary } from "../model-usage.js";
import { setMouseTracking } from "./mouse-wheel.js";
import { clearTerminalScreen, elapsedTime, fitTerminalText, terminalHeader, terminalRow, terminalTheme, type TerminalTheme } from "./theme.js";
import { TextViewer } from "./text-viewer.js";
import { verifierProgressLabel } from "../human-log.js";

const PHASES: Record<string, string> = {
  implementation: "模块实现", audit: "独立验收", repair: "修复与回归", delivery: "最终交付",
};

/** Braille spinner for the activity line; the frame follows wall-clock time. */
const ACTIVITY_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Render cadence while running; also the spinner frame duration. */
const RENDER_INTERVAL_MS = 200;

type TreeStatus = RequirementStatus | "implemented" | "skipped";
type ScenarioStatus = RunScenarioResult["status"];
interface TreeCounts {
  total: number;
  implemented: number;
  verified: number;
  failed: number;
  inconclusive: number;
  blocked: number;
  skipped: number;
  scenarioTotal: number;
  scenarioVerified: number;
}

/** Requirement ids and scenario ids are independent namespaces; never join with a separator that can appear in either. */
function scenarioKey(requirementId: string, scenarioId: string): string {
  return JSON.stringify([requirementId, scenarioId]);
}

const TREE_STATUS_LABEL: Record<TreeStatus, string> = {
  verified: "已验证", implemented: "已实现", failed: "失败", inconclusive: "证据不足", blocked: "阻塞", skipped: "沿用", todo: "未实现",
};
const TREE_STATUS_ICON: Record<TreeStatus, string> = {
  verified: "✓", implemented: "◐", failed: "✗", inconclusive: "?", blocked: "⊘", skipped: "·", todo: "○",
};

function treeColour(theme: TerminalTheme, status: TreeStatus): (text: string) => string {
  switch (status) {
    case "verified": return theme.success;
    case "implemented": return theme.builder;
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
  return theme.builder("█".repeat(filled)) + theme.muted("░".repeat(cells - filled));
}

export interface BuildTuiOptions {
  requirementIds: string[];
  /** 原始需求树；交互页面按子树聚合完成状态。 */
  requirementTree?: RequirementNode;
  /** 本轮输入需求树的完整 YAML；需求页面可切换查看。 */
  requirementsText?: string;
  /** 本轮三个角色的实际模型；状态页逐一标注来源。 */
  models: Record<AgentRole, string>;
  onInterrupt(): void;
}

/** 运行结束后保留在 TUI 中的结果摘要；只用于展示，不参与验收。 */
export interface BuildCompletion {
  status: RunSummary["status"];
  runDirectory: string;
  projectDirectory: string;
  elapsedMs: number;
  patch?: string;
}

/** A projection of emitted facts; presentation never grants verification. */
export class BuildView implements Component {
  private readonly statuses: Map<string, RequirementStatus>;
  /** 场景来源（需求树）与累积验收结果；模块边界只更新时间，不重置历史覆盖。 */
  private readonly scenariosByRequirement = new Map<string, string[]>();
  private readonly scenarioStatuses = new Map<string, ScenarioStatus>();
  /** Builder 已完成实现的需求；与独立验收结果无关，可同时出现在已验证/失败等状态中。 */
  private readonly implemented = new Set<string>();
  private scope: Set<string>;
  private readonly skippedIds = new Set<string>();
  private readonly runnable = new Set<string>();
  private readonly recent: string[] = [];
  private phase = "准备运行";
  private module = "等待功能分组";
  private activity = "正在准备需求与执行环境";
  private packetId?: string;
  private builderRunning = false;
  private readonly verifierTasks = new Map<string, { queued: boolean; label: string }>();
  private lastActivityAt = Date.now();
  private readonly startedAt = Date.now();
  private readonly usage = new ModelUsageTotals();
  private live?: TokenUsage;
  private readonly verifierLive = new Map<string, TokenUsage>();
  private usageExpanded = false;
  private awaitingStart = false;
  private completed = false;
  private finishedAt?: number;
  private outcome?: RunSummary["status"];

  constructor(
    private readonly options: BuildTuiOptions,
    private readonly rows: () => number,
    private readonly theme: TerminalTheme = terminalTheme(),
  ) {
    this.statuses = new Map(options.requirementIds.map(id => [id, "todo"]));
    this.scope = new Set(options.requirementIds);
    if (options.requirementTree) this.collectScenarios(options.requirementTree);
  }

  receive(event: RunEvent, line: string): void {
    const detail = event.detail as Record<string, unknown> | undefined;
    const ids = (key: string) => Array.isArray(detail?.[key]) ? detail![key] as string[] : [];
    const scenarioAuthoritative = event.type === "module_check_finished" ? detail?.published === true
      : event.type === "repair_batch_finished" ? detail?.retained === true : true;
    if (scenarioAuthoritative && Array.isArray(detail?.scenarioResults)) this.receiveScenarioResults(detail.scenarioResults);
    if (event.type === "snapshot_sealed" && detail?.authoritative !== false) {
      for (const id of ids("implementedRequirementIds")) this.implemented.add(id);
      // 封存新模块只代表源码更新；旧覆盖保留到后续验收明确给出失败或无法判断。
      this.verifierTasks.clear();
    }
    if (event.type === "evolution_scope_selected") {
      if (Array.isArray(detail?.auditRequirementIds)) this.scope = new Set(ids("auditRequirementIds"));
      this.setSkipped(ids("skippedRequirementIds"));
    }
    if (["checkpoint_saved", "module_rescued", "run_resumed"].includes(event.type)) {
      for (const id of ids("requirementIds")) this.implemented.add(id);
      for (const id of ids("requirementIds")) this.runnable.add(id);
    }
    if ((event.type === "module_check_finished" && detail?.published === true) || (event.type === "repair_batch_finished" && detail?.retained === true)) {
      const results = detail?.requirementResults as Record<string, RequirementStatus> | undefined;
      for (const [id, status] of Object.entries(results ?? {})) this.setStatus(id, status);
    }
    if (event.type === "dependency_gate_blocked" || event.type === "module_failed") {
      for (const id of ids("requirementIds")) this.statuses.set(id, "blocked");
    }
    if (event.type === "pipeline_finished") {
      if (Array.isArray(detail?.auditRequirementIds)) this.scope = new Set(ids("auditRequirementIds"));
      this.setSkipped(ids("skippedRequirementIds"));
      for (const id of this.scope) this.statuses.set(id, "todo");
      for (const id of ids("implementedRequirementIds")) this.implemented.add(id);
      for (const [key, status] of [["verifiedRequirementIds", "verified"], ["failedRequirementIds", "failed"],
        ["inconclusiveRequirementIds", "inconclusive"]] as const) {
        for (const id of ids(key)) this.setStatus(id, status);
      }
      for (const id of ids("blockedRequirementIds")) this.statuses.set(id, "blocked");
    }
    if (event.type === "feature_grouping_usage") {
      this.addUsage("grouper", detail);
      return;
    }
    if (event.type === "verifier_usage_progress") {
      const jobId = typeof detail?.jobId === "string" ? detail.jobId : undefined;
      const usage = this.usageFromDetail(detail);
      if (jobId && usage) this.verifierLive.set(jobId, usage);
      return;
    }
    if (event.type === "verifier_usage") {
      const jobId = typeof detail?.jobId === "string" ? detail.jobId : undefined;
      if (jobId) this.verifierLive.delete(jobId);
      this.addUsage("verifier", detail);
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
      this.verifierTasks.clear();
    }
    if (event.type.endsWith("_usage") || event.type === "builder_reference_images") return;
    const checkEvent = event.type.startsWith("check_");
    const jobId = typeof detail?.jobId === "string" ? detail.jobId : undefined;
    if (checkEvent && jobId) {
      if (event.type === "check_completed" || event.type === "check_cancelled") {
        this.verifierTasks.delete(jobId);
        this.verifierLive.delete(jobId);
      }
      if (detail?.archived) return;
      if (event.type === "check_queued") this.verifierTasks.set(jobId, { queued: true, label: "Verifier · 等待执行" });
      if (event.type === "check_started" || event.type === "check_progress") {
        // Keep the most recently active job last, independently of opaque packet ids.
        this.verifierTasks.delete(jobId);
        this.verifierTasks.set(jobId, { queued: false, label: event.type === "check_progress"
          ? verifierProgressLabel(event.detail!) : "Verifier · 开始检查" });
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
        this.activity = this.verifierActivity() ?? "Verifier · 当前任务结束，等待结果汇总";
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

  /** 运行结束后冻结计时并保留页面，供查看日志、需求树与花费。 */
  finish(status: RunSummary["status"]): void {
    this.completed = true;
    this.outcome = status;
    this.finishedAt = Date.now();
    this.builderRunning = false;
    this.verifierTasks.clear();
    this.verifierLive.clear();
    this.activity = "运行已结束，可查看日志、需求树与花费";
    this.lastActivityAt = this.finishedAt;
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

  private collectScenarios(node: RequirementNode): void {
    if (node.type === "ATOMIC" && node.scenarios.length) {
      this.scenariosByRequirement.set(node.id, node.scenarios.map(scenario => scenario.id));
    }
    for (const child of node.children) this.collectScenarios(child);
  }

  private receiveScenarioResults(value: unknown[]): void {
    for (const raw of value) {
      if (typeof raw !== "object" || raw === null) continue;
      const item = raw as Partial<RunScenarioResult>;
      if (typeof item.requirementId !== "string" || typeof item.scenarioId !== "string") continue;
      if (item.status !== "verified" && item.status !== "failed" && item.status !== "inconclusive" && item.status !== "not_run") continue;
      this.scenarioStatuses.set(scenarioKey(item.requirementId, item.scenarioId), item.status);
    }
  }

  private scenarioStatusesFor(requirementId: string): ScenarioStatus[] {
    return (this.scenariosByRequirement.get(requirementId) ?? []).map(scenarioId =>
      this.scenarioStatuses.get(scenarioKey(requirementId, scenarioId)) ?? "not_run");
  }

  private setSkipped(ids: string[]): void {
    this.skippedIds.clear();
    for (const id of ids) this.skippedIds.add(id);
  }

  private setStatus(id: string, status: RequirementStatus): void {
    this.statuses.set(id, status);
    // 验收结果只出现在已实现范围；旧事件缺少快照字段时也保持一致。
    if (status === "verified" || status === "failed" || status === "inconclusive") this.implemented.add(id);
  }

  private isImplemented(id: string): boolean {
    const status = this.statuses.get(id) ?? "todo";
    return this.implemented.has(id) || status === "verified" || status === "failed" || status === "inconclusive";
  }

  private treeStatus(id: string): TreeStatus {
    const status = this.statuses.get(id) ?? "todo";
    if (status !== "todo") return status;
    if (this.skippedIds.has(id)) return "skipped";
    return this.isImplemented(id) ? "implemented" : "todo";
  }

  private emptyCounts(): TreeCounts {
    return { total: 0, implemented: 0, verified: 0, failed: 0, inconclusive: 0, blocked: 0, skipped: 0,
      scenarioTotal: 0, scenarioVerified: 0 };
  }

  private addCounts(target: TreeCounts, source: TreeCounts): void {
    target.total += source.total;
    target.implemented += source.implemented;
    target.verified += source.verified;
    target.failed += source.failed;
    target.inconclusive += source.inconclusive;
    target.blocked += source.blocked;
    target.skipped += source.skipped;
    target.scenarioTotal += source.scenarioTotal;
    target.scenarioVerified += source.scenarioVerified;
  }

  private aggregateStatus(counts: TreeCounts): TreeStatus {
    if (counts.failed > 0) return "failed";
    if (counts.blocked > 0) return "blocked";
    if (counts.inconclusive > 0) return "inconclusive";
    if (counts.total > 0 && counts.verified === counts.total) return "verified";
    if (counts.total > 0 && counts.implemented === counts.total) return "implemented";
    if (counts.total === 0 && counts.skipped > 0) return "skipped";
    return "todo";
  }

  private addRequirement(counts: TreeCounts, id: string): void {
    const status = this.treeStatus(id);
    if (status === "skipped") { counts.skipped += 1; return; }
    counts.total += 1;
    if (this.isImplemented(id)) counts.implemented += 1;
    for (const scenario of this.scenarioStatusesFor(id)) {
      counts.scenarioTotal += 1;
      if (scenario === "verified") counts.scenarioVerified += 1;
    }
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
      this.addRequirement(counts, node.id);
      return counts;
    }
    for (const child of node.children) this.addCounts(counts, this.treeCounts(child));
    return counts;
  }

  private flatTreeCounts(): TreeCounts {
    const counts = this.emptyCounts();
    for (const id of this.statuses.keys()) this.addRequirement(counts, id);
    return counts;
  }

  private treeSuffix(counts: TreeCounts, theme: TerminalTheme): string {
    const parts = [
      counts.implemented ? theme.builder(`已实现 ${counts.implemented}/${counts.total}`) : theme.muted(`已实现 0/${counts.total}`),
      counts.verified ? theme.success(`已验证 ${counts.verified}/${counts.total}`) : theme.muted(`已验证 0/${counts.total}`),
      ...(counts.scenarioTotal ? [counts.scenarioVerified
        ? theme.success(`场景 ${counts.scenarioVerified}/${counts.scenarioTotal}`)
        : theme.muted(`场景 0/${counts.scenarioTotal}`)] : []),
    ];
    if (counts.failed) parts.push(`${theme.error(`失败 ${counts.failed}`)}`);
    if (counts.inconclusive) parts.push(`${theme.warning(`证据不足 ${counts.inconclusive}`)}`);
    if (counts.blocked) parts.push(`${theme.blocked(`阻塞 ${counts.blocked}`)}`);
    if (counts.skipped) parts.push(`${theme.muted(`沿用 ${counts.skipped}`)}`);
    return parts.join(theme.muted(" · "));
  }

  private treeSummary(counts: TreeCounts, theme: TerminalTheme): string {
    return [
      counts.implemented ? theme.builder(`已实现 ${counts.implemented}/${counts.total}`) : theme.muted(`已实现 0/${counts.total}`),
      counts.verified ? theme.success(`已验证 ${counts.verified}/${counts.total}`) : theme.muted(`已验证 0/${counts.total}`),
      ...(counts.scenarioTotal ? [counts.scenarioVerified
        ? theme.success(`场景覆盖 ${counts.scenarioVerified}/${counts.scenarioTotal}`)
        : theme.muted(`场景覆盖 0/${counts.scenarioTotal}`)] : []),
      counts.failed ? theme.error(`失败 ${counts.failed}`) : theme.muted("失败 0"),
      counts.inconclusive ? theme.warning(`证据不足 ${counts.inconclusive}`) : theme.muted("证据不足 0"),
      counts.blocked ? theme.blocked(`阻塞 ${counts.blocked}`) : theme.muted("阻塞 0"),
      theme.muted(`未实现 ${counts.total - counts.implemented}`),
      ...(counts.skipped ? [theme.muted(`沿用 ${counts.skipped}`)] : []),
    ].join("  ");
  }

  private appendTree(node: RequirementNode, prefix: string, last: boolean, lines: string[], theme: TerminalTheme, root = false): void {
    const counts = this.treeCounts(node);
    const status = this.aggregateStatus(counts);
    const connector = root ? "" : `${prefix}${last ? "└─ " : "├─ "}`;
    const icon = node.type === "ATOMIC" ? TREE_STATUS_ICON[status] : status === "todo" ? "○" : TREE_STATUS_ICON[status];
    const scenario = counts.scenarioTotal
      ? `  ${counts.scenarioVerified ? theme.success(`场景 ${counts.scenarioVerified}/${counts.scenarioTotal}`)
        : theme.muted(`场景 0/${counts.scenarioTotal}`)}`
      : "";
    const suffix = node.type === "ATOMIC"
      ? `  ${theme.muted(`[${TREE_STATUS_LABEL[status]}]`)}${scenario}`
      : `  ${this.treeSuffix(counts, theme)}`;
    lines.push(theme.border(connector) + treeColour(theme, status)(`${icon} ${node.name}`) + suffix);
    const childPrefix = root ? "" : `${prefix}${last ? "   " : "│  "}`;
    node.children.forEach((child, index) => this.appendTree(child, childPrefix, index === node.children.length - 1, lines, theme));
  }

  private modelLines(width: number, t: TerminalTheme, compact = false): string[] {
    const entries = AGENT_ROLES.map(role => {
      const colour = role === "builder" ? t.builder : role === "verifier" ? t.verifier : t.grouper;
      const model = compact ? (this.options.models[role].split("/").at(-1) ?? this.options.models[role])
        : this.options.models[role];
      return `${colour(AGENT_LABELS[role])} ${model}`;
    });
    const line = ` ${t.label("模型")}  ${entries.join(` ${t.faint("·")} `)}`;
    if (compact || visibleWidth(line) <= width) return [line];
    return entries.map((entry, index) => ` ${index === 0 ? t.label("模型") : "    "}  ${entry}`);
  }

  private usageLines(): string[] {
    const summary = this.usage.summary(this.live, this.verifierProgressUsage());
    const lines = [`总计  ${formatUsageSummary(summary)}`];
    if (this.usageExpanded) {
      let details = 0;
      for (const role of AGENT_ROLES) {
        const usage = summary[role];
        if (usage.total <= 0) continue;
        lines.push(`${AGENT_LABELS[role]}  ${formatUsageSummary(usage)}`);
        details += 1;
      }
      // 启动前展开时给出明确反馈，避免按键看起来没有响应。
      if (!details) lines.push("花费明细  尚未产生用量");
    }
    return lines;
  }

  private highlightRole(text: string, t: TerminalTheme): { colour: (value: string) => string; text: string } {
    const role = AGENT_ROLES.map(role => AGENT_LABELS[role]).find(name => text.startsWith(name));
    if (!role) return { colour: t.accent, text };
    const colour = role === AGENT_LABELS.builder ? t.builder : role === AGENT_LABELS.verifier ? t.verifier : t.grouper;
    return { colour, text: colour(role) + text.slice(role.length) };
  }

  private progressLines(width: number, counts: { implemented: number; verified: number; failed: number; inconclusive: number;
    blocked: number; scenarioTotal: number; scenarioVerified: number }, t: TerminalTheme): string[] {
    const total = this.scope.size;
    const bar = progressBar(counts.implemented, total, Math.max(5, Math.min(18, Math.floor(width / 8))), t);
    const implemented = `已实现 ${counts.implemented}/${total}`;
    const verified = `已验证 ${counts.verified}/${total}`;
    const scenarios = counts.scenarioTotal ? `场景覆盖 ${counts.scenarioVerified}/${counts.scenarioTotal}` : undefined;
    const progress = `${t.accent("进度")} ${bar} ${counts.implemented ? t.strong(t.builder(implemented)) : t.accent(t.strong(implemented))}`;
    const pending = total - counts.implemented;
    const summary = [
      counts.verified ? t.strong(t.success(verified)) : t.muted(verified),
      ...(scenarios ? [counts.scenarioVerified ? t.strong(t.success(scenarios)) : t.muted(scenarios)] : []),
      counts.failed ? t.strong(t.error(`失败 ${counts.failed}`)) : t.muted(`失败 ${counts.failed}`),
      counts.inconclusive ? t.strong(t.warning(`证据不足 ${counts.inconclusive}`)) : t.muted(`证据不足 ${counts.inconclusive}`),
      `${t.muted(`阻塞 ${counts.blocked} · `)}${pending ? t.accent(`未实现 ${pending}`) : t.muted("未实现 0")}`,
    ].join("  ");
    return width >= 60 ? [` ${progress}  ${summary}`] : [` ${progress}`, ` ${summary}`];
  }

  render(width: number): string[] {
    const t = this.theme;
    const counts = { implemented: 0, verified: 0, failed: 0, inconclusive: 0, blocked: 0, scenarioTotal: 0, scenarioVerified: 0 };
    for (const id of this.scope) {
      if (this.isImplemented(id)) counts.implemented += 1;
      const status = this.statuses.get(id) ?? "todo";
      if (status !== "todo") counts[status] += 1;
      for (const scenario of this.scenarioStatusesFor(id)) {
        counts.scenarioTotal += 1;
        if (scenario === "verified") counts.scenarioVerified += 1;
      }
    }
    const frame = ACTIVITY_FRAMES[Math.floor(Date.now() / RENDER_INTERVAL_MS) % ACTIVITY_FRAMES.length];
    const activityRole = this.highlightRole(this.activity, t);
    const completionColour = this.outcome === "delivered" ? t.success : this.outcome === "partial" ? t.warning : t.error;
    const activity = this.awaitingStart
      ? ` ${t.accent("◆")} ${t.strong("按 Enter 开始运行")}`
      : this.completed
        ? ` ${completionColour("◆")} ${t.strong(this.activity)}`
        : ` ${activityRole.colour(frame)} ${activityRole.text}`;
    const verifier = this.builderRunning ? this.verifierActivity() : undefined;
    const verifierLines = verifier ? [` ${t.muted("后台")} ${this.highlightRole(verifier, t).text}`] : [];
    const modelLines = this.modelLines(width, t);
    const keyHint = (key: string, label: string) => `${t.accent(key)} ${t.label(label)}`;
    const footer = this.awaitingStart
      ? ` ${keyHint("Enter", "开始运行")}   ${keyHint("d", "日志")}   ${keyHint("t", "需求树")}   ` +
        `${keyHint("c", "花费")}   ${keyHint("?", "帮助")}   ${t.muted("^C 中断")}`
      : width >= 60
        ? ` ${keyHint("d", "详细日志")}   ${keyHint("t", "需求树")}   ` +
          `${keyHint("c", this.usageExpanded ? "收起花费" : "花费明细")}   ${keyHint("?", "帮助")}   ` +
          (this.completed ? keyHint("Ctrl+C", "退出") : t.muted("Ctrl+C 中断"))
        : ` ${keyHint("d", "日志")}  ${keyHint("t", "需求树")}  ${keyHint("c", this.usageExpanded ? "收起" : "花费")}  ` +
          `${keyHint("?", "帮助")}  ${this.completed ? keyHint("^C", "退出") : t.muted("^C 中断")}`;
    const usage = this.usageLines();
    const progress = this.progressLines(width, counts, t);
    const compact = () => {
      const head = [terminalHeader("Builder", width, t)[0], ...this.modelLines(width, t, true), activity, ...verifierLines];
      const tail = [...progress, footer];
      return [...head, ...usage.slice(0, Math.max(0, this.rows() - head.length - tail.length)).map(line => ` ${line}`), ...tail]
        .slice(0, this.rows()).map(line => fitTerminalText(line, width));
    };
    if (this.rows() < 18) return compact();
    const usageLines = usage.flatMap(line => new Text(line, 1, 0).render(width));
    const runState = this.awaitingStart ? t.accent("● 等待开始")
      : this.completed ? this.outcome === "delivered" ? t.success("● 交付完成")
        : this.outcome === "partial" ? t.warning("● 部分完成") : t.error("● 交付失败")
        : t.success("● 运行中");
    const elapsed = elapsedTime((this.finishedAt ?? Date.now()) - this.startedAt);
    const runnable = [...this.scope].filter(id => this.runnable.has(id)).length;
    const lines = [
      ...terminalHeader("Builder", width, t), "",
      terminalRow(` ${t.strong(t.accent(this.phase))}`, `${runState} ${t.muted(elapsed + " ")}`, width),
      ` ${t.label("模块")}  ${this.module}`,
      ...modelLines,
      ...usageLines,
      activity,
      ...verifierLines,
      this.awaitingStart
        ? t.muted(" 尚未开始 · Enter 启动本轮运行，其他按键可先查看日志与需求树")
        : this.completed
          ? t.muted(" 运行已结束 · 按 d 查看日志、t 查看需求树、c 查看花费；Ctrl+C 退出")
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

  private usageFromDetail(usage: Record<string, unknown> | undefined): TokenUsage | undefined {
    if (!usage || typeof usage.input !== "number" || typeof usage.output !== "number") return undefined;
    const number = (key: string) => typeof usage[key] === "number" ? usage[key] as number : 0;
    const cost = typeof usage.cost === "number" ? usage.cost : undefined;
    return { input: number("input"), output: number("output"), cacheRead: number("cacheRead"),
      cacheWrite: number("cacheWrite"), ...(cost === undefined ? {} : { cost }),
      ...(typeof usage.unpricedTokens === "number" ? { unpricedTokens: usage.unpricedTokens } : {}) };
  }

  private addUsage(source: AgentRole, usage: Record<string, unknown> | undefined): void {
    const parsed = this.usageFromDetail(usage);
    if (parsed) this.usage.add(source, parsed);
  }

  /** 并发 Verifier 任务各自上报累计值，显示时汇总但不写入结算用量。 */
  private verifierProgressUsage(): TokenUsage | undefined {
    if (!this.verifierLive.size) return undefined;
    const totals = new UsageTotals();
    for (const usage of this.verifierLive.values()) totals.add(usage);
    return totals.summary();
  }

  private verifierActivity(): string | undefined {
    const tasks = [...this.verifierTasks.values()];
    if (!tasks.length) return undefined;
    const active = tasks.filter(task => !task.queued);
    const queued = tasks.length - active.length;
    return (active.at(-1)?.label ?? "Verifier · 等待执行") +
      (active.length > 1 ? ` · ${active.length} 项运行` : "") + (queued ? ` · ${queued} 项排队` : "");
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
      case "module_check_started": return "Verifier · 模块集中重放与确认";
      case "module_check_finished": return detail?.moduleId === "<final>" ? "当前交付范围验收完成" : "模块当前版本检查完成";
      case "feature_grouping_started": return "Grouper · 整理功能分组";
      case "feature_grouping_finished": return "功能分组完成，准备实现";
      case "phase_started": this.phase = PHASES[String(detail?.phase)] ?? "运行中"; return this.phase;
      case "packet_selected": return "已选择需求包，准备 Builder";
      case "builder_started": return `Builder · 实现当前模块${detail?.attempt ? ` · 第 ${detail.attempt} 次尝试` : ""}`;
      case "builder_finished": return this.verifierActivity() ?? (detail?.outcome === "completed" ? "Builder 本轮完成，等待运行检查" : "Builder 本轮结束，检查候选与检查点");
      case "candidate_prepared": return "候选构建完成，准备独立验收";
      case "gateway_wait": return `${detail?.source === "builder" ? "Builder" : detail?.source === "verifier" ? "Verifier" : "Grouper"} · 等待模型网关恢复`;
      case "repair_batch_started": return `Builder · 第 ${detail?.round ?? 1} 轮修复`;
      case "delivery_started": this.phase = "最终交付"; return "重新验收当前范围，检查交付入口";
      case "delivery_check_started": return "检查交付运行合同";
      case "delivery_check_finished": return detail?.ok ? "交付运行合同检查通过" : "交付运行合同未通过，准备修复";
      case "delivery_repair_restored": return "交付修复未保留，已恢复检查点";
      case "pipeline_finished": return "本轮结束，正在保存报告与进度";
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
  private completed = false;
  private requirementsYaml = false;
  private readonly startedRun: Promise<void>;
  private resolveStart!: () => void;
  private readonly exited: Promise<void>;
  private resolveExit!: () => void;

  constructor(private readonly options: BuildTuiOptions, terminal: Terminal = new ProcessTerminal()) {
    this.tui = new TuiMainScreen(terminal);
    this.tui.setClearOnShrink(true);
    this.view = new BuildView(options, () => terminal.rows, this.theme);
    this.view.setAwaitingStart(true);
    this.startedRun = new Promise(resolve => { this.resolveStart = resolve; });
    this.exited = new Promise(resolve => { this.resolveExit = resolve; });
    this.tui.addChild(this.view);
    this.tui.addInputListener(data => {
      if (matchesKey(data, "ctrl+c")) {
        if (this.completed) { this.resolveExit(); return { consume: true }; }
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

  /** 等待用户在 TUI 中确认开始；确认前不启动 Builder 或 Verifier。 */
  waitForStart(): Promise<void> { return this.startedRun; }

  /** 运行结束：冻结状态但保持页面，直到用户按 Ctrl+C 退出。 */
  complete(completion: BuildCompletion): void {
    if (this.completed) return;
    this.completed = true;
    this.view.finish(completion.status);
    clearInterval(this.timer);
    this.timer = undefined;
    const label = completion.status === "delivered" ? "交付完成"
      : completion.status === "partial" ? "部分完成" : "交付失败";
    const lines = [
      "",
      `本轮结束：${label} · 总耗时 ${elapsedTime(completion.elapsedMs)}`,
      `报告：${join(completion.runDirectory, "report.md")}`,
      `日志：${join(completion.runDirectory, "run-log.txt")}`,
      ...(completion.patch ? [`补丁：${completion.patch}`] : []),
      `项目：${completion.projectDirectory}`,
    ];
    if (completion.status !== "delivered") {
      lines.push("下一步：在项目目录再次执行 shallow build");
    }
    this.log.push(...lines);
    if (this.log.length > 500) this.log.splice(0, this.log.length - 500);
    this.viewer?.setText("详细日志 · 最近 500 条", this.log.join("\n"), false);
    this.refreshRequirementsViewer();
    this.tui.requestRender();
  }

  /** 完成后的 TUI 等待用户主动退出；进程在收到该信号后才结束。 */
  waitForExit(): Promise<void> { return this.exited; }

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
    // 进行中用量只刷新费用面板，不进入“详细日志”或在屏日志。
    if (event.type === "verifier_usage_progress") {
      this.tui.requestRender();
      return;
    }
    this.log.push(line);
    if (this.log.length > 500) this.log.shift();
    this.viewer?.setText("详细日志 · 最近 500 条", this.log.join("\n"), false);
    this.refreshRequirementsViewer();
    this.tui.requestRender();
  }

  stop(): void {
    this.resolveExit?.();
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
    this.requirementsYaml = false;
    const viewer = new TextViewer(this.tui, this.theme, "需求树 · 完成情况",
      this.view.requirementTreeText(this.theme), () => this.closeViewer());
    viewer.onToggle = () => {
      this.requirementsYaml = !this.requirementsYaml;
      this.refreshRequirementsViewer();
    };
    this.treeViewer = viewer;
    setMouseTracking(this.tui.terminal, true);
    this.overlay = this.tui.showOverlay(viewer, { width: "100%", anchor: "top-left" });
  }

  /** 需求页面跟随验收状态更新；切换到完整 YAML 后保持原文不动。 */
  private refreshRequirementsViewer(): void {
    const viewer = this.treeViewer;
    if (!viewer) return;
    viewer.setText(this.requirementsYaml ? "需求树 · requirements.yaml" : "需求树 · 完成情况",
      this.requirementsYaml ? this.options.requirementsText?.trimEnd() || "需求文件内容不可用。" : this.view.requirementTreeText(this.theme), false);
  }

  private showHelp(): void {
    this.treeViewer = undefined;
    const viewer = new TextViewer(this.tui, this.theme, "运行帮助",
      "d  查看详细日志，包含安装、构建与模型用量\nt  查看需求树与每个需求的实现/验收状态；按 v 切换完整 requirements.yaml\n   子树按聚合状态着色：已实现 / 已验证 / 失败 / 证据不足 / 阻塞 / 未实现\nc  展开或收起花费明细；默认只显示总计\n↑↓ / 滚轮 / PgUp / PgDn  滚动页面\nEsc  返回运行状态\nCtrl+C  运行中中断，运行结束后退出\n\n" +
      "已实现：Builder 已写出该需求的实现，独立验收尚未给出结果；进度条按已实现计数\n已验证：最近一次独立验收通过，交付前仍会复验；新模块封存不会清空已有覆盖\n场景覆盖：需求内场景通过独立验收的比例，模块推进时累计，直到后续检查明确失败或无法判断\n证据不足：本轮验收无法确定行为结果，需求仍算已实现\n未实现：Builder 尚未实现该需求\n可运行检查点：保存了可运行实现，功能验收单独记录\n沿用跳过：不计入本轮验收通过\n后台 Verifier：与 Builder 并行，单独显示检查阶段与排队数量\n程序复核通过：测试程序合格，需求结果仍由当前版本重放确定\n\n完整日志持续保存到 run-log.txt；运行结束后 TUI 保持打开，报告与项目路径追加在详细日志末尾；在项目目录再次执行 shallow build 可继续开发，按 Ctrl+C 退出。",
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
  const scenarios = summary.scenarioResults ?? [];
  const scenarioVerified = scenarios.filter(item => item.status === "verified").length;
  const scenarioDetails = [["失败", "failed"], ["无法判断", "inconclusive"], ["未运行", "not_run"]]
    .map(([label, key]) => ({ label, count: scenarios.filter(item => item.status === key).length }))
    .filter(item => item.count > 0).map(item => `${item.label} ${item.count}`).join(" · ");
  const lines = ["", ...terminalHeader("Result", width, t), "", " " + t.strong(status),
    ` 已实现 ${summary.implementedRequirementIds?.length ?? summary.verifiedRequirementIds.length} · ` +
      `已验证 ${summary.verifiedRequirementIds.length} · 业务失败 ${summary.failedRequirementIds?.length ?? 0} · ` +
      `证据不足 ${summary.inconclusiveRequirementIds?.length ?? 0}`,
    ` 阻塞 ${summary.blockedRequirementIds.length} · 待处理 ${summary.pendingRequirementIds?.length ?? 0} · 沿用跳过 ${summary.skippedRequirementIds?.length ?? 0}`,
    ...(scenarios.length ? [` 场景覆盖 ${scenarioVerified}/${scenarios.length}${scenarioDetails ? ` · ${scenarioDetails}` : ""}`] : []),
    ` 总耗时  ${elapsedTime(elapsedMs)}`,
    ...(summary.modelUsage ? formatModelUsageSummary(summary.modelUsage).map(line => ` ${line}`) : []),
    "", ` 报告  ${join(runDirectory, "report.md")}`, ` 日志  ${join(runDirectory, "run-log.txt")}`,
    ...(patch ? [` 补丁  ${patch}`] : []), "", t.muted(" 下一步")];
  if (summary.status !== "delivered") lines.push(" 在项目目录再次执行 shallow build");
  else lines.push(` 项目已写入 ${projectDirectory}`);
  lines.push("");
  return lines.join("\n");
}
