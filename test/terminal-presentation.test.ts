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
import type { RunEvent } from "../src/types.js";
import { MemoryTerminal } from "./helpers/terminal.js";
import { withTempDir } from "./helpers/temp-dir.js";

const options = { requirementIds: ["A", "B", "C"], models: { builder: "gateway/builder-model", judge: "gateway/judge-model" }, onInterrupt() {} };
const formatter = new HumanRunFormatter();
function receive(view: BuildView, type: RunEvent["type"], detail: Record<string, unknown> = {}, packetId = "packet-a"): void {
  const event = { at: "2026-10-13T00:00:00Z", type, packetId, detail } as RunEvent;
  view.receive(event, formatter.format(JSON.stringify(event)) ?? type);
}

test("Run view counts independent evidence, keeps runnable checkpoints and reflects a later regression", () => {
  const view = new BuildView(options, () => 24, terminalTheme(false));
  receive(view, "builder_finished", { outcome: "completed" });
  receive(view, "checkpoint_saved", { requirementIds: ["A"], reason: "runnable" });
  receive(view, "packet_accepted");
  receive(view, "compatibility_checked", { status: "passed", requirementIds: ["A"] });
  assert.match(view.render(80).join("\n"), /已验证 0\/3/);
  assert.match(view.render(80).join("\n"), /可运行检查点覆盖 1 条需求/);
  receive(view, "audit_result", { requirementIds: ["A"], status: "verified" });
  assert.match(view.render(80).join("\n"), /已验证 1\/3/);
  receive(view, "audit_result", { requirementIds: ["A"], status: "inconclusive" });
  assert.match(view.render(80).join("\n"), /已验证 0\/3.*证据不足 1/);
  receive(view, "audit_result", { requirementIds: ["A"], status: "failed" });
  assert.match(view.render(80).join("\n"), /已验证 0\/3.*失败 1/);
});

test("Evolution skips stay outside the current numerator and denominator", () => {
  const view = new BuildView(options, () => 24, terminalTheme(false));
  receive(view, "evolution_scope_selected", { auditRequirementIds: ["B", "C"], skippedRequirementIds: ["A"] });
  receive(view, "audit_result", { requirementIds: ["A", "B"], status: "verified" });
  const text = view.render(80).join("\n");
  assert.match(text, /已验证 1\/2/);
  assert.match(text, /沿用跳过 1/);
});

test("Run view names the models it runs with in full and compact layouts", () => {
  const full = new BuildView(options, () => 24, terminalTheme(false)).render(80).join("\n");
  assert.match(full, /模型\s+Builder gateway\/builder-model/);
  assert.match(full, /Judge gateway\/judge-model/);
  const compact = new BuildView(options, () => 8, terminalTheme(false)).render(80).join("\n");
  assert.match(compact, /模型\s+Builder gateway\/builder-model/);
  assert.match(compact, /Judge gateway\/judge-model/);
});

test("Run view preserves foreground activity during background planning and fits smaller terminals", () => {
  for (const [columns, rows] of [[80, 24], [40, 18], [24, 8], [120, 30]]) {
    const view = new BuildView(options, () => rows, terminalTheme(false));
    receive(view, "packet_selected", { names: ["一段很长的中文模块名称与详细说明".repeat(5)] });
    receive(view, "builder_started", { attempt: 1 });
    receive(view, "probe_planning", {}, "packet-background");
    const lines = view.render(columns);
    assert.ok(lines.length <= rows, `${columns}×${rows}: ${lines.length} rows`);
    assert.ok(lines.every(line => visibleWidth(line) <= columns), `${columns} columns exceeded`);
    assert.match(lines.join("\n"), /Builder/);
    assert.doesNotMatch(lines.join("\n"), /\x1b\[/);
  }
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
    assert.match(output, /Shallow Code.*Build Agent/);
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

test("Interactive presentation keeps complete, colour-free logs on disk", async () => {
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
  });
});

test("Result card offers applicable commands, quotes paths and separates skips from verification", () => {
  const summary = { status: "partial" as const, verifiedRequirementIds: ["A"], blockedRequirementIds: [], acceptedSha: "sha",
    inconclusiveRequirementIds: ["B"], skippedRequirementIds: ["C"] };
  const partial = buildResult(summary, "E:\\runs\\user's run", "changes.patch", "demo", 65_000, false);
  assert.match(partial, /总耗时\s+01:05/);
  assert.match(partial, /已验证 1.*证据不足 1/);
  assert.match(partial, /沿用跳过 1/);
  assert.match(partial, /shallow build resume.*user''s run/);
  assert.doesNotMatch(partial, /shallow build apply/);
  const delivered = buildResult({ ...summary, status: "delivered" }, "run", "changes.patch", "demo", 3_600_000, false);
  assert.match(delivered, /总耗时\s+60:00/);
  assert.match(delivered, /shallow build apply/);
  assert.doesNotMatch(delivered, /\x1b\[/);
  const usage = new ModelUsageTotals();
  usage.add("builder", { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.01 });
  const withUsage = buildResult({ ...summary, modelUsage: usage.summary() },
    "run", "changes.patch", "demo", 5_000, false);
  assert.match(withUsage, /总计\s+tokens 1\.2k（入 1\.0k \/ 出 200） · 费用 \$0\.01/);
  assert.match(withUsage, /Builder\s+tokens 1\.2k/);
  assert.match(withUsage, /Judge\s+tokens 0/);
});

test("Run view accumulates model tokens and cost and shows in-flight progress until the call settles", () => {
  const view = new BuildView(options, () => 24, terminalTheme(false));
  receive(view, "feature_grouping_usage", { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120, cost: 0.0001 });
  receive(view, "probe_planner_usage", { operation: "plan", input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120, cost: 0.0001 });
  assert.match(view.render(80).join("\n"), /总计\s+tokens 240（入 200 \/ 出 40） · 费用 \$0\.0002/);
  assert.match(view.render(80).join("\n"), /Judge\s+tokens 240/);
  view.liveUsage({ usage: { status: "available", input: 800, output: 200, cacheRead: 0, cacheWrite: 0, total: 1000, cost: 0.0012 } });
  assert.match(view.render(80).join("\n"), /Builder\s+tokens 1\.0k（入 800 \/ 出 200） · 费用 \$0\.0012/);
  assert.match(view.render(80).join("\n"), /总计\s+tokens 1\.2k（入 1\.0k \/ 出 240） · 费用 \$0\.0014/);
  receive(view, "builder_usage", { input: 800, output: 200, cacheRead: 0, cacheWrite: 0, total: 1000, cost: 0.0012 });
  receive(view, "builder_finished", { outcome: "completed",
    execution: { usage: { status: "available", input: 800, output: 200, cacheRead: 0, cacheWrite: 0, total: 1000, cost: 0.0012 } } });
  const text = view.render(80).join("\n");
  assert.match(text, /总计\s+tokens 1\.2k（入 1\.0k \/ 出 240） · 费用 \$0\.0014/);
  assert.match(text, /Builder\s+tokens 1\.0k/);
  assert.match(text, /Judge\s+tokens 240/);
});

test("Run view keeps grouped cache counts and partial cost visible in an 80-column terminal", () => {
  const view = new BuildView(options, () => 24, terminalTheme(false));
  receive(view, "builder_usage", { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000,
    cacheWrite: 1_000_000, total: 4_000_000, cost: 2 });
  receive(view, "probe_planner_usage", { operation: "plan", input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, total: 1200 });
  const lines = view.render(80);
  const text = lines.join("\n");
  assert.ok(lines.length <= 24);
  assert.ok(lines.every(line => visibleWidth(line) <= 80));
  assert.match(text, /总计/);
  assert.match(text, /Builder/);
  assert.match(text, /Judge/);
  assert.match(text, /缓存读 1\.00M/);
  assert.match(text, /缓存写 1\.00M/);
  assert.match(text, /部分未计价/);
  assert.match(text, /费用未知/);
});

test("Progress entries drop internal packet ids", () => {
  const view = new BuildView(options, () => 24, terminalTheme(false));
  receive(view, "builder_started", {}, "packet-a");
  receive(view, "audit_result", { requirementIds: ["A"], status: "verified" }, "packet-a");
  receive(view, "execution_fault", { source: "runner", code: "browser_launch", retry: true }, "packet-b");
  const text = view.render(80).join("\n");
  assert.match(text, /Builder 开始编写代码/);
  assert.match(text, /独立验收通过/);
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

test("Semantic colours use bright ANSI variants", () => {
  const theme = terminalTheme(true);
  assert.match(theme.accent("x"), /^\x1b\[96m/);
  assert.match(theme.success("x"), /^\x1b\[92m/);
  assert.match(theme.warning("x"), /^\x1b\[93m/);
  assert.match(theme.error("x"), /^\x1b\[91m/);
});
