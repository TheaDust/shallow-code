import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { BuildTui, BuildView, buildResult } from "../src/terminal/build-tui.js";
import { TextViewer } from "../src/terminal/text-viewer.js";
import { terminalTheme } from "../src/terminal/theme.js";
import { HumanRunFormatter } from "../src/human-log.js";
import { ModelUsageTotals } from "../src/model-usage.js";
import { createRunLogSink } from "../index.js";
import type { RequirementNode, RunEvent } from "../src/types.js";
import { MemoryTerminal } from "./helpers/terminal.js";
import { withTempDir } from "./helpers/temp-dir.js";

const options = { requirementIds: ["A", "B", "C"], models: { grouper: "gateway/grouper-model", builder: "gateway/builder-model", verifier: "gateway/verifier-model" }, onInterrupt() {} };
const formatter = new HumanRunFormatter();
function requirementNode(id: string, name: string, type: RequirementNode["type"], children: RequirementNode[] = [],
  scenarioIds: string[] = []): RequirementNode {
  return { id, name, type, description: "", dependencies: [], children, visual_reference: [],
    scenarios: scenarioIds.map(scenarioId => ({ id: scenarioId, name: scenarioId, steps: [] })) };
}
const requirementTree = requirementNode("root", "示例产品", "ROOT", [
  requirementNode("orders", "订单管理", "FOLDER", [
    requirementNode("A", "创建订单", "ATOMIC"),
    requirementNode("B", "取消订单", "ATOMIC"),
  ]),
  requirementNode("users", "用户管理", "FOLDER", [
    requirementNode("C", "登录", "ATOMIC"),
    requirementNode("D", "权限", "ATOMIC"),
  ]),
]);
function receive(view: BuildView, type: RunEvent["type"], detail: Record<string, unknown> = {}, packetId = "packet-a"): void {
  if (type === "module_check_finished") detail = { ...detail, published: true,
    requirementResults: detail.requirementResults ?? Object.fromEntries(((detail.requirementIds ?? []) as string[]).map(id => [id, detail.status])) };
  const event = { at: "2026-10-13T00:00:00Z", type, packetId, detail } as RunEvent;
  view.receive(event, formatter.format(JSON.stringify(event)) ?? type);
}

test("Run view counts independent evidence, keeps runnable checkpoints and reflects a later regression", () => {
  const view = new BuildView(options, () => 24, terminalTheme(false));
  receive(view, "builder_finished", { outcome: "completed" });
  receive(view, "checkpoint_saved", { requirementIds: ["A"], reason: "runnable" });
  receive(view, "checkpoint_saved");
  receive(view, "check_completed", { status: "passed", requirementIds: ["A"] });
  receive(view, "check_completed", { verdict: "pass", passed: 1, failed: 0 });
  assert.match(view.render(80).join("\n"), /已实现 1\/3/);
  assert.match(view.render(80).join("\n"), /已验证 0\/3/);
  assert.match(view.render(80).join("\n"), /可运行检查点覆盖 1 条需求/);
  receive(view, "module_check_finished", { requirementIds: ["A"], status: "verified" });
  assert.match(view.render(80).join("\n"), /已实现 1\/3/);
  assert.match(view.render(80).join("\n"), /已验证 1\/3/);
  receive(view, "module_check_finished", { requirementIds: ["A"], status: "inconclusive" });
  assert.match(view.render(80).join("\n"), /已验证 0\/3.*证据不足 1/);
  receive(view, "module_check_finished", { requirementIds: ["A"], status: "failed" });
  assert.match(view.render(80).join("\n"), /已验证 0\/3.*失败 1/);
});

test("Module audit results update requirement counts before the final audit and reflect later regressions", () => {
  const view = new BuildView(options, () => 24, terminalTheme(false));
  receive(view, "module_check_finished", { moduleId: "first", packetIds: ["opaque-audit-packet"],
    results: { "opaque-audit-packet": "verified" }, requirementResults: { A: "verified", B: "inconclusive" } });
  let text = view.render(80).join("\n");
  assert.match(text, /已实现 2\/3.*已验证 1\/3.*证据不足 1/);
  assert.match(text, /未实现 1/);

  receive(view, "module_check_finished", { moduleId: "second", packetIds: ["other-audit-packet"],
    results: { "other-audit-packet": "verified" }, requirementResults: { A: "failed", B: "verified", C: "verified" } });
  text = view.render(80).join("\n");
  assert.match(text, /已实现 3\/3.*已验证 2\/3.*失败 1/);
  assert.match(text, /未实现 0/);
});

test("Only retained repairs update live audit counts and the final summary replaces stage results", () => {
  const view = new BuildView(options, () => 24, terminalTheme(false));
  receive(view, "module_check_finished", { moduleId: "first", packetIds: ["audit-packet"],
    results: { "audit-packet": "failed" }, requirementResults: { A: "failed" } });
  receive(view, "repair_batch_finished", { round: 1, retained: false, reason: "restored", requirementResults: { A: "verified" } });
  assert.match(view.render(80).join("\n"), /已验证 0\/3.*失败 1/);
  receive(view, "repair_batch_finished", { round: 2, retained: true, reason: "confirmed",
    requirementResults: { A: "verified", B: "inconclusive", C: "verified" } });
  assert.match(view.render(80).join("\n"), /已实现 3\/3.*已验证 2\/3.*失败 0.*证据不足 1/);

  receive(view, "pipeline_finished", { status: "partial", verifiedRequirementIds: ["A"], failedRequirementIds: ["B"],
    blockedRequirementIds: [], pendingRequirementIds: ["C"] });
  const text = view.render(80).join("\n");
  assert.match(text, /已实现 3\/3.*已验证 1\/3.*失败 1.*证据不足 0/);
  assert.match(text, /未实现 0/);
});

test("Evolution skips stay outside the current numerator and denominator", () => {
  const view = new BuildView(options, () => 24, terminalTheme(false));
  receive(view, "evolution_scope_selected", { auditRequirementIds: ["B", "C"], skippedRequirementIds: ["A"] });
  receive(view, "module_check_finished", { moduleId: "first", packetIds: ["audit-packet"],
    results: { "audit-packet": "verified" }, requirementResults: { A: "verified", B: "verified", C: "inconclusive" } });
  assert.match(view.render(80).join("\n"), /已实现 2\/2.*已验证 1\/2.*证据不足 1/);
  receive(view, "module_check_finished", { requirementIds: ["A", "B"], status: "verified" });
  const text = view.render(80).join("\n");
  assert.match(text, /已实现 2\/2/);
  assert.match(text, /已验证 1\/2/);
  assert.match(text, /沿用跳过 1/);
});

test("Run view names all three models in full and compact layouts", () => {
  const full = new BuildView(options, () => 24, terminalTheme(false)).render(80).join("\n");
  assert.match(full, /Grouper gateway\/grouper-model/);
  assert.match(full, /Builder gateway\/builder-model/);
  assert.match(full, /Verifier gateway\/verifier-model/);
  const compact = new BuildView(options, () => 8, terminalTheme(false)).render(80).join("\n");
  assert.match(compact, /Grouper grouper-model/);
  assert.match(compact, /Builder builder-model/);
  assert.match(compact, /Verifier verifier-model/);
});

test("Run view preserves foreground activity during background planning and fits smaller terminals", () => {
  for (const [columns, rows] of [[80, 24], [40, 18], [24, 8], [120, 30]]) {
    const view = new BuildView(options, () => rows, terminalTheme(false));
    receive(view, "packet_selected", { names: ["一段很长的中文模块名称与详细说明".repeat(5)] });
    receive(view, "builder_started", { attempt: 1 });
    receive(view, "check_started", {}, "packet-background");
    const lines = view.render(columns);
    assert.ok(lines.length <= rows, `${columns}×${rows}: ${lines.length} rows`);
    assert.ok(lines.every(line => visibleWidth(line) <= columns), `${columns} columns exceeded`);
    assert.match(lines.join("\n"), /Builder/);
    assert.doesNotMatch(lines.join("\n"), /\x1b\[/);
  }
});

test("Verifier stages stay visible beside foreground Builder and take focus when it finishes", () => {
  const view = new BuildView(options, () => 24, terminalTheme(false));
  receive(view, "packet_selected", { names: ["当前模块"] });
  receive(view, "builder_started");
  const job = { jobId: "j1", snapshotId: "s1", mode: "replay" };
  receive(view, "check_started", job, "opaque-audit-packet");
  receive(view, "check_progress", { ...job, stage: "semantic_review" }, "opaque-audit-packet");
  let rendered = view.render(100).join("\n");
  assert.match(rendered, /Builder · 实现当前模块/);
  assert.match(rendered, /后台.*Verifier · 独立语义复核/);
  assert.match(rendered, /已验证 0\/3/);
  receive(view, "builder_finished", { outcome: "completed" });
  rendered = view.render(100).join("\n");
  assert.match(rendered, /Verifier · 独立语义复核/);
  assert.doesNotMatch(rendered, /后台|Builder · 实现当前模块/);
  receive(view, "check_progress", { ...job, stage: "review_rejected", cached: true, reason: "INTERNAL-REJECTION-DETAIL" }, "opaque-audit-packet");
  receive(view, "check_progress", { ...job, stage: "rediscovery" }, "opaque-audit-packet");
  rendered = view.render(100).join("\n");
  assert.match(rendered, /按拒绝原因修正验收程序/);
  assert.doesNotMatch(rendered, /INTERNAL-REJECTION-DETAIL|opaque-audit-packet/);
  assert.match(rendered, /已验证 0\/3/);
});

test("Concurrent Verifier jobs clear on cancellation and historical progress cannot replace current activity", () => {
  const view = new BuildView(options, () => 24, terminalTheme(false));
  receive(view, "builder_started");
  receive(view, "check_progress", { jobId: "j1", stage: "replay" }, "audit-1");
  receive(view, "check_progress", { jobId: "j2", stage: "semantic_review" }, "audit-2");
  receive(view, "check_queued", { jobId: "j3" }, "audit-3");
  assert.match(view.render(100).join("\n"), /2 项运行 · 1 项排队/);
  receive(view, "check_cancelled", { jobId: "j2" }, "audit-2");
  assert.doesNotMatch(view.render(100).filter(line => line.includes("后台")).join("\n"), /独立语义复核|2 项运行/);
  receive(view, "snapshot_sealed", { snapshotId: "s2", authoritative: true });
  receive(view, "check_progress", { jobId: "j1", stage: "semantic_review", archived: true }, "audit-1");
  assert.doesNotMatch(view.render(100).filter(line => !line.startsWith(" · ")).join("\n"), /后台|独立语义复核/);
  receive(view, "check_progress", { jobId: "current", stage: "replay" }, "audit-current");
  receive(view, "pipeline_finished", { verifiedRequirementIds: ["A"], auditRequirementIds: ["A", "B", "C"] });
  const rendered = view.render(100).join("\n");
  assert.doesNotMatch(rendered, /后台|正在重放/);
  assert.match(rendered, /本轮结束/);
});

test("Background Verifier progress preserves counts and controls in compact terminals", () => {
  for (const [columns, rows] of [[80, 24], [40, 18], [24, 8]]) {
    const view = new BuildView(options, () => rows!, terminalTheme(false));
    receive(view, "builder_started");
    receive(view, "check_progress", { jobId: "j", stage: "rediscovery" }, "background");
    const lines = view.render(columns!);
    assert(lines.length <= rows!);
    assert(lines.every(line => visibleWidth(line) <= columns!));
    assert.match(lines.join("\n"), /后台/);
    assert.match(lines.join("\n"), /已验证 0\/3/);
    assert.match(lines.join("\n"), /日志/);
  }
});

test("Delivery checks show their current activity after Verifier preparation ends", () => {
  const view = new BuildView(options, () => 24, terminalTheme(false));
  receive(view, "delivery_started", {}, "");
  receive(view, "check_completed", { jobId: "prepare" }, "delivery");
  receive(view, "delivery_check_started", { snapshotId: "candidate" }, "");
  assert.match(view.render(100).join("\n"), /检查交付运行合同/);
  receive(view, "delivery_check_finished", { snapshotId: "candidate", ok: false }, "");
  assert.match(view.render(100).join("\n"), /交付运行合同未通过，准备修复/);
  assert.match(view.render(100).join("\n"), /已验证 0\/3/);
});

test("Document viewer scrolls wrapped CJK content, preserves reading position and can follow the tail", () => {
  const terminal = new MemoryTerminal();
  terminal.rows = 12;
  const tui = new TuiMainScreen(terminal);
  const viewer = new TextViewer(tui, terminalTheme(false), "草案", Array.from({ length: 30 }, (_, i) => `第 ${i} 行`).join("\n"), () => {});
  viewer.render(40);
  viewer.handleInput("\x1b[B");
  assert.match(viewer.render(40)[2], /第 1 行/);
  viewer.setText("草案", Array.from({ length: 31 }, (_, i) => `第 ${i} 行`).join("\n"), false);
  assert.match(viewer.render(40)[2], /第 1 行/);
  viewer.scrollToEnd();
  assert.match(viewer.render(40).join("\n"), /第 30 行/);
  viewer.setText("草案", Array.from({ length: 32 }, (_, i) => `第 ${i} 行`).join("\n"), false);
  assert.match(viewer.render(40).join("\n"), /第 31 行/);
  viewer.setText("中文", "很长的中文描述".repeat(25));
  assert.ok(viewer.render(24).every(line => visibleWidth(line) <= 24));
});

test("Document viewer scrolls with the pointer wheel and ignores other mouse events", () => {
  const terminal = new MemoryTerminal();
  terminal.rows = 12;
  const tui = new TuiMainScreen(terminal);
  const viewer = new TextViewer(tui, terminalTheme(false), "草案", Array.from({ length: 30 }, (_, i) => `第 ${i} 行`).join("\n"), () => {});
  viewer.render(40);
  viewer.handleInput("\x1b[<65;10;5M");
  assert.match(viewer.render(40)[2], /第 3 行/, "滚轮向下按档滚动");
  viewer.handleInput("\x1b[<64;10;5M");
  assert.match(viewer.render(40)[2], /第 0 行/, "滚轮向上按档滚动");
  viewer.handleInput("\x1b[<69;10;5M");
  assert.match(viewer.render(40)[2], /第 3 行/, "带修饰键的滚轮同样生效");
  viewer.handleInput("\x1b[<0;10;5M");
  viewer.handleInput("\x1b[<0;10;5m");
  viewer.handleInput("\x1b[<66;10;5M");
  assert.match(viewer.render(40)[2], /第 3 行/, "点击与横向滚轮不滚动正文");
  viewer.handleInput("\x1b[<64;10;5M");
  viewer.handleInput("\x1b[<64;10;5M");
  assert.match(viewer.render(40)[2], /第 0 行/, "顶部继续上滚保持在顶部");
});

class OverlayTui extends TuiMainScreen {
  compose(lines: string[], width: number, height: number): string[] {
    return this.compositeOverlays(lines, width, height);
  }
}

test("Document viewer fills the terminal so its overlay hides the base UI hints", (t) => {
  const terminal = new MemoryTerminal();
  const tui = new OverlayTui(terminal);
  t.after(() => tui.stop());
  tui.start();
  const viewer = new TextViewer(tui, terminalTheme(false), "草案预览", "正文", () => {});
  viewer.onToggle = () => {};
  assert.equal(viewer.render(80).length, terminal.rows);
  tui.showOverlay(viewer, { width: "100%", anchor: "top-left" });
  const base = Array.from({ length: terminal.rows }, (_, row) =>
    row === terminal.rows - 1 ? "Enter 发送   F2 草案预览" : `base ${row}`);
  const visible = tui.compose(base, terminal.columns, terminal.rows).slice(-terminal.rows).join("\n");
  assert.match(visible, /Enter 返回 · v YAML/);
  assert.doesNotMatch(visible, /Enter 发送/);
});

test("Build TUI stays idle until Enter releases the start gate", async (t) => {
  const terminal = new MemoryTerminal();
  const ui = new BuildTui(options, terminal);
  t.after(() => ui.stop());
  ui.start();
  ui.tui.renderNow();
  const frame = () => (ui.tui as TuiMainScreen).captureRenderState().previousLines.join("\n");
  assert.match(frame(), /按 Enter 开始运行/);
  assert.match(frame(), /Enter 开始运行/);
  terminal.input("c");
  ui.tui.renderNow();
  assert.match(frame(), /花费明细  尚未产生用量/);
  terminal.input("c");
  ui.tui.renderNow();
  assert.doesNotMatch(frame(), /花费明细  尚未产生用量/);

  let started = false;
  const waiting = ui.waitForStart().then(() => { started = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started, false);

  terminal.input("\r");
  await waiting;
  assert.equal(started, true);
  ui.tui.renderNow();
  assert.doesNotMatch(frame(), /按 Enter 开始运行/);
});

test("Interactive details and interrupt keys leave the terminal restored", async (t) => {
  const terminal = new MemoryTerminal();
  let interrupted = 0;
  const ui = new BuildTui({ ...options, onInterrupt() { interrupted++; } }, terminal);
  t.after(() => ui.stop());
  ui.start();
  ui.record(JSON.stringify({ at: "2026-10-13T00:00:00Z", type: "phase_started", detail: { phase: "implementation" } }), "进入模块实现阶段");
  terminal.input("d");
  assert.equal(ui.tui.hasOverlay(), true);
  terminal.input("\x1b");
  assert.equal(ui.tui.hasOverlay(), false);
  terminal.input("?");
  assert.equal(ui.tui.hasOverlay(), true);
  terminal.input("\x03");
  assert.equal(interrupted, 1);
  assert.equal(terminal.stops, 1);
  ui.stop();
  assert.equal(terminal.stops, 1);
});

test("Returning from build help and logs clears their full-screen content before repainting the status", (t) => {
  const terminal = new MemoryTerminal();
  terminal.rows = 30;
  const ui = new BuildTui(options, terminal);
  t.after(() => ui.stop());
  ui.start();
  ui.tui.renderNow();
  for (const [key, title] of [["?", "运行帮助"], ["d", "详细日志"]]) {
    terminal.input(key);
    ui.tui.renderNow();
    assert.ok(terminal.writes.at(-1)?.includes(title));
    const before = terminal.writes.length;

    terminal.input("\x1b");
    ui.tui.renderNow();

    const output = terminal.writes.slice(before).join("");
    assert.ok(output.includes("\x1b[2J\x1b[H\x1b[3J"), `${title} should be cleared before returning`);
    assert.match(output, /Shallow Code.*Builder/);
    assert.doesNotMatch(output, /运行帮助|详细日志 · 最近/);
    assert.equal(ui.tui.hasOverlay(), false);
  }
});

test("Long-running build updates keep one status frame and redraw within resized terminal bounds", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  t.mock.timers.setTime(0);
  const terminal = new MemoryTerminal();
  const ui = new BuildTui(options, terminal);
  t.after(() => ui.stop());
  ui.start();
  ui.record(JSON.stringify({ at: "2026-10-13T00:00:00Z", type: "builder_started" }), "Builder 开始编写代码");
  ui.tui.renderNow();
  const before = terminal.writes.length;
  for (let seconds = 30; seconds <= 600; seconds += 30) {
    t.mock.timers.setTime(seconds * 1_000);
    ui.tui.renderNow();
  }
  const updates = terminal.writes.slice(before).join("");
  assert.match(updates, /10:00/);
  assert.doesNotMatch(updates, /Shallow Code/, "timer updates should update existing rows");

  for (const [columns, rows] of [[40, 12], [120, 30], [24, 8], [80, 24]]) {
    terminal.resize(columns, rows);
    ui.tui.renderNow();
    assert.ok(terminal.writes.at(-1)?.includes("\x1b[2J\x1b[H\x1b[3J"));
    const frame = (ui.tui as TuiMainScreen).captureRenderState().previousLines;
    assert.ok(frame.length <= rows, `${columns}×${rows}: ${frame.length} rows`);
    assert.ok(frame.every(line => visibleWidth(line) <= columns));
    assert.match(frame.join("\n"), /Shallow Code/);
  }
});

test("Interactive presentation clears the console page and reports the wheel only while a viewer is open", (t) => {
  const terminal = new MemoryTerminal();
  const ui = new BuildTui({ ...options, onInterrupt() {} }, terminal);
  t.after(() => ui.stop());
  ui.start();
  assert.equal(terminal.writes[0], "\x1b[2J\x1b[H\x1b[3J", "进入 build 应先清空控制台页面");
  const on = () => terminal.writes.filter(write => write === "\x1b[?1000h\x1b[?1006h").length;
  const off = () => terminal.writes.filter(write => write === "\x1b[?1000l\x1b[?1006l").length;
  assert.equal(on(), 0);
  terminal.input("d");
  assert.equal(on(), 1, "打开详细日志后上报滚轮");
  terminal.input("\x1b");
  assert.equal(off(), 1, "关闭日志后交还终端原生鼠标");
  terminal.input("?");
  assert.equal(on(), 2);
  terminal.input("\x1b");
  assert.equal(off(), 2);
});

test("Interactive presentation keeps human-readable logs on disk and routes live usage to the terminal", async () => {
  await withTempDir("shallow-terminal-log-", async directory => {
    const file = join(directory, "run-log.txt");
    const received: string[] = [];
    const plain: string[] = [];
    const sink = createRunLogSink(file, undefined, { write: text => { plain.push(text); } }, (raw, line) => {
      received.push(JSON.parse(raw).type, line);
    });
    sink.write(JSON.stringify({ at: "2026-10-13T00:00:00Z", type: "feature_grouping_usage", detail: { input: 42, output: 8, total: 50 } }));
    assert.equal(plain.length, 0);
    assert.equal(received[0], "feature_grouping_usage");
    const log = await readFile(file, "utf8");
    assert.match(log, /tokens.*42.*8/);
    assert.doesNotMatch(log, /\x1b\[/);

    sink.present?.(JSON.stringify({ at: "2026-10-13T00:00:01Z", type: "verifier_usage_progress",
      detail: { jobId: "j1", role: "exploration", input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120 } }));
    assert.equal(received.at(-2), "verifier_usage_progress", "live usage still reaches the interactive presenter");
    assert.equal(plain.length, 0, "live usage never reaches the console or log file");
    const after = await readFile(file, "utf8");
    assert.match(after, /tokens.*42.*8/, "persistent human log is unchanged");
    assert.doesNotMatch(after, /进行中用量/);
  });
});

test("Result card offers applicable commands, quotes paths and separates skips from verification", () => {
  const summary = { status: "partial" as const, verifiedRequirementIds: ["A"], blockedRequirementIds: [], acceptedSha: "sha",
    inconclusiveRequirementIds: ["B"], skippedRequirementIds: ["C"],
    scenarioResults: [{ requirementId: "A", scenarioId: "a-1", name: "a-1", status: "verified" as const, caseIds: [] },
      { requirementId: "A", scenarioId: "a-2", name: "a-2", status: "failed" as const, caseIds: [] },
      { requirementId: "B", scenarioId: "b-1", name: "b-1", status: "inconclusive" as const, caseIds: [] }] };
  const partial = buildResult(summary, "E:\\runs\\user's run", "changes.patch", "demo", 65_000, false);
  assert.match(partial, /总耗时\s+01:05/);
  assert.match(partial, /已验证 1.*证据不足 1/);
  assert.match(partial, /场景覆盖 1\/3 · 失败 1 · 无法判断 1/);
  assert.match(partial, /沿用跳过 1/);
  assert.match(partial, /shallow build resume.*user''s run/);
  assert.doesNotMatch(partial, /shallow build apply/);
  const delivered = buildResult({ ...summary, status: "delivered" }, "run", "changes.patch", "demo", 3_600_000, false);
  assert.match(delivered, /总耗时\s+60:00/);
  assert.match(delivered, /shallow build apply/);
  assert.doesNotMatch(delivered, /\x1b\[/);
  const usage = new ModelUsageTotals();
  usage.add("builder", { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.01 });
  usage.add("grouper", { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.0001 });
  const withUsage = buildResult({ ...summary, modelUsage: usage.summary() },
    "run", "changes.patch", "demo", 5_000, false);
  assert.match(withUsage, /总计\s+tokens 1\.3k（入 1\.1k \/ 出 220） · 费用 \$0\.0101/);
  assert.match(withUsage, /Builder\s+tokens 1\.2k/);
  assert.match(withUsage, /Verifier\s+tokens 0/);
  assert.match(withUsage, /Grouper\s+tokens 120/);
});

test("Run view accumulates model tokens and cost and shows in-flight progress until the call settles", () => {
  const view = new BuildView(options, () => 24, terminalTheme(false));
  receive(view, "feature_grouping_usage", { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120, cost: 0.0001 });
  receive(view, "feature_grouping_usage", { operation: "plan", input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120, cost: 0.0001 });
  const collapsed = view.render(80).join("\n");
  assert.match(collapsed, /总计\s+tokens 240（入 200 \/ 出 40） · 费用 \$0\.0002/);
  assert.doesNotMatch(collapsed, /Builder\s+tokens|Verifier\s+tokens|Grouper\s+tokens/);
  view.toggleUsage();
  const expanded = view.render(80).join("\n");
  assert.doesNotMatch(expanded, /Builder\s+tokens 0/, "zero groups stay out of the expanded view");
  assert.match(expanded, /Grouper\s+tokens 240/);
  view.liveUsage({ usage: { status: "available", input: 800, output: 200, cacheRead: 0, cacheWrite: 0, total: 1000, cost: 0.0012 } });
  assert.match(view.render(80).join("\n"), /Builder\s+tokens 1\.0k（入 800 \/ 出 200） · 费用 \$0\.0012/);
  assert.match(view.render(80).join("\n"), /总计\s+tokens 1\.2k（入 1\.0k \/ 出 240） · 费用 \$0\.0014/);
  receive(view, "builder_usage", { input: 800, output: 200, cacheRead: 0, cacheWrite: 0, total: 1000, cost: 0.0012 });
  receive(view, "builder_finished", { outcome: "completed",
    execution: { usage: { status: "available", input: 800, output: 200, cacheRead: 0, cacheWrite: 0, total: 1000, cost: 0.0012 } } });
  const text = view.render(80).join("\n");
  assert.match(text, /总计\s+tokens 1\.2k（入 1\.0k \/ 出 240） · 费用 \$0\.0014/);
  assert.match(text, /Builder\s+tokens 1\.0k/);
  assert.doesNotMatch(text, /Verifier\s+tokens 0/, "zero groups stay out of the expanded view");
  assert.match(text, /Grouper\s+tokens 240/);
});

test("Run view attributes verification usage to the Verifier group", () => {
  const view = new BuildView(options, () => 24, terminalTheme(false));
  receive(view, "verifier_usage", { jobId: "j1", role: "semantic_review", input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120, cost: 0.0001 });
  view.toggleUsage();
  const text = view.render(80).join("\n");
  assert.match(text, /Verifier\s+tokens 120（入 100 \/ 出 20） · 费用 \$0\.0001/);
  assert.doesNotMatch(text, /Builder\s+tokens 0/, "zero groups stay out of the expanded view");
  assert.match(text, /总计\s+tokens 120/);
});

test("In-flight Verifier usage updates immediately and is replaced by the settled result", () => {
  const view = new BuildView(options, () => 24, terminalTheme(false));
  receive(view, "verifier_usage_progress", { jobId: "j1", role: "exploration", input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120, cost: 0.0001 });
  receive(view, "verifier_usage_progress", { jobId: "j2", role: "exploration", input: 50, output: 10, cacheRead: 0, cacheWrite: 0, total: 60 });
  assert.match(view.render(80).join("\n"), /总计\s+tokens 180/);
  receive(view, "verifier_usage_progress", { jobId: "j1", role: "exploration", input: 200, output: 40, cacheRead: 0, cacheWrite: 0, total: 240, cost: 0.0002 });
  view.toggleUsage();
  assert.match(view.render(80).join("\n"), /Verifier\s+tokens 300/);
  receive(view, "verifier_usage", { jobId: "j1", role: "exploration", input: 220, output: 44, cacheRead: 0, cacheWrite: 0, total: 264, cost: 0.00022 });
  assert.match(view.render(80).join("\n"), /Verifier\s+tokens 324/);
  receive(view, "verifier_usage", { jobId: "j2", role: "exploration", input: 55, output: 11, cacheRead: 0, cacheWrite: 0, total: 66 });
  assert.match(view.render(80).join("\n"), /Verifier\s+tokens 330/);
});

test("Run view keeps grouped cache counts and partial cost visible in an 80-column terminal", () => {
  const view = new BuildView(options, () => 24, terminalTheme(false));
  receive(view, "builder_usage", { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000,
    cacheWrite: 1_000_000, total: 4_000_000, cost: 2 });
  receive(view, "feature_grouping_usage", { operation: "plan", input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, total: 1200 });
  view.toggleUsage();
  const lines = view.render(80);
  const text = lines.join("\n");
  assert.ok(lines.length <= 24);
  assert.ok(lines.every(line => visibleWidth(line) <= 80));
  assert.match(text, /总计/);
  assert.match(text, /Builder/);
  assert.match(text, /Verifier/);
  assert.match(text, /缓存读 1\.00M/);
  assert.match(text, /缓存写 1\.00M/);
  assert.match(text, /部分未计价/);
  assert.match(text, /费用未知/);
});

test("Run view renders implementation progress as a bar in full and compact layouts", () => {
  for (const [columns, rows] of [[80, 24], [40, 18], [24, 8]] as const) {
    const view = new BuildView(options, () => rows, terminalTheme(false));
    receive(view, "snapshot_sealed", { snapshotId: "s", authoritative: true, implementedRequirementIds: ["A"] });
    const lines = view.render(columns);
    const text = lines.join("\n");
    assert.match(text, /进度\s+[█░]+/);
    assert.match(text, /已实现 1\/3/);
    assert.match(text, /已验证 0\/3/);
    assert.ok(lines.length <= rows, `${columns}×${rows}: ${lines.length} rows`);
    assert.ok(lines.every(line => visibleWidth(line) <= columns), `${columns} columns exceeded`);
  }
});

test("Interactive cost key expands grouped spending", (t) => {
  const terminal = new MemoryTerminal();
  const ui = new BuildTui(options, terminal);
  t.after(() => ui.stop());
  ui.start();
  ui.record(JSON.stringify({ at: "2026-10-13T00:00:00Z", type: "builder_usage",
    detail: { input: 800, output: 200, cacheRead: 0, cacheWrite: 0, total: 1000, cost: 0.0012 } }), "Builder 用量");
  ui.tui.renderNow();
  const frame = () => (ui.tui as TuiMainScreen).captureRenderState().previousLines.join("\n");
  assert.match(frame(), /总计\s+tokens 1\.0k/);
  assert.doesNotMatch(frame(), /Builder\s+tokens/);
  terminal.input("c");
  ui.tui.renderNow();
  assert.match(frame(), /Builder\s+tokens 1\.0k/);
  terminal.input("c");
  ui.tui.renderNow();
  assert.doesNotMatch(frame(), /Builder\s+tokens/);
});

test("Completed build TUI stays open for cost, requirements and logs until Ctrl+C", async (t) => {
  const terminal = new MemoryTerminal();
  terminal.rows = 30;
  const ui = new BuildTui({ ...options, requirementsText: "id: ROOT\nname: Demo\ntype: ROOT\nchildren: []\n" }, terminal);
  t.after(() => ui.stop());
  ui.start();
  terminal.input("\r");
  ui.record(JSON.stringify({ at: "2026-10-13T00:00:00Z", type: "builder_usage",
    detail: { input: 800, output: 200, cacheRead: 0, cacheWrite: 0, total: 1000, cost: 0.0012 } }), "Builder 用量");
  ui.complete({ status: "delivered", runDirectory: "E:\\runs\\demo", projectDirectory: "E:\\project",
    elapsedMs: 65_000, patch: "E:\\runs\\demo\\changes.patch" });
  ui.tui.renderNow();
  const frame = () => (ui.tui as TuiMainScreen).captureRenderState().previousLines.join("\n");
  assert.match(frame(), /交付完成/);
  assert.match(frame(), /运行已结束/);
  assert.match(frame(), /Ctrl\+C 退出/);
  assert.doesNotMatch(frame(), /Result/);

  terminal.input("d");
  ui.tui.renderNow();
  const log = terminal.writes.join("");
  assert.match(log, /详细日志 · 最近 500 条/);
  assert.match(log, /本轮结束：交付完成 · 总耗时 01:05/);
  assert.match(log, /报告：E:\\runs\\demo\\report\.md/);
  assert.match(log, /日志：E:\\runs\\demo\\run-log\.txt/);
  assert.match(log, /shallow build apply --run-dir 'E:\\runs\\demo'/);
  terminal.input("\x1b");

  terminal.input("t");
  ui.tui.renderNow();
  terminal.input("v");
  ui.tui.renderNow();
  assert.match(terminal.writes.join(""), /需求树 · requirements\.yaml/);
  assert.match(terminal.writes.join(""), /name: Demo/);
  terminal.input("\x1b");

  terminal.input("c");
  ui.tui.renderNow();
  assert.match(frame(), /Builder\s+tokens 1\.0k/);

  let exited = false;
  const waiting = ui.waitForExit().then(() => { exited = true; });
  terminal.input("\x03");
  await waiting;
  assert.equal(exited, true);
  assert.equal(terminal.stops, 0, "入口在等待退出后负责恢复终端");
});

test("Live Verifier usage updates the cost panel without flooding the detailed log", (t) => {
  const terminal = new MemoryTerminal();
  const ui = new BuildTui(options, terminal);
  t.after(() => ui.stop());
  ui.start();
  for (let index = 1; index <= 12; index++) {
    ui.record(JSON.stringify({ at: "2026-10-13T00:00:00Z", type: "verifier_usage_progress",
      detail: { jobId: "j1", role: "exploration", input: index * 100, output: index * 20,
        cacheRead: 0, cacheWrite: 0, total: index * 120 } }), `Verifier 探索 进行中用量 ${index}`);
  }
  ui.tui.renderNow();
  const frame = (ui.tui as TuiMainScreen).captureRenderState().previousLines.join("\n");
  assert.match(frame, /总计\s+tokens 1\.4k/);
  terminal.input("d");
  ui.tui.renderNow();
  const rendered = terminal.writes.join("");
  assert.match(rendered, /详细日志/);
  assert.doesNotMatch(rendered, /进行中用量/);
});

test("Requirement tree page colours subtree states and shows per-node completion", () => {
  const view = new BuildView({ ...options, requirementIds: ["A", "B", "C", "D"], requirementTree }, () => 30, terminalTheme(false));
  receive(view, "module_check_finished", { requirementIds: ["A"], status: "verified" });
  receive(view, "module_check_finished", { requirementIds: ["B"], status: "failed" });
  receive(view, "module_check_finished", { requirementIds: ["C"], status: "inconclusive" });
  receive(view, "dependency_gate_blocked", { requirementIds: ["D"] });
  const plain = view.requirementTreeText(terminalTheme(false));
  assert.match(plain, /总体\s+已实现 3\/4.*已验证 1\/4/);
  assert.match(plain, /订单管理\s+已实现 2\/2 · 已验证 1\/2 · 失败 1/);
  assert.match(plain, /创建订单\s+\[已验证\]/);
  assert.match(plain, /用户管理\s+已实现 1\/2 · 已验证 0\/2 · 证据不足 1 · 阻塞 1/);
  assert.match(plain, /权限\s+\[阻塞\]/);
  assert.match(plain, /├─|└─/);

  const coloured = view.requirementTreeText(terminalTheme(true));
  assert.match(coloured, /\x1b\[38;5;108m[^\n]*创建订单/);
  assert.match(coloured, /\x1b\[38;5;167m[^\n]*取消订单/);
  assert.match(coloured, /\x1b\[38;5;179m[^\n]*登录/);
  assert.match(coloured, /\x1b\[38;5;139m[^\n]*用户管理/);
  assert.match(coloured, /\x1b\[38;5;139m[^\n]*权限/);
});

test("Requirement tree shows builder implementation independently from verification", () => {
  const view = new BuildView({ ...options, requirementIds: ["A", "B", "C", "D"], requirementTree }, () => 30, terminalTheme(false));
  receive(view, "snapshot_sealed", { snapshotId: "s1", authoritative: true, implementedRequirementIds: ["A", "B"] });
  let text = view.requirementTreeText(terminalTheme(false));
  assert.match(text, /总体\s+已实现 2\/4.*已验证 0\/4/);
  assert.match(text, /订单管理\s+已实现 2\/2 · 已验证 0\/2/);
  assert.match(text, /创建订单\s+\[已实现\]/);
  assert.match(text, /取消订单\s+\[已实现\]/);
  assert.match(view.render(80).join("\n"), /进度\s+[█░]+.*已实现 2\/4/);

  receive(view, "module_check_finished", { requirementIds: ["A"], status: "verified" });
  text = view.requirementTreeText(terminalTheme(false));
  assert.match(text, /订单管理\s+已实现 2\/2 · 已验证 1\/2/);
  assert.match(text, /创建订单\s+\[已验证\]/);
  assert.match(view.render(80).join("\n"), /已实现 2\/4.*已验证 1\/4/);

  // 新模块封存不会清空此前模块的验证结果；只有后续验收明确不通过时才扣减。
  receive(view, "snapshot_sealed", { snapshotId: "s2", authoritative: true, implementedRequirementIds: ["A", "B", "C"] });
  text = view.requirementTreeText(terminalTheme(false));
  assert.match(text, /总体\s+已实现 3\/4.*已验证 1\/4/);
  assert.match(text, /登录\s+\[已实现\]/);
  assert.match(view.render(80).join("\n"), /已实现 3\/4.*已验证 1\/4/);
});

test("Scenario coverage accumulates across module boundaries and decreases only with explicit results", () => {
  const scenarioTree = requirementNode("root", "示例产品", "ROOT", [
    requirementNode("A", "创建订单", "ATOMIC", [], ["a-create", "a-cancel"]),
    requirementNode("B", "取消订单", "ATOMIC", [], ["b-cancel"]),
  ]);
  const view = new BuildView({ ...options, requirementIds: ["A", "B"], requirementTree: scenarioTree }, () => 30, terminalTheme(false));
  receive(view, "module_check_finished", { requirementIds: ["A"], status: "verified",
    scenarioResults: [
      { requirementId: "A", scenarioId: "a-create", name: "创建", status: "verified", caseIds: [] },
      { requirementId: "A", scenarioId: "a-cancel", name: "取消", status: "failed", caseIds: [] },
    ],
    scenarioCoverage: { total: 3, verified: 1, failed: 1, inconclusive: 0, notRun: 1 } });
  assert.match(view.render(80).join("\n"), /已验证 1\/2.*场景覆盖 1\/3/);
  assert.match(view.requirementTreeText(terminalTheme(false)), /创建订单\s+\[已验证\]\s+场景 1\/2/);

  receive(view, "snapshot_sealed", { snapshotId: "s2", authoritative: true, implementedRequirementIds: ["A", "B"] });
  assert.match(view.render(80).join("\n"), /已验证 1\/2.*场景覆盖 1\/3/,
    "sealing a new module must not reset requirement or scenario coverage");

  receive(view, "module_check_finished", { requirementIds: ["A", "B"], status: "inconclusive",
    requirementResults: { A: "failed", B: "verified" },
    scenarioResults: [
      { requirementId: "A", scenarioId: "a-create", name: "创建", status: "verified", caseIds: [] },
      { requirementId: "A", scenarioId: "a-cancel", name: "取消", status: "failed", caseIds: [] },
      { requirementId: "B", scenarioId: "b-cancel", name: "取消", status: "verified", caseIds: [] },
    ],
    scenarioCoverage: { total: 3, verified: 2, failed: 1, inconclusive: 0, notRun: 0 } });
  assert.match(view.render(80).join("\n"), /已验证 1\/2.*场景覆盖 2\/3/,
    "explicit failures remove requirement coverage while independently verified scenarios stay counted");
  const tree = view.requirementTreeText(terminalTheme(false));
  assert.match(tree, /取消订单\s+\[已验证\]\s+场景 1\/1/);
  assert.match(tree, /创建订单\s+\[失败\]\s+场景 1\/2/);
});

test("Interactive tree key opens the requirement page and Esc closes it", (t) => {
  const terminal = new MemoryTerminal();
  terminal.rows = 30;
  const ui = new BuildTui({ ...options, requirementIds: ["A", "B", "C", "D"], requirementTree }, terminal);
  t.after(() => ui.stop());
  ui.start();
  ui.tui.renderNow();
  terminal.input("t");
  ui.tui.renderNow();
  assert.equal(ui.tui.hasOverlay(), true);
  assert.ok(terminal.writes.join("").includes("需求树 · 完成情况"));
  terminal.input("\x1b");
  assert.equal(ui.tui.hasOverlay(), false);
});

test("Progress entries drop internal packet ids", () => {
  const view = new BuildView(options, () => 24, terminalTheme(false));
  receive(view, "builder_started", {}, "packet-a");
  receive(view, "module_check_finished", { requirementIds: ["A"], status: "verified" }, "packet-a");
  receive(view, "execution_fault", { source: "runner", code: "browser_launch", retry: true }, "packet-b");
  const text = view.render(80).join("\n");
  assert.match(text, /Builder 开始编写代码/);
  assert.match(text, /模块集中检查完成/);
  assert.match(text, /执行基础设施故障（runner \/ browser_launch）/);
  assert.doesNotMatch(text, /packet-a|packet-b/);
});

test("Activity line rotates a spinner frame with wall-clock time", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  t.mock.timers.setTime(0);
  const view = new BuildView(options, () => 24, terminalTheme(false));
  receive(view, "builder_started", {}, "packet-a");
  const glyph = (text: string): string | undefined => /([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])/.exec(text)?.[1];
  const first = glyph(view.render(80).join("\n"));
  t.mock.timers.setTime(1_000);
  const second = glyph(view.render(80).join("\n"));
  assert.ok(first !== undefined && second !== undefined);
  assert.notEqual(first, second);
});

test("Semantic colours use the restrained 256-colour palette", () => {
  const theme = terminalTheme(true);
  assert.match(theme.brand("x"), /^\x1b\[1;38;5;111m/);
  assert.match(theme.accent("x"), /^\x1b\[38;5;111m/);
  assert.match(theme.builder("x"), /^\x1b\[38;5;111m/);
  assert.match(theme.verifier("x"), /^\x1b\[38;5;74m/);
  assert.match(theme.grouper("x"), /^\x1b\[38;5;141m/);
  assert.match(theme.success("x"), /^\x1b\[38;5;108m/);
  assert.match(theme.warning("x"), /^\x1b\[38;5;179m/);
  assert.match(theme.error("x"), /^\x1b\[38;5;167m/);
  assert.match(theme.blocked("x"), /^\x1b\[38;5;139m/);
  assert.match(theme.border("x"), /^\x1b\[38;5;238m/);
});

test("Role colours distinguish Builder, Verifier and Grouper activity", () => {
  const view = new BuildView(options, () => 24, terminalTheme(true));
  receive(view, "builder_started");
  assert.match(view.render(100).join("\n"), /\x1b\[38;5;111mBuilder/);
  receive(view, "feature_grouping_started");
  assert.match(view.render(100).join("\n"), /\x1b\[38;5;141mGrouper/);
  receive(view, "builder_started");
  receive(view, "check_started", { jobId: "j1" });
  assert.match(view.render(100).join("\n"), /\x1b\[38;5;74mVerifier/);
});
