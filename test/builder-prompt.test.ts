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
  PlatformContract,
  WorkPacket,
} from "../src/types.js";
import { FakeBuilder } from "./fakes/fake-builder.js";
import { loadPrompt } from "../src/prompt-assets.js";

test("Authorized entry guidance reaches every product and repair mode without mixing domain fragments", () => {
  const accessibleFragment = loadPrompt("fragments", "accessible-web-controls");
  assert.match(accessibleFragment, /仅依赖已确认身份、路由和权限/);
  assert.match(accessibleFragment, /权限未知时先确认/);
  assert.match(accessibleFragment, /身份或对象变化后重新校验/);
  const selfTest = loadPrompt("system", "self-test");
  assert.match(selfTest, /每段点击后立即核对/);
  assert.match(selfTest, /用可控的未完成 Promise 延迟正文或列表响应/);
  assert.match(selfTest, /同步检查已授权入口/);
  assert.match(selfTest, /不能用直点替代需求明确规定的入口/);
  assert.match(selfTest, /分别核对访客和登录用户/);
  assert.match(selfTest, /检查全局控件位于 banner/);
  for (const kind of ["repository_collaboration", "spreadsheet", "generic_web"] as const) {
    for (const request of [implementRequest(), repairRequest("repair"), repairRequest("root_cause_repair")]) {
      assert.ok("packet" in request);
      request.packet.requirements[0].product.kind = kind;
      if (request.projectContext) request.projectContext.product.kind = kind;
      const compiled = compileBuilderPrompt(request);
      const body = compiled.systemPrompt + "\n" + compiled.taskPrompt;
      assert.ok(compiled.taskPrompt.includes(accessibleFragment));
      assert.match(body, /继承应用中的公共组件拷贝/);
      assert.match(body, /管理型对话框保存后先呈现更新的列表/);
      assert.match(body, /同一失败表单上下文/);
      assert.match(body, /完整的数值与实体单位文字/);
      assert.match(body, /全局控件在首页、登录后及实体详情/);
      assert.match(body, /默认状态也写入地址/);
      assert.match(body, /150ms、500ms 和失败分支/);
      assert.ok(compiled.systemPrompt.includes(selfTest));
      assert.match(compiled.systemPrompt, /全局页头使用顶层 `<header>`（banner）/);
      assert.match(compiled.systemPrompt, /与唯一的 `<main>` 主内容区并列/);
      assert.match(compiled.systemPrompt, /页面入口依据已确认的身份与权限呈现，不等待无关数据/);
      assert.match(compiled.systemPrompt, /依赖未就绪数据的操作保留控件并暂时禁用/);
      assert.match(compiled.systemPrompt, /脚手架混合 Combobox 分别用浏览器原生 selectOption/);
      assert.match(compiled.systemPrompt, /专用 ARIA combobox 按需求核对输入、可见 option 与选择结果/);
      assert.match(compiled.systemPrompt, /传统测试分别检查原生 disabled、非原生 aria-disabled 及实际操作效果/);
      assert.match(compiled.systemPrompt, /真实浏览器用 toBeDisabled\/toBeEnabled 检查禁用和恢复/);
      const repositoryFragment = loadPrompt("fragments", "repository-collaboration");
      assert.equal(body.includes(repositoryFragment), kind === "repository_collaboration");
      if (kind === "repository_collaboration") {
        assert.match(body, /登录入口的角色、名称和容器以当前需求为准/);
        assert.match(body, /先识别已知旧 ID 与关联引用/);
        assert.match(body, /工作台提供当前身份可见的组织和可读仓库的具名入口/);
        assert.match(body, /本包实现组织或仓库功能且提供登录工作台时/);
        assert.match(body, /已登录身份与本页规定的具名对象入口一起就绪/);
        assert.match(body, /同时保留需求规定的账户菜单、列表和搜索路径/);
        assert.match(body, /身份或权限变化后重新核对列表/);
        assert.match(body, /权限已确认且不依赖列表内容的创建入口也独立呈现/);
        assert.match(body, /后台继续校验每次读取和写入的权限/);
        assert.match(body, /先通过项目路由工具完成导航，再关闭菜单/);
        assert.match(body, /在正式构建的应用中从首页登录，逐段检查/);
      }
      if (kind === "spreadsheet") {
        assert.match(body, /按坐标提供可访问名称/);
        assert.match(body, /条件格式检查实际计算背景色/);
        assert.match(body, /明确的范围与列配置/);
        assert.match(body, /先识别已知旧 ID 与关联引用/);
      }
    }
  }
});

test("Builder prompt compiles a Chinese system contract and dynamic task prompt", () => {
  const compiled = compileBuilderPrompt(implementRequest());

  assert.match(compiled.systemPrompt, /唯一代码实现者/);
  assert.match(compiled.systemPrompt, /Builder 开发检查/);
  assert.match(compiled.systemPrompt, /传统测试/);
  assert.match(compiled.systemPrompt, /保留种子数据/);
  assert.match(compiled.systemPrompt, /释放进程/);
  assert.doesNotMatch(compiled.systemPrompt, /MCP/);
  assert.match(compiled.systemPrompt, /SHALLOW_DATA_DIR/);
  assert.match(compiled.systemPrompt, /持续增量扩展/);
  assert.match(compiled.systemPrompt, /必要的开发检查/);
  assert.match(compiled.systemPrompt, /全新的独立会话/);
  assert.match(compiled.systemPrompt, /唯一交接面/);
  assert.match(compiled.systemPrompt, /复杂或边界逻辑必须编写传统测试并用 run_tests 运行/);
  assert.match(compiled.systemPrompt, /browser 是昂贵工具/);
  assert.match(compiled.systemPrompt, /清晰稳定的模块与接口边界/);
  assert.match(compiled.systemPrompt, /延续既有栈，不得换栈重写/);
  assert.match(compiled.systemPrompt, /通用最小脚手架只建立 React\/Vite\/TypeScript/);
  assert.match(compiled.systemPrompt, /不代表任何业务需求已经实现/);
  assert.match(compiled.systemPrompt, /frontend\/src\/ui/);
  assert.match(compiled.systemPrompt, /list_capabilities/);
  assert.match(compiled.systemPrompt, /install_capability/);
  assert.match(compiled.systemPrompt, /React \+ Vite \+ TypeScript/);
  assert.match(compiled.systemPrompt, /hash 路由/);
  assert.match(compiled.systemPrompt, /必须使用 HashRouter/);
  assert.match(compiled.systemPrompt, /@testing-library\/react/);
  assert.match(compiled.systemPrompt, /按其所属控件或文本逐字实现/);
  assert.match(compiled.systemPrompt, /不得缩写、加长、同义替换或翻译/);
  assert.match(compiled.systemPrompt, /共享种子及按场景区分的初始条件/);
  assert.match(compiled.systemPrompt, /明确列为预置或既有的实体/);
  assert.match(compiled.systemPrompt, /logo 等返回首页入口的角色和可访问名以需求明示为准/);
  assert.match(compiled.systemPrompt, /等待期间给出忙碌状态并防止重复操作/);
  assert.match(compiled.taskPrompt, /浏览器未执行/);
  assert.match(compiled.taskPrompt, /未执行/);
  assert.match(compiled.taskPrompt, /需求核对/);
  assert.doesNotMatch(compiled.systemPrompt, /REQ-PROFILE/);
  assert.match(compiled.taskPrompt, /# 行动：实现当前工作包/);
  assert.match(compiled.taskPrompt, /先规划，再实施/);
  assert.match(compiled.taskPrompt, /严格符合需求文档/);
  assert.match(compiled.taskPrompt, /覆盖本包每条需求和场景新增的具体约束/);
  assert.match(compiled.taskPrompt, /按需求 ID 和场景名或序号/);
  assert.match(compiled.taskPrompt, /在同一实施计划中列出每个新场景实际依赖的既有前置/);
  assert.match(compiled.taskPrompt, /实施前用相关既有测试或最小公开交互逐项检查现状/);
  assert.match(compiled.taskPrompt, /尚未实现或尚未验证的场景约束/);
  assert.match(compiled.taskPrompt, /完整业务链路/);
  assert.match(compiled.systemPrompt, /不能为示例输入、账号或断言硬编码结果/);
  assert.match(compiled.taskPrompt, /ARCHITECTURE\.md/);
  assert.match(compiled.taskPrompt, /REQ-PROFILE/);
  assert.match(compiled.taskPrompt, /Root description/);
  assert.match(compiled.taskPrompt, /Profile area/);
  assert.match(compiled.taskPrompt, /Keep a profile name after refresh\./);
  assert.match(compiled.taskPrompt, /The value remains after refresh\./);
  assert.match(compiled.taskPrompt, /reference\/profile\.png/);
  assert.match(compiled.taskPrompt, /Profile name \| Save/);
  assert.match(compiled.taskPrompt, /引号原词（须按原文区分界面名称、数据值与示例）/);
  assert.match(compiled.taskPrompt, /输入控件使用符合用途的原生类型/);
  assert.match(compiled.taskPrompt, /优先使用脚手架混合 Combobox/);
  assert.match(compiled.taskPrompt, /不只依赖浏览器原生校验气泡/);
  assert.match(compiled.taskPrompt, /同名操作可以重复/);
  assert.match(compiled.taskPrompt, /打开对象的方式依需求/);
  assert.match(compiled.taskPrompt, /<h1>–<h6>/);
  assert.match(compiled.taskPrompt, /要求 menu\/menuitem 时提供相应角色与键盘行为/);
  assert.match(compiled.taskPrompt, /按需求使用 table、row、cell/);
  assert.match(compiled.taskPrompt, /使用 status 或 alert/);
  assert.match(compiled.taskPrompt, /禁用的原生控件用 disabled/);
  assert.match(compiled.taskPrompt, /对话框有可访问名称/);
  assert.match(compiled.taskPrompt, /需求或场景要求悬停显示的次要操作应在悬停后出现/);
  assert.match(compiled.taskPrompt, /可访问的 option、radio、checkbox/);
  assert.match(compiled.taskPrompt, /背景不可操作/);
  assert.match(compiled.taskPrompt, /npm --prefix frontend run build/);
  assert.match(compiled.taskPrompt, /http:\/\/127\.0\.0\.1:3000/);
  assert.match(compiled.taskPrompt, /PORT/);
  assert.match(compiled.taskPrompt, /同源相对路径/);
  assert.doesNotMatch(compiled.taskPrompt, /SECRET-OTHER-REQ/);
  assert.doesNotMatch(compiled.taskPrompt, /acceptedSha|global budget|\/workspace\/tests/i);
  // 技术栈缺省（React+Vite）只出现在固定系统合同里；任务模板不向既有项目推销换栈
  assert.doesNotMatch(compiled.taskPrompt, /use React|use Vue/i);
  assert.deepEqual(compiled.fragmentIds, [
    "accessible_web_controls",
    "server_persistence",
  ]);
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
    assert.match(compiled.systemPrompt, /逐场景还原 GIVEN/);
    assert.match(compiled.systemPrompt, /逐场景核对 GIVEN、准备、WHEN 操作和全部 THEN 结果/);
    assert.ok(compiled.taskPrompt.includes(`Path ${index}`));
    assert.ok(compiled.taskPrompt.includes(`Contract ${index}`));
    assert.ok(compiled.taskPrompt.includes(`Packet evidence ${index}.`));
    assert.ok(compiled.taskPrompt.includes(`工作包编号：packet-${index}`));
    assert.ok(compiled.taskPrompt.includes(`当前尝试：${index + 1}`));
    return compiled;
  });
  const boundary = prompts[0].taskPrompt.indexOf("当前功能路径：");
  assert.ok(boundary > 0);
  const prefix = prompts[0].taskPrompt.slice(0, boundary);
  assert.ok(prefix.includes("Root description."));
  assert.ok(prefix.includes("shared account alice"));
  assert.ok(prefix.includes("npm --prefix frontend run build"));
  assert.ok(prefix.includes("结果：完成 | 阻塞"));
  for (const prompt of prompts) {
    assert.equal(prompt.systemPrompt, prompts[0].systemPrompt);
    assert.ok(prompt.taskPrompt.startsWith(prefix));
    assert.equal(prompt.taskPrompt.split("npm --prefix frontend run build").length, 2);
  }
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
    assert.match(prompt, /当前阶段：Stage 3/);
    assert.ok(prompt.includes(`本轮起点：${expected}`));
    assert.match(prompt, /REQ-1-1-2、REQ-3-3/);
    assert.match(prompt, /不是本轮单独验收的需求/);
    assert.ok(prompt.includes(loadPrompt("system", "action-implement")));
    assert.ok(compiled.systemPrompt.includes(loadPrompt("system", "self-test")));
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
      assert.ok(compiled.systemPrompt.includes(loadPrompt("system", "self-test")));
      assert.equal(prompt.includes(loadPrompt("system", "action-implement")), request.mode === "implement");
      if (startingPoint === "inherited_application") assert.match(prompt, /沿用现有技术栈、模型和接口/);
      else if (startingPoint === "blank_template") assert.match(prompt, /最小必要的前序支撑能力/);
      else assert.match(prompt, /先检查 frontend、backend、ARCHITECTURE\.md/);
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
      const action = loadPrompt("system", assetName);
      assert.equal(stagePrompt.split(action).length, 2);
      assert.equal(evolutionPrompt.split(action).length, 2);
      assert.match(evolutionPrompt, /当前任务：Evolution；Stage 2/);
      assert.doesNotMatch(evolutionPrompt, /## 分阶段增量上下文/);
      for (const other of ["incremental-start-inherited", "incremental-start-blank", "incremental-start-unknown"]) {
        if (other !== assetName) {
          assert.ok(!stagePrompt.includes(loadPrompt("system", other)));
          assert.ok(!evolutionPrompt.includes(loadPrompt("system", other)));
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
  const architectureNotes = loadPrompt("system", "architecture-notes");
  for (const request of [implementRequest(), repairRequest("repair"), repairRequest("root_cause_repair"), deliveryRequest()]) {
    const compiled = compileBuilderPrompt(request);
    assert.equal(compiled.systemPrompt.split(architectureNotes).length, 2);
    assert.match(compiled.systemPrompt, /全局页头使用顶层 `<header>`（banner）/);
    assert.match(compiled.systemPrompt, /检查全局控件位于 banner/);
    assert.match(compiled.systemPrompt, /选定本包实现入口、调用方和测试/);
    assert.match(compiled.systemPrompt, /已读且未变化的内容沿用上下文/);
    assert.match(compiled.systemPrompt, /修改后按需要重读受影响片段/);
    assert.match(compiled.taskPrompt, /按 ARCHITECTURE\.md 交接约定/);
  }
});

test("Module and consolidated repair prompts bound self-test and maintain architecture handoff notes", () => {
  for (const request of [implementRequest(), repairRequest("repair")]) {
    const compiled = compileBuilderPrompt(request);
    assert.match(compiled.systemPrompt, /传统测试/);
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
  assert.match(compiled.systemPrompt, /不把它们拼成单一默认记录/);
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
  assert.doesNotMatch(compiled.taskPrompt, /"verdict"|JSON|black-box report/i);
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
      assert.match(compiled.systemPrompt, /precondition 表示准备未完成/);
      assert.match(compiled.systemPrompt, /locator 表示定位尚需诊断，不能据此认定目标业务失败/);
      assert.match(compiled.systemPrompt, /重复控件不得为消除定位歧义而随意重命名、隐藏或删除/);
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
  assert.match(compiled.taskPrompt, /【交付合同】/);
  assert.match(compiled.taskPrompt, /依次补齐安装、构建、探针端口启动、健康检查和根页面访问/);
  assert.match(compiled.taskPrompt, /沿用本轮已成功且输入未变的安装、构建结果/);
  assert.doesNotMatch(compiled.taskPrompt, /当前工作包|delivery-repair/);
  assert.doesNotMatch(compiled.taskPrompt, /REQ-PROFILE/);
  assert.doesNotMatch(
    compiled.taskPrompt,
    /【状态与持久化】|【身份与权限】|【仓库协作业务】|【电子表格业务】/,
  );
  assert.deepEqual(compiled.fragmentIds, ["delivery_contract"]);
  assert.match(compiled.taskPrompt, /结果：完成 \| 阻塞/);
  assert.ok(compiled.taskPrompt.indexOf("npm --prefix frontend run build") < compiled.taskPrompt.indexOf("实际观察："));
  assert.equal(compiled.taskPrompt.split("npm --prefix frontend run build").length, 2);
});

test("Startup failures append the delivery contract on top of the product base", () => {
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

  assert.match(compiled.taskPrompt, /【交付合同】/);
  assert.match(compiled.taskPrompt, /【状态与持久化】/);
  assert.match(compiled.taskPrompt, /Application exited before readiness/);
});

test("Builder distinguishes the evaluation default from the probe port", () => {
  const request = implementRequest();
  request.platformContract.port = 3210;
  request.platformContract.baseUrl = "http://127.0.0.1:3210";
  const compiled = compileBuilderPrompt(request);
  assert.match(compiled.taskPrompt, /未设置时使用 3000/);
  assert.match(compiled.taskPrompt, /PORT=3210/);
});

test("Builder receives every discovered extra port and omits the clause when there are none", () => {
  const withoutExtra = compileBuilderPrompt(implementRequest());
  assert.doesNotMatch(withoutExtra.taskPrompt, /额外监听/);
  assert.doesNotMatch(withoutExtra.taskPrompt, /ERR_SERVER_ALREADY_LISTEN/);

  const request = implementRequest();
  request.platformContract.extraPorts = [3301, 4400];
  const compiled = compileBuilderPrompt(request);
  assert.match(compiled.taskPrompt, /3301/);
  assert.match(compiled.taskPrompt, /4400/);
  assert.match(compiled.taskPrompt, /所有端口服务同一个应用/);
  assert.match(compiled.taskPrompt, /ARC_EXTRA_PORTS=0/);
  assert.match(compiled.taskPrompt, /ERR_SERVER_ALREADY_LISTEN/);
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
    platformContract: contractFixture(),
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
    platformContract: contractFixture(),
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
    platformContract: contractFixture(),
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

function contractFixture(): PlatformContract {
  return {
    baseUrl: "http://127.0.0.1:3000",
    port: 3000,
    evaluationPort: 3000,
    installCommands: [
      { executable: "npm", args: ["install"], cwd: "frontend" },
    ],
    buildCommands: [
      { executable: "npm", args: ["run", "build"], cwd: "frontend" },
    ],
    startCommand: {
      executable: "npm",
      args: ["run", "start"],
      cwd: "backend",
    },
    healthPath: "/health",
    buildTimeoutMs: 120_000,
    startTimeoutMs: 30_000,
  };
}

function builderRequest(attempt: 1 | 2 | 3): BuilderRequest {
  const packet = { ...packetFixture(), attempt };
  const projectContext = projectContextFixture();
  const outputDir = "C:\\candidate-app";
  const platformContract = contractFixture();
  if (attempt === 1) {
    return { mode: "implement", packet, projectContext, outputDir, platformContract };
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
    platformContract,
  };
}
