import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { createRequirementsTool } from "../src/cli.js";
import { createDraftStore } from "../src/draft-store.js";

const promptFile = new URL("../prompts/requirements-agent.md", import.meta.url);

test("requirements prompt carries the downstream acceptance contract", async () => {
  const prompt = await readFile(promptFile, "utf8");
  assert.doesNotMatch(prompt, /\r/);
  for (const heading of [
    "## 文档读者与验收标准",
    "## 对话方式",
    "## 需求结构",
    "## 生成流程",
  ]) {
    assert.ok(prompt.includes(heading), `missing ${heading}`);
  }
  for (const anchor of [
    "Builder",
    "Verifier",
    "独立重放",
    "每个结果子句只写一个可独立判定的结果",
    "description",
    "guidance",
    "共享预置",
    "不要放进 `data`",
    "场景 `id`",
    "按 `id` 合并",
    "分成多次调用",
    "removedNodes",
    "不可重复",
    "固定种子",
    "改变角色",
  ]) {
    assert.ok(prompt.includes(anchor), `missing ${anchor}`);
  }
});

test("requirements tool description mirrors the acceptance contract", () => {
  const description = createRequirementsTool(createDraftStore()).description;
  for (const anchor of [
    "kebab-case",
    "THEN",
    "guidance 不进入正式验收",
    "产品级共享预置",
    "GIVEN",
    "不要重命名",
    "增量更新",
    "removedNodes",
    "不可重复",
  ]) {
    assert.ok(description.includes(anchor), `missing ${anchor}`);
  }
});
