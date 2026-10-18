import assert from "node:assert/strict";
import { test } from "node:test";

test("Resume logs distinguish restored implementation from new behavior evidence", () => {
  const line = formatLine(new HumanRunFormatter(), eventLine("2026-10-10T00:00:00Z", "run_resumed", { detail: { requirementIds: ["A", "B"] } }));
  assert.match(line, /恢复可运行实现/);
  assert.match(line, /重新独立验收：A、B/);
});

import { HumanRunFormatter } from "../src/human-log.js";

function eventLine(at: string, type: string, rest: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ at, type, ...rest })}\n`;
}

function formatLine(formatter: HumanRunFormatter, raw: string): string {
  const formatted = formatter.format(raw);
  assert.ok(formatted !== null, `expected a formatted line for ${raw.trim()}`);
  return formatted;
}

test("Evolution scope logs separate inherited IDs from current independent verification", () => {
  const line = formatLine(new HumanRunFormatter(), eventLine("2026-10-06T00:00:00Z", "evolution_scope_selected", {
    detail: { historicalPlans: 2, ignoredPlans: 1, addedRequirementIds: ["NEW"], changedRequirementIds: ["CHANGED"],
      historicalPlanRequirementCount: 3, historicalCheckpointRequirementCount: 4,
      historicalCheckpointSupplementCount: 2, historicalRequirementCount: 5,
      inheritedRequirementIds: ["OLD"], implementationRequirementIds: ["CHANGED", "NEW"] },
  }));
  assert.match(line, /有效历史计划 2.*忽略损坏计划 1.*初次实现 2.*沿用 1 条并独立验收/);
  assert.match(line, /历史计划需求 ID 3；历史检查点需求 ID 4；检查点补充 ID 2；合并历史 ID 5/);
  assert.doesNotMatch(line, /已通过/);
});

test("Evolution competition logs expose skipped requirements without saying they were verified", () => {
  const scope = formatLine(new HumanRunFormatter(), eventLine("2026-10-06T00:00:00Z", "evolution_scope_selected", {
    detail: { historicalPlans: 2, ignoredPlans: 0, addedRequirementIds: ["NEW"], changedRequirementIds: [],
      inheritedRequirementIds: ["OLD"], implementationRequirementIds: ["NEW"], auditRequirementIds: ["NEW"], skippedRequirementIds: ["OLD"] },
  }));
  assert.match(scope, /本轮验收 1 条；跳过旧需求验收 1 条/);
  assert.doesNotMatch(scope, /沿用 1 条并独立验收/);
  const summary = formatLine(new HumanRunFormatter(), eventLine("2026-10-06T00:00:00Z", "pipeline_finished", {
    detail: { status: "delivered", implementedRequirementIds: ["NEW"], verifiedRequirementIds: ["NEW"],
      auditRequirementIds: ["NEW"], skippedRequirementIds: ["OLD"], acceptedSha: "sha" },
  }));
  assert.match(summary, /已实现 1，已验证 1/);
  assert.match(summary, /本轮验收范围 1 条；跳过旧需求验收 1 条/);
});

test("Runtime grouping logs show its validated source, fallback reason and actual usage", () => {
  const formatter = new HumanRunFormatter();
  const at = "2026-09-29T00:00:00Z";
  assert.match(formatLine(formatter, eventLine(at, "feature_grouping_retry", {
    detail: { attempt: 2, reason: "model output cutoff", cutOffByModel: true },
  })), /分组失败后重试.*第 2 次.*model output cutoff.*扩大输出额度/);
  assert.match(formatLine(formatter, eventLine(at, "implementation_split", {
    packetId: "feature-a", detail: { requirementIds: ["A", "B"], reason: "deadline" },
  })), /拆分后继续实现.*A、B.*deadline/);
  assert.match(formatLine(formatter, eventLine(at, "feature_grouping_started", {
    detail: { requirements: 47 },
  })), /运行时语义分组.*47/);
  assert.match(formatLine(formatter, eventLine(at, "feature_grouping_usage", {
    detail: { input: 60, output: 20, cacheRead: 40, cacheWrite: 0, total: 120 },
  })), /功能分组 token 用量；tokens 入 60 \/ 出 20 \/ 缓存读 40 \/ 总计 120/);
  assert.match(formatLine(formatter, eventLine(at, "feature_grouping_finished", {
    detail: { source: "llm", grouping: { packets: 17 }, durationMs: 1000 },
  })), /语义分组已通过校验.*17.*1s/);
  assert.match(formatLine(formatter, eventLine(at, "feature_grouping_finished", {
    detail: { source: "deterministic", grouping: { packets: 16 }, reason: "Unknown ID", durationMs: 1000 },
  })), /使用确定性分组.*16.*Unknown ID/);
});

test("Repair logs distinguish case improvement from a fully verified requirement", () => {
  const line = formatLine(new HumanRunFormatter(), eventLine("2026-09-29T00:00:00Z", "repair_batch_finished", {
    detail: { round: 1, retained: true, improvedCases: 1, resolvedGaps: 2, reason: "verified improvement with regression coverage" },
  }));
  assert.match(line, /新增通过用例 1，已解决准备\/控件缺口 2/);
});

test("Gateway recovery logs distinguish saved code from completed requirements", () => {
  const formatter = new HumanRunFormatter();
  const at = "2026-09-20T00:00:00Z";
  assert.match(formatLine(formatter, eventLine(at, "gateway_wait", {
    packetId: "a", detail: { source: "builder", retry: 2, delayMs: 60_000, failure: { kind: "rate_limit", retryable: true, status: 429 } },
  })), /网关恢复等待.*a.*builder.*1m.*重试 2/);
  assert.match(formatLine(formatter, eventLine(at, "gateway_wait", {
    packetId: "a", detail: { source: "planning", retry: 1, delayMs: 30_000,
      failure: { kind: "unavailable", retryable: true }, reason: "TypeError: fetch failed → Error: other side closed [UND_ERR_SOCKET]" },
  })), /底层原因：TypeError: fetch failed → Error: other side closed \[UND_ERR_SOCKET\]/);
  assert.match(formatLine(formatter, eventLine(at, "builder_work_preserved", {
    packetId: "a", detail: { preserved: true, requirementIds: ["A"] },
  })), /保存为可运行检查点.*仍待完成/);
  assert.match(formatLine(formatter, eventLine(at, "implementation_paused", {
    packetId: "a", detail: { requirementIds: ["A"], failure: { kind: "rate_limit", retryable: true, status: 429 } },
  })), /暂停实现.*等待恢复后重试同一需求包/);
  assert.match(formatLine(formatter, eventLine(at, "implementation_stopped", {
    packetId: "a", detail: { requirementIds: ["A"], failure: { kind: "request", retryable: false, status: 400 } },
  })), /不可重试.*停止派发实现任务.*需求保持待处理/);
  assert.match(formatLine(formatter, eventLine(at, "repair_paused", {
    packetId: "a", detail: { requirementIds: ["A"], failure: { kind: "rate_limit", retryable: true, status: 429 } },
  })), /暂停本轮修复并等待恢复后重试.*需求 A/);
});

test("HumanRunFormatter explains dependency gate savings", () => {
  const formatter = new HumanRunFormatter();
  const line = formatLine(formatter, eventLine("2026-09-26T00:00:00Z", "dependency_gate_blocked", {
    packetId: "downstream", detail: { requirementIds: ["C"], unmetDependencyIds: ["A", "B"],
      dependencyStatuses: { A: "failed", B: "inconclusive" } },
  }));
  assert.match(line, /跳过下游实现.*C.*A、B/);
  assert.match(line, /基础依赖尚无已完成的可运行实现/);
  assert.match(formatLine(formatter, eventLine("2026-09-26T00:00:00Z", "dependency_gate_provisional", {
    packetId: "downstream", detail: { requirementIds: ["C"], dependencyIds: ["A"] },
  })), /前置需求已有可运行检查点.*继续下游实现.*尚未通过独立验收 A/);
});

test("HumanRunFormatter records whether the generic starter scaffold was installed", () => {
  const formatter = new HumanRunFormatter();
  const line = formatLine(formatter, eventLine("2026-09-27T00:00:00Z", "pipeline_started", {
    detail: { requirements: 2, totalBudgetMs: 0, adapterId: "web",
      starterScaffold: { status: "installed", reason: "empty output", files: ["frontend/package.json"] } },
  }));
  assert.match(line, /通用脚手架 installed/);
});

test("HumanRunFormatter shows the judge model when it differs from the builder model", () => {
  const formatter = new HumanRunFormatter();
  const line = formatLine(formatter, eventLine("2026-10-11T00:00:00Z", "pipeline_started", {
    detail: { model: "provider/builder", checkerModel: "provider/judge" },
  }));
  assert.match(line, /；模型 provider\/builder/);
  assert.match(line, /；Checker 模型 provider\/judge/);

  const same = formatLine(formatter, eventLine("2026-10-11T00:00:00Z", "pipeline_started", {
    detail: { model: "provider/model", checkerModel: "provider/model" },
  }));
  assert.match(same, /；模型 provider\/model/);
  assert.doesNotMatch(same, /Checker 模型/);
});

test("HumanRunFormatter identifies progressive stage starting points", () => {
  const formatter = new HumanRunFormatter();
  const line = formatLine(formatter, eventLine("2026-10-02T00:00:00Z", "pipeline_started", {
    detail: { requirements: 14, totalBudgetMs: 0, adapterId: "web",
      progressiveStage: { index: 2, currentStageTestsOnly: true,
        startingPoint: "inherited_application", externalDependencyIds: ["REQ-1-1-2"] } },
  }));
  assert.match(line, /分阶段任务 Stage 2（继承前序应用）/);
});

test("HumanRunFormatter identifies Evolution starting points and optional stages", () => {
  for (const [startingPoint, expected] of [
    ["inherited_application", "（继承已有应用）"],
    ["blank_template", "（空白模板）"],
    ["unknown", ""],
  ]) {
    for (const stageIndex of [undefined, 2]) {
      const line = formatLine(new HumanRunFormatter(), eventLine("2026-10-06T00:00:00Z", "pipeline_started", {
        detail: { evolution: { startingPoint, externalDependencyIds: ["REQ-1"],
          ...(stageIndex === undefined ? {} : { stageIndex }) } },
      }));
      assert.ok(line.endsWith(`增量开发 Evolution${stageIndex === undefined ? "" : " Stage 2"}${expected}`));
    }
  }
});

test("HumanRunFormatter reports candidate reuse, installation and preparation failures", () => {
  const formatter = new HumanRunFormatter();
  const built = formatLine(formatter, eventLine("2026-09-08T00:00:00Z", "candidate_prepared", {
    detail: { candidateId: "candidate-1", reused: false, installed: true, installMs: 2000, buildMs: 3000, durationMs: 5000 },
  }));
  assert.match(built, /候选构建已完成.*candidate-1.*已安装依赖.*安装 2s，构建 3s/);
  const reused = formatLine(formatter, eventLine("2026-09-08T00:00:06Z", "candidate_prepared", {
    detail: { candidateId: "candidate-1", reused: true, installed: false, installMs: 0, buildMs: 0, durationMs: 100 },
  }));
  assert.match(reused, /候选构建已复用.*复用依赖/);
  assert.match(formatLine(formatter, eventLine("2026-09-08T00:00:07Z", "candidate_prepare_failed", {
    detail: { stage: "build", message: "build failed", durationMs: 1000 },
  })), /候选准备失败.*build failed/);
});

test("HumanRunFormatter reports reference image use and text fallback", () => {
  const formatter = new HumanRunFormatter();
  for (const [mode, expected] of [
    ["attached", /发送 2 张参考图片/],
    ["text_fallback", /图片输入不受支持，已回退纯文本/],
    ["unavailable", /参考图片不可用，按文字继续/],
  ] as const) {
    const line = formatLine(formatter, eventLine("2026-09-05T06:00:00.000Z", "builder_reference_images", {
      packetId: "profile", detail: { mode, attachedCount: 2, skipped: [{ reference: "missing.png", reason: "unreadable_image" }] },
    }));
    assert.match(line, expected);
    assert.match(line, /跳过 1 项/);
  }
});

test("HumanRunFormatter distinguishes bounded infrastructure recovery from Builder repair", () => {
  const formatter = new HumanRunFormatter();
  for (const retry of [true, false]) {
    const line = formatLine(formatter, eventLine("2026-09-06T06:00:00.000Z", "execution_fault", {
      packetId: "profile", detail: { source: "browser", code: "browser_disconnected", retry, attempt: 3 },
    }));
    assert.match(line, /browser_disconnected/);
    assert.match(line, retry ? /保持候选和计划/ : /停止当前执行/);
    assert.match(line, /Builder 尝试 3/);
  }
});

test("HumanRunFormatter renders feature grouping stats at pipeline start", () => {
  const formatter = new HumanRunFormatter();
  const line = formatLine(formatter, eventLine("2026-09-16T00:00:00.000Z", "pipeline_started", {
    detail: { requirements: 24, totalBudgetMs: 0, adapterId: "web", builderContextWindow: 256_000,
      grouping: { packets: 6, requirements: 24, maxPacketSize: 5, crossModulePackets: 0, cohesionRate: 0.347, thresholdLimitedPackets: 0 } },
  }));
  assert.match(line, /流水线启动；原子需求 24；预算 不限时；应用适配器 web；Builder 上下文 256000；功能组 6$/);
});

test("HumanRunFormatter breaks Builder time into model and tool and reports tokens", () => {
  const formatter = new HumanRunFormatter();
  const detailed = formatLine(formatter, eventLine("2026-09-17T00:00:00.000Z", "builder_finished", {
    packetId: "p",
    detail: {
      outcome: "completed",
      durationMs: 1_471_000,
      execution: {
        toolCalls: 29,
        compactions: 2,
        usage: { status: "available", input: 1000, output: 200, cacheRead: 300, cacheWrite: 0, total: 1500 },
        timing: { turns: 12, modelMsTotal: 1_082_000, toolMsTotal: 389_000, outputBytes: 2048,
          longestTools: [{ name: "shell", durationMs: 130_000 }, { name: "read", durationMs: 63_000 }],
          toolCounts: [{ name: "shell", count: 20 }, { name: "read", count: 9 }] },
      },
    },
  }));
  assert.match(detailed, /耗时分布 模型 18m2s \/ 工具 6m29s/);
  assert.match(detailed, /轮次 12/);
  assert.match(detailed, /工具调用 29（最慢 shell 2m10s、read 1m3s）/);
  assert.match(detailed, /tokens 入 1000 \/ 出 200 \/ 缓存读 300 \/ 总计 1500/);
  // A cache write is part of the total, so it has to be printed or the parts stop adding up.
  assert.match(formatLine(formatter, eventLine("2026-09-17T00:00:00.000Z", "builder_finished", {
    packetId: "p",
    detail: { outcome: "completed", execution: {
      usage: { status: "available", input: 700, output: 50, cacheRead: 200, cacheWrite: 100, total: 1050 } } },
  })), /tokens 入 700 \/ 出 50 \/ 缓存读 200 \/ 缓存写 100 \/ 总计 1050/);
  assert.match(detailed, /输出 2\.0KiB/);
  assert.match(detailed, /各工具 shell 20、read 9/);
  assert.match(detailed, /压缩 2/);
  assert.match(detailed, /本阶段耗时 24m31s/);
  // The overflow signal only matters while the reason is overflow; a threshold
  // compaction must not print a context-bound verdict.
  for (const [progressed, expected] of [[true, /压缩后推进 true/], [false, /压缩后推进 false/]] as const) {
    assert.match(formatLine(formatter, eventLine("2026-09-17T00:00:00.000Z", "builder_finished", {
      packetId: "p", detail: { outcome: "timed_out", execution: { usage: { status: "unavailable" },
        termination: { compactionPending: false, retryPending: false, compactionReason: "overflow",
          progressedAfterOverflowCompaction: progressed } } },
    })), expected);
  }
  assert.doesNotMatch(formatLine(formatter, eventLine("2026-09-17T00:00:00.000Z", "builder_finished", {
    packetId: "p", detail: { outcome: "timed_out", execution: { usage: { status: "unavailable" },
      termination: { compactionPending: false, retryPending: false, compactionReason: "threshold",
        progressedAfterOverflowCompaction: false } } },
  })), /压缩后推进/);
  const partial = formatLine(formatter, eventLine("2026-09-17T00:00:01.000Z", "builder_finished", {
    packetId: "p", detail: { outcome: "failed", execution: { usage: { status: "unavailable" } } },
  }));
  assert.match(partial, /Builder 失败（p）$/);
});

test("HumanRunFormatter ignores garbage lines and unknown event types", () => {
  const formatter = new HumanRunFormatter();
  assert.equal(formatter.format("not json\n"), null);
  assert.equal(formatter.format("\n"), null);
  assert.equal(formatter.format('{"at":"2026-09-05T06:00:00.000Z"}\n'), null);
  assert.equal(
    formatter.format(
      eventLine("2026-09-05T06:00:00.000Z", "something_new", { packetId: "x" }),
    ),
    null,
  );
});

test("Human logs report rescued modules in Chinese", () => {
  const formatter = new HumanRunFormatter();
  assert.match(formatLine(formatter, eventLine("2026-09-15T00:00:00Z", "module_rescued", {
    packetId: "packet-a", detail: { requirementIds: ["A", "B"], reason: "timed_out" },
  })), /Builder 未完成回执，但写出的应用可运行，已保存为可运行版本.*A、B.*timed_out/);
});

test("Human logs explain the bounded implementation retry", () => {
  assert.match(formatLine(new HumanRunFormatter(), eventLine("2026-09-21T00:00:00Z", "implementation_retry", {
    packetId: "packet-a", detail: { requirementIds: ["A"], timeoutMs: 2_700_000 },
  })), /新会话续做原需求包.*仅重试一次.*45m/);
  assert.match(formatLine(new HumanRunFormatter(), eventLine("2026-09-21T00:00:00Z", "implementation_retry", {
    packetId: "packet-a", detail: { requirementIds: ["A"], timeoutMs: 600_000, reason: "missing_terminal_response" },
  })), /终态不完整.*仅重试一次.*10m/);
});

test("Human logs explain a same-session continuation with its actual failure", () => {
  assert.match(formatLine(new HumanRunFormatter(), eventLine("2026-09-21T00:00:00Z", "implementation_continued", {
    packetId: "packet-a", detail: { reason: "missing export", timeoutMs: 60_000 },
  })), /同会话续做一次.*missing export/);
});

test("Human logs cover Checker queue, module checks and cancellation", () => {
  const formatter = new HumanRunFormatter();
  const base = "2026-10-16T00:00:00.000Z";
  const job = { jobId: "j1", snapshotId: "snap-1", checkedSourceSha: "sha", moduleEpoch: 1, attempt: 1, mode: "discover", requirementIds: ["A"] };
  assert.match(formatLine(formatter, eventLine(base, "snapshot_sealed", { packetId: "g1",
    detail: { snapshotId: "snap-1", sourceSha: "sha", requirementIds: ["A", "B"], sequence: 2 } })),
    /源码已封存；版本 snap-1；需求 A、B$/);
  assert.match(formatLine(formatter, eventLine(base, "check_queued", { packetId: "g1", detail: job })),
    /Checker 已排队（g1）；版本 snap-1$/);
  assert.match(formatLine(formatter, eventLine(base, "check_started", { packetId: "g1", detail: job })),
    /Checker 开始检查（g1）；版本 snap-1$/);
  assert.match(formatLine(formatter, eventLine(base, "check_completed", { packetId: "g1",
    detail: { ...job, status: "completed" } })),
    /Checker 检查完成（g1）；版本 snap-1；等待当前版本汇总$/);
  assert.match(formatLine(formatter, eventLine(base, "check_completed", { packetId: "g1",
    detail: { ...job, status: "completed", archived: true, reason: "版本已收口" } })),
    /历史结果已归档；版本已收口$/);
  assert.match(formatLine(formatter, eventLine(base, "check_completed", { packetId: "g1",
    detail: { ...job, status: "interrupted", reason: "Execution interrupted" } })),
    /Checker 检查未完成.*Execution interrupted/);
  assert.match(formatLine(formatter, eventLine(base, "check_cancelled", { packetId: "g1",
    detail: { ...job, status: "cancelled" } })),
    /Checker 任务已结束（g1）；检查范围由模块收口接续$/);
  assert.match(formatLine(formatter, eventLine(base, "check_cancelled", { packetId: "g1",
    detail: { ...job, status: "cancelled", reason: "Budget exhausted" } })),
    /Checker 任务已结束（g1）；Budget exhausted$/);
  assert.match(formatLine(formatter, eventLine(base, "module_check_started",
    { detail: { moduleId: "M", moduleEpoch: 2, snapshotId: "snap-2", requirementIds: ["A"] } })),
    /开始模块集中检查；版本 snap-2；需求 A$/);
  assert.match(formatLine(formatter, eventLine(base, "module_check_finished",
    { detail: { moduleId: "M", moduleEpoch: 2, snapshotId: "snap-2", published: true, requirementResults: { A: "verified" } } })),
    /模块集中检查完成；版本 snap-2；当前结果已发布$/);
  assert.match(formatLine(formatter, eventLine(base, "module_check_finished",
    { detail: { moduleId: "M", moduleEpoch: 2, snapshotId: "snap-2", published: false, requirementResults: {} } })),
    /模块集中检查完成；版本 snap-2；结果已归档$/);
});

test("Human logs explain Checker stages, cache reuse and rejection feedback", () => {
  const formatter = new HumanRunFormatter();
  for (const [stage, label] of [
    ["prepare", "准备隔离环境"], ["exploration", "探索并编写"], ["rediscovery", "按拒绝原因修正"],
    ["replay", "独立重放"], ["semantic_review", "独立语义复核"], ["review_approved", "验收程序复核通过"],
    ["review_rejected", "验收程序复核未通过"], ["review_cached", "复用已批准复核"],
    ["confirmation", "第二个独立环境"], ["diagnostic", "保留诊断"], ["cleanup", "释放本次隔离环境"],
  ]) {
    assert.ok(formatLine(formatter, eventLine("2026-10-18T00:00:00Z", "check_progress", {
      packetId: "p", detail: { stage },
    })).includes(label!));
  }
  const cached = formatLine(formatter, eventLine("2026-10-18T00:00:00Z", "check_progress", {
    packetId: "p", detail: { stage: "review_rejected", cached: true, archived: true, reason: "Assertion ignores the required actor" },
  }));
  assert.match(cached, /跳过已被拒绝的程序.*历史任务.*原因：Assertion ignores/);
});
