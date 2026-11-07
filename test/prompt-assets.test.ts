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
  const source = await readFile(new URL("../prompts/builder/builder-system.md", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\r/);
  assert.equal(
    loadPrompt("builder", "builder-system"),
    source.trimEnd(),
  );
});

test("loadPrompt normalizes CRLF line endings", async () => {
  const probe = fileURLToPath(
    new URL("../prompts/builder/__crlf-probe__.md", import.meta.url),
  );
  await writeFile(probe, "第一行\r\n第二行\r\n", "utf8");
  try {
    assert.equal(loadPrompt("builder", "__crlf-probe__"), "第一行\n第二行");
  } finally {
    await rm(probe, { force: true });
  }
});

test("loadPrompt caches by category and name", () => {
  const first = loadPrompt("builder", "builder-system");
  assert.ok(first === loadPrompt("builder", "builder-system"));
});

test("loadPrompt throws a locating error for missing assets", () => {
  assert.throws(
    () => loadPrompt("builder", "does-not-exist"),
    /builder\/does-not-exist/,
  );
});

test("Module action assets retain placeholders and bounded self-test responsibilities", () => {
  const selfTest = loadPrompt("builder", "self-test") + "\n\n" + loadPrompt("adapters/web", "self-test");
  assert.match(selfTest, /默认实际执行/);
  assert.match(selfTest, /独立于运行数据和构建产物的确定性测试设置 reuse=true/);
  assert.match(selfTest, /功能组以业务实现和必要局部检查完成为交接条件/);
  assert.match(selfTest, /最后一个实现包也沿用这一范围/);
  assert.match(selfTest, /逐场景独立验收由 Verifier 完成/);
  assert.match(selfTest, /使用项目声明的 target 和 filter，仅运行受影响文件/);
  assert.match(selfTest, /同一源码状态不重复全量测试、类型检查或构建/);
  assert.match(selfTest, /已有检查确认的结果直接沿用/);
  assert.match(selfTest, /修改种子或持久化逻辑时.*检查空数据与继承数据/);
  for (const anchor of ["传统测试", "不替代独立 Verifier 验收", "保留种子数据", "SHALLOW_DATA_DIR", "可访问名", "昂贵操作", "browser", "复杂计算", "run_tests", "隔离目录"]) {
    assert.ok(selfTest.includes(anchor), anchor);
  }
  const implement = loadPrompt("builder", "action-implement");
  assert.match(implement, /以列出的需求 ID 为实施范围/);
  assert.match(implement, /ARCHITECTURE\.md/);
  assert.match(implement, /直接完成本包的业务实现和必要局部检查/);
  assert.match(implement, /完整场景用于确定实现约束/);
  assert.match(implement, /前序能力按现有接口复用/);
  assert.match(implement, /缺口随本包局部补齐/);
  assert.match(implement, /实现覆盖本包需求、必要局部检查通过后即交接/);
  assert.match(loadPrompt("builder", "builder-system"), /只有当前业务复杂度、重复逻辑或真实故障需要时才拆分模块/);
  assert.match(implement, /集中完成同一改动面/);
  const repair = loadPrompt("builder", "action-repair");
  assert.ok(repair.includes("{{PASSED_CASE_IDS}}"));
  assert.ok(repair.includes("{{FAILURES}}"));
  assert.match(repair, /一次修复/);
  const delivery = loadPrompt("builder", "action-delivery-repair");
  for (const key of ["FAILURE_STAGE", "FAILURE_COMMAND", "FAILURE_EXPECTED", "FAILURE_ACTUAL"]) {
    assert.ok(delivery.includes(`{{${key}}}`));
  }
});

test("Builder architecture handoff indexes domains before scanning source", () => {
  const notes = loadPrompt("builder", "architecture-notes");
  const system = loadPrompt("builder", "builder-system");
  const implement = loadPrompt("builder", "action-implement");
  const repair = loadPrompt("builder", "action-repair");
  const receipt = loadPrompt("builder", "receipt");

  assert.match(notes, /简短的领域索引/);
  for (const field of ["入口", "同步点", "测试"]) assert.ok(notes.includes(field));
  assert.match(notes, /缺失或过期时做窄搜索并核对源码/);
  assert.match(notes, /只在本次改动改变跨文件入口或约定时更新对应条目/);
  assert.match(notes, /每项用简短说明和源码指针表达/);
  assert.doesNotMatch(system, /先看项目目录/);
  assert.match(system, /超过约 300 行的文件只读相关片段/);
  assert.match(system, /不递归扫描无关源码/);
  assert.match(implement, /已有会话上下文（如有）、ARCHITECTURE\.md 和本包原文/);
  assert.match(repair, /按失败涉及的领域读取 ARCHITECTURE\.md 条目/);
  assert.match(receipt, /更新了哪些 ARCHITECTURE\.md 条目/);
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
    const template = loadPrompt("builder", name);
    for (const placeholder of packetPlaceholders) {
      assert.ok(template.includes(placeholder), `${name} missing ${placeholder}`);
    }
  }
  const delivery = loadPrompt("builder", "task-delivery-repair");
  for (const placeholder of ["{{OUTPUT_DIR}}", "{{ACTION}}", "{{PLATFORM_CONTRACT}}", "{{RECEIPT}}"]) {
    assert.ok(delivery.includes(placeholder), `missing ${placeholder}`);
  }
  assert.ok(!delivery.includes("{{PACKET_ID}}"));
});

test("Feature grouping balances session overhead with cohesion and hard capacity", () => {
  const grouping = loadPrompt("grouper", "feature-grouping");
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
  assert.match(grouping, /减少后组反复修改前组已完成的行为/);
  assert.match(grouping, /改变成员、顺序、purpose 或前置关系后须再次校验/);
  assert.match(grouping, /原生工具/);
  assert.match(grouping, /调用 finish/);
});

test("prompt assets contain no CR characters", async () => {
  const categories = ["builder", "grouper", "adapters/web", "verifier", "verifier/web"] as const;
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
