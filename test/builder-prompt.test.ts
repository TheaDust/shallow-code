import { minimalWebContract } from "../src/adapters/web/project-spec.js";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { compileBuilderPrompt } from "../src/builder/prompt.js";
import { loadRequirementCatalog } from "../src/catalog.js";
import type {
  BuilderPromptInput,
  BuilderProjectContext,
  BuilderShadowObservation,
} from "../src/builder/prompt-input.js";
import type { BuilderRequest } from "../src/builder/port.js";
import type {
  AtomicRequirement,
  ApplicationContract,
  WorkPacket,
} from "../src/types.js";
import { FakeBuilder } from "./fakes/fake-builder.js";
import { loadPrompt } from "../src/prompt-assets.js";

test("Builder contracts follow requirements and project choices across products and modes", () => {
  const systems = new Set<string>();
  for (const kind of ["repository_collaboration", "spreadsheet", "generic_web"] as const) {
    for (const request of [implementRequest(), repairRequest("repair"), repairRequest("root_cause_repair")]) {
      if (request.mode === "delivery_repair") throw new Error("unexpected mode");
      request.projectContext.product.kind = kind;
      request.packet.requirements[0].product.kind = kind;
      const compiled = compileBuilderPrompt(request);
      systems.add(compiled.systemPrompt);
      assert.ok(compiled.taskPrompt.includes(request.packet.requirements[0].text));
      assert.match(compiled.systemPrompt + compiled.taskPrompt, /用 read 读取其 SKILL.md/);
      assert.doesNotMatch(compiled.systemPrompt, /必须使用 HashRouter|全局页头使用顶层/);
      assert.doesNotMatch(compiled.taskPrompt, /【仓库协作业务】|【电子表格业务】/);
    }
  }
  assert.equal(systems.size, 1);
});

test("Builder prompt compiles a Chinese system contract and dynamic task prompt", () => {
  const compiled = compileBuilderPrompt(implementRequest());

  assert.match(compiled.systemPrompt + compiled.taskPrompt, /唯一代码实现者/);
  assert.match(compiled.systemPrompt + compiled.taskPrompt, /Builder 开发检查/);
  assert.match(compiled.systemPrompt + compiled.taskPrompt, /传统测试/);
  assert.match(compiled.systemPrompt + compiled.taskPrompt, /保留种子数据/);
  assert.match(compiled.systemPrompt + compiled.taskPrompt, /释放进程/);
  assert.doesNotMatch(compiled.systemPrompt, /MCP/);
  assert.match(compiled.systemPrompt + compiled.taskPrompt, /SHALLOW_DATA_DIR/);
  assert.match(compiled.systemPrompt + compiled.taskPrompt, /持续增量扩展/);
  assert.match(compiled.systemPrompt + compiled.taskPrompt, /必要的开发检查/);
  assert.match(compiled.systemPrompt + compiled.taskPrompt, /全新的独立会话/);
  assert.match(compiled.systemPrompt + compiled.taskPrompt, /唯一交接面/);
  assert.match(compiled.systemPrompt + compiled.taskPrompt, /复杂或边界逻辑必须编写传统测试并用 run_tests 运行/);
  assert.match(compiled.systemPrompt + compiled.taskPrompt, /browser 是昂贵工具/);
  assert.match(compiled.systemPrompt + compiled.taskPrompt, /清晰稳定的模块与接口边界/);
  assert.match(compiled.systemPrompt + compiled.taskPrompt, /延续既有栈，不得换栈重写/);
  assert.match(compiled.systemPrompt + compiled.taskPrompt, /通用最小脚手架提供运行配置/);
  assert.match(compiled.systemPrompt + compiled.taskPrompt, /不代表任何业务需求已经实现/);
  assert.match(compiled.systemPrompt + compiled.taskPrompt, /frontend\/src\/ui/);
  assert.match(compiled.systemPrompt + compiled.taskPrompt, /list_capabilities/);
  assert.match(compiled.systemPrompt + compiled.taskPrompt, /install_capability/);
  assert.match(compiled.systemPrompt + compiled.taskPrompt, /React \+ Vite \+ TypeScript/);
  assert.match(compiled.systemPrompt + compiled.taskPrompt, /路由方案按页面直达、刷新/);
  assert.doesNotMatch(compiled.systemPrompt, /必须使用 HashRouter/);
  assert.match(compiled.systemPrompt + compiled.taskPrompt, /@testing-library\/react/);
  assert.match(compiled.systemPrompt + compiled.taskPrompt, /按其所属控件或文本逐字实现/);
  assert.match(compiled.systemPrompt + compiled.taskPrompt, /不得缩写、加长、同义替换或翻译/);
  assert.match(compiled.systemPrompt + compiled.taskPrompt, /共享种子及按场景区分的初始条件/);
  assert.match(compiled.systemPrompt + compiled.taskPrompt, /明确列为预置或既有的实体/);
  assert.match(compiled.systemPrompt + compiled.taskPrompt, /logo 等返回首页入口的角色和可访问名以需求明示为准/);
  assert.match(compiled.systemPrompt + compiled.taskPrompt, /等待期间给出忙碌状态并防止重复操作/);
  assert.match(compiled.taskPrompt, /应用交互检查未执行/);
  assert.match(compiled.taskPrompt, /未执行/);
  assert.match(compiled.taskPrompt, /需求核对/);
  assert.doesNotMatch(compiled.systemPrompt, /REQ-PROFILE/);
  assert.match(compiled.taskPrompt, /# 行动：实现当前工作包/);
  const actionIndex = compiled.taskPrompt.indexOf(loadPrompt("builder", "action-implement"));
  const packetIndex = compiled.taskPrompt.indexOf("## 当前工作包");
  assert.ok(actionIndex >= 0 && packetIndex > actionIndex, "implement action stays ahead of packet-specific context");
  assert.match(compiled.taskPrompt, /先规划，再实施/);
  assert.match(compiled.taskPrompt, /严格符合需求文档/);
  assert.match(compiled.taskPrompt, /覆盖本包每条需求和场景新增的具体约束/);
  assert.match(compiled.taskPrompt, /按需求 ID 和场景名或序号/);
  assert.match(compiled.taskPrompt, /在同一实施计划中列出每个新场景实际依赖的既有前置/);
  assert.match(compiled.taskPrompt, /实施前用相关既有测试或最小公开交互逐项检查现状/);
  assert.match(compiled.taskPrompt, /尚未实现或尚未验证的场景约束/);
  assert.match(compiled.taskPrompt, /完整业务链路/);
  assert.match(compiled.systemPrompt + compiled.taskPrompt, /不能为示例输入、账号或断言硬编码结果/);
  assert.match(compiled.taskPrompt, /ARCHITECTURE\.md/);
  assert.match(compiled.taskPrompt, /REQ-PROFILE/);
  assert.match(compiled.taskPrompt, /Root description/);
  assert.match(compiled.taskPrompt, /Profile area/);
  assert.match(compiled.taskPrompt, /Keep a profile name after refresh\./);
  assert.match(compiled.taskPrompt, /The value remains after refresh\./);
  assert.match(compiled.taskPrompt, /reference\/profile\.png/);
  assert.match(compiled.taskPrompt, /Profile name \| Save/);
  assert.match(compiled.taskPrompt, /引号原词（须按原文区分界面名称、数据值与示例）/);
  assert.match(compiled.taskPrompt, /cwd=frontend: npm run build/);
  assert.match(compiled.taskPrompt, /http:\/\/127\.0\.0\.1:3000/);
  assert.match(compiled.taskPrompt, /PORT/);
  assert.match(compiled.taskPrompt, /同源相对路径/);
  assert.doesNotMatch(compiled.taskPrompt, /SECRET-OTHER-REQ/);
  assert.doesNotMatch(compiled.taskPrompt, /acceptedSha|global budget|\/workspace\/tests/i);
  // 技术栈缺省（React+Vite）只出现在固定系统合同里；任务模板不向既有项目推销换栈
  assert.doesNotMatch(compiled.taskPrompt, /use React|use Vue/i);
  assert.match(compiled.taskPrompt, /结果：完成 \| 阻塞/);
});

test("Builder shares its product and platform prefix across packets and repair modes", () => {
  const requests = [implementRequest(), repairRequest("repair"), repairRequest("root_cause_repair")];
  const prompts = requests.map((request, index) => {
    if (request.mode === "delivery_repair") throw new Error("unexpected mode");
    request.projectContext.product.seedData = [{ category: "accounts", items: ["shared account alice"] }];
    request.projectContext.ancestors = [{ id: `AREA-${index}`, name: `Area ${index}`, description: `Path ${index}` }];
    request.projectContext.satisfiedDependencies = [{ id: `DEP-${index}`, name: "Dependency", contract: `Contract ${index}` }];
    request.packet.id = `packet-${index}`;
    request.packet.attempt = (index + 1) as 1 | 2 | 3;
    request.packet.requirements[0].text += ` Packet evidence ${index}.`;
    const compiled = compileBuilderPrompt(request);
    assert.match(compiled.systemPrompt + compiled.taskPrompt, /逐场景还原 GIVEN/);
    assert.match(compiled.systemPrompt + compiled.taskPrompt, /逐场景核对 GIVEN、准备、WHEN 操作和全部 THEN 结果/);
    assert.ok(compiled.taskPrompt.includes(`Path ${index}`));
    assert.ok(compiled.taskPrompt.includes(`Contract ${index}`));
    assert.ok(compiled.taskPrompt.includes(`Packet evidence ${index}.`));
    assert.ok(compiled.taskPrompt.includes(`工作包编号：packet-${index}`));
    assert.ok(compiled.taskPrompt.includes(`当前尝试：${index + 1}`));
    return compiled;
  });
  const commonLength = prompts.reduce((length, prompt) => {
    let index = 0;
    while (index < length && prompt.taskPrompt[index] === prompts[0].taskPrompt[index]) index++;
    return index;
  }, prompts[0].taskPrompt.length);
  const prefix = prompts[0].taskPrompt.slice(0, commonLength);
  assert.ok(prefix.includes("Root description."));
  assert.ok(prefix.includes("shared account alice"));
  assert.ok(prefix.includes("cwd=frontend: npm run build"));
  assert.ok(prefix.includes("结果：完成 | 阻塞"));
  assert.ok(prompts[0].taskPrompt.indexOf("# 行动：实现当前工作包") < prompts[0].taskPrompt.indexOf("当前功能路径："));
  for (const prompt of prompts.slice(1)) assert.ok(prompt.taskPrompt.indexOf("# 行动：") > prompt.taskPrompt.indexOf("## 当前工作包"));
  for (const prompt of prompts) {
    assert.equal(prompt.systemPrompt, prompts[0].systemPrompt);
    assert.equal(prompt.taskPrompt.split("cwd=frontend: npm run build").length, 2);
  }
});

test("Evolution packets share the static context before their prerequisite ids", () => {
  const prompts = ["REQ-1-1-2", "REQ-3-3"].map((externalId, index) => {
    const request = implementRequest();
    if (request.mode !== "implement") throw new Error("unexpected mode");
    request.packet.id = `packet-${index}`;
    request.packet.requirements[0].text += ` Packet ${index}.`;
    request.packet.requirements[0].ancestors = [{ id: `AREA-${index}`, name: `Area ${index}`, description: `Area ${index}.` }];
    request.projectContext.ancestors = [{ id: `AREA-${index}`, name: `Area ${index}`, description: `Area ${index}.` }];
    request.projectContext.evolution = { startingPoint: "inherited_application", externalPrerequisiteIds: [externalId], changesOnly: true };
    return compileBuilderPrompt(request).taskPrompt;
  });
  const marker = "前序能力 ID：";
  const boundary = prompts[0]!.indexOf(marker);
  assert.ok(boundary > 0);
  const prefix = prompts[0]!.slice(0, boundary + marker.length);
  assert.ok(prefix.includes("## 增量开发上下文"));
  assert.ok(prefix.includes(loadPrompt("builder", "evolution-audit-all")));
  assert.ok(prefix.includes(loadPrompt("builder", "incremental-start-inherited")));
  assert.ok(prefix.includes("继承应用的持久化目录"), "the last static paragraph stays in the shared prefix");
  for (const prompt of prompts) assert.ok(prompt.startsWith(prefix));
  assert.notEqual(prompts[0]!.slice(boundary), prompts[1]!.slice(boundary));
});

test("Builder receives progressive-stage rules for inherited and blank starting points", () => {
  for (const [startingPoint, expected] of [
    ["inherited_application", "继承自前序阶段的应用"],
    ["blank_template", "空白通用模板"],
  ] as const) {
    const request = implementRequest();
    if (request.mode !== "implement") throw new Error("unexpected mode");
    request.projectContext.progressiveStage = {
      index: 3,
      currentStageTestsOnly: true,
      startingPoint,
      externalPrerequisiteIds: ["REQ-1-1-2", "REQ-3-3"],
    };
    const compiled = compileBuilderPrompt(request);
    const prompt = compiled.taskPrompt;
    assert.match(prompt, /## 分阶段增量上下文/);
    assert.ok(prompt.indexOf("前序阶段能力 ID：") > prompt.indexOf("无论起点如何"));
    assert.match(prompt, /当前阶段：Stage 3/);
    assert.ok(prompt.includes(`本轮起点：${expected}`));
    assert.match(prompt, /REQ-1-1-2、REQ-3-3/);
    assert.match(prompt, /不是本轮单独验收的需求/);
    assert.ok(prompt.includes(loadPrompt("builder", "action-implement")));
    assert.ok(compiled.systemPrompt.includes(loadPrompt("builder", "self-test")));
    if (startingPoint === "inherited_application") assert.match(prompt, /不换栈、不推倒重写/);
    else assert.match(prompt, /最小必要的前序支撑能力/);
  }
});

test("Evolution context reaches implementation and repair modes for each starting point", () => {
  for (const [startingPoint, expected] of [
    ["inherited_application", "已有应用"],
    ["blank_template", "空白通用模板"],
    ["unknown", "未明确；先检查项目目录判断是否已有应用"],
  ] as const) {
    for (const request of [implementRequest(), repairRequest("repair"), repairRequest("root_cause_repair")]) {
      if (request.mode === "delivery_repair") throw new Error("unexpected mode");
      request.projectContext.product.evolution = true;
      request.projectContext.evolution = { startingPoint, externalPrerequisiteIds: ["REQ-1", "REQ-2"] };
      const compiled = compileBuilderPrompt(request);
      const prompt = compiled.taskPrompt;
      assert.match(prompt, /## 增量开发上下文/);
      assert.match(prompt, /当前任务：Evolution\n/);
      assert.ok(prompt.includes(`本轮起点：${expected}`));
      assert.match(prompt, /前序能力 ID：REQ-1、REQ-2/);
      assert.match(prompt, /本工作包是本轮实现范围，验收范围见下方声明/);
      assert.match(prompt, /本轮模块边界验收和最终交付覆盖当前需求树，包括沿用项/);
      assert.match(prompt, /不是本轮单独验收的需求/);
      assert.match(prompt, /改动的原始需求与新增需求/);
      assert.match(prompt, /原功能复用符合当前合同的部分，局部修改变化/);
      assert.match(prompt, /新增功能沿用既有模型和接口补齐完整业务链路/);
      assert.match(prompt, /不能凭旧需求 ID 或前次通过结果跳过核对/);
      assert.ok(compiled.systemPrompt.includes(loadPrompt("builder", "self-test")));
      assert.equal(prompt.includes(loadPrompt("builder", "action-implement")), request.mode === "implement");
      if (startingPoint === "inherited_application") assert.match(prompt, /沿用现有技术栈、模型和接口/);
      else if (startingPoint === "blank_template") assert.match(prompt, /最小必要的前序支撑能力/);
      else assert.match(prompt, /先阅读项目目录、其中适用的 AGENTS\.md、ARCHITECTURE\.md/);
    }
  }
});

test("Evolution and progressive stages share starting-point actions across implementation and repair", () => {
  for (const [startingPoint, assetName] of [
    ["inherited_application", "incremental-start-inherited"],
    ["blank_template", "incremental-start-blank"],
    ["unknown", "incremental-start-unknown"],
  ] as const) {
    for (const request of [implementRequest(), repairRequest("repair"), repairRequest("root_cause_repair")]) {
      if (request.mode === "delivery_repair") throw new Error("unexpected mode");
      request.projectContext.progressiveStage = { index: 2, currentStageTestsOnly: true, startingPoint, externalPrerequisiteIds: [] };
      const stagePrompt = compileBuilderPrompt(request).taskPrompt;
      request.projectContext.evolution = { stageIndex: 2, startingPoint, externalPrerequisiteIds: [] };
      const evolutionPrompt = compileBuilderPrompt(request).taskPrompt;
      const action = loadPrompt("builder", assetName);
      assert.equal(stagePrompt.split(action).length, 2);
      assert.equal(evolutionPrompt.split(action).length, 2);
      assert.match(evolutionPrompt, /当前任务：Evolution；Stage 2/);
      assert.doesNotMatch(evolutionPrompt, /## 分阶段增量上下文/);
      for (const other of ["incremental-start-inherited", "incremental-start-blank", "incremental-start-unknown"]) {
        if (other !== assetName) {
          assert.ok(!stagePrompt.includes(loadPrompt("builder", other)));
          assert.ok(!evolutionPrompt.includes(loadPrompt("builder", other)));
        }
      }
    }
  }
});

test("Evolution context includes a declared stage as optional metadata", () => {
  const request = implementRequest();
  if (request.mode !== "implement") throw new Error("unexpected mode");
  request.projectContext.evolution = { stageIndex: 2, startingPoint: "inherited_application", externalPrerequisiteIds: [] };
  assert.match(compileBuilderPrompt(request).taskPrompt, /当前任务：Evolution；Stage 2/);
});

test("Every Builder mode includes shared handoff and public-entry contracts", () => {
  const architectureNotes = loadPrompt("builder", "architecture-notes");
  for (const request of [implementRequest(), repairRequest("repair"), repairRequest("root_cause_repair"), deliveryRequest()]) {
    const compiled = compileBuilderPrompt(request);
    assert.equal(compiled.systemPrompt.split(architectureNotes).length, 2);
    assert.match(compiled.systemPrompt + compiled.taskPrompt, /需求声明全局页头时/);
    assert.match(compiled.systemPrompt + compiled.taskPrompt, /按需求核对全局控件的作用域/);
    assert.match(compiled.systemPrompt + compiled.taskPrompt, /选定本包实现入口、调用方和测试/);
    assert.match(compiled.systemPrompt + compiled.taskPrompt, /已读且未变化的内容沿用上下文/);
    assert.match(compiled.systemPrompt + compiled.taskPrompt, /修改后按需要重读受影响片段/);
    assert.match(compiled.taskPrompt, /按 ARCHITECTURE\.md 交接约定/);
  }
});

test("Module and consolidated repair prompts bound self-test and maintain architecture handoff notes", () => {
  for (const request of [implementRequest(), repairRequest("repair")]) {
    const compiled = compileBuilderPrompt(request);
    assert.match(compiled.systemPrompt + compiled.taskPrompt, /传统测试/);
    assert.match(compiled.taskPrompt, /ARCHITECTURE\.md/);
    assert.match(compiled.taskPrompt, /不超过十行/);
    assert.doesNotMatch(compiled.taskPrompt, /再重新 `prepare` 并完成关键路径检查/);
  }
});

test("Builder includes all seed data in implementation and both packet repair modes", () => {
  const item = `固定验证码 123456；${"完整预置值。".repeat(400)}末尾标记`;
  for (const request of [implementRequest(), repairRequest("repair"), repairRequest("root_cause_repair")]) {
    if (request.mode === "delivery_repair") throw new Error("unexpected mode");
    request.projectContext.product.seedData = [{ category: "账户预置", items: [item] }];
    const { taskPrompt } = compileBuilderPrompt(request);
    assert.match(taskPrompt, /## 种子数据/);
    assert.match(taskPrompt, /账户预置/);
    assert.ok(taskPrompt.includes(item));
    assert.match(taskPrompt, /内置或可复现/);
    assert.match(taskPrompt, /产品级共享预置/);
  }
  assert.doesNotMatch(compileBuilderPrompt(implementRequest()).taskPrompt, /## 种子数据/);
  assert.doesNotMatch(compileBuilderPrompt(deliveryRequest()).taskPrompt, /## 种子数据/);
});

test("Implementation guidance reaches the Builder as guidance, never as acceptance scenarios", () => {
  const request = implementRequest();
  if (request.mode === "delivery_repair") throw new Error("unexpected mode");
  request.projectContext.product.guidance = ["整体采用深色主题。"];
  request.packet.requirements[0].guidance = ["提交按钮保持醒目。"];
  const { taskPrompt } = compileBuilderPrompt(request);
  assert.ok(taskPrompt.includes("整体采用深色主题。"));
  assert.ok(taskPrompt.includes("提交按钮保持醒目。"));
  assert.equal(taskPrompt.split("实现指引（不可独立验收；按原文融入实现）：").length, 3);

  const without = compileBuilderPrompt(implementRequest()).taskPrompt;
  assert.doesNotMatch(without, /实现指引/);
});

test("Work packet renders the aggregated verbatim seed checklist and omits it when empty", () => {
  const withSeeds = implementRequest();
  if (withSeeds.mode === "delivery_repair") throw new Error("unexpected mode");
  withSeeds.packet.requirements[0].seedDeclarations = [
    'Seed data: shelf "Shelf 4.3.1"',
    'The evaluation seed contains workbook "Q3 Sales" with cell A1 value "Region"',
  ];
  const compiled = compileBuilderPrompt(withSeeds);
  const seeded = compiled.taskPrompt;
  assert.match(seeded, /### 本包初始数据原文摘录/);
  assert.match(seeded, /预置记录须完整播种/);
  assert.match(seeded, /同名对象的互斥初始值分别保留/);
  assert.match(compiled.systemPrompt + compiled.taskPrompt, /不把它们拼成单一默认记录/);
  assert.ok(seeded.includes('- REQ-PROFILE：Seed data: shelf "Shelf 4.3.1"'));
  assert.ok(seeded.includes('- REQ-PROFILE：The evaluation seed contains workbook "Q3 Sales" with cell A1 value "Region"'));

  const withoutSeeds = compileBuilderPrompt(implementRequest()).taskPrompt;
  assert.doesNotMatch(withoutSeeds, /本包初始数据原文摘录/);

  const repaired = compileBuilderPrompt(repairRequest("repair")).taskPrompt;
  assert.doesNotMatch(repaired, /本包初始数据原文摘录/);
});

test("Official spreadsheet seed variants reach their own Builder work packets", async () => {
  const catalog = await loadRequirementCatalog(resolve("data/official-competition/hackathon--sheet/requirements.yaml"));
  for (const [id, clause] of [
    ["REQ-1-1-1", "cell A1 value `Region`"],
    ["REQ-4-1-1", "cells `A1=2`, `B1=3`"],
  ]) {
    const requirement = catalog.requirements.find((item) => item.id === id);
    assert.ok(requirement);
    const request = implementRequest();
    if (request.mode !== "implement") throw new Error("unexpected mode");
    request.packet = { ...request.packet, requirements: [requirement], requirementIds: [id] };
    request.projectContext.product = requirement.product;
    request.projectContext.ancestors = requirement.ancestors;
    const { taskPrompt } = compileBuilderPrompt(request);
    assert.ok(taskPrompt.includes(`- ${id}：The evaluation seed contains`));
    assert.ok(taskPrompt.includes(clause));
    assert.match(taskPrompt, /独立场景中同名对象的互斥初始值分别保留/);
  }
});

test("Repair prompt carries only the cleaned shadow observation", () => {
  const compiled = compileBuilderPrompt(repairRequest("repair"));

  assert.match(compiled.taskPrompt, /# 行动：检查并修复需求偏差/);
  assert.match(compiled.taskPrompt, /category 为 locator 或 precondition 的观测表示需要诊断，目标业务尚未完成验收/);
  assert.match(compiled.taskPrompt, /已通过的用例标识/);
  assert.match(compiled.taskPrompt, /open-page/);
  assert.match(compiled.taskPrompt, /允许使用的失败观测/);
  assert.match(compiled.taskPrompt, /save-profile/);
  assert.match(compiled.taskPrompt, /Expected Saved, received Error/);
  assert.doesNotMatch(compiled.taskPrompt, /"verdict"|(?:^|\s)JSON(?:\s|$)|black-box report/i);
  assert.match(compiled.taskPrompt, /ARCHITECTURE\.md/);
  assert.match(compiled.taskPrompt, /结果：完成 \| 阻塞/);
});

test("Root-cause repair frames the last allowed attempt", () => {
  const compiled = compileBuilderPrompt(repairRequest("root_cause_repair"));

  assert.match(compiled.taskPrompt, /# 行动：执行最后一次根因修复/);
  assert.match(compiled.taskPrompt, /身份认证和权限判断/);
  assert.match(compiled.taskPrompt, /不超过三句话/);
  assert.match(compiled.taskPrompt, /根因/);
  assert.match(compiled.taskPrompt, /结果：完成 \| 阻塞/);
});

test("Both boundary repair rounds and root-cause repair share diagnostic safeguards", () => {
  for (const mode of ["repair", "root_cause_repair"] as const) {
    for (const attempt of [2, 3] as const) {
      const request = repairRequest(mode);
      if (request.mode === "delivery_repair") throw new Error("unexpected mode");
      request.packet.attempt = attempt;
      const compiled = compileBuilderPrompt(request);
      assert.match(compiled.systemPrompt + compiled.taskPrompt, /precondition 表示准备未完成/);
      assert.match(compiled.systemPrompt + compiled.taskPrompt, /locator 表示定位尚需诊断，不能据此认定目标业务失败/);
      assert.match(compiled.systemPrompt + compiled.taskPrompt, /重复控件不得为消除定位歧义而随意重命名、隐藏或删除/);
      if (mode === "repair") {
        assert.match(compiled.taskPrompt, /任务模式：需求修复/);
        assert.doesNotMatch(compiled.taskPrompt, /任务模式：第一次修复/);
      }
    }
  }
});

test("Delivery repair renders the failure without any work packet context", () => {
  const compiled = compileBuilderPrompt(deliveryRequest());

  assert.match(compiled.taskPrompt, /# 行动：修复最终交付故障/);
  assert.match(compiled.taskPrompt, /失败阶段：\nbuild/);
  assert.match(compiled.taskPrompt, /失败命令：\n未提供/);
  assert.match(compiled.taskPrompt, /平台构建命令成功退出并生成生产构建产物/);
  assert.match(compiled.taskPrompt, /实际观察：\nproduction build failed/);
  assert.match(compiled.systemPrompt + compiled.taskPrompt, /用 read 读取其 SKILL.md/);
  assert.match(compiled.taskPrompt, /依次补齐安装、构建、启动、就绪和公开入口检查/);
  assert.match(compiled.taskPrompt, /沿用本轮已成功且输入未变的安装、构建结果/);
  assert.doesNotMatch(compiled.taskPrompt, /当前工作包|delivery-repair/);
  assert.doesNotMatch(compiled.taskPrompt, /REQ-PROFILE/);
  assert.doesNotMatch(
    compiled.taskPrompt,
    /【状态与持久化】|【身份与权限】|【仓库协作业务】|【电子表格业务】/,
  );
  assert.match(compiled.taskPrompt, /结果：完成 \| 阻塞/);
  assert.ok(compiled.taskPrompt.indexOf("cwd=frontend: npm run build") < compiled.taskPrompt.indexOf("实际观察："));
  assert.equal(compiled.taskPrompt.split("cwd=frontend: npm run build").length, 2);
});

test("Startup repairs retain the runtime contract and observed failure", () => {
  const compiled = compileBuilderPrompt(
    repairRequest("repair", {
      applicationStartupFailed: true,
      failures: [
        {
          caseId: "<application>",
          stepIndex: -1,
          category: "runner",
          message: "Application exited before readiness with code 1",
        },
      ],
    }),
  );

  assert.match(compiled.systemPrompt + compiled.taskPrompt, /用 read 读取其 SKILL.md/);
  assert.match(compiled.taskPrompt, /Application exited before readiness/);
});

test("Builder distinguishes the evaluation default from the probe port", () => {
  const request = implementRequest();
  request.applicationContract = minimalWebContract({ port: 3210 });
  const compiled = compileBuilderPrompt(request);
  assert.match(compiled.taskPrompt, /应用读取 PORT 环境变量/);
  assert.match(compiled.taskPrompt, /PORT=3210/);
});

test("Web builder instructions keep static adapter guidance ahead of run-specific ports", () => {
  const instructions = minimalWebContract({ port: 3210 }).builderInstructions!;
  const implementation = instructions.indexOf("## 全新项目的缺省栈");
  const selfTest = instructions.indexOf("## Web 开发检查");
  const runtime = instructions.indexOf("## 项目运行合同");
  assert.ok(implementation >= 0 && selfTest >= 0 && runtime >= 0);
  assert.ok(implementation < runtime && selfTest < runtime);
  assert.ok(instructions.indexOf("PORT=3210") > runtime);
});

test("Builder receives every discovered extra port and omits the clause when there are none", () => {
  const withoutExtra = compileBuilderPrompt(implementRequest());
  assert.doesNotMatch(withoutExtra.taskPrompt, /额外监听/);
  assert.doesNotMatch(withoutExtra.taskPrompt, /为各端口建立独立的服务实例/);

  const request = implementRequest();
  request.applicationContract = minimalWebContract({ port: 3000, extraPorts: [3301, 4400] });
  const compiled = compileBuilderPrompt(request);
  assert.match(compiled.taskPrompt, /3301/);
  assert.match(compiled.taskPrompt, /4400/);
  assert.match(compiled.taskPrompt, /项目声明了额外服务端口/);
  assert.match(compiled.taskPrompt, /SHALLOW_EXTRA_PORTS=0/);
  assert.match(compiled.taskPrompt, /为各端口建立独立的服务实例/);
});

test("FakeBuilder copies only the test fixture app into output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shallow-fake-builder-"));
  try {
    const builder = new FakeBuilder();
    const result = await builder.run({
      ...builderRequest(1),
      outputDir: directory,
    });

    assert.equal(result.outcome, "completed");
    await access(join(directory, "server.mjs"));
    const packageJson = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    assert.equal(packageJson.scripts.start, "node server.mjs");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function implementRequest(): BuilderPromptInput {
  return {
    mode: "implement",
    packet: packetFixture(),
    projectContext: projectContextFixture(),
    outputDir: "C:\\candidate-app",
    applicationContract: contractFixture(),
  };
}

function repairRequest(
  mode: "repair" | "root_cause_repair",
  overrides?: Partial<BuilderShadowObservation>,
): BuilderPromptInput {
  return {
    mode,
    packet: packetFixture(),
    projectContext: projectContextFixture(),
    shadowObservation: {
      packetId: "packet-req-profile",
      passedCaseIds: ["open-page"],
      failures: [
        {
          caseId: "save-profile",
          stepIndex: 3,
          category: "assertion",
          message: "Expected Saved, received Error",
        },
      ],
      applicationStartupFailed: false,
      ...overrides,
    },
    outputDir: "C:\\candidate-app",
    applicationContract: contractFixture(),
  };
}

function deliveryRequest(): BuilderPromptInput {
  return {
    mode: "delivery_repair",
    deliveryFailure: {
      stage: "build",
      expected: "平台构建命令成功退出并生成生产构建产物",
      actual: "production build failed",
    },
    outputDir: "C:\\candidate-app",
    applicationContract: contractFixture(),
  };
}

function projectContextFixture(): BuilderProjectContext {
  return {
    product: {
      kind: "generic_web",
      rootId: "ROOT",
      rootName: "Demo Product",
      description: "Root description.",
      seedData: [],
    },
    ancestors: [
      { id: "PROFILE", name: "Profile", description: "Profile area" },
    ],
    satisfiedDependencies: [
      {
        id: "REQ-BASE",
        name: "Base profile",
        contract: "The base profile stores a name.",
      },
    ],
  };
}

function packetFixture(): WorkPacket {
  return {
    id: "packet-req-profile",
    requirementIds: ["REQ-PROFILE"],
    attempt: 1,
    requirements: [requirementFixture()],
  };
}

function requirementFixture(): AtomicRequirement {
  return {
    id: "REQ-PROFILE",
    folderPath: ["ROOT", "PROFILE"],
    declarationIndex: 0,
    name: "Profile",
    text: "Keep a profile name after refresh.",
    dependencyIds: [],
    scenarios: ["Save a profile\nTHEN: The value remains after refresh."],
    references: ["reference/profile.png"],
    exactUiStrings: ["Profile name", "Save"],
    seedDeclarations: [],
    product: {
      kind: "generic_web",
      rootId: "ROOT",
      rootName: "Demo Product",
      description: "Root description.",
      seedData: [],
    },
    ancestors: [
      { id: "PROFILE", name: "Profile", description: "Profile area" },
    ],
  };
}

function contractFixture(): ApplicationContract {
  return minimalWebContract({ port: 3000, evaluationPort: 3000 }, "linux");
}

function builderRequest(attempt: 1 | 2 | 3): BuilderRequest {
  const packet = { ...packetFixture(), attempt };
  const projectContext = projectContextFixture();
  const outputDir = "C:\\candidate-app";
  const applicationContract = contractFixture();
  if (attempt === 1) {
    return { mode: "implement", packet, projectContext, outputDir, applicationContract };
  }
  return {
    mode: attempt === 2 ? "repair" : "root_cause_repair",
    packet,
    projectContext,
    shadowObservation: {
      packetId: packet.id,
      passedCaseIds: [],
      failures: [
        {
          caseId: "save-profile",
          stepIndex: 3,
          category: "assertion",
          message: "Value did not persist",
        },
      ],
      applicationStartupFailed: false,
    },
    outputDir,
    applicationContract,
  };
}
