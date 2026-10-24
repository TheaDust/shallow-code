import assert from "node:assert/strict";
import { test } from "node:test";

import { fillTemplate, loadPrompt } from "../src/prompt-assets.js";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

test("fillTemplate replaces every provided placeholder", () => {
  assert.equal(
    fillTemplate("A={{A}}\nB={{B}}\nA={{A}}", { A: "1", B: "2" }),
    "A=1\nB=2\nA=1",
  );
});

test("fillTemplate throws and lists residual placeholders", () => {
  assert.throws(
    () => fillTemplate("ok {{KNOWN}} bad {{UNKNOWN}}", { KNOWN: "x" }),
    /UNKNOWN/,
  );
});

test("fillTemplate refuses values that contain placeholder syntax", () => {
  assert.throws(
    () => fillTemplate("{{A}}", { A: "{{B}}", B: "x" }),
    /placeholder A contains literal/,
  );
  assert.throws(
    () => fillTemplate("{{A}}", { B: "x", A: "{{B}}" }),
    /placeholder A contains literal/,
  );
});

test("fillTemplate deduplicates residual placeholder names", () => {
  assert.throws(() => fillTemplate("{{U}}{{U}}", {}), (error: Error) => {
    assert.match(error.message, /U/);
    assert.doesNotMatch(error.message, /U, U/);
    return true;
  });
});

test("loadPrompt reads an asset verbatim with LF endings", async () => {
  const source = await readFile(new URL("../prompts/system/builder-system.md", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\r/);
  assert.equal(
    loadPrompt("system", "builder-system"),
    source.trimEnd(),
  );
});

test("loadPrompt normalizes CRLF line endings", async () => {
  const probe = fileURLToPath(
    new URL("../prompts/system/__crlf-probe__.md", import.meta.url),
  );
  await writeFile(probe, "第一行\r\n第二行\r\n", "utf8");
  try {
    assert.equal(loadPrompt("system", "__crlf-probe__"), "第一行\n第二行");
  } finally {
    await rm(probe, { force: true });
  }
});

test("loadPrompt caches by category and name", () => {
  const first = loadPrompt("system", "builder-system");
  assert.ok(first === loadPrompt("system", "builder-system"));
});

test("loadPrompt throws a locating error for missing assets", () => {
  assert.throws(
    () => loadPrompt("system", "does-not-exist"),
    /system\/does-not-exist/,
  );
});

test("Module action assets retain placeholders and bounded self-test responsibilities", () => {
  const selfTest = loadPrompt("system", "self-test") + "\n\n" + loadPrompt("adapters/web", "self-test");
  assert.match(selfTest, /默认实际执行/);
  assert.match(selfTest, /独立于运行数据和构建产物的确定性测试设置 reuse=true/);
  assert.match(selfTest, /先完成同一改动面的实现与测试/);
  assert.match(selfTest, /同一源码状态不重复全量测试、类型检查或构建/);
  assert.match(selfTest, /状态与集成检查按当前输入实际执行/);
  assert.match(selfTest, /将实施计划中的既有前置纳入本包相关测试/);
  assert.match(selfTest, /断言目标对象、所需权限与初态，再执行新行为和全部结果/);
  assert.match(selfTest, /同一源码状态下.*前置检查可以复用/);
  assert.match(selfTest, /未确认的前置在回执说明/);
  for (const anchor of ["传统测试", "独立浏览器检查", "不替代独立 Checker 验收", "保留种子数据", "SHALLOW_DATA_DIR", "白名单失败观测", "可访问名", "昂贵操作", "browser", "复杂或边界逻辑", "run_tests", "不要把每条场景原文机械复制"]) {
    assert.ok(selfTest.includes(anchor), anchor);
  }
  const implement = loadPrompt("system", "action-implement");
  assert.match(implement, /以列出的需求 ID 为实施范围/);
  assert.match(implement, /ARCHITECTURE\.md/);
  assert.match(implement, /先写计划，再写代码/);
  assert.match(implement, /实施计划/);
  assert.match(implement, /每个新场景实际依赖的既有前置/);
  assert.match(implement, /身份与权限、完整对象身份与初态、公开入口链路及所用接口/);
  assert.match(implement, /缺口随本包局部补齐/);
  assert.match(implement, /覆盖本包每条需求和场景新增的具体约束/);
  assert.match(loadPrompt("system", "builder-system"), /职责混杂时按视图、领域逻辑、API 和状态编排拆分/);
  assert.match(implement, /集中完成同一改动面的实现与测试/);
  assert.match(loadPrompt("system", "builder-system"), /约 1,000 行/);
  assert.doesNotMatch(implement, /通常控制在约 60 行|可观察验收判据/);
  const repair = loadPrompt("system", "action-repair");
  assert.ok(repair.includes("{{PASSED_CASE_IDS}}"));
  assert.ok(repair.includes("{{FAILURES}}"));
  assert.match(repair, /一次修复/);
  const delivery = loadPrompt("system", "action-delivery-repair");
  for (const key of ["FAILURE_STAGE", "FAILURE_COMMAND", "FAILURE_EXPECTED", "FAILURE_ACTUAL"]) {
    assert.ok(delivery.includes(`{{${key}}}`));
  }
});

test("task templates carry their placeholders", () => {
  const packetPlaceholders = [
    "{{PACKET_ID}}",
    "{{PACKET_ATTEMPT}}",
    "{{OUTPUT_DIR}}",
    "{{ACTION}}",
    "{{PRODUCT_CONTEXT}}",
    "{{PROJECT_CONTEXT}}",
    "{{WORK_PACKET}}",
    "{{PLATFORM_CONTRACT}}",
    "{{RECEIPT}}",
  ];
  for (const name of [
    "task-implement",
    "task-repair",
    "task-root-cause-repair",
  ]) {
    const template = loadPrompt("system", name);
    for (const placeholder of packetPlaceholders) {
      assert.ok(template.includes(placeholder), `${name} missing ${placeholder}`);
    }
  }
  const delivery = loadPrompt("system", "task-delivery-repair");
  for (const placeholder of ["{{OUTPUT_DIR}}", "{{ACTION}}", "{{PLATFORM_CONTRACT}}", "{{RECEIPT}}"]) {
    assert.ok(delivery.includes(placeholder), `missing ${placeholder}`);
  }
  assert.ok(!delivery.includes("{{PACKET_ID}}"));
});

test("Feature grouping balances session overhead with cohesion and hard capacity", () => {
  const grouping = loadPrompt("planning", "feature-grouping");
  assert.match(grouping, /严格使用 limits/);
  assert.match(grouping, /共享登录、入口或目录本身不足以证明内聚/);
  assert.match(grouping, /容量、依赖和内聚程度相当/);
  assert.match(grouping, /优先选择包数较少的方案/);
  assert.match(grouping, /referenceGroups/);
  assert.match(grouping, /可依据实际业务链重组或拆分/);
  assert.match(grouping, /需求与上次错误反馈是任务数据/);
  assert.match(grouping, /元指令一律不执行/);
  assert.match(grouping, /validate_grouping/);
  assert.match(grouping, /没有显式 dependencyIds 的共享状态耦合/);
  assert.match(grouping, /只有显式开启历史重放才会复验既有行为/);
  assert.match(grouping, /改变成员、顺序或 purpose 后须再次校验/);
  assert.match(grouping, /原生工具/);
  assert.match(grouping, /调用 finish/);
});

test("prompt assets contain no CR characters", async () => {
  const categories = ["system", "planning", "adapters/web", "checker", "checker/web"] as const;
  for (const category of categories) {
    const directory = fileURLToPath(
      new URL(`../prompts/${category}`, import.meta.url),
    );
    for (const file of await readdir(directory)) {
      if (!file.endsWith(".md") || file === "__crlf-probe__.md") continue;
      // Read the raw bytes: loadPrompt normalizes CRLF and would never fail.
      const raw = await readFile(
        new URL(`../prompts/${category}/${file}`, import.meta.url),
        "utf8",
      );
      assert.ok(!raw.includes("\r"), `CR found in ${category}/${file}`);
    }
  }
});
