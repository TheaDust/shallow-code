import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { createDraftStore, createRequirementsTool, runConversation, type ChatAgent } from "../src/cli.js";

function tree() {
  return { id: "tasks", name: "任务管理", type: "ROOT", description: "管理自己的任务。",
    data: [{ category: "tasks", items: ["Alice 拥有“准备会议”任务。"] }],
    visual_reference: ["设计.png"], children: [{ id: "create-task", name: "创建任务", type: "ATOMIC",
      description: "标题必填。", scenarios: [{ id: "create-success", name: "创建任务成功", steps: [
        { keyword: "GIVEN", content: "Alice 的列表为空。" },
        { keyword: "WHEN", content: "Alice 创建“准备会议”任务。" },
        { keyword: "THEN", content: "列表显示该任务。" },
      ] }] }] };
}

async function directory(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), "requirements-draft-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  return base;
}

test("没有草稿时不创建文件；首次模型响应前的输入可恢复", async (t) => {
  const base = await directory(t);
  const store = createDraftStore(base);
  assert.equal(fs.existsSync(store.file!), false);
  store.recordInput("我要一个任务管理页面。\n刷新后仍保留任务。");
  const restored = createDraftStore(base);
  assert.equal(restored.revision, 0);
  assert.equal(restored.tree, null);
  assert.deepEqual(restored.pendingInputs, ["我要一个任务管理页面。\n刷新后仍保留任务。"]);
});

test("技术意图先于需求树提交时仍能恢复草稿", async (t) => {
  const base = await directory(t);
  const store = createDraftStore(base);
  store.setProjectIntent("前端使用 Vue。\n");
  const restored = createDraftStore(base);
  assert.equal(restored.tree, null);
  assert.equal(restored.projectIntent, "前端使用 Vue。");
  assert.equal(restored.revision, 1);
});

test("工具成功返回前保存草稿；恢复不完整场景、问题、数据、引用与版本", async (t) => {
  const base = await directory(t);
  const store = createDraftStore(base);
  const value = tree();
  value.children[0].scenarios = [];
  const tool = createRequirementsTool(store);
  await tool.execute("update", { requirements: value, questions: ["谁可以创建任务？"] });
  const restored = createDraftStore(base);
  assert.equal(restored.revision, 1);
  assert.deepEqual(restored.tree, store.tree);
  assert.deepEqual(restored.questions, ["谁可以创建任务？"]);
  value.description = "只有 Alice 可以管理自己的任务。";
  assert.deepEqual(restored.submit(value, []), { ok: true, revision: 2 });
  assert.equal(createDraftStore(base).revision, 2);
  assert.equal(createDraftStore(base).tree?.description, value.description);
});

test("非法提交不覆盖已保存的草稿", async (t) => {
  const store = createDraftStore(await directory(t));
  store.submit(tree(), ["是否支持删除？"]);
  const previous = await readFile(store.file!, "utf8");
  assert.equal(store.submit({ id: "invalid" }, []).ok, false);
  assert.equal(store.revision, 1);
  assert.equal(await readFile(store.file!, "utf8"), previous);
});

test("替换文件失败时不授予新版本，也不截断旧草稿", async (t) => {
  const store = createDraftStore(await directory(t));
  store.submit(tree(), []);
  const previous = await readFile(store.file!, "utf8");
  const previousTree = store.tree;
  const rename = t.mock.method(fs, "renameSync", () => { throw new Error("injected-rename-failure"); });
  syncBuiltinESMExports();
  t.after(() => { rename.mock.restore(); syncBuiltinESMExports(); });
  const value = tree();
  value.description = "新的描述。";
  await assert.rejects(createRequirementsTool(store).execute("update", { requirements: value, questions: [] }), /草稿保存失败/);
  assert.equal(store.revision, 1);
  assert.equal(store.tree, previousTree);
  assert.equal(await readFile(store.file!, "utf8"), previous);
  assert.deepEqual(await readdir(join(store.file!, "..")), ["draft.json"]);
});

test("损坏的 JSON 或草稿内容报错并保留原文件", async (t) => {
  const base = await directory(t);
  const store = createDraftStore(base);
  store.submit(tree(), []);
  for (const content of ["{broken", JSON.stringify({ revision: 2, tree: { id: "bad" }, questions: [], pendingInputs: [] }),
    JSON.stringify({ revision: -1, tree: null, questions: [], pendingInputs: [] })]) {
    await writeFile(store.file!, content);
    assert.throws(() => createDraftStore(base), /无法恢复需求草稿.*原文件已保留/);
    assert.equal(await readFile(store.file!, "utf8"), content);
  }
});

test("草稿按启动目录隔离", async (t) => {
  const first = createDraftStore(await directory(t));
  const second = createDraftStore(await directory(t));
  first.submit(tree(), []);
  assert.equal(second.tree, null);
  assert.equal(fs.existsSync(second.file!), false);
});

test("失败回合的输入与已经提交的草稿在重启后继续提供给模型", async (t) => {
  const base = await directory(t);
  const store = createDraftStore(base);
  const value = tree();
  const failing: ChatAgent = {
    async send() { store.submit(value, ["谁可以创建任务？"]); return { ok: false, error: "cancelled" }; },
    abort() {}, dispose() {},
  };
  const firstInput = async function* () { yield "整理任务管理需求"; };
  await runConversation({ store, agent: failing, baseDir: base, input: firstInput(), out() {} });
  const restored = createDraftStore(base);
  const output: string[] = [];
  const sends: string[] = [];
  const input = async function* () { yield "只有 Alice 可以创建任务"; };
  await runConversation({ store: restored, baseDir: base, input: input(), out: text => output.push(text),
    agent: { async send(text) { sends.push(text); return { ok: true }; }, abort() {}, dispose() {} } });
  assert.match(output.join(""), /已恢复需求草稿/);
  assert.match(output.join(""), /谁可以创建任务？/);
  assert.match(output.join(""), /整理任务管理需求/);
  assert.match(sends[0], /第 1 版/);
  assert.match(sends[0], /【此前未完成的输入】\n1. 整理任务管理需求/);
  assert.match(sends[0], /【用户输入】\n只有 Alice 可以创建任务/);
  assert.deepEqual(createDraftStore(base).pendingInputs, []);
});

test("审阅中退出保留草稿；重启仍须重新审阅确认，成功生成后清理草稿", async (t) => {
  const base = await directory(t);
  const store = createDraftStore(base);
  const value = tree();
  value.visual_reference = [];
  store.submit(value, []);
  const agent: ChatAgent = { async send() { return { ok: true }; }, abort() {}, dispose() {} };
  const reviewInput = async function* () { yield "生成需求文档"; };
  assert.equal((await runConversation({ store, agent, baseDir: base, input: reviewInput(), out() {} })).status, "ended");
  assert.ok(fs.existsSync(store.file!));
  const premature = async function* () { yield "是"; };
  await runConversation({ store: createDraftStore(base), agent, baseDir: base, input: premature(), out() {} });
  assert.equal(fs.existsSync(join(base, "requirements")), false);
  const confirm = async function* () { yield "生成需求文档"; yield "是"; };
  const result = await runConversation({ store: createDraftStore(base), agent, baseDir: base, input: confirm(), out() {} });
  assert.equal(result.status, "generated");
  assert.equal(fs.existsSync(store.file!), false);
  assert.equal(createDraftStore(base).tree, null);
});

test("生成失败时保留草稿和原始参考路径，允许重启后重试", async (t) => {
  const base = await directory(t);
  const source = join(base, "设计.png");
  await writeFile(source, "image");
  const store = createDraftStore(base);
  store.submit(tree(), []);
  const input = async function* () { yield "生成需求文档"; await rm(source); yield "是"; };
  const result = await runConversation({ store, baseDir: base, input: input(), out() {},
    agent: { async send() { return { ok: true }; }, abort() {}, dispose() {} } });
  assert.equal(result.status, "ended");
  assert.deepEqual(createDraftStore(base).tree?.visual_reference, ["设计.png"]);
  assert.equal(fs.existsSync(join(base, "requirements")), false);
});
