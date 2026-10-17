# AGENTS.md — ShallowCode

项目概览、安装、运行命令与结果解释见 [README.md](README.md)。本文件用于修改控制器、提示词与测试。

## 修改流程

1. 从下方源码索引定位入口与调用方，核对当前源码、配置和相关测试，再确定改动范围。
2. 采用满足当前任务的最小且结构良好的方案；复杂度由当前需求、现有模式、真实失败或明确的简化收益证明。
3. 修改行为时同步其合同、提示词装配与相关测试；共享执行层或平台合同变化时同时检查 baseline。
4. 运行相关验证，交付前执行 `npm run test:all`。报告实际通过、跳过与未验证项，区分本地检查和官方结果。

## 核心约束

### Builder 与 Judge

- Pi Worker 是唯一实现目标应用业务代码的 Builder；控制器只调度、验收及安装任务无关脚手架和批准能力。
- Judge 依据需求与浏览器观察规划和验收，保持与目标源码、diff、Builder 会话及官方测试隔离。Builder 输入通过白名单失败观测装配。
- 控制器的私有证据不放进工作区：运行日志、Judge 计划、证据与 Pi 会话位于工作区外的 run 目录，`pi-tools.ts` 与候选快照据此屏蔽私有路径。`shallow-progress/` 保持 untracked，用于对外可见的进度记录。ARC 事件投影与平台打包约定由原项目维护，本仓库不再生成 `.arc/` 产物。
- Builder 自述、构建成功和历史记录均不能授予 `verified`。历史计划与进度只提供需求 ID 来源，本轮按当前需求重新规划与执行。

### 验收与修复

- 还原完整 GIVEN / WHEN / THEN。全部 THEN、结果段 AND / BUT 及其显式复合子句都须映射实际结果断言；需求 ID 覆盖不能代替场景覆盖。
- `legacy` Judge 使用 `probe-schema.ts` 的白名单 DSL；`active` Checker 使用独立进程中的 QuickJS 程序和声明的 Web 能力。两者均保持原文依据、操作、输入、预期、控件角色和完整对象身份。定位严格唯一；`firstMatch` 只由需求原文明示授权，交互控件保持 role / label 语义。
- Checker 内核消费领域无关的任务、引用和收据；Web 的命令、地址、数据、浏览器和端口由 `checker/adapters/web/` 解释。新能力同步声明、schema、执行绑定与提示词。
- 每个功能组完成后封存独立副本，后台结果只归属原任务、快照和 epoch。模块收口重放最新版本后发布；`producedHead` 与可运行 `acceptedSha` 分开持久化。回滚以集中修复开始时的完整模块为基线，恢复被忽略的输入数据，并保留后续功能组源码。
- 准备前缀须建立并断言初始状态。修改种子或持久化行为时检查空数据与继承数据；同名对象依据归属、父对象与名称区分。
- `acceptedSha` 是可运行检查点，`verified` 是当前候选的独立行为证据。Judge 的规划、定位、执行等故障记 `inconclusive` 并保留可运行实现。
- 保持候选副本、case 数据隔离和源码/构建一致性检查。修复接受前复验既有通过路径；未接受改动恢复检查点，并保留失败尝试历史。
- 最终验收只检测当前验收范围；交付修复改变代码后重新验收。Evolution / Stage 的外部前序依赖只作上下文，跳过沿用项单列，不计作通过。

### 项目配置、提示词与观测

- 项目的安装、构建、开发测试目标、启动命令、环境、就绪条件、依赖输入、生成目录与持久化数据隔离方式由 `shallowcode.config.json`（`ProjectSpec`）声明，与需求 YAML 分开加载；命令使用项目相对 cwd，不依赖 `frontend`/`backend` 之类固定目录名。解析期拒绝绝对路径与 `..` 越界。
- 入口通过 `resolveRuntimeContract` 装配运行合同；评测端口仅在显式预留时存在。Builder 测试与 app、候选及交付检查共享合同，数据路径与注入变量均按声明使用。
- 已有项目通过 `project-workspace.ts` 复制到运行拥有的目录，包含当前 staged 和未跟踪源码。原目录与 Git index 保持不动；GitOps 以显式接管参数操作副本，回滚只恢复该副本的输入检查点。
- `run-record.ts` 保存输入摘要与基线。resume 核对输入和合同，恢复接受检查点并重新验收；apply 核对补丁和受影响文件的完整输入内容后写回，保留用户 index。交付配置须与本轮运行合同一致，需求与参考文件使用私有快照。
- 行为文案放在 `prompts/`。Markdown 资产使用 UTF-8 和 LF，模板 `{{占位符}}` 全部填充。Builder 技能位于 `prompts/skills/<name>/SKILL.md`，用 name/description 描述适用条件，正文按需读取；Pi 只显式加载该目录，技能文件仅允许 read 访问。
- 合同修改核对 Builder、Planner、复核、精化及 baseline 的适用资产和动态装配，而非只改一份 Markdown。
- 新增或调整运行事件同步 `types.ts`、`human-log.ts` 与对应测试；主线观测经 `RunStateStore.record` 发射，诊断使用统一脱敏。

## 源码索引

| 任务 | 优先入口 |
| --- | --- |
| 生产装配、CLI、项目运行配置 | `index.ts`、`bin/shallow.mjs`、`src/cli.ts`、`src/project-spec.ts`、`src/runtime-config.ts` |
| 需求解析、原文阶段分析、依赖、增量范围 | `src/catalog.ts`、`src/requirement-text.ts`、`src/requirement-analysis.ts`、`src/evolution.ts`、`src/scheduler.ts` |
| 功能分组 | `src/feature-grouper.ts`、`src/llm-feature-grouper.ts`、`prompts/planning/feature-grouping.md` |
| 管线、工作区、恢复、写回、交付 | `src/pipeline.ts`、`src/project-workspace.ts`、`src/controller-metadata.ts`、`src/run-record.ts`、`src/candidate-runtime.ts`、`src/git-ops.ts`、`src/final-verifier.ts` |
| Builder 提示词、技能与执行 | `src/builder/prompt.ts`、`skills.ts`、`prompt-builder.ts`、`pi-sdk-adapter.ts`、`pi-worker-client.ts`、`pi-worker.ts`、`pi-tools.ts`（均在 `src/builder/`），`prompts/skills/` |
| Judge 规划、覆盖、恢复与执行 | `src/judge/llm-probe-planner.ts`、`probe-schema.ts`、`probe-coverage.ts`、`audit.ts`、`playwright-probe-runner.ts`（均在 `src/judge/`） |
| Checker 调度、产物、证据与恢复 | `src/checker-pipeline.ts`、`src/snapshot-store.ts`、`src/checker/port.ts`、`queue.ts`、`checkpoints.ts`、`artifacts.ts`、`agent.ts`、`evidence.ts`（后六项在 `src/checker/`） |
| Checker 模型、Web 能力与程序 | `src/checker/model.ts`、`src/checker/adapters/web/`、`prompts/checker/` |
| 事件、日志、进度记录 | `src/types.ts`、`src/run-state.ts`、`src/human-log.ts`、`src/progress-journal.ts`、`src/diagnostics.ts` |
| 模型用量与单价 | `src/model-usage.ts`、`src/builder/pi-execution-stats.ts`、`src/planner-json-client.ts` |
| 继承数据 | `src/inherited-data.ts` |

目标应用的 `ARCHITECTURE.md` 交接合同位于 `prompts/system/architecture-notes.md`；修改跨会话交接时读取该资产。

## 验证

```powershell
npm run typecheck
npm test
npm run test:browser
npm run test:all
```

按改动选择回归入口：

- 需求与分组：`test/catalog.test.ts`、`test/scheduler.test.ts`、`test/feature-grouping.test.ts`、`test/evolution.test.ts`。
- Judge 合同与恢复：`test/probe-contract.test.ts`、`test/semantic-review.test.ts`、`test/locator-recovery.test.ts`、`test/browser/`。
- Checker：`test/checker-core.test.ts`、`test/checker-agent.test.ts`、`test/checker-pipeline.test.ts`、`test/checker-web-runtime.test.ts`、`test/snapshot-store.test.ts` 及 `test/browser/checker-*.test.ts`。
- 管线、工作区与交付：`test/pipeline.e2e.test.ts`、`test/project-workspace.test.ts`、`test/run-record.test.ts`、`test/resume-pipeline.test.ts`、`test/entry.test.ts`、`test/candidate-runtime.test.ts`、`test/final-verifier.test.ts`、`test/inherited-data.test.ts`。
- 提示词与共享执行：`test/builder-prompt.test.ts`、`test/prompt-assets.test.ts`、`test/pi-worker.test.ts`、`test/project-spec.test.ts`。
- 观测：`test/observability.test.ts`、`test/human-log.test.ts`。

真实网关冒烟需显式设置 `RUN_CREDENTIAL_SMOKE=1` 并提供凭证；缺省 skip。没有独立 lint / format 脚本，验证命令以 `package.json` 为准。

## 代码惯例

- TypeScript 使用 strict ESM / NodeNext，相对 import 带 `.js` 后缀。
- 控制器测试使用 `node:test` 和 `node:assert/strict`，经 `tsx --test` 运行；无凭证测试依赖 `test/fakes/`。
- 生产依赖通过现有 port 注入；Fake 属于测试。Builder 的传统开发测试经 `run_tests` 工具执行，工具合同在 `prompts/system/self-test.md`。
