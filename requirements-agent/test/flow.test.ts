import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { loadRequirementCatalog } from "../../src/catalog.js";

import {
  assembleInputLines,
  createDraftStore,
  createRequirementsTool,
  isAffirmative,
  requestsGeneration,
  runConversation,
  type ChatAgent,
  type ChatTurnResult,
  type DraftStore,
} from "../src/cli.js";
import { normalizeDraft } from "../src/dsl.js";

function validTree(): Record<string, unknown> {
  return {
    id: "task-app",
    name: "任务管理",
    type: "ROOT",
    description: "用户管理自己的任务。",
    children: [
      {
        id: "create-task",
        name: "创建任务",
        type: "ATOMIC",
        description: "标题必填。",
        scenarios: [
          {
            id: "create-task-success",
            name: "创建后刷新仍可看到任务",
            steps: [
              { keyword: "GIVEN", content: "列表中没有“准备会议”任务。" },
              { keyword: "WHEN", content: "用户填写标题并提交创建。" },
              { keyword: "THEN", content: "列表中出现该任务。" },
            ],
          },
        ],
      },
    ],
  };
}

type RequirementsTool = ReturnType<typeof createRequirementsTool>;
type Step = (context: { store: DraftStore; tool: RequirementsTool }) => void | Promise<void>;

class FakeAgent implements ChatAgent {
  readonly sends: string[] = [];
  private readonly steps: Step[];
  private readonly results: ChatTurnResult[];
  readonly tool: RequirementsTool;

  constructor(
    private readonly store: DraftStore,
    steps: Step[] = [],
    results: ChatTurnResult[] = [],
  ) {
    this.steps = steps;
    this.results = results;
    this.tool = createRequirementsTool(store);
  }

  async submit(requirements: unknown, questions: string[] = []) {
    return this.tool.execute("call-1", { requirements, questions }, undefined, undefined, undefined as never);
  }

  async send(text: string): Promise<ChatTurnResult> {
    this.sends.push(text);
    const step = this.steps.shift();
    const result = this.results.shift() ?? { ok: true };
    if (result.ok) await step?.({ store: this.store, tool: this.tool });
    return result;
  }

  async abort(): Promise<void> {}
  dispose(): void {}
}

function collect() {
  const chunks: string[] = [];
  return {
    out: (text: string) => chunks.push(text),
    all: () => chunks.join(""),
  };
}

async function* scripted(lines: string[]): AsyncIterable<string> {
  for (const line of lines) yield line;
}

async function tempBase(): Promise<string> {
  return mkdtemp(join(tmpdir(), "requirements-agent-test-"));
}

test("普通回合展示草案摘要与最多三个优先问题，后续回合带上当前草案", async (t) => {
  const store = createDraftStore();
  const base = await tempBase();
  t.after(() => rm(base, { recursive: true, force: true }).catch(() => {}));
  const { out, all } = collect();
  const agent = new FakeAgent(store, [
    async ({ tool }) => {
      await tool.execute("call-1", {
        requirements: validTree(),
        questions: ["刷新后是否保留任务？", "是否需要筛选？", "导出范围？", "是否需要删除？"],
      }, undefined, undefined, undefined as never);
    },
  ]);

  const result = await runConversation({
    agent,
    store,
    input: scripted(["我要一个任务管理页面。", "好的"]),
    out,
    baseDir: base,
  });

  assert.equal(result.status, "ended");
  assert.match(all(), /本轮修改/);
  assert.match(all(), /create-task/);
  assert.match(all(), /刷新后是否保留任务？/);
  assert.match(all(), /共 4 个/);
  assert.doesNotMatch(all(), /是否需要删除？/);
  assert.match(agent.sends[1], /第 1 版/);
  assert.match(agent.sends[1], /create-task/);
  assert.match(agent.sends[1], /刷新后是否保留任务？/);
});

test("生成请求在草案不完整时被拦下并继续对话", async (t) => {
  const store = createDraftStore();
  const base = await tempBase();
  t.after(() => rm(base, { recursive: true, force: true }).catch(() => {}));
  const { out, all } = collect();
  const incomplete = validTree();
  (incomplete.children as Record<string, unknown>[])[0].scenarios = [];
  const agent = new FakeAgent(store, [
    async ({ tool }) => {
      await tool.execute("call-1", { requirements: incomplete, questions: [] },
        undefined, undefined, undefined as never);
    },
  ]);

  const result = await runConversation({
    agent,
    store,
    input: scripted(["整理一下", "生成需求文档"]),
    out,
    baseDir: base,
  });

  assert.equal(result.status, "ended");
  assert.match(all(), /还不能生成/);
  assert.match(all(), /缺少场景/);
  assert.doesNotMatch(all(), /是否生成这份需求文档/);
  assert.ok(!existsSync(join(base, "requirements")));
  assert.equal(agent.sends.length, 1, "不完整草案由程序拦截，无需调用模型");
});

test("存在未决问题时生成请求被拦下", async (t) => {
  const store = createDraftStore();
  const base = await tempBase();
  t.after(() => rm(base, { recursive: true, force: true }).catch(() => {}));
  const { out, all } = collect();
  const agent = new FakeAgent(store, [
    async ({ tool }) => {
      await tool.execute("call-1", { requirements: validTree(), questions: ["刷新后是否保留任务？"] },
        undefined, undefined, undefined as never);
    },
  ]);

  const result = await runConversation({
    agent,
    store,
    input: scripted(["整理一下", "生成需求文档"]),
    out,
    baseDir: base,
  });

  assert.equal(result.status, "ended");
  assert.match(all(), /未决问题/);
  assert.doesNotMatch(all(), /是否生成这份需求文档/);
  assert.equal(agent.sends.length, 1, "未决问题由程序拦截，无需调用模型");
});

test("单独输入生成直接审阅，再次输入生成才写出；全程不调用模型", async (t) => {
  const store = createDraftStore();
  const value = validTree();
  value.guidance = ["页面简洁，保留设计约定。"];
  assert.equal(store.submit(value, []).ok, true);
  const base = await tempBase();
  t.after(() => rm(base, { recursive: true, force: true }));
  const { out, all } = collect();
  const agent = new FakeAgent(store, [], [{ ok: false, error: "网关不可用" }]);
  async function* input() {
    yield "生成";
    assert.match(all(), /是否生成这份需求文档/);
    assert.ok(!existsSync(join(base, "requirements")), "审阅前不能直接写出文件");
    yield "生成！";
  }
  const result = await runConversation({ agent, store, input: input(), out, baseDir: base });
  assert.equal(result.status, "generated");
  if (result.status !== "generated") return;
  const written = normalizeDraft(parse(await readFile(result.file, "utf8")));
  assert.ok(written.ok);
  assert.deepEqual(written.tree, store.tree);
  assert.equal(store.revision, 1);
  assert.deepEqual(store.pendingInputs, []);
  assert.equal(agent.sends.length, 0);
});

test("空草案收到生成指令时直接提示补充需求，不调用模型", async (t) => {
  const store = createDraftStore();
  const base = await tempBase();
  t.after(() => rm(base, { recursive: true, force: true }));
  const { out, all } = collect();
  const agent = new FakeAgent(store);
  const result = await runConversation({ agent, store, input: scripted(["生成"]), out, baseDir: base });
  assert.equal(result.status, "ended");
  assert.match(all(), /需求草案为空/);
  assert.equal(agent.sends.length, 0);
  assert.ok(!existsSync(join(base, "requirements")));
});

test("同时修改需求并请求生成时，先由模型更新，再审阅并写出修改后的草案", async (t) => {
  const store = createDraftStore();
  assert.equal(store.submit(validTree(), []).ok, true);
  const changed = validTree();
  (changed.children as Record<string, unknown>[])[0].description = "标题选填。";
  const agent = new FakeAgent(store, [async ({ tool }) => {
    await tool.execute("call-1", { requirements: changed, questions: [] });
  }]);
  const base = await tempBase();
  t.after(() => rm(base, { recursive: true, force: true }));
  const { out, all } = collect();
  const result = await runConversation({ agent, store,
    input: scripted(["把标题改成选填，然后生成需求文档", "是"]), out, baseDir: base });
  assert.equal(result.status, "generated");
  if (result.status !== "generated") return;
  assert.equal(agent.sends.length, 1);
  assert.match(all(), /标题选填/);
  assert.equal(parse(await readFile(result.file, "utf8")).children[0].description, "标题选填。");
});

test("完整草案经确认后生成 requirements.yaml", async (t) => {
  const store = createDraftStore();
  const base = await tempBase();
  t.after(() => rm(base, { recursive: true, force: true }).catch(() => {}));
  const { out, all } = collect();
  const agent = new FakeAgent(store, [
    async ({ tool }) => {
      await tool.execute("call-1", { requirements: validTree(), questions: [] },
        undefined, undefined, undefined as never);
    },
  ]);

  const result = await runConversation({
    agent,
    store,
    input: scripted(["我要任务管理。", "生成需求文档", "是"]),
    out,
    baseDir: base,
  });

  assert.equal(result.status, "generated");
  if (result.status !== "generated") return;
  assert.match(all(), /是否生成这份需求文档/);
  const reparsed = normalizeDraft(parse(await readFile(result.file, "utf8")));
  assert.equal(reparsed.ok, true);
  if (!reparsed.ok) return;
  assert.deepEqual(reparsed.tree, store.tree);
  assert.equal(result.file, join(base, "requirements", "requirements.yaml"));
  const catalog = await loadRequirementCatalog(result.file);
  assert.deepEqual(catalog.requirements.map((requirement) => requirement.id), ["create-task"]);
});

test("审阅后回复非确认内容会回到对话且不生成", async (t) => {
  const store = createDraftStore();
  const base = await tempBase();
  t.after(() => rm(base, { recursive: true, force: true }).catch(() => {}));
  const { out, all } = collect();
  const agent = new FakeAgent(store, [
    async ({ tool }) => {
      await tool.execute("call-1", { requirements: validTree(), questions: [] },
        undefined, undefined, undefined as never);
    },
  ]);

  const result = await runConversation({
    agent,
    store,
    input: scripted(["我要任务管理。", "生成需求文档", "再加一个删除功能"]),
    out,
    baseDir: base,
  });

  assert.equal(result.status, "ended");
  assert.match(all(), /是否生成这份需求文档/);
  assert.equal(agent.sends.length, 2);
  assert.match(agent.sends[1], /再加一个删除功能/);
  assert.ok(!existsSync(join(base, "requirements")));
});

test("已有同名文件时使用编号目录并保留已有文档", async (t) => {
  const store = createDraftStore();
  const base = await tempBase();
  t.after(() => rm(base, { recursive: true, force: true }).catch(() => {}));
  await mkdir(join(base, "requirements"), { recursive: true });
  await writeFile(join(base, "requirements", "requirements.yaml"), "existing: true\n", "utf8");
  const agent = new FakeAgent(store, [
    async ({ tool }) => {
      await tool.execute("call-1", { requirements: validTree(), questions: [] },
        undefined, undefined, undefined as never);
    },
  ]);

  const result = await runConversation({
    agent,
    store,
    input: scripted(["整理", "生成需求文档", "是"]),
    out: collect().out,
    baseDir: base,
  });

  assert.equal(result.status, "generated");
  if (result.status !== "generated") return;
  assert.equal(result.file, join(base, "requirements-2", "requirements.yaml"));
  assert.equal(await readFile(join(base, "requirements", "requirements.yaml"), "utf8"), "existing: true\n");
});

test("审阅并交接参考文件：同名来源分别保存、重复来源复用、描述中的图片路径同步重写", async (t) => {
  const store = createDraftStore();
  const base = await tempBase();
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(join(base, "other"));
  await writeFile(join(base, "页面.png"), "first-image");
  await writeFile(join(base, "other", "页面.png"), "second-image");
  const tree = validTree();
  tree.visual_reference = ["页面.png"];
  const child = (tree.children as Record<string, unknown>[])[0];
  child.visual_reference = ["页面.png", "other/页面.png"];
  child.description = "标题必填。![参考](other/页面.png)";
  const agent = new FakeAgent(store, [async ({ tool }) => {
    await tool.execute("call-1", { requirements: tree, questions: [] });
  }]);
  const { out, all } = collect();
  const result = await runConversation({ agent, store, input: scripted(["整理需求", "生成需求文档", "是"]), out, baseDir: base });
  assert.equal(result.status, "generated");
  if (result.status !== "generated") return;
  const output = parse(await readFile(result.file, "utf8"));
  assert.deepEqual(output.visual_reference, ["references/1-页面.png"]);
  assert.deepEqual(output.children[0].visual_reference, ["references/1-页面.png", "references/2-页面.png"]);
  assert.match(output.children[0].description, /!\[参考\]\(references\/2-页面.png\)/);
  assert.equal(await readFile(join(base, "requirements", "references", "1-页面.png"), "utf8"), "first-image");
  assert.equal(await readFile(join(base, "requirements", "references", "2-页面.png"), "utf8"), "second-image");
  assert.match(all(), /将交接的参考文件/);
  assert.ok(all().includes(join(base, "other", "页面.png")));
  assert.deepEqual(store.tree?.visual_reference, ["页面.png"], "导出不能改动对话草案的来源路径");
  assert.ok(all().includes(await readFile(result.file, "utf8")), "审阅 YAML 必须与写出内容一致");
  const catalog = await loadRequirementCatalog(result.file);
  assert.deepEqual(catalog.requirements[0].references, ["references/2-页面.png", "references/1-页面.png"]);
});

test("参考文件缺失时继续对话；审阅后来源消失导致写出失败时可重试", async (t) => {
  const store = createDraftStore();
  const base = await tempBase();
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = join(base, "参考.png");
  const tree = validTree();
  tree.visual_reference = ["参考.png"];
  const agent = new FakeAgent(store, [async ({ tool }) => {
    await tool.execute("call-1", { requirements: tree, questions: [] });
  }]);
  const { out, all } = collect();
  async function* input() {
    yield "整理需求";
    yield "生成需求文档"; // 缺失附件，不能进入确认态。
    assert.doesNotMatch(all(), /是否生成这份需求文档/);
    await writeFile(source, "image");
    yield "生成需求文档";
    await rm(source);
    yield "是"; // 复制失败，不留下半成品目录。
    assert.match(all(), /生成失败/);
    assert.ok(!existsSync(join(base, "requirements")));
    await writeFile(source, "image");
    yield "是";
  }
  const result = await runConversation({ agent, store, input: input(), out, baseDir: base });
  assert.equal(result.status, "generated");
  assert.match(all(), /参考文件不存在/);
  assert.equal(agent.sends.length, 1, "生成指令和确认重试不应调用模型");
});

test("update_requirements 拒绝非法草案并保留旧草案", async () => {
  const store = createDraftStore();
  const agent = new FakeAgent(store);

  const invalid = validTree();
  (invalid.children as Record<string, unknown>[])[0].dependencies = ["nope"];
  await assert.rejects(
    () => agent.submit(invalid),
    /依赖 nope 不存在/,
  );
  assert.equal(store.tree === null, true);
  assert.equal(store.revision, 0);

  const tool = createRequirementsTool(store);
  const ok = await tool.execute("call-1", { requirements: validTree(), questions: [] },
    undefined, undefined, undefined as never);
  const text = ok.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  assert.match(text, /第 1 版/);
  assert.equal(store.revision, 1);

  await assert.rejects(
    () => agent.submit({ id: "bad" }),
    /校验失败/,
  );
  assert.equal(store.revision, 1);
  assert.equal(store.tree?.id, "task-app");
});

test("代理回合失败时展示错误并继续对话", async (t) => {
  const store = createDraftStore();
  const base = await tempBase();
  t.after(() => rm(base, { recursive: true, force: true }).catch(() => {}));
  const { out, all } = collect();
  const agent = new FakeAgent(store, [], [{ ok: false, error: "网关错误" }, { ok: true }]);

  const result = await runConversation({
    agent,
    store,
    input: scripted(["第一句", "第二句"]),
    out,
    baseDir: base,
  });

  assert.equal(result.status, "ended");
  assert.match(all(), /本轮处理失败/);
  assert.match(all(), /网关错误/);
});

test("输入直接结束时不写文件", async (t) => {
  const store = createDraftStore();
  const base = await tempBase();
  t.after(() => rm(base, { recursive: true, force: true }).catch(() => {}));
  const { out, all } = collect();
  const agent = new FakeAgent(store);

  const result = await runConversation({
    agent,
    store,
    input: scripted([]),
    out,
    baseDir: base,
  });

  assert.equal(result.status, "ended");
  assert.ok(!existsSync(join(base, "requirements")));
  assert.match(all(), /requirements-agent|需求整理/);
});

test("requestsGeneration 与 isAffirmative 识别自然语言", () => {
  assert.equal(requestsGeneration("生成"), true);
  assert.equal(requestsGeneration(" 生成！ "), true);
  assert.equal(requestsGeneration("generate"), true);
  assert.equal(requestsGeneration("生成需求文档"), true);
  assert.equal(requestsGeneration("整理好了"), true);
  assert.equal(requestsGeneration("帮我加一个导出，然后生成需求文档"), true);
  assert.equal(requestsGeneration("再加一个删除功能"), false);
  assert.equal(requestsGeneration("是"), false);
  assert.equal(requestsGeneration("不生成"), false);

  assert.equal(isAffirmative("是"), true);
  assert.equal(isAffirmative(" 好。 "), true);
  assert.equal(isAffirmative("确认"), true);
  assert.equal(isAffirmative("可以生成"), true);
  assert.equal(isAffirmative("不"), false);
  assert.equal(isAffirmative("是，但要改"), false);
});

test("assembleInputLines 把续行合并为一次输入", async () => {
  const result: string[] = [];
  for await (const line of assembleInputLines(scripted(["需求：\\", "第一行\\", "第二行", "普通"]))) {
    result.push(line);
  }
  assert.deepEqual(result, ["需求：\n第一行\n第二行", "普通"]);
});
