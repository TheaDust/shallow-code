import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";

import {
  diffRequirements,
  normalizeDraft,
  normalizeQuestions,
  serializeRequirementsYaml,
  summarizeTree,
  validateForGeneration,
  type RequirementNode,
} from "../src/dsl.js";

function expectOk(result: ReturnType<typeof normalizeDraft>): RequirementNode {
  assert.equal(result.ok, true, result.ok ? "" : result.errors.join("\n"));
  if (!result.ok) throw new Error("unreachable");
  return result.tree;
}

function validTree(): Record<string, unknown> {
  return {
    id: "task-app",
    name: "任务管理",
    type: "ROOT",
    description: "用户管理自己的任务。",
    dependencies: [],
    children: [
      {
        id: "create-task",
        name: "创建任务",
        type: "ATOMIC",
        description: "标题必填。",
        dependencies: [],
        scenarios: [
          {
            id: "create-task-success",
            name: "创建后刷新仍可看到任务",
            steps: [
              { keyword: "GIVEN", content: "列表中没有“准备会议”任务。" },
              { keyword: "WHEN", content: "用户填写标题并提交创建。" },
              { keyword: "THEN", content: "列表中出现该任务。" },
              { keyword: "AND", content: "刷新页面后仍显示该任务。" },
            ],
          },
        ],
      },
    ],
  };
}

test("normalizeDraft 接受完整草案并保留内容与顺序", () => {
  const tree = expectOk(normalizeDraft(validTree()));
  assert.equal(tree.id, "task-app");
  assert.equal(tree.type, "ROOT");
  assert.equal(tree.children.length, 1);
  assert.equal(tree.children[0].id, "create-task");
  assert.deepEqual(tree.children[0].scenarios[0].steps.map((step) => step.keyword), [
    "GIVEN",
    "WHEN",
    "THEN",
    "AND",
  ]);
});

test("normalizeDraft 规格化：修剪空白、小写关键字转为大写、缺省数组补空", () => {
  const tree = expectOk(normalizeDraft({
    id: " task-app ",
    name: " 任务 ",
    type: "ROOT",
    description: "d",
    children: [
      {
        id: "a",
        name: "A",
        type: "ATOMIC",
        description: "x",
        scenarios: [
          { name: "场景", steps: [{ keyword: "then", content: "  结果 " }] },
        ],
      },
    ],
  }));
  assert.equal(tree.id, "task-app");
  assert.equal(tree.name, "任务");
  assert.deepEqual(tree.dependencies, []);
  assert.deepEqual(tree.children[0].dependencies, []);
  assert.equal(tree.children[0].scenarios[0].id, "a::0");
  assert.equal(tree.children[0].scenarios[0].steps[0].keyword, "THEN");
  assert.equal(tree.children[0].scenarios[0].steps[0].content, "结果");
});

test("normalizeDraft 缺少或空值必填字段时报错并给出路径", () => {
  const missingName = structuredClone(validTree());
  (missingName.children as Record<string, unknown>[])[0].name = "";
  const result = normalizeDraft(missingName);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.errors.join("\n"), /children\[0\]\.name 不能为空/);

  const badType = structuredClone(validTree());
  badType.type = "FOLDER";
  const rootType = normalizeDraft(badType);
  assert.equal(rootType.ok, false);
  if (rootType.ok) return;
  assert.match(rootType.errors.join("\n"), /ROOT/);

  const badNodeType = structuredClone(validTree());
  (badNodeType.children as Record<string, unknown>[])[0].type = "LEAF";
  const nodeType = normalizeDraft(badNodeType);
  assert.equal(nodeType.ok, false);
  if (nodeType.ok) return;
  assert.match(nodeType.errors.join("\n"), /children\[0\]\.type/);

  const missingDescription = structuredClone(validTree());
  delete missingDescription.description;
  const description = normalizeDraft(missingDescription);
  assert.equal(description.ok, false);
  if (description.ok) return;
  assert.match(description.errors.join("\n"), /description/);
});

test("normalizeDraft 拒绝重复 id 与含空白的 id", () => {
  const duplicate = structuredClone(validTree());
  (duplicate.children as Record<string, unknown>[]).push(
    { id: "create-task", name: "重复", type: "ATOMIC", description: "x", dependencies: [] },
  );
  const dup = normalizeDraft(duplicate);
  assert.equal(dup.ok, false);
  if (dup.ok) return;
  assert.match(dup.errors.join("\n"), /重复 id：create-task/);

  const blankId = structuredClone(validTree());
  (blankId.children as Record<string, unknown>[])[0].id = "bad id";
  const blank = normalizeDraft(blankId);
  assert.equal(blank.ok, false);
  if (blank.ok) return;
  assert.match(blank.errors.join("\n"), /不能包含空白/);
});

test("normalizeDraft 拒绝不存在的依赖与依赖环", () => {
  const unknown = structuredClone(validTree());
  (unknown.children as Record<string, unknown>[])[0].dependencies = ["nope"];
  const unknownResult = normalizeDraft(unknown);
  assert.equal(unknownResult.ok, false);
  if (unknownResult.ok) return;
  assert.match(unknownResult.errors.join("\n"), /依赖 nope 不存在/);

  const cyclic = structuredClone(validTree());
  (cyclic.children as Record<string, unknown>[]).push(
    { id: "edit-task", name: "编辑", type: "ATOMIC", description: "x", dependencies: ["view-task"],
      scenarios: [{ name: "s", steps: [{ keyword: "WHEN", content: "w" }, { keyword: "THEN", content: "t" }] }] },
    { id: "view-task", name: "查看", type: "ATOMIC", description: "x", dependencies: ["edit-task"] },
  );
  const cyclicResult = normalizeDraft(cyclic);
  assert.equal(cyclicResult.ok, false);
  if (cyclicResult.ok) return;
  assert.match(cyclicResult.errors.join("\n"), /依赖环/);
});

test("normalizeDraft 约束节点形状：ATOMIC 无子节点、非 ATOMIC 无场景", () => {
  const atomicWithChild = structuredClone(validTree());
  (atomicWithChild.children as Record<string, unknown>[])[0].children = [
    { id: "sub", name: "子", type: "ATOMIC", description: "x" },
  ];
  const childResult = normalizeDraft(atomicWithChild);
  assert.equal(childResult.ok, false);
  if (childResult.ok) return;
  assert.match(childResult.errors.join("\n"), /ATOMIC 不能包含子节点/);

  const folderWithScenario = structuredClone(validTree());
  folderWithScenario.children = [
    { id: "area", name: "区域", type: "FOLDER", description: "x",
      scenarios: [{ name: "s", steps: [{ keyword: "THEN", content: "t" }] }] },
  ];
  const scenarioResult = normalizeDraft(folderWithScenario);
  assert.equal(scenarioResult.ok, false);
  if (scenarioResult.ok) return;
  assert.match(scenarioResult.errors.join("\n"), /只有 ATOMIC 可以包含场景/);
});

test("normalizeDraft 校验步骤：关键字白名单、名称与内容非空", () => {
  const badKeyword = structuredClone(validTree());
  const badSteps = ((badKeyword.children as Record<string, unknown>[])[0].scenarios as any[])[0]
    .steps as any[];
  badSteps[0].keyword = "GIVENN";
  const keywordResult = normalizeDraft(badKeyword);
  assert.equal(keywordResult.ok, false);
  if (keywordResult.ok) return;
  assert.match(keywordResult.errors.join("\n"), /关键字/);

  const emptyContent = structuredClone(validTree());
  const emptySteps = ((emptyContent.children as Record<string, unknown>[])[0].scenarios as any[])[0]
    .steps as any[];
  emptySteps[1].content = " ";
  const contentResult = normalizeDraft(emptyContent);
  assert.equal(contentResult.ok, false);
  if (contentResult.ok) return;
  assert.match(contentResult.errors.join("\n"), /content 不能为空/);
});

test("normalizeQuestions 修剪空白、丢弃空项并拒绝非字符串数组", () => {
  const ok = normalizeQuestions([" 问题一 ", "", "问题二"]);
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.deepEqual(ok.questions, ["问题一", "问题二"]);

  const bad = normalizeQuestions([{ text: "问题" }]);
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.match(bad.errors.join("\n"), /questions 必须是非空字符串数组/);
});

test("validateForGeneration 要求非空草案、至少一个 ATOMIC、每个 ATOMIC 有完整场景与结果", () => {
  assert.match(validateForGeneration(null).join("\n"), /草案为空/);

  const noAtomic = expectOk(normalizeDraft({
    id: "root", name: "产品", type: "ROOT", description: "d",
    children: [{ id: "area", name: "区域", type: "FOLDER", description: "d" }],
  }));
  assert.match(validateForGeneration(noAtomic).join("\n"), /至少需要一个 ATOMIC/);

  const noScenario = structuredClone(validTree());
  (noScenario.children as Record<string, unknown>[])[0].scenarios = [];
  const noScenarioTree = expectOk(normalizeDraft(noScenario));
  assert.match(validateForGeneration(noScenarioTree).join("\n"), /create-task 缺少场景/);

  const noOutcome = structuredClone(validTree());
  (((noOutcome.children as Record<string, unknown>[])[0].scenarios as any[])[0]).steps = [
    { keyword: "WHEN", content: "用户点击。" },
  ];
  const noOutcomeTree = expectOk(normalizeDraft(noOutcome));
  assert.match(validateForGeneration(noOutcomeTree).join("\n"), /缺少可观察结果/);

  const complete = expectOk(normalizeDraft(validTree()));
  assert.deepEqual(validateForGeneration(complete), []);
});

test("serializeRequirementsYaml 序列化后可由 YAML 解析还原（中文、引号、换行、data）", () => {
  const input = validTree();
  input.description = "第一行。\n“引号”与换行都要保留。";
  input.data = [
    { category: "初始任务", items: ["准备会议", "写方案"] },
  ];
  (input.children as Record<string, unknown>[])[0].description = "包含\n换行与“中文引号”的描述。";
  const tree = expectOk(normalizeDraft(input));

  const yaml = serializeRequirementsYaml(tree);
  assert.ok(yaml.endsWith("\n"));
  // 序列化省略空数组，往返比较先经规范化还原为同一形状。
  const reparsed = normalizeDraft(parse(yaml));
  assert.equal(reparsed.ok, true, reparsed.ok ? "" : reparsed.errors.join("\n"));
  if (!reparsed.ok) return;
  assert.deepEqual(reparsed.tree, tree);
});

test("serializeRequirementsYaml 无 data 时省略 data 字段", () => {
  const tree = expectOk(normalizeDraft(validTree()));
  const yaml = serializeRequirementsYaml(tree);
  assert.ok(!/^data:/m.test(yaml));
  assert.ok(/^id: task-app$/m.test(yaml));
});

test("diffRequirements 识别新增、删除与修改", () => {
  const before = expectOk(normalizeDraft(validTree()));
  const afterInput = structuredClone(validTree());
  (afterInput.children as Record<string, unknown>[])[0].description = "标题必填，状态默认为待办。";
  (afterInput.children as Record<string, unknown>[]).push(
    { id: "filter-tasks", name: "筛选任务", type: "ATOMIC", description: "按状态筛选。" },
  );
  const after = expectOk(normalizeDraft(afterInput));

  const diff = diffRequirements(before, after);
  assert.deepEqual(diff.added.map((node) => node.id), ["filter-tasks"]);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.changed.map((node) => node.id), ["create-task"]);
  assert.deepEqual(diffRequirements(null, after).added.map((node) => node.id), ["task-app", "create-task", "filter-tasks"]);
});

test("diffRequirements 子节点变化不会把父节点标记为修改", () => {
  const before = expectOk(normalizeDraft({
    id: "root", name: "产品", type: "ROOT", description: "d",
    children: [{ id: "area", name: "区域", type: "FOLDER", description: "d",
      children: [{ id: "a", name: "A", type: "ATOMIC", description: "旧" }] }],
  }));
  const after = expectOk(normalizeDraft({
    id: "root", name: "产品", type: "ROOT", description: "d",
    children: [{ id: "area", name: "区域", type: "FOLDER", description: "d",
      children: [{ id: "a", name: "A", type: "ATOMIC", description: "新" }] }],
  }));

  const diff = diffRequirements(before, after);
  assert.deepEqual(diff.changed.map((node) => node.id), ["a"]);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diffRequirements(after, after), { added: [], removed: [], changed: [] });
});

test("summarizeTree 统计 ATOMIC 与场景数量", () => {
  const tree = expectOk(normalizeDraft({
    id: "root", name: "产品", type: "ROOT", description: "d",
    children: [
      { id: "area", name: "区域", type: "FOLDER", description: "d", children: [
        { id: "a", name: "A", type: "ATOMIC", description: "x",
          scenarios: [
            { name: "s1", steps: [{ keyword: "THEN", content: "t" }] },
            { name: "s2", steps: [{ keyword: "THEN", content: "t" }] },
          ] },
        { id: "b", name: "B", type: "ATOMIC", description: "x" },
      ] },
    ],
  }));
  assert.deepEqual(summarizeTree(tree), { atomics: 2, scenarios: 2 });
});
