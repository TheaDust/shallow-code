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
- 目标应用仓库的 `.arc/` 与 `shallow-progress/` 对 Builder 屏蔽，回滚保留二者；其中 `shallow-progress/` 保持 untracked 且不 ignore，以便平台打包。保留 `.arc/` 原有事件协议与投影。
- Builder 自述、构建成功和历史记录均不能授予 `verified`。历史计划与进度只提供需求 ID 来源，本轮按当前需求重新规划与执行。

### 验收与修复

- 还原完整 GIVEN / WHEN / THEN。全部 THEN、结果段 AND / BUT 及其显式复合子句都须映射实际结果断言；需求 ID 覆盖不能代替场景覆盖。
- 探针使用 `probe-schema.ts` 的白名单 DSL，保持原文依据、操作、输入、预期、控件角色和完整对象身份。定位严格唯一；`firstMatch` 只由需求原文明示授权，交互控件保持 role / label 语义。
- 准备前缀须建立并断言初始状态。修改种子或持久化行为时检查空数据与继承数据；同名对象依据归属、父对象与名称区分。
- `acceptedSha` 是可运行检查点，`verified` 是当前候选的独立行为证据。Judge 的规划、定位、执行等故障记 `inconclusive` 并保留可运行实现。
- 保持候选副本、case 数据隔离和源码/构建一致性检查。修复接受前复验既有通过路径；未接受改动恢复检查点，并保留失败尝试历史。
- 最终验收只检测当前验收范围；交付修复改变代码后重新验收。Evolution / Stage 的外部前序依赖只作上下文，跳过沿用项单列，不计作通过。

### 平台、提示词与观测

- 主线端口取公共运行合同：`PORT` 缺省 3000、兼容端口 3301，探针避开二者并使用 `ARC_EXTRA_PORTS=0`；交付复验只设 `PORT` 的启动路径。
- 行为文案放在 `prompts/`。Markdown 资产使用 UTF-8 和 LF，模板 `{{占位符}}` 全部填充；新增 fragment 同步 `prompt-fragments.ts` 与测试。
- 合同修改核对 Builder、Planner、复核、精化及 baseline 的适用资产和动态装配，而非只改一份 Markdown。
- 新增或调整运行事件同步 `types.ts`、`human-log.ts` 与对应测试；主线观测经 `RunStateStore.record` 发射，诊断使用统一脱敏。

## 源码索引

| 任务 | 优先入口 |
| --- | --- |
| 生产装配、CLI、平台配置 | `index.ts`、`main.py`、`src/cli.ts`、`src/runtime-config.ts` |
| 需求解析、依赖、增量范围 | `src/catalog.ts`、`src/evolution.ts`、`src/scheduler.ts` |
| 功能分组 | `src/feature-grouper.ts`、`src/llm-feature-grouper.ts`、`prompts/planning/feature-grouping.md` |
| 管线、检查点、回滚、交付 | `src/pipeline.ts`、`src/candidate-runtime.ts`、`src/git-ops.ts`、`src/final-verifier.ts` |
| Builder 提示词与执行 | `src/builder/prompt.ts`、`prompt-builder.ts`、`pi-worker-client.ts`、`pi-worker.ts`、`pi-tools.ts`（均在 `src/builder/`） |
| Judge 规划、覆盖、恢复与执行 | `src/judge/llm-probe-planner.ts`、`probe-schema.ts`、`probe-coverage.ts`、`audit.ts`、`playwright-probe-runner.ts`（均在 `src/judge/`） |
| 事件、日志、平台投影 | `src/types.ts`、`src/run-state.ts`、`src/human-log.ts`、`src/arc-protocol.ts`、`src/progress-journal.ts`、`src/diagnostics.ts` |
| 数据继承与 baseline | `src/inherited-data.ts`、`baseline/index.ts`、`baseline/system.md` |

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
- 管线、候选与交付：`test/pipeline.e2e.test.ts`、`test/candidate-runtime.test.ts`、`test/final-verifier.test.ts`、`test/inherited-data.test.ts`。
- 提示词与共享执行：`test/builder-prompt.test.ts`、`test/prompt-assets.test.ts`、`test/pi-worker.test.ts`、`test/baseline.test.ts`。
- 观测与投影：`test/observability.test.ts`、`test/arc-protocol.test.ts`、`test/human-log.test.ts`。

真实网关冒烟需显式设置 `RUN_CREDENTIAL_SMOKE=1` 并提供凭证；缺省 skip。没有独立 lint / format 脚本，验证命令以 `package.json` 为准。

## 代码惯例

- TypeScript 使用 strict ESM / NodeNext，相对 import 带 `.js` 后缀。
- 控制器测试使用 `node:test` 和 `node:assert/strict`，经 `tsx --test` 运行；无凭证测试依赖 `test/fakes/`。
- 生产依赖通过现有 port 注入；Fake 属于测试。Builder 的传统开发测试经 `run_tests` 工具执行，工具合同在 `prompts/system/self-test.md`。
