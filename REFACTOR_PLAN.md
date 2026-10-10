**Shallow → ShallowCode 重构方案**

目标：在 `E:\my-works\coding\ShallowCode` 建立面向结构化需求的 Web 应用开发与交付智能体，保留需求树、依赖调度、独立浏览器验收和有界修复，将项目执行与比赛平台约定解耦。

迁移依据是 2026-10-09 检查的原项目提交 `6d4cd70`。本文定义首版方案与完成条件；原项目继续承担 ARC 运行职责。

实施进度：批次 A 已提交。批次 B 的项目声明、开发测试、应用环境、数据隔离、工作区副本与补丁导出已实现，并通过 Windows 本地完整回归。批次 C 的 resume/apply 子命令及其增量、交付收敛仍待实现；当前 CLI 的可用参数与产物以 README 为准。真实模型端到端开发任务单独验证。

**1. 首版范围与核心流程**

首版面向 Web 应用，支持按需求创建新应用，以及在已有 Web 项目上开发功能、修复缺陷和重构。保留本地 CLI 和可调用的 TypeScript 入口。已有项目沿用其技术栈与布局；现有 React/Vite/TypeScript + Node 模板作为可运行的初始基线，支持范围由实际项目验证。

主要输入继续是需求目录中的 `requirements.yaml`，保持现有 ROOT/FOLDER/ATOMIC 层级、依赖、需求描述、场景、初始数据和参考图的 schema。Catalog、Scheduler、Builder 和独立 Judge 共同组成需求驱动的开发闭环。

流程为：解析需求树与项目配置 → 展开并校验依赖 → 建立基线与工作区 → 功能分组 → Builder 按包实现 → 安装、构建和开发检查 → 模块边界独立浏览器验收 → 检查点或有界修复 → 当前需求范围最终验收 → 交付代码与逐需求报告。

Builder 负责目标业务代码，控制器负责调度与决策，Judge 根据需求和浏览器观察独立验收。Builder 自述、开发测试回执和构建成功分别作为开发记录，需求取得 verified 必须有完整场景覆盖和实际执行证据。

**2. 保留的核心能力**

| Module | 保留的 Interface 与 Implementation |
| --- | --- |
| Requirements | 保留 RequirementCatalog、AtomicRequirement、WorkPacket、需求原文、祖先合同、场景、数据声明、依赖展开与校验、功能分组和模块边界 |
| Builder | 保留 Pi Worker、BuilderPort、会话和交接、参考图、网关恢复、预算、工具执行统计、进程回收与脱敏 |
| Judge | 保留 ProbePlanner 的 plan/refineLocators/reviewPlan、ProbePlan/ProbeStep、Playwright Runner、严格定位、场景覆盖、语义复核和定位恢复 |
| Workspace 与运行状态 | 保留候选隔离、源码与构建一致性、检查点、失败尝试记录、修复回归及逐需求状态 |

以现有管线和 `src/builder/`、`src/judge/` 为基础，逐项抽离平台装配和固定项目运行约定。沿用现有源码组织，目录调整随实际职责变化推进。控制器继续使用 TypeScript strict ESM / NodeNext 和现有 Pi SDK，依赖升级单独处理。

**3. 主要重构点与源码位置**

| 位置 | 当前约定 | 首版处理 |
| --- | --- | --- |
| `main.py`、`index.ts`、`src/cli.ts` | Python 平台入口、ARCBENCH 环境变量、ARC 合同与事件装配 | 新入口保留需求目录与输出参数，读取独立的项目运行配置 |
| `src/catalog.ts`、`src/types.ts` | 根据特定 ROOT 名称判断 GitHub/Sheet 产品类型 | 保留需求解析语义，以当前需求提供领域上下文，项目运行方式由配置决定 |
| `src/runtime-config.ts:83`、`src/types.ts:94` | install/build/start 固定到 frontend/backend；端口包含比赛兼容约定 | 安装、构建、启动、相对 cwd、环境和就绪检查由 ProjectSpec 描述 |
| `src/git-ops.ts:26`、`:240`、`:283` | 特殊接管 frontend/backend 应用，并按输出仓库历史清理残留 | 接管一般 Web 项目，建立本次工作区所有权；检查点和清理仅操作本次拥有的目录 |
| `src/candidate-runtime.ts`、`src/inherited-data.ts` | 候选运行依赖平台合同；数据位置固定 backend/data 或 backend/.data | 保留候选身份和构建复用，使用声明的数据路径与隔离方式 |
| `src/final-verifier.ts` | 固定 main 角色、health、兼容端口与 grader-like startup | 检查项目声明的启动路径、就绪条件和浏览器入口，具体断言依据项目合同与需求 |
| `src/builder/pi-test-tool.ts`、`pi-app-tool.ts` | 测试固定 frontend Vitest/backend node:test；app 使用平台合同 | run_tests 执行项目登记的测试目标，app 使用同一份 Web 运行配置 |
| `src/builder/pi-worker.ts:39`、`pi-tools.ts` | 上下文自动加载关闭，工具包含平台私有路径约定 | 显式装配项目说明、适用 AGENTS.md 和架构索引；保护本次运行的私有证据与会话 |
| `src/builder/prompt.ts`、`prompt-fragments.ts`、`prompts/` | 固定平台合同、产品分支、种子和阶段文案混合装配 | 保留场景、种子和增量语义，按项目配置装配运行合同，按需求装配 Web 行为指导 |
| `src/arc-protocol.ts`、`progress-journal.ts`、比赛入口和打包脚本 | ARC 投影、平台产物可见性和提交约定 | 继续由原项目维护；新项目使用私有运行目录、通用事件和报告 |

以上描述来自源码检查；重构行为的实现和验证按后面的迁移批次完成。

**4. 需求输入与项目运行配置**

需求节点保持 `id`、`name`、`type`、`description`、`dependencies`、`children`、`scenarios`、`visual_reference`。根节点的 `data` 继续使用 `category` 和 `items`；场景保留名称、可选 ID，以及 steps 中的 keyword/content。现有可选字段和场景 ID 的兼容行为保持一致。

与现有格式一致的 Web 需求示例：

```yaml
id: ROOT
name: 待办应用
type: ROOT
description: 提供待办记录的创建与持久化。
dependencies: []
children:
  - id: F-TODO
    name: 待办记录
    type: FOLDER
    dependencies: []
    children:
      - id: REQ-TODO-CREATE
        name: 添加待办
        type: ATOMIC
        dependencies: []
        description: 用户输入待办内容并点击“添加”，新记录刷新后仍然存在。
        scenarios:
          - name: 添加并保留待办
            steps:
              - keyword: GIVEN
                content: 待办页面已打开，输入框为空。
              - keyword: WHEN
                content: 用户输入“阅读文档”并点击“添加”。
              - keyword: THEN
                content: 列表显示“阅读文档”。
              - keyword: AND
                content: 刷新页面后该条目仍然存在。
```

ProjectSpec 与需求 YAML 分别加载，描述安装和构建命令、开发测试目标、Web 启动命令、环境、浏览器基础地址、就绪条件、依赖输入、生成目录及持久化数据的隔离方式。命令采用 executable、args、项目相对 cwd 和 timeout，不依赖特定目录名称。

先实现这些当前流程需要的配置字段。现有模板提供可用默认配置；已有项目优先采用显式配置，再参考 package.json、README 与 AGENTS.md。不能可靠确定的关键运行信息报告为待补充项。

建议以 `shallowcode.config.json` 保存项目配置。配置、Builder 的 app/run_tests 工具、CandidateRuntime 和 FinalVerifier 使用同一份运行描述。端口按本次运行分配或显式指定，避免占用已被使用的端口。

示意命令，新增参数名称在实现时定稿：

```powershell
npm start -- --requirements-dir E:\requirements\demo --output-dir E:\projects\new-web
npm start -- --requirements-dir E:\requirements\demo --project E:\projects\existing-web
npm start -- plan --requirements-dir E:\requirements\demo --project E:\projects\existing-web
npm start -- resume --run-id <run-id>
npm start -- apply --run-id <run-id>
```

**5. Web Judge 的职责与改动范围**

独立验收继续使用现有浏览器 Planner、白名单 DSL、覆盖校验、Runner、复核和恢复流程。Judge 的输入是当前需求包、祖先合同、必要前置能力、数据声明以及浏览器观察；目标源码、diff 和 Builder 会话保持隔离。

GIVEN 建立并断言初始对象、身份与状态；WHEN 保留需求要求的公开入口与操作；THEN 及其结果段 AND/BUT 全部映射真实断言。保留 `scenarioId/stepIndex/clauseIndex`、准备前缀、严格唯一定位、控件角色和完整对象身份，未执行或无法表达的结果记录为 inconclusive。

浏览器操作 schema 和现有覆盖语义仍适用于首版。Judge 的工程改动集中于获取 Web 基础地址、启动和停止应用、case 数据隔离、计划与证据存储位置，以及与通用项目配置的装配。根据项目配置运行候选后，把其地址交给现有 Runner。

构建、类型检查、项目测试、启动就绪和需求验收分别记账。首页可打开不能替代业务结果检查。模板声明的运行合同与用户需求作为断言依据；既有应用的入口和就绪方式遵循其项目配置。

修复接受前复验已经通过且受影响的路径。共享组件和状态变更检查相关跨页面行为。只有可复现的业务失败进入实现修复；规划、覆盖、准备、定位、执行、网关和预算问题保持明确的 inconclusive 分类。

每条证据关联当前候选身份、源码与构建摘要、项目配置、计划摘要和执行记录。源码、配置或计划改变后，受影响证据失效。计划缓存保持原 ProbePlan schema，缓存键补充需求、项目配置及相关资产的摘要。

**6. 工作区、数据与交付**

已有项目在本次运行拥有的受控副本中开发，记录包括已有未提交源码的输入基线。检查点提交、失败恢复和清理只操作受控副本。原项目的分支、index 和既有改动保持可用。

候选构建继续在独立目录进行，保留依赖安装与构建复用、一致性检查和进程回收。运行日志、Judge 计划、证据与 Pi 会话放在工作区外的 run 目录。Builder 的私有路径保护依据实际目录和权限装配。

各 case 使用隔离的应用数据。根据项目配置复制继承数据，应用自身负责种子补充和迁移。空数据与已有持久化数据分别验证；同一 case 的刷新和新浏览器会话保持其服务端状态。

新项目可以使用现有最小 Web 模板，其端口和服务约定由 ProjectSpec 装配。已有项目沿用原栈、路由和目录。目标项目的说明、适用 AGENTS.md 和简短架构索引进入开发上下文。

完成后输出代码改动、完整补丁、逐需求及逐场景结果、失败与未验证原因。apply 对受影响文件检查输入基线兼容性，再写回目标项目；存在并发冲突时保留补丁和候选副本。

最终交付检查项目声明的安装、构建、启动和浏览器入口，并核对证据对应当前代码版本。交付修复改变代码后重新执行受影响验收。

**7. 增量、恢复与运行状态**

保留 Stage/Phase、Evolution 标记以及 Original/Modified Feature Description 的输入解释。前序能力作为上下文，当前需求依赖按原有规则校验，当前阶段的验收范围保持明确。

增量判断结合显式修改描述、需求及祖先合同摘要、历史需求来源和当前项目基线。历史计划和需求 ID 提供来源，不能授予本轮 verified。沿用项是否回归保持显式策略，跳过项单列。

运行记录保存当前需求树、工作包、场景覆盖、项目配置、输入基线、检查点、预算使用和证据。resume 核对这些输入，可复用未改变的计划，重新执行当前候选的验收。

逐需求状态保留 todo、verified、blocked、failed、inconclusive。delivered 要求当前必要需求全部验证且交付检查通过；partial 展示已完成和未确认部分；failed 记录不能交付的原因。退出码、JSON 汇总和可读报告采用一致语义。

**8. 迁移批次与完成条件**

| 批次 | 交付范围 | 完成条件 |
| --- | --- | --- |
| A：独立迁移与平台解耦 | 迁移原格式 Catalog、调度、Pi 和现有 Web Judge；抽离 ARC 入口、投影和私有产物装配，建立通用日志与报告 | 原 YAML 可直接解析；代表 Web 需求可完成实现与浏览器验收；迁入类型检查和相关测试通过 |
| B：Web 项目运行与工作区 | 引入 ProjectSpec，同步 Builder 工具、候选运行和交付检查；调整项目接管、基线保护、数据隔离及最小模板 | 默认模板和不同目录布局的已有 Web 项目均可运行；原有改动受到保护；空数据和继承数据均有验证 |
| C：增量与交付收敛 | 核对增量与阶段兼容、修复回归、resume、apply、提示词一致性、文档和发布产物 | 当前范围与前序上下文正确区分；恢复可用；写回检查冲突；完整离线回归通过，实模型冒烟单列 |

每批同步源码类型、适用提示词与动态装配、工具合同、运行事件和相关测试。优先使用 Fake Builder/Planner 和本地 Web fixture，实模型运行另行记录。

重点回归覆盖：原格式和祖先合同；文件夹依赖与分组；复合场景结果覆盖；公开入口和初态；严格定位与权限；自定义命令 cwd、端口和就绪条件；已有未提交文件；共享页面修复回归；持久化继承；证据失效；超时取消与进程回收；恢复与 apply 冲突。

代表项目至少覆盖默认模板、单项目目录布局的 Web 应用、带继承数据的已有应用。分别记录开发检查、独立浏览器验收和交付结果。

建议先实施 A+B，让原格式需求树在比赛环境之外完成 Web 开发、场景验收和修复回归闭环，再完成 C 的增量与交付收敛。迁移通用源码、适用提示词、测试与必要配置；历史运行、任务数据、比赛资料、baseline、提交 ZIP、依赖安装目录、生成产物和凭证继续由原项目管理。
