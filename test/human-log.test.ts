import assert from "node:assert/strict";
import { test } from "node:test";

test("Public entry samples report their evidence boundary", () => {
  const formatter = new HumanRunFormatter();
  const line = formatLine(formatter, eventLine("2026-10-07T00:00:00Z", "public_entry_checked", {
    detail: { requirementIds: ["A"], status: "passed" },
  }));
  assert.match(line, /公共入口检查通过/);
  assert.match(line, /完整场景验收另计/);
});

test("Compatibility samples cannot be mistaken for requirement verification", () => {
  const line = formatLine(new HumanRunFormatter(), eventLine("2026-10-08T00:00:00Z", "compatibility_checked", {
    packetId: "anonymous", detail: { requirementIds: ["A"], contract: "derived_web_contracts", status: "failed" },
  }));
  assert.match(line, /兼容性检查缺口已复现/);
  assert.match(line, /不单独授予需求通过/);
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

test("Module boundary logs distinguish sampled seed entries from full atomic verification", () => {
  const line = formatLine(new HumanRunFormatter(), eventLine("2026-10-01T00:00:00Z", "module_boundary_audit_finished", {
    detail: { moduleId: "SECOND", packetIds: ["packet-c"], regressionPacketIds: ["packet-a"], results: { "packet-c": "verified" } },
  }));
  assert.match(line, /通过 1，失败 0，无法判断 0；跨模块种子入口抽查 1 条/);
});

test("Audit and guard logs expose coverage and uncertainty without declaring a regression", () => {
  const formatter = new HumanRunFormatter();
  const audit = formatLine(formatter, eventLine("2026-10-02T00:00:00Z", "audit_result", {
    packetId: "p", detail: { status: "inconclusive", failureKind: "coverage", navigationRecovered: true, uncoveredOutcomes: 2 },
  }));
  assert.match(audit, /无法判断.*场景覆盖.*导航恢复.*未覆盖场景结果 2/);
  const guard = formatLine(formatter, eventLine("2026-10-02T00:00:01Z", "repair_guard_checked", {
    packetId: "p", detail: { status: "unresolved", critical: false, retried: true, failureKind: "execution" },
  }));
  assert.match(guard, /无法判定.*新应用实例重试.*执行故障/);
  assert.doesNotMatch(guard, /确认回归/);
  assert.match(formatLine(formatter, eventLine("2026-10-02T00:00:02Z", "repair_guard_checked", {
    packetId: "menu", detail: { status: "passed", critical: true },
  })), /通过.*必须确认的既有路径/);
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
    packetId: "a", detail: { source: "planner", retry: 1, delayMs: 30_000,
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
    detail: { requirements: 2, totalBudgetMs: 0, port: 43210,
      starterScaffold: { status: "installed", reason: "empty output", files: ["frontend/package.json"] } },
  }));
  assert.match(line, /通用脚手架 installed/);
});

test("HumanRunFormatter identifies progressive stage starting points", () => {
  const formatter = new HumanRunFormatter();
  const line = formatLine(formatter, eventLine("2026-10-02T00:00:00Z", "pipeline_started", {
    detail: { requirements: 14, totalBudgetMs: 0, port: 43210,
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

test("HumanRunFormatter shows planner validation reasons while keeping response previews in the ledger", () => {
  const formatter = new HumanRunFormatter();
  for (const type of ["probe_planner_retry", "probe_planner_failed", "probe_preplan_failed", "probe_refinement_failed"]) {
    const line = formatLine(formatter, eventLine("2026-09-06T06:00:00.000Z", type, {
      packetId: "profile", detail: {
        message: "Probe planner content violates ProbePlan", category: "schema",
        validationError: "ProbePlan.cases[0] requires at least one assertion",
        contentPreview: "PRIVATE-PLAN-PREVIEW",
      },
    }));
    assert.match(line, /schema/);
    assert.match(line, /requires at least one assertion/);
    assert.doesNotMatch(line, /PRIVATE-PLAN-PREVIEW/);
  }
});

test("HumanRunFormatter identifies both locator recovery rounds", () => {
  const formatter = new HumanRunFormatter();
  for (const [type, refinementAttempt] of [["probe_refinement_failed", 1], ["probe_refined", 2]] as const) {
    assert.match(formatLine(formatter, eventLine("2026-09-13T00:00:00Z", type, {
      packetId: "p", detail: { refinementAttempt, validationError: "unchanged failed locator" },
    })), new RegExp(`定位恢复第 ${refinementAttempt}/2 轮`));
  }
  assert.match(formatLine(formatter, eventLine("2026-09-13T00:00:00Z", "probe_navigation_attempted", {
    packetId: "p", detail: { recovered: true },
  })), /首页搜索导航复查通过，待新实例确认/);
  assert.match(formatLine(formatter, eventLine("2026-09-13T00:00:00Z", "probe_navigation_attempted", {
    packetId: "p", detail: { recovered: false, improved: true },
  })), /部分路径通过，继续检查/);
});

test("HumanRunFormatter renders a happy path in Chinese with elapsed time", () => {
  const formatter = new HumanRunFormatter();
  const lines = [
    eventLine("2026-09-05T06:00:00.000Z", "pipeline_started"),
    eventLine("2026-09-05T06:00:02.000Z", "packet_selected", { packetId: "auth-login" }),
    eventLine("2026-09-05T06:00:03.000Z", "builder_started", { packetId: "auth-login" }),
    eventLine(
      "2026-09-05T06:02:13.000Z",
      "builder_finished",
      { packetId: "auth-login", detail: { outcome: "completed", sessionId: "s1" } },
    ),
    eventLine(
      "2026-09-05T06:02:15.000Z",
      "probe_planned",
      { packetId: "auth-login", detail: { cases: 3 } },
    ),
    eventLine(
      "2026-09-05T06:02:30.000Z",
      "probe_finished",
      { packetId: "auth-login", detail: { verdict: "pass" } },
    ),
    eventLine("2026-09-05T06:02:31.000Z", "packet_accepted", { packetId: "auth-login" }),
    eventLine("2026-09-05T06:03:00.000Z", "pipeline_finished"),
  ];

  assert.match(formatLine(formatter, lines[0]), /^\[\d{2}:\d{2}:\d{2} \+0s\] 流水线启动$/);
  assert.match(formatLine(formatter, lines[1]), /^\[\d{2}:\d{2}:\d{2} \+2s\] 选定需求包 auth-login$/);
  assert.match(
    formatLine(formatter, lines[2]),
    /^\[\d{2}:\d{2}:\d{2} \+3s\] Builder 开始编写代码（auth-login）$/,
  );
  assert.match(
    formatLine(formatter, lines[3]),
    /^\[\d{2}:\d{2}:\d{2} \+2m13s\] Builder 完成（auth-login）$/,
  );
  assert.match(
    formatLine(formatter, lines[4]),
    /^\[\d{2}:\d{2}:\d{2} \+2m15s\] 已生成 3 个探针用例（auth-login）$/,
  );
  assert.match(
    formatLine(formatter, lines[5]),
    /^\[\d{2}:\d{2}:\d{2} \+2m30s\] 探针通过（auth-login）$/,
  );
  assert.match(
    formatLine(formatter, lines[6]),
    /^\[\d{2}:\d{2}:\d{2} \+2m31s\] 需求包验收通过（auth-login）$/,
  );
  assert.match(formatLine(formatter, lines[7]), /^\[\d{2}:\d{2}:\d{2} \+3m0s\] 流水线结束$/);
});

test("HumanRunFormatter renders feature grouping stats at pipeline start", () => {
  const formatter = new HumanRunFormatter();
  const line = formatLine(formatter, eventLine("2026-09-16T00:00:00.000Z", "pipeline_started", {
    detail: { requirements: 24, totalBudgetMs: 0, port: 43210, builderContextWindow: 256_000,
      grouping: { packets: 6, requirements: 24, maxPacketSize: 5, crossModulePackets: 0, cohesionRate: 0.347, thresholdLimitedPackets: 0 } },
  }));
  assert.match(line, /流水线启动；原子需求 24；预算 不限时；探针端口 43210；Builder 上下文 256000；功能组 6$/);
});

test("HumanRunFormatter surfaces failure reasons and refined reruns", () => {
  const formatter = new HumanRunFormatter();
  const lines = [
    eventLine("2026-09-05T06:00:00.000Z", "pipeline_started"),
    eventLine(
      "2026-09-05T06:01:00.000Z",
      "application_start_failed",
      { packetId: "auth-login", detail: { message: "npm start exited 1: missing script" } },
    ),
    eventLine(
      "2026-09-05T06:02:00.000Z",
      "builder_finished",
      { packetId: "auth-login", detail: { outcome: "timed_out", sessionId: "s2" } },
    ),
    eventLine(
      "2026-09-05T06:03:00.000Z",
      "probe_finished",
      { packetId: "auth-login", detail: { verdict: "inconclusive", refined: true } },
    ),
    eventLine(
      "2026-09-05T06:05:00.000Z",
      "delivery_repair_started",
      { detail: { stage: "readiness", message: "/health unreachable" } },
    ),
    eventLine(
      "2026-09-05T06:06:00.000Z",
      "delivery_finished",
      { detail: { ok: false, stage: "readiness", message: "/health unreachable" } },
    ),
  ];

  assert.match(formatLine(formatter, lines[0]), /^\[\d{2}:\d{2}:\d{2} \+0s\] 流水线启动$/);
  assert.match(
    formatLine(formatter, lines[1]),
    /^\[\d{2}:\d{2}:\d{2} \+1m0s\] 应用启动失败（auth-login）：npm start exited 1: missing script$/,
  );
  assert.match(
    formatLine(formatter, lines[2]),
    /^\[\d{2}:\d{2}:\d{2} \+2m0s\] Builder 超时（auth-login）$/,
  );
  assert.match(
    formatLine(formatter, lines[3]),
    /^\[\d{2}:\d{2}:\d{2} \+3m0s\] 探针无法定论（精化后重跑）（auth-login）$/,
  );
  assert.match(
    formatLine(formatter, lines[4]),
    /^\[\d{2}:\d{2}:\d{2} \+5m0s\] 最终验收未通过（readiness），启动交付修复：\/health unreachable$/,
  );
  assert.match(
    formatLine(formatter, lines[5]),
    /^\[\d{2}:\d{2}:\d{2} \+6m0s\] 交付失败（readiness）：\/health unreachable$/,
  );
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

test("HumanRunFormatter covers remaining planner, refinement, and delivery events", () => {
  const formatter = new HumanRunFormatter();
  const base = "2026-09-05T06:00:00.000Z";
  assert.match(
    formatLine(
      formatter,
      eventLine(base, "probe_planner_retry", {
        packetId: "p",
        detail: { message: "gateway 500" },
      }),
    ),
    /^\[\d{2}:\d{2}:\d{2} \+0s\] 探针规划失败，将重试（p）：gateway 500$/,
  );
  assert.match(
    formatLine(formatter, eventLine(base, "probe_planner_failed", { packetId: "p" })),
    /^\[\d{2}:\d{2}:\d{2} \+0s\] 探针规划失败（p）$/,
  );
  assert.match(
    formatLine(formatter, eventLine(base, "probe_refined", { packetId: "p" })),
    /^\[\d{2}:\d{2}:\d{2} \+0s\] 定位器已精化，重跑探针（p）$/,
  );
  assert.match(
    formatLine(
      formatter,
      eventLine(base, "probe_refinement_failed", {
        packetId: "p",
        detail: { message: "schema drift" },
      }),
    ),
    /^\[\d{2}:\d{2}:\d{2} \+0s\] 定位器精化失败（p）：schema drift$/,
  );
  assert.match(
    formatLine(formatter, eventLine(base, "delivery_started")),
    /^\[\d{2}:\d{2}:\d{2} \+0s\] 进入交付窗口，开始最终验收$/,
  );
  assert.match(
    formatLine(formatter, eventLine(base, "delivery_repair_accepted")),
    /^\[\d{2}:\d{2}:\d{2} \+0s\] 交付修复验收通过$/,
  );
  assert.match(
    formatLine(
      formatter,
      eventLine(base, "delivery_finished", { detail: { ok: true, stage: "browser" } }),
    ),
    /^\[\d{2}:\d{2}:\d{2} \+0s\] 交付运行检查通过（browser）$/,
  );
  assert.match(
    formatLine(
      formatter,
      eventLine(base, "builder_finished", { packetId: "p", detail: { sessionId: "s" } }),
    ),
    /^\[\d{2}:\d{2}:\d{2} \+0s\] Builder 结束（p）$/,
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

test("Human logs distinguish runnable checkpoints, unknown audits, and retained repairs", () => {
  const formatter = new HumanRunFormatter();
  const checkpoint = formatLine(formatter, eventLine("2026-09-13T00:00:00Z", "checkpoint_saved", {
    acceptedSha: "runnable-sha", detail: { requirementIds: ["A"], reason: "module-a" },
  }));
  assert.match(checkpoint, /可运行检查点.*功能验收状态单独记录/);
  assert.doesNotMatch(checkpoint, /验收通过/);
  assert.match(formatLine(formatter, eventLine("2026-09-13T00:00:01Z", "audit_result", {
    packetId: "packet-a", detail: { requirementIds: ["A"], status: "inconclusive", reason: "invalid plan" },
  })), /无法判断.*保留可运行检查点/);
  assert.match(formatLine(formatter, eventLine("2026-09-13T00:00:02Z", "repair_batch_finished", {
    detail: { round: 1, retained: false, reason: "regression" },
  })), /已恢复原检查点.*regression/);
});

test("Human logs explain semantic review outcomes", () => {
  const formatter = new HumanRunFormatter();
  const base = "2026-09-22T00:00:00.000Z";
  assert.match(formatLine(formatter, eventLine(base, "probe_review_started", {
    packetId: "p", detail: { cases: 4, failed: 2 },
  })), /^\[\d{2}:\d{2}:\d{2} \+0s\] 开始语义复核探针依据（p）；失败 2 \/ 4 个用例$/);
  assert.match(formatLine(formatter, eventLine(base, "probe_reviewed", {
    packetId: "p", detail: { verdict: "sound", rationale: "依据成立" },
  })), /语义复核确认探针依据成立（p）$/);
  assert.match(formatLine(formatter, eventLine(base, "probe_reviewed", {
    packetId: "p", detail: { verdict: "corrected", corrections: [{ caseId: "c" }] },
  })), /语义复核发现探针与需求冲突，按需求重建 1 个用例并重跑（p）$/);
  assert.match(formatLine(formatter, eventLine(base, "probe_review_failed", {
    packetId: "p", detail: { message: "schema drift" },
  })), /语义复核失败（p）：schema drift$/);
});

test("Human logs report Probe Planner token usage per operation", () => {
  const formatter = new HumanRunFormatter();
  const base = "2026-09-27T00:00:00.000Z";
  assert.match(formatLine(formatter, eventLine(base, "probe_planner_usage", {
    packetId: "p", detail: { operation: "plan", input: 700, output: 50, cacheRead: 200, cacheWrite: 100, total: 1050 },
  })), /^\[\d{2}:\d{2}:\d{2} \+0s\] 探针规划 token 用量（p）；tokens 入 700 \/ 出 50 \/ 缓存读 200 \/ 缓存写 100 \/ 总计 1050$/);
  assert.match(formatLine(formatter, eventLine(base, "probe_planner_usage", {
    packetId: "p", detail: { operation: "refine", input: 10, output: 2, cacheRead: 0, cacheWrite: 0, total: 12 },
  })), /探针定位精化 token 用量（p）；tokens 入 10 \/ 出 2 \/ 总计 12$/);
  assert.match(formatLine(formatter, eventLine(base, "probe_planner_usage", {
    packetId: "p", detail: { operation: "review", input: 10, output: 2, cacheRead: 0, cacheWrite: 0, total: 12 },
  })), /探针语义复核 token 用量（p）/);
});
