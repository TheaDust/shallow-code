import type { RunEvent } from "./types.js";
import { sanitizeDiagnosticText } from "./diagnostics.js";

export class HumanRunFormatter {
  private firstAtMs: number | null = null;

  format(rawLine: string): string | null {
    const event = parseEvent(rawLine);
    if (!event) return null;
    const at = typeof event.at === "string" ? Date.parse(event.at) : Number.NaN;
    const elapsed = this.trackElapsed(at);
    const message = describe(event.type, event);
    if (message === null) return null;
    const elapsedSuffix = elapsed === null ? "" : ` +${elapsed}`;
    const context = event.sequence ? ` [#${event.sequence}${event.attempt ? ` 尝试 ${event.attempt}` : ""}]` : "";
    const duration = pickNumber(event.detail, "durationMs");
    const durationText = duration === null ? "" : `；本阶段耗时 ${renderDuration(duration)}`;
    return `[${renderClock(at)}${elapsedSuffix}] ${message.replace(/[\r\n]+/g, " ↵ ")}${durationText}${context}`;
  }

  private trackElapsed(atMs: number): string | null {
    if (!Number.isFinite(atMs)) return null;
    if (this.firstAtMs === null) {
      this.firstAtMs = atMs;
      return "0s";
    }
    return renderDuration(atMs - this.firstAtMs);
  }
}

function plannerFailureText(detail: RunEvent["detail"]): string {
  const message = pickString(detail, "message");
  const category = pickString(detail, "category");
  const validationError = pickString(detail, "validationError");
  return `${category ? ` [${category}]` : ""}${message ? `：${message}` : ""}${
    validationError ? `；原因：${validationError}` : ""
  }`;
}

function parseEvent(rawLine: string): RunEvent | null {
  const trimmed = rawLine.trim();
  if (!trimmed) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<RunEvent>;
  if (typeof candidate.type !== "string") return null;
  return value as RunEvent;
}

function describe(type: string, event: RunEvent): string | null {
  const detail: Record<string, unknown> | undefined = event.detail;
  const packetId = event.packetId ?? "";
  const message = pickString(detail, "message");
  const reason = pickString(detail, "reason");
  switch (type) {
    case "phase_started":
      return `进入${({ implementation: "模块实现", audit: "独立验收", repair: "修复", delivery: "最终交付" } as Record<string, string>)[pickString(detail, "phase") ?? ""] ?? "运行"}阶段${detail?.round ? `；第 ${detail.round} 轮` : ""}${typeof detail?.remainingMs === "number" ? `；阶段剩余 ${renderDuration(detail.remainingMs)}` : ""}`;
    case "checkpoint_saved":
      return `保存可运行检查点；${pickString(detail, "reason")}；需求 ${strings(detail?.requirementIds).join("、")}；SHA ${event.acceptedSha ?? ""}（功能验收状态单独记录）`;
    case "module_failed":
      return `模块实现未形成可运行版本，已恢复检查点（${packetId}）${reason ? `：${reason}` : ""}`;
    case "module_rescued":
      return `Builder 未完成回执，但写出的应用可运行，已保存为可运行版本（${packetId}）；需求 ${strings(detail?.requirementIds).join("、")}${reason ? `；回执原因：${reason}` : ""}`;
    case "audit_result":
      return `独立验收${detail?.status === "verified" ? "通过" : detail?.status === "failed" ? "业务失败已复现" : "无法判断"}（${packetId}）；保留可运行检查点${pickString(detail, "failureKind") ? `；分类 ${inconclusiveKindText(pickString(detail, "failureKind")!)}` : ""}${detail?.navigationRecovered ? "；使用已确认的导航恢复" : ""}${detail?.uncoveredOutcomes ? `；未覆盖场景结果 ${detail.uncoveredOutcomes}` : ""}${reason ? `；${reason}` : ""}`;
    case "repair_guard_checked":
      return `修复守卫${({ passed: "通过", regressed: "确认回归", unresolved: "无法判定" } as Record<string, string>)[pickString(detail, "status") ?? ""] ?? "检查"}（${packetId}）${detail?.critical ? "；必须确认的既有路径" : ""}${detail?.retried ? "；已用新应用实例重试" : ""}${pickString(detail, "failureKind") ? `；分类 ${inconclusiveKindText(pickString(detail, "failureKind")!)}` : ""}`;
    case "public_entry_checked":
      return `公共入口检查${({ passed: "通过", failed: "缺口已复现", unresolved: "无法判定" } as Record<string, string>)[pickString(detail, "status") ?? ""] ?? "完成"}（${packetId}）；仅为入口证据，完整场景验收另计${pickString(detail, "failureKind") ? `；分类 ${inconclusiveKindText(pickString(detail, "failureKind")!)}` : ""}`;
    case "compatibility_checked":
      return `兼容性检查${({ passed: "通过", failed: "缺口已复现", unresolved: "无法判定" } as Record<string, string>)[pickString(detail, "status") ?? ""] ?? "完成"}（${packetId}）；不单独授予需求通过${pickString(detail, "failureKind") ? `；分类 ${inconclusiveKindText(pickString(detail, "failureKind")!)}` : ""}`;
    case "repair_batch_started":
      return `开始第 ${detail?.round} 轮修复；需求 ${strings(detail?.requirementIds).join("、")}`;
    case "repair_batch_finished":
      return `第 ${detail?.round} 轮修复${detail?.retained ? "已保存" : "已恢复原检查点"}${detail?.retained && (detail.improvedCases || detail.resolvedGaps) ? `；新增通过用例 ${detail.improvedCases ?? 0}，已解决准备/控件缺口 ${detail.resolvedGaps ?? 0}` : ""}${reason ? `；${reason}` : ""}`;
    case "repair_paused":
      return `模型网关故障，暂停本轮修复并等待恢复后重试（${packetId}）；需求 ${strings(detail?.requirementIds).join("、")}`;
    case "pipeline_started": {
      const grouping = typeof detail?.grouping === "object" && detail.grouping !== null
        ? detail.grouping as Record<string, unknown> : undefined;
      const groups = pickNumber(grouping, "packets");
      const contextWindow = pickNumber(detail, "builderContextWindow");
      const scaffold = asRecord(detail?.starterScaffold);
      const scaffoldStatus = scaffold && typeof scaffold.status === "string" ? scaffold.status : null;
      const stage = asRecord(detail?.progressiveStage);
      const stageIndex = pickNumber(stage, "index");
      const stageStart = pickString(stage, "startingPoint");
      const stageText = stageIndex === null ? "" : `；分阶段任务 Stage ${stageIndex}${stageStart === "inherited_application" ? "（继承前序应用）" : stageStart === "blank_template" ? "（空白模板）" : ""}`;
      const evolution = asRecord(detail?.evolution);
      const evolutionStage = pickNumber(evolution, "stageIndex");
      const evolutionStart = pickString(evolution, "startingPoint");
      const evolutionText = evolution ? `；增量开发 Evolution${evolutionStage === null ? "" : ` Stage ${evolutionStage}`}${evolutionStart === "inherited_application" ? "（继承已有应用）" : evolutionStart === "blank_template" ? "（空白模板）" : ""}` : "";
      return `流水线启动${detail ? `；原子需求 ${pickNumber(detail, "requirements") ?? "未知"}；预算 ${detail.totalBudgetMs === 0 ? "不限时" : renderDuration(pickNumber(detail, "totalBudgetMs") ?? 0)}；探针端口 ${pickNumber(detail, "port") ?? "未知"}${pickString(detail, "model") ? `；模型 ${pickString(detail, "model")}` : ""}${contextWindow !== null ? `；Builder 上下文 ${contextWindow}` : ""}${groups !== null ? `；功能组 ${groups}` : ""}${scaffoldStatus ? `；通用脚手架 ${scaffoldStatus}` : ""}${stageText}${evolutionText}` : ""}`;
    }
    case "packet_selected":
      return `选定需求包 ${packetId}${strings(detail?.names).length ? `：${strings(detail?.names).join("、")}` : ""}`;
    case "evolution_scope_selected": {
      const skipped = strings(detail?.skippedRequirementIds).length;
      const history = pickNumber(detail, "historicalRequirementCount") === null ? ""
        : `；历史计划需求 ID ${pickNumber(detail, "historicalPlanRequirementCount") ?? 0}；历史检查点需求 ID ${pickNumber(detail, "historicalCheckpointRequirementCount") ?? 0}；检查点补充 ID ${pickNumber(detail, "historicalCheckpointSupplementCount") ?? 0}；合并历史 ID ${pickNumber(detail, "historicalRequirementCount")}`;
      const auditScope = Array.isArray(detail?.auditRequirementIds)
        ? `；本轮验收 ${strings(detail.auditRequirementIds).length} 条；跳过旧需求验收 ${skipped} 条` : "";
      return `增量实现范围已确定；有效历史计划 ${pickNumber(detail, "historicalPlans") ?? 0}；忽略损坏计划 ${pickNumber(detail, "ignoredPlans") ?? 0}${history}；新增或历史缺失 ${strings(detail?.addedRequirementIds).length} 条；明确修改 ${strings(detail?.changedRequirementIds).length} 条；初次实现 ${strings(detail?.implementationRequirementIds).length} 条；沿用 ${strings(detail?.inheritedRequirementIds).length} 条${skipped ? "" : "并独立验收"}${auditScope}${reason ? `；${reason}` : ""}`;
    }
    case "feature_grouping_started":
      return `开始运行时语义分组；原子需求 ${pickNumber(detail, "requirements") ?? 0}`;
    case "feature_grouping_usage": {
      const tokens = tokenUsageParts(detail);
      return tokens.length ? `功能分组 token 用量；tokens ${tokens.join(" / ")}` : null;
    }
    case "feature_grouping_finished": {
      const grouping = asRecord(detail?.grouping);
      return `${detail?.source === "llm" ? "语义分组已通过校验" : "语义分组未采用，使用确定性分组"}；功能组 ${pickNumber(grouping, "packets") ?? 0}${reason ? `；原因：${reason}` : ""}`;
    }
    case "feature_grouping_retry":
      return `语义分组失败后重试；第 ${detail?.attempt} 次；原因：${reason ?? "未知"}${detail?.cutOffByModel ? "；扩大输出额度至 128k" : ""}`;
    case "dependency_gate_blocked":
      return `基础依赖尚无已完成的可运行实现，跳过下游实现（${packetId}）；当前需求 ${strings(detail?.requirementIds).join("、")}；未完成依赖 ${strings(detail?.unmetDependencyIds).join("、")}`;
    case "dependency_gate_provisional":
      return `前置需求已有可运行检查点，继续下游实现（${packetId}）；尚未通过独立验收 ${strings(detail?.dependencyIds).join("、")}`;
    case "builder_started":
      return `Builder 开始编写代码（${packetId}）`;
    case "gateway_wait":
      return `模型网关恢复等待（${packetId}）；调用方 ${pickString(detail, "source")}；剩余等待 ${renderDuration(pickNumber(detail, "delayMs") ?? 0)}；原调用重试 ${pickNumber(detail, "retry") ?? 0}${reason ? `；底层原因：${reason}` : ""}`;
    case "builder_work_preserved":
      return `中断任务的代码${detail?.preserved ? "已保存为可运行检查点" : "未通过保留检查，已恢复上一检查点"}（${packetId}）；当前需求仍待完成${reason ? `；${reason}` : ""}`;
    case "implementation_split":
      return `${detail?.kind === "dependency" ? "混合依赖包拆出依赖已就绪的成员" : "未完成需求包拆分后继续实现"}（${packetId}）；原子需求 ${strings(detail?.requirementIds).join("、")}；${reason ?? ""}`;
    case "implementation_retry":
      return `实现${detail?.reason && detail.reason !== "timeout" ? "终态不完整" : "超时"}后以新会话续做原需求包（${packetId}）；仅重试一次，上限 ${renderDuration(pickNumber(detail, "timeoutMs") ?? 0)}`;
    case "implementation_continued":
      return `实现检查失败，同会话续做一次（${packetId}）；剩余额度 ${renderDuration(pickNumber(detail, "timeoutMs") ?? 0)}；${pickString(detail, "reason")}`;
    case "implementation_paused":
      return `模型网关故障，暂停实现（${packetId}）并等待恢复后重试同一需求包；短暂中断不会跳过剩余需求`;
    case "implementation_stopped":
      return `模型网关故障不可重试，停止派发实现任务（${packetId}）；需求保持待处理`;
    case "builder_finished":
      return `Builder ${builderOutcomeText(pickString(detail, "outcome"))}（${packetId}）${pickString(detail, "summary") ? `；自述回执（非验收）：${pickString(detail, "summary")}` : ""}${describeBuilderExecution(detail?.execution)}`;
    case "probe_planning":
      return `开始规划黑盒探针（${packetId}）`;
    case "application_starting":
      return `开始启动候选应用（${packetId}）`;
    case "candidate_prepared":
      return `候选构建${detail?.reused ? "已复用" : "已完成"}；候选 ${pickString(detail, "candidateId")}；${detail?.installed ? "已安装依赖" : "复用依赖"}；安装 ${renderDuration(pickNumber(detail, "installMs") ?? 0)}，构建 ${renderDuration(pickNumber(detail, "buildMs") ?? 0)}`;
    case "candidate_prepare_failed":
      return `候选准备失败；阶段 ${pickString(detail, "stage")}${message ? `：${message}` : ""}`;
    case "application_ready":
      return `候选应用已就绪（${packetId}）：${pickString(detail, "baseUrl") ?? ""}`;
    case "application_stopped":
      return `候选应用已停止（${packetId}）`;
    case "probe_started":
      return `开始执行 ${pickNumber(detail, "cases") ?? 0} 个黑盒探针（${packetId}）；基础设施重试 ${pickNumber(detail, "retryCount") ?? 0}`;
    case "verification_started":
      return `开始交付验证（安装→构建→启动→健康检查→浏览器冒烟）；基础设施重试 ${pickNumber(detail, "retryCount") ?? 0}`;
    case "verification_finished":
      return `交付验证${detail?.ok ? "通过" : "失败"}；阶段 ${pickString(detail, "stage")}${message ? `：${message}` : ""}`;
    case "arc_projection_failed":
      return `ARC 平台投影写入失败，内部判定保持不变${message ? `：${message}` : ""}`;
    case "evidence_write_failed":
      return `失败证据保存失败（${packetId}），继续依据现有判词决策`;
    case "builder_reference_images": {
      const mode = pickString(detail, "mode");
      const skipped = Array.isArray(detail?.skipped) ? detail.skipped.length : 0;
      const description = mode === "text_fallback" ? "图片输入不受支持，已回退纯文本"
        : mode === "unsupported" ? "模型不支持图片输入，预探测已跳过附带"
        : mode === "disabled" ? "参考图片已按运行开关关闭"
        : mode === "attached" ? `发送 ${pickNumber(detail, "attachedCount") ?? 0} 张参考图片`
        : "参考图片不可用，按文字继续";
      return `${description}（${packetId}）；跳过 ${skipped} 项`;
    }
    case "probe_planned": {
      const cases = pickNumber(detail, "cases");
      return cases === null
        ? `探针用例已生成（${packetId}）`
        : `已生成 ${cases} 个探针用例（${packetId}）`;
    }
    case "probe_planner_usage": {
      const label = ({ plan: "探针规划", refine: "探针定位精化", review: "探针语义复核" } as Record<string, string>)[
        pickString(detail, "operation") ?? ""
      ] ?? "探针调用";
      const tokens = tokenUsageParts(detail);
      return tokens.length ? `${label} token 用量（${packetId}）；tokens ${tokens.join(" / ")}` : null;
    }
    case "application_start_failed":
      return `应用启动失败（${packetId}）${message ? `：${message}` : ""}`;
    case "probe_finished":
      return `探针${verdictText(pickString(detail, "verdict"))}${
        detail?.refined === true ? "（精化后重跑）" : ""
      }（${packetId}）${typeof detail?.passed === "number" ? `；通过 ${detail.passed} / 失败 ${detail.failed}；失败分类 ${strings(detail.categories).join("、") || "无"}` : ""}${pickString(detail, "evidenceId") ? `；私有证据 ${pickString(detail, "evidenceId")}` : ""}`;
    case "probe_refined":
      return `定位器已精化，重跑探针（${packetId}）${detail?.refinementAttempt ? `；定位恢复第 ${detail.refinementAttempt}/2 轮` : ""}`;
    case "probe_navigation_attempted":
      return `首页搜索导航复查${detail?.recovered ? "通过，待新实例确认" : detail?.improved ? "部分路径通过，继续检查" : "未通过"}（${packetId}）`;
    case "probe_refinement_failed":
      return `定位器精化失败（${packetId}）${detail?.refinementAttempt ? `；定位恢复第 ${detail.refinementAttempt}/2 轮` : ""}${plannerFailureText(detail)}`;
    case "probe_review_started":
      return `开始语义复核探针依据（${packetId}）；失败 ${pickNumber(detail, "failed") ?? 0} / ${pickNumber(detail, "cases") ?? 0} 个用例`;
    case "probe_reviewed": {
      const verdict = pickString(detail, "verdict");
      if (verdict === "corrected") {
        const corrections = Array.isArray(detail?.corrections) ? detail.corrections.length : 0;
        return `语义复核发现探针与需求冲突，按需求重建 ${corrections} 个用例并重跑（${packetId}）`;
      }
      return `语义复核确认探针依据成立（${packetId}）`;
    }
    case "probe_review_failed":
      return `语义复核失败（${packetId}）${plannerFailureText(detail)}`;
    case "probe_planner_retry":
      return `探针规划失败，将重试（${packetId}）${plannerFailureText(detail)}`;
    case "probe_planner_failed":
      return `探针规划失败（${packetId}）${plannerFailureText(detail)}`;
    case "probe_preplan_failed":
      return `后台探针预规划失败（${packetId}）${plannerFailureText(detail)}`;
    case "execution_fault":
      return `执行基础设施故障（${packetId}，${pickString(detail, "source")} / ${pickString(detail, "code")}），${
        detail?.retry === true ? "保持候选和计划，重试一次" : "停止当前执行"
      }；Builder 尝试 ${pickNumber(detail, "attempt") ?? 0}`;
    case "packet_accepted":
      return `需求包验收通过（${packetId}）${event.acceptedSha ? `；接受 SHA ${event.acceptedSha}` : ""}`;
    case "delivery_started":
      return "进入交付窗口，开始最终验收";
    case "delivery_repair_started":
      return `最终验收未通过（${pickString(detail, "stage")}），启动交付修复${
        pickNumber(detail, "round") ? `第 ${pickNumber(detail, "round")} 轮` : ""
      }${message ? `：${message}` : ""}`;
    case "delivery_repair_accepted":
      return "交付修复验收通过";
    case "delivery_repair_restored":
      return `交付修复未被接受，已恢复最后接受状态${pickNumber(detail, "round") ? `（第 ${pickNumber(detail, "round")} 轮）` : ""}`;
    case "pipeline_failed":
      return `流水线异常退出，已回滚${message ? `：${message}` : ""}`;
    case "delivery_finished": {
      const stage = pickString(detail, "stage");
      const stageSuffix = stage ? `（${stage}）` : "";
      return detail?.ok === true
        ? `交付运行检查通过${stageSuffix}`
        : `交付失败${stageSuffix}${message ? `：${message}` : ""}`;
    }
    case "module_boundary_audit_finished": {
      const results = typeof detail?.results === "object" && detail.results !== null
        ? detail.results as Record<string, string> : {};
      const counts = { verified: 0, failed: 0, inconclusive: 0 };
      for (const status of Object.values(results)) {
        if (status === "verified" || status === "failed" || status === "inconclusive") counts[status]++;
      }
      const checks = strings(detail?.regressionPacketIds).length;
      return `模块边界验收完成（${pickString(detail, "moduleId") ?? ""}）；通过 ${counts.verified}，失败 ${counts.failed}，无法判断 ${counts.inconclusive}${checks ? `；跨模块种子入口抽查 ${checks} 条` : ""}`;
    }
    case "pipeline_finished": {
      const breakdown = asRecord(detail?.inconclusiveByKind);
      const categories = breakdown ? Object.entries(breakdown).map(([kind, ids]) => `${inconclusiveKindText(kind)} ${strings(ids).length}`).join("、") : "";
      const auditScope = Array.isArray(detail?.auditRequirementIds)
        ? `；本轮验收范围 ${strings(detail.auditRequirementIds).length} 条；跳过旧需求验收 ${strings(detail.skippedRequirementIds).length} 条` : "";
      return `流水线结束${detail ? `；结果 ${pickString(detail, "status")}；已实现 ${strings(detail.implementedRequirementIds).length}，已验证 ${strings(detail.verifiedRequirementIds).length}，业务失败 ${strings(detail.failedRequirementIds).length}，无法判断 ${strings(detail.inconclusiveRequirementIds).length}，阻塞 ${strings(detail.blockedRequirementIds).length}，待处理 ${strings(detail.pendingRequirementIds).length}；阻塞 ID：${strings(detail.blockedRequirementIds).join("、") || "无"}；待处理 ID：${strings(detail.pendingRequirementIds).join("、") || "无"}${categories ? `；无法判断分类：${categories}` : ""}${strings(detail.missingPlanRequirementIds).length ? `；缺计划 ID：${strings(detail.missingPlanRequirementIds).join("、")}` : ""}${auditScope}；接受 SHA ${pickString(detail, "acceptedSha")}` : ""}`;
    }
    default:
      return null;
  }
}

/** Bounded token/duration diagnostics attached to a Builder call; never message content. */
function describeBuilderExecution(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const execution = value as Record<string, unknown>;
  const timing = asRecord(execution.timing);
  const parts: string[] = [];
  const modelMs = asNumber(timing?.modelMsTotal);
  const toolMs = asNumber(timing?.toolMsTotal);
  if (modelMs !== null || toolMs !== null) {
    const segments = [
      modelMs === null ? null : `模型 ${renderDuration(modelMs)}`,
      toolMs === null ? null : `工具 ${renderDuration(toolMs)}`,
    ].filter((segment): segment is string => segment !== null);
    parts.push(`耗时分布 ${segments.join(" / ")}`);
  }
  const turns = asNumber(timing?.turns);
  if (turns !== null) parts.push(`轮次 ${turns}`);
  const toolCalls = asNumber(execution.toolCalls);
  const slowest = (Array.isArray(timing?.longestTools) ? timing.longestTools : [])
    .map(item => asRecord(item))
    .map(item => ({ name: item && typeof item.name === "string" ? sanitizeDiagnosticText(item.name) : null,
      durationMs: asNumber(item?.durationMs) }))
    .filter((item): item is { name: string; durationMs: number } => item.name !== null && item.durationMs !== null)
    .map(item => `${item.name} ${renderDuration(item.durationMs)}`);
  if (toolCalls !== null || slowest.length) {
    parts.push(`工具调用 ${toolCalls ?? "未知"}${slowest.length ? `（最慢 ${slowest.join("、")}）` : ""}`);
  }
  const usage = asRecord(execution.usage);
  if (usage?.status === "available") {
    const tokens = tokenUsageParts(usage);
    if (tokens.length) parts.push(`tokens ${tokens.join(" / ")}`);
  }
  // Size and call counts only; assistant text and tool payloads stay out of the log.
  const outputBytes = asNumber(timing?.outputBytes);
  if (outputBytes !== null && outputBytes > 0) parts.push(`输出 ${renderBytes(outputBytes)}`);
  const byTool = (Array.isArray(timing?.toolCounts) ? timing.toolCounts : [])
    .map(item => asRecord(item))
    .map(item => ({ name: item && typeof item.name === "string" ? sanitizeDiagnosticText(item.name) : null,
      count: asNumber(item?.count) }))
    .filter((item): item is { name: string; count: number } => item.name !== null && item.count !== null)
    .map(item => `${item.name} ${item.count}`);
  if (byTool.length) parts.push(`各工具 ${byTool.join("、")}`);
  const compactions = asNumber(execution.compactions);
  if (compactions !== null) parts.push(`压缩 ${compactions}`);
  const termination = asRecord(execution.termination);
  if (termination?.compactionReason) parts.push(`压缩原因 ${termination.compactionReason}`);
  if (typeof termination?.progressedAfterOverflowCompaction === "boolean" &&
    termination.compactionReason === "overflow") {
    parts.push(`压缩后推进 ${termination.progressedAfterOverflowCompaction}`);
  }
  if (termination?.recoveryError) parts.push(`恢复失败 ${sanitizeDiagnosticText(String(termination.recoveryError))}`);
  if (termination?.compactionPending || termination?.retryPending) {
    parts.push(`终态 ${termination.lastMessageRole ?? "未知"}；压缩等待 ${Boolean(termination.compactionPending)}；重试等待 ${Boolean(termination.retryPending)}`);
  }
  return parts.length ? `；${parts.join("；")}` : "";
}

function tokenPart(label: string, value: unknown): string | null {
  const number = asNumber(value);
  return number === null ? null : `${label} ${number}`;
}

/**
 * Renders 入/出/缓存读/缓存写/总计. The total is the sum of all four, so a
 * non-zero cache write has to appear or the printed parts stop adding up.
 * Shared by the Builder summary and the Probe Planner usage line.
 */
function tokenUsageParts(usage: unknown): string[] {
  const record = asRecord(usage);
  if (!record) return [];
  const cacheRead = asNumber(record.cacheRead);
  const cacheWrite = asNumber(record.cacheWrite);
  return [
    tokenPart("入", record.input), tokenPart("出", record.output),
    cacheRead !== null && cacheRead > 0 ? `缓存读 ${cacheRead}` : null,
    cacheWrite !== null && cacheWrite > 0 ? `缓存写 ${cacheWrite}` : null,
    tokenPart("总计", record.total),
  ].filter((token): token is string => token !== null);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function builderOutcomeText(outcome: string | null): string {
  if (outcome === "completed") return "完成";
  if (outcome === "timed_out") return "超时";
  if (outcome === "failed") return "失败";
  return outcome ? `结束于 ${outcome}` : "结束";
}

function verdictText(verdict: string | null): string {
  if (verdict === "pass") return "通过";
  if (verdict === "fail") return "失败";
  if (verdict === "inconclusive") return "无法定论";
  return `结果 ${verdict ?? "未知"}`;
}

function pickString(detail: Record<string, unknown> | undefined, key: string): string | null {
  const value = detail?.[key];
  return typeof value === "string" && value.length > 0 ? sanitizeDiagnosticText(value) : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => sanitizeDiagnosticText(item)) : [];
}

function pickNumber(detail: Record<string, unknown> | undefined, key: string): number | null {
  const value = detail?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function renderClock(atMs: number): string {
  if (!Number.isFinite(atMs)) return "--:--:--";
  const moment = new Date(atMs);
  const hh = String(moment.getHours()).padStart(2, "0");
  const mm = String(moment.getMinutes()).padStart(2, "0");
  const ss = String(moment.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function renderDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${seconds}s`;
}

function renderBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MiB`;
}

function inconclusiveKindText(kind: string): string {
  return ({ planning: "计划生成", coverage: "场景覆盖", preparation: "准备失败", locator: "定位歧义或缺口",
    execution: "执行故障", review: "语义复核", gateway: "模型网关", budget: "预算耗尽", unreproduced: "失败未复现" } as Record<string, string>)[kind] ?? kind;
}
