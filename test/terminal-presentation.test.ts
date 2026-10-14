import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { BuildTui, BuildView, buildResult } from "../src/terminal/build-tui.js";
import { TextViewer } from "../src/terminal/text-viewer.js";
import { terminalTheme } from "../src/terminal/theme.js";
import { HumanRunFormatter } from "../src/human-log.js";
import { createRunLogSink } from "../index.js";
import type { RunEvent } from "../src/types.js";
import { MemoryTerminal } from "./helpers/terminal.js";
import { withTempDir } from "./helpers/temp-dir.js";

const options = { requirementIds: ["A", "B", "C"], onInterrupt() {} };
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
  const partial = buildResult(summary, "E:\\runs\\user's run", "changes.patch", "demo", false);
  assert.match(partial, /已验证 1.*证据不足 1/);
  assert.match(partial, /沿用跳过 1/);
  assert.match(partial, /shallow build resume.*user''s run/);
  assert.doesNotMatch(partial, /shallow build apply/);
  const delivered = buildResult({ ...summary, status: "delivered" }, "run", "changes.patch", "demo", false);
  assert.match(delivered, /shallow build apply/);
  assert.doesNotMatch(delivered, /\x1b\[/);
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
