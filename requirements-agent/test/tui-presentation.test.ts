import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { visibleWidth } from "@earendil-works/pi-tui";
import { MemoryTerminal } from "../../test/helpers/terminal.js";
import { RequirementsTui, formatRequirementPreview } from "../src/tui.js";
import { createDraftStore, runConversation, type ConversationView } from "../src/cli.js";
import { diffRequirements, normalizeDraft, type RequirementNode } from "../src/dsl.js";

function tree(): RequirementNode {
  const result = normalizeDraft({ id: "app", name: "任务管理", type: "ROOT", description: "仅管理自己的任务。",
    guidance: ["整体采用深色主题，界面保持简洁。"],
    data: [{ category: "tasks", items: ["现有任务归属于 Alice。"] }], children: [{ id: "create", name: "创建任务", type: "ATOMIC",
      description: "标题必填。", guidance: ["提交按钮保持醒目。"], visual_reference: ["references/task.png"],
      scenarios: [{ id: "create-success", name: "创建后持久化",
        steps: [{ keyword: "GIVEN", content: "Alice 的列表为空。" }, { keyword: "WHEN", content: "创建“准备会议”任务。" },
          { keyword: "THEN", content: "任务出现在列表。" }, { keyword: "AND", content: "刷新后仍然可见。" },
          { keyword: "BUT", content: "Bob 无法查看该任务。" }] }] }] });
  assert.ok(result.ok);
  return result.tree;
}

test("Readable preview retains descriptions, guidance, seed identity, references and every scenario clause", () => {
  const value = tree();
  const preview = formatRequirementPreview(value);
  assert.match(preview, /Alice/);
  assert.match(preview, /references\/task.png/);
  assert.match(preview, /create-success/);
  assert.match(preview, /实现指引（不单独验收）：/);
  assert.match(preview, /整体采用深色主题，界面保持简洁。/);
  assert.match(preview, /提交按钮保持醒目。/);
  for (const step of value.children[0].scenarios[0].steps) assert.ok(preview.includes(step.content));
  assert.match(preview, /BUT.*Bob/);
});

test("Req status and preview keys reflect the draft and leave editing available", (t) => {
  const terminal = new MemoryTerminal();
  const ui = new RequirementsTui({ onAbort() {}, onExit() {} }, terminal);
  t.after(() => ui.stop());
  ui.start();
  ui.present({ type: "intro" });
  const value = tree();
  ui.present({ type: "draft", revision: 2, tree: value, questions: ["谁可以创建任务？"], changes: diffRequirements(null, value) });
  const lines = ui.tui.render(80);
  assert.match(lines.join("\n"), /草案 r2 · 1 个功能 · 1 个场景/);
  assert.match(lines.join("\n"), /待确认 1 个问题/);
  assert.ok(lines.every(line => visibleWidth(line) <= 80));
  terminal.input("\x1bOQ");
  assert.equal(ui.tui.hasOverlay(), true);
  terminal.input("v");
  terminal.input("\r");
  assert.equal(ui.tui.hasOverlay(), false);
  ui.present({ type: "review", revision: 2, tree: value, references: [] });
  assert.match(ui.tui.render(80).join("\n"), /等待确认 · 回复“是”生成/);
  ui.present({ type: "edit" });
  assert.doesNotMatch(ui.tui.render(80).join("\n").slice(-200), /等待确认/);
});

test("Req TUI clears the console page and reports the wheel only while the preview is open", (t) => {
  const terminal = new MemoryTerminal();
  const ui = new RequirementsTui({ onAbort() {}, onExit() {} }, terminal);
  t.after(() => ui.stop());
  ui.start();
  assert.equal(terminal.writes[0], "\x1b[2J\x1b[H\x1b[3J", "进入 req 应先清空控制台页面");
  const value = tree();
  ui.present({ type: "draft", revision: 1, tree: value, questions: [], changes: diffRequirements(null, value) });
  const on = () => terminal.writes.filter(write => write === "\x1b[?1000h\x1b[?1006h").length;
  const off = () => terminal.writes.filter(write => write === "\x1b[?1000l\x1b[?1006l").length;
  terminal.input("\x1bOQ");
  assert.equal(ui.tui.hasOverlay(), true);
  assert.equal(on(), 1, "打开草案预览后上报滚轮");
  terminal.input("\x1b");
  assert.equal(ui.tui.hasOverlay(), false);
  assert.equal(off(), 1, "关闭预览后交还终端原生鼠标");
});

test("Req status area tracks live model usage from the session", (t) => {
  const terminal = new MemoryTerminal();
  const ui = new RequirementsTui({ onAbort() {}, onExit() {} }, terminal);
  t.after(() => ui.stop());
  ui.start();
  assert.doesNotMatch(ui.tui.render(80).join("\n"), /模型用量/);
  let listener: Parameters<RequirementsTui["watchSession"]>[0] extends { subscribe(listener: infer L): unknown } ? L : never;
  ui.watchSession({
    subscribe(fn) { listener = fn; return () => {}; },
    getSessionStats: () => ({ tokens: { total: 1234 }, cost: 0.0032 }),
  });
  listener!({ type: "turn_end" } as never);
  const text = ui.tui.render(80).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(text, /模型用量 tokens 1\.2k · 费用 \$0\.0032/);
});

test("Draft card reports revision changes without repeating pending questions", (t) => {
  const terminal = new MemoryTerminal();
  const ui = new RequirementsTui({ onAbort() {}, onExit() {} }, terminal);
  t.after(() => ui.stop());
  ui.start();
  const value = tree();
  const questions = ["刷新后是否保留任务？", "是否需要筛选？", "导出范围？", "是否需要删除？"];
  ui.present({ type: "draft", revision: 3, tree: value, questions, changes: diffRequirements(null, value) });
  const text = ui.tui.render(80).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(text, /草案更新 · r3/);
  assert.doesNotMatch(text, /待确认问题/);
  for (const question of questions) assert.ok(!text.includes(question), `卡片不应重复问题：${question}`);
  assert.match(text, /待确认 4 个问题/);
});

test("Tool activity occupies the status area without adding a chat entry", (t) => {
  const terminal = new MemoryTerminal();
  const ui = new RequirementsTui({ onAbort() {}, onExit() {} }, terminal);
  t.after(() => ui.stop());
  ui.start();
  let listener: Parameters<RequirementsTui["watchSession"]>[0] extends { subscribe(listener: infer L): unknown } ? L : never;
  ui.watchSession({ subscribe(fn) { listener = fn; return () => {}; } });
  terminal.input("描述应用");
  terminal.input("\r");
  const before = ui.tui.render(80).length;
  listener!({ type: "tool_execution_start", toolCallId: "call", toolName: "read", args: { path: "需求.md" } });
  const during = ui.tui.render(80);
  assert.match(during.join("\n"), /正在读取文件：需求.md/);
  assert.equal(during.length, before);
});

test("Interactive review exports its prepared tree only after explicit confirmation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "requirements-view-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createDraftStore();
  const value = tree();
  value.children[0].visual_reference = [];
  assert.equal(store.submit(value, []).ok, true);
  const views: ConversationView[] = [];
  const inputs = async function* () { yield "生成需求文档"; yield "是"; };
  const result = await runConversation({ store, baseDir: directory, input: inputs(), out() {}, onView: view => { views.push(view); },
    agent: { async send() { return { ok: true }; }, abort() {}, dispose() {} } });
  assert.equal(result.status, "generated");
  if (result.status !== "generated") return;
  const review = views.find(view => view.type === "review");
  assert.ok(review?.type === "review");
  const written = normalizeDraft(parse(await readFile(result.file, "utf8")));
  assert.ok(written.ok);
  assert.deepEqual(written.tree, review.tree);
});

test("An interrupted turn displays an already committed draft without entering generation review", async () => {
  const store = createDraftStore();
  const value = tree();
  const views: ConversationView[] = [];
  const inputs = async function* () { yield "生成需求文档"; };
  const result = await runConversation({ store, baseDir: process.cwd(), input: inputs(), out() {}, onView: view => { views.push(view); },
    agent: { async send() { store.submit(value, []); return { ok: false, error: "cancelled" }; }, abort() {}, dispose() {} } });
  assert.equal(result.status, "ended");
  const draft = views.find(view => view.type === "draft");
  assert.ok(draft?.type === "draft");
  assert.deepEqual(draft.tree, store.tree);
  assert.equal(draft.revision, store.revision);
  assert.ok(!views.some(view => view.type === "review"));
});
