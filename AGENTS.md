# AGENTS.md — ShallowCode

项目概览、安装、运行命令与结果解释见 [README.md](README.md)。本文件用于修改控制器、提示词与测试。

## 修改流程

1. 从下方源码索引定位入口与调用方，核对当前源码、配置和相关测试，再确定改动范围。
2. 采用满足当前任务的最小且结构良好的方案；复杂度由当前需求、现有模式、真实失败或明确的简化收益证明。
3. 修改行为时同步其合同、提示词装配与相关测试；共享执行层或平台合同变化时同时检查 baseline。
4. 运行相关验证，交付前执行 `npm run test:all`。报告实际通过、跳过与未验证项，区分本地检查和官方结果。

## 核心约束

### Grouper、Builder 与 Verifier

- 三类模型角色统一命名为 Grouper / Builder / Verifier，默认环境前缀分别为 `SHALLOW_GROUPER_*` / `SHALLOW_BUILDER_*` / `SHALLOW_VERIFIER_*`，三者均可独立配置网关、模型与单价。
- Grouper 负责功能分组；Pi Worker 是唯一实现目标应用业务代码的 Builder；控制器只调度、验收及安装任务无关脚手架和批准能力。
- Verifier 探索可只读查询当前封存快照的实现文件结构与片段用于定位；预期来自需求，验收来自实际观察。独立语义复核不接触目标源码，全部 Verifier 会话与 diff、Builder 会话及官方测试隔离。Builder 输入通过白名单失败观测装配。
- 控制器的私有证据不放进工作区：运行日志、Verifier 合同、程序、证据与 Pi 会话位于工作区外的 run 目录，`pi-tools.ts` 与候选快照据此屏蔽私有路径。`shallow-progress/` 保持 untracked，用于对外可见的进度记录。ARC 事件投影与平台打包约定由原项目维护，本仓库不再生成 `.arc/` 产物。
- Builder 自述、构建成功和历史记录均不能授予 `verified`。历史计划与进度只提供需求 ID 来源，本轮按当前需求重新规划与执行。

### 验收与修复

- 还原完整 GIVEN / WHEN / THEN。全部 THEN、结果段 AND / BUT 及其显式复合子句都须映射实际结果断言；需求 ID 覆盖不能代替场景覆盖。
- Verifier 是唯一验收入口，任务绑定快照、执行声明和初态。Web 使用独立进程中的 QuickJS 与受控浏览器能力，使用接近原生的 Playwright 定位器与事件对象，保持原文依据、完整身份、严格唯一定位及需求明确规定的 role / label 语义。隔离、权限与证据集中在 Web 执行器；读取返回宿主观察，动作通过 check.action 绑定 checkpoint。
- Verifier 内核消费领域无关的任务、引用和收据；应用合同与候选位于 `application/`；Web 的命令、HTTP 就绪、端口和 Builder 能力由 `adapters/web/` 解释，Web 验收能力由 `verifier/adapters/web/` 解释。新能力同步声明、schema、执行绑定与提示词。
- 每个功能组完成后封存独立副本，后台结果只归属原任务、快照和 epoch。语义复核与历史程序重放分别由 `SHALLOW_VERIFIER_SEMANTIC_REVIEW`、`SHALLOW_VERIFIER_REPLAY` 控制，缺省关闭；关闭重放时汇总功能组原快照的执行证据，开启时在模块与最终版本重放。`producedHead` 与可运行 `acceptedSha` 分开持久化。回滚以集中修复开始时的完整模块为基线，恢复被忽略的输入数据，并保留后续功能组源码。
- 准备前缀须建立并断言初始状态。修改种子或持久化行为时检查空数据与继承数据；同名对象依据归属、父对象与名称区分。
- `acceptedSha` 是可运行检查点，`verified` 来自报告所标注检查快照的行为证据；跨快照汇总不授予最终版本的全量重验标记。关闭语义复核仍须校验合同与执行证据，复核批准缓存仅由真实复核写入。Verifier 的探索、复核和执行等故障记 `inconclusive` 并保留可运行实现。
- 保持候选副本、case 数据隔离和源码/构建一致性检查。修复接受前验收修复范围；开启历史重放时同时复验既有通过路径。未接受改动恢复检查点，并保留失败尝试历史。
- 最终结果只覆盖当前验收范围；交付修复后检查运行合同，行为重验遵循历史重放开关。Evolution / Stage 的外部前序依赖只作上下文，跳过沿用项单列，不计作通过。

### 项目配置、提示词与观测

- 项目的安装、构建、开发测试目标、启动命令、环境、就绪条件、依赖输入、生成目录与持久化数据隔离方式由 `shallowcode.config.json`（`ProjectSpec`）声明，与需求 YAML 分开加载；命令使用项目相对 cwd，不依赖 `frontend`/`backend` 之类固定目录名。解析期拒绝绝对路径与 `..` 越界。
- 入口通过应用适配器注册表装配 `ApplicationContract`，核心只传递适配器配置；评测端口仅在显式预留时存在。Builder 测试与 app、候选及交付检查共享合同，数据路径与注入变量均按声明使用。
- 已有项目通过 `project-workspace.ts` 复制到运行拥有的目录，包含当前 staged 和未跟踪源码。原目录与 Git index 保持不动；GitOps 以显式接管参数操作副本，回滚只恢复该副本的输入检查点。
- `run-record.ts` 保存输入摘要与基线。resume 核对输入和合同，恢复接受检查点并重新验收；apply 核对补丁和受影响文件的完整输入内容后写回，保留用户 index。交付配置须与本轮运行合同一致，需求与参考文件使用私有快照。
- 行为文案放在 `prompts/`。Markdown 资产使用 UTF-8 和 LF，模板 `{{占位符}}` 全部填充。Builder 通用技能位于 `prompts/skills/<name>/SKILL.md`，Web 技能位于 `prompts/adapters/web/skills/<name>/SKILL.md`，用 name/description 描述适用条件，正文按需读取；Pi 只显式加载通用目录及选定适配器的技能目录，技能文件仅允许 read 访问。
- 合同修改核对 Grouper、Builder、Verifier 探索与复核及适用的共享执行调用方的适用资产和动态装配，而非只改一份 Markdown。
- 通用 Builder 与 Verifier 提示词只保留领域无关流程。Web 专用语法、定位、浏览器事件与证据解释放在 `prompts/adapters/web/` 或 `prompts/verifier/web/`，经运行适配器初始化指令或 Verifier 声明的 prompts 装配。动作能力按通用浏览器机制与证据需求定义，对象与路径由当前需求及实际观察确定，业务预期以需求原文为准。
- 新增或调整运行事件同步 `types.ts`、`human-log.ts` 与对应测试；主线观测经 `RunStateStore.record` 发射，诊断使用统一脱敏。

## 源码索引

| 任务 | 优先入口 |
| --- | --- |
| 生产装配、CLI、项目运行配置 | `index.ts`、`bin/shallow.mjs`、`src/cli.ts`、`src/project-spec.ts`、`src/runtime-config.ts` |
| 需求解析、原文阶段分析、依赖、增量范围 | `src/catalog.ts`、`src/requirement-text.ts`、`src/requirement-analysis.ts`、`src/evolution.ts`、`src/scheduler.ts` |
| 功能分组、Pi Grouper 与网关恢复 | `src/feature-grouper.ts`、`src/llm-feature-grouper.ts`、`src/feature-grouping-tools.ts`、`prompts/grouper/feature-grouping.md` |
| 管线、工作区、恢复、写回、交付 | `src/pipeline.ts`、`src/project-workspace.ts`、`src/controller-metadata.ts`、`src/run-record.ts`、`src/application/candidate-runtime.ts`、`src/git-ops.ts` |
| Builder 提示词、技能与执行 | `src/builder/prompt.ts`、`skills.ts`、`prompt-builder.ts`、`pi-sdk-adapter.ts`、`pi-worker-client.ts`、`pi-worker.ts`、`pi-tools.ts`（均在 `src/builder/`），`prompts/builder/`、`prompts/skills/` |
| 应用适配、配置、运行与 Builder 能力 | `src/application/port.ts`、`registry.ts`、`candidate-runtime.ts`；`src/adapters/web/`；注册装配 `src/adapters/index.ts`、`src/adapters/verifier.ts` |
| Verifier 调度、产物、证据与恢复 | `src/verifier-pipeline.ts`、`src/snapshot-store.ts`、`src/verifier/port.ts`、`queue.ts`、`checkpoints.ts`、`artifacts.ts`、`agent.ts`、`evidence.ts`（后六项在 `src/verifier/`） |
| Verifier 模型、源码索引、Web 能力与程序 | `src/verifier/model.ts`、`src/verifier/source-index.ts`、`src/verifier/adapters/web/`（权限与原生调用见 `playwright-interface.ts`）、`prompts/verifier/` |
| 事件、日志、进度记录 | `src/types.ts`、`src/run-state.ts`、`src/human-log.ts`、`src/progress-journal.ts`、`src/diagnostics.ts` |
| Grouper / Builder / Verifier 的网关重试、SSE、取消与故障分类 | `src/pi-gateway.ts`、`src/gateway-failure.ts`、`src/gateway-recovery.ts`、`src/builder/sse-resilience.ts` |
| 角色名称、模型配置、用量与单价 | `src/agent-config.ts`、`src/model-usage.ts`、`src/builder/pi-execution-stats.ts` |
| 继承数据 | `src/inherited-data.ts` |

目标应用的 `ARCHITECTURE.md` 交接合同位于 `prompts/builder/architecture-notes.md`；修改跨会话交接时读取该资产。

## 验证

```powershell
npm run typecheck
npm test
npm run test:browser
npm run test:all
```

按改动选择回归入口：

- 需求与分组：`test/catalog.test.ts`、`test/scheduler.test.ts`、`test/feature-grouping.test.ts`、`test/pi-feature-grouper.test.ts`、`test/evolution.test.ts`。
- 应用适配与运行：`test/application.test.ts`、`test/application-boundaries.test.ts`、`test/web-runtime.test.ts`、`test/project-spec.test.ts`、`test/candidate-runtime.test.ts`。
- Verifier：`test/verifier-core.test.ts`、`test/verifier-agent.test.ts`、`test/verifier-pipeline.test.ts`、`test/verifier-entry.test.ts`、`test/verifier-web-runtime.test.ts`、`test/snapshot-store.test.ts` 及 `test/browser/verifier-*.test.ts`。
- 管线、工作区与交付：`test/project-workspace.test.ts`、`test/run-record.test.ts`、`test/entry.test.ts`、`test/candidate-runtime.test.ts`、`test/inherited-data.test.ts`。
- 提示词与共享执行：`test/builder-prompt.test.ts`、`test/prompt-assets.test.ts`、`test/pi-worker.test.ts`、`test/project-spec.test.ts`。
- 观测：`test/observability.test.ts`、`test/human-log.test.ts`。

真实网关冒烟需显式设置 `RUN_CREDENTIAL_SMOKE=1` 并提供凭证；缺省 skip。没有独立 lint / format 脚本，验证命令以 `package.json` 为准。

## 代码惯例

- TypeScript 使用 strict ESM / NodeNext，相对 import 带 `.js` 后缀。
- 控制器测试使用 `node:test` 和 `node:assert/strict`，经 `tsx --test` 运行；无凭证测试依赖 `test/fakes/`。
- 生产依赖通过现有 port 注入；Fake 属于测试。Builder 的传统开发测试经 `run_tests` 工具执行，工具合同在 `prompts/builder/self-test.md`。
- 对提示词资产的改动原则上保持最长固定前缀
