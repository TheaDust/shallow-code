# ShallowCode

ShallowCode 是面向结构化需求的 Web 应用开发与交付智能体。它读取需求树，按依赖和功能分组交给 Pi Builder 实现，再由独立浏览器 Judge 验收，管理可运行检查点、修复回归和交付结果。

需求输入沿用 `requirements.yaml` 的 ROOT/FOLDER/ATOMIC、祖先描述、依赖、场景、数据声明、实现指引（`guidance`）和参考图。项目运行方式由独立的 `shallowcode.config.json` 声明。

**运行流程**

需求解析与依赖校验 → 功能分组 → 实现与开发检查 → 候选安装、构建和启动 → 模块边界浏览器验收 → 有界修复与回归 → 当前范围最终验收 → 交付检查。

Builder 是目标业务代码的唯一实现者。Judge 依据需求及浏览器观察工作，与目标源码、diff、Builder 会话和自述隔离。构建成功、开发测试通过和需求获得 `verified` 分别记账。

**安装与网关配置**

需要 Node.js >=22.19.0、npm、Git 和 Playwright Chromium。控制器依赖版本由锁文件固定。clone 后在仓库根运行一键安装脚本（跨平台，Node 实现）：

```powershell
git clone <仓库地址> ShallowCode
cd ShallowCode
npm.cmd run setup
```

脚本依次安装仓库根与 requirements-agent 的依赖、下载 Playwright Chromium、从 `.env.example` 初始化 `.env`（已存在则保留）并注册全局 `shallow` 命令；`--check` 只检查环境并打印计划，`--skip-browser` 跳过 Chromium 下载。手动执行时依次运行 `npm ci`、`requirements-agent` 目录内的 `npm ci`、`npx playwright install chromium`、复制 `.env.example` 为 `.env` 与 `npm link`。

在仓库 `.env` 或进程环境中配置 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`MODEL`，真实环境变量优先。凭证用于控制器和 Pi Worker 的模型请求。Builder 与 Judge（规划/验收）可分别用 `SHALLOW_BUILDER_*`、`SHALLOW_JUDGE_*` 覆盖 API key、地址与模型（字段级回退公共值）；[requirements-agent](requirements-agent/README.md) 读取同一份仓库根 `.env`，用 `REQUIREMENTS_AGENT_*` 单独覆盖。网关为 opencode.ai（Zen/Go）时，控制器与 requirements-agent 会自动附带该网关要求的 `x-opencode-session` 会话头。模型单价（USD / 百万 token）缺省按网关地址与模型 id 匹配 pi-ai 内置目录的标价，可用 `MODEL_COST_INPUT/OUTPUT/CACHE_READ/CACHE_WRITE` 或 `<组件>_COST_*` 按字段覆盖；目录与配置均无价格时只统计 token。

Pi 通过 `CodingAgentPort` 在独立 Worker 中执行。[pi-sdk-adapter.ts](src/builder/pi-sdk-adapter.ts) 集中 SDK 导入、工具转换、会话恢复、压缩重试和完成判断；项目工具使用 [tool-contract.ts](src/builder/tool-contract.ts)，运行日志记录实际 SDK 版本。模型描述与上下文窗口配置位于 `pi-model-config.ts`。

Pi SDK 与 TUI 使用 `@earendil-works/*` 包，精确固定为 `1.2.0` 并保留锁文件，按所需功能或修复主动升级。升级时先运行 `npx tsx --test test/pi-*.test.ts test/terminal-presentation.test.ts`，再运行 `npm run test:all`；同步检查 requirements-agent 的类型与测试。真实网关冒烟按下方凭证验证说明启用。

**创建和修改 Web 应用**

```powershell
npm.cmd start -- --requirements-dir E:\requirements\demo --output-dir E:\projects\new-web
npm.cmd start -- --requirements-dir E:\requirements\demo --project E:\projects\existing-web
npm.cmd start                                    # 两项参数都省略：按当前目录约定运行
```

`--requirements-dir` 与 `--output-dir` 都可省略：缺省在当前目录及其子目录中查找唯一的 `requirements.yaml`（没有或找到多个都报错），输出目录缺省为当前目录；`--project` 与 `--output-dir` 互斥。已有项目须提供运行配置；控制器把其当前源码复制到独立开发目录，包含 staged 和未跟踪文件，原目录及其 Git index、分支和历史保持不动。已有应用作为增量起点，沿用原技术栈和布局。

空输出目录使用随附的 React/Vite/TypeScript + Node Web 模板，安装时写入可复用的运行配置。`--budget-ms` 是非负毫秒，缺省或 0 表示不限本轮总调度时间，单次调用仍有上限。

**全局命令**

在仓库根执行 `npm.cmd link` 注册一次后，可在任意目录用 `shallow` 调用：

```powershell
shallow req      # 需求整理（轻量 TUI），在当前目录自动保存并恢复草稿，确认后生成文档
shallow build    # 在当前目录子树查找 requirements.yaml，并输出到当前目录
shallow build --requirements-dir E:\requirements\demo --output-dir E:\projects\new-web
shallow build --requirements-dir E:\requirements\demo --project E:\projects\existing-web
shallow build resume --run-dir E:\runs\<运行目录>
shallow build apply --run-dir E:\runs\<运行目录>
```

`shallow build` 与 `npm.cmd start` 等价，参数原样透传；`shallow` 无参数或 `--help` 显示用法。省略 `--requirements-dir` 时在当前目录及其子目录中查找唯一的 `requirements.yaml`，找不到或找到多个都报错并要求显式指定；省略 `--output-dir`/`--project` 时输出目录缺省为当前目录，当前目录已有项目文件时按增量起点处理，改动经 `apply` 写回。仓库根 `.env` 与全部提示词按模块位置解析，不随启动目录变化；`--requirements-dir`、`--output-dir`、`--project` 等相对路径参数按启动目录解析。

真实终端中，`req` 与 `build` 使用一致的单列 TUI：进入时清空控制台页面，从全新页面开始渲染。`req` 在输入区上方显示草案版本、场景数与待确认问题，`F2` 打开可滚动草案（方向键、PgUp/PgDn 或鼠标滚轮），`v` 切换完整 YAML。`build` 显示当前模块、活动耗时、本轮验收状态，并按总计、Builder、Judge 三行显示 token 总量、输入/输出、缓存读写和按标价估算的费用；当前 Builder 快照计入对应分组与总计，调用结束后结算一次。Builder 包含实现、修复、图片预检及降级重试；Judge 包含功能分组、规划、复核和定位精化。未定价调用保留 token，标注“费用未知”；混合计价显示“已知费用（部分未计价）”。`d` 查看详细日志，`?` 查看帮助，`Esc` 返回状态页，`Ctrl+C` 中断。结束后保留报告、产物位置、累计用量、总耗时与适用的恢复或应用命令。`NO_COLOR` 关闭界面配色；管道、重定向与 `TERM=dumb` 使用纯文本构建日志。

**项目运行配置**

下面是 Windows 上单项目目录布局的配置示例；Linux/macOS 使用 `npm` 替换 `npm.cmd`。

```json
{
  "install": [{ "executable": "npm.cmd", "args": ["ci"], "cwd": "." }],
  "build": [{ "executable": "npm.cmd", "args": ["run", "build"], "cwd": "." }],
  "tests": [{ "id": "unit", "executable": "npm.cmd", "args": ["run", "test", "--"], "cwd": "." }],
  "start": { "executable": "npm.cmd", "args": ["run", "start"], "cwd": "." },
  "readyPath": "/health",
  "browserPath": "/",
  "env": { "APP_MODE": "local" },
  "dependencyPaths": ["."],
  "generatedPaths": ["dist"],
  "dataPaths": ["storage"],
  "dataEnvVar": "APP_DATA_DIR"
}
```

命令的 cwd 是项目相对路径，缺省为根目录；可选 `timeoutMs` 覆盖该命令的阶段时限。`start` 必填；install、build、tests 可按项目声明。路径解析拒绝绝对路径及 `..` 越界。

`env` 提供本轮项目进程环境，安装、构建、开发测试和应用启动共享声明。控制器为启动设置本次 `PORT`，并为数据环境变量注入独立目录。`readyPath` 用于 HTTP 就绪检测；`browserPath` 是浏览器入口，缺省 `/`，交付检查要求它返回成功的 HTML 并可在真实浏览器中打开。具体页面内容和角色由需求验收。本轮运行配置固定，交付配置须与其一致；调整运行方式后启动新一轮。

`dependencyPaths` 限定依赖清单的输入目录；`generatedPaths` 声明生成目录，候选从源码重新构建。`dataPaths` 是同一逻辑存储的候选目录，复制唯一存在者；多个同时存在时报告歧义。`dataEnvVar` 缺省为 `SHALLOW_DATA_DIR`，应用须从该变量接受运行数据目录。应用自身负责迁移和种子补充，检查包含空数据与继承数据。

`extraPorts` 可声明交付时的额外 HTTP 服务端口。应用通过 `SHALLOW_EXTRA_PORTS=0` 在隔离开发与候选验收时跳过这些固定端口，交付时开启。缺省不预留评测端口；显式 `SHALLOW_EVAL_PORT` 才产生预留约束。开发探针使用独立分配的端口。

**开发工具与独立验收**

Builder 的 `run_tests` 使用声明的目标 ID；`all` 顺序执行全部目标，`filter` 作为一个额外参数传给目标命令。模板目标保留单 worker。默认实际运行，仅在确定性测试与输入未改变时可显式 `reuse=true`。

`app` 按相同合同启动、观察和停止开发应用，返回浏览器地址。重建前停止，构建后重新启动。候选验收每个 case 使用隔离数据，同一 case 的刷新和新浏览器会话保留该 case 的服务端状态。

Judge 保留 GIVEN/WHEN/THEN 的准备和结果语义。所有明示结果分别映射断言，定位保持严格唯一，角色和对象身份以需求为准。证据关联候选源码、构建和计划；变更后需要复验。

需求分析按结构化步骤标记 GIVEN/WHEN/THEN，AND/BUT 延续所属阶段，并保留原文与场景步骤来源。分组使用按阶段合并的原文事实，Builder 与 Judge 使用阶段索引；结果覆盖共用字面值与复合结果提取，保留引号内的标点、公式和备选值。节点 `guidance` 记录用户提出但无法独立验收的期望（页面主题、风格、美观等）：它随需求原文进入 Builder 的实现指引并按原文实现，不进入 Judge 的场景断言，也不影响需求状态。

Builder 通过 Pi 显式加载 `prompts/skills/` 中的技能目录，先看到名称、description 与路径，根据当前工作按需用 `read` 读取 SKILL.md。技能涵盖 Web 控件、持久化、身份权限、关联对象、可编辑网格和运行交付，供模型选择适用指导。技能文件只读；目标项目和全局目录的技能自动发现保持关闭。其余提示词提供通用实现与验收合同，具体框架、路由和布局按现有项目及需求决定。

`acceptedSha` 表示可运行检查点；`verified` 表示独立行为证据。`delivered` 要求当前范围全部验证且交付检查通过，退出码 0；`partial` 列出已完成及未确认项，退出码 2；`failed` 表示交付失败，退出码 1。输入错误或运行异常也返回 1。

**运行产物与增量**

`SHALLOW_RUN_DIR` 缺省指向系统临时目录下的 `shallowcode-runs`，每轮建立日志目录。`run-log.txt`、`run-ledger.jsonl`、Judge 计划、证据、Pi 会话和候选构建位于私有运行目录。交互终端展示运行摘要与最近进展，详细视图保留最近 500 条人类可读日志；`run-log.txt` 与 `shallow-progress/progress.log` 持续保存全部人类可读行。纯文本模式直接输出这些日志行；`run-ledger.jsonl` 等原始事件只保留在私有运行目录。

已有项目的开发副本保留在该轮 `workspace` 中。`run.json` 记录需求、配置与控制器合同摘要、来源和输入基线；需求及参考文件保存在私有 `requirements/` 快照中。`changes.patch` 导出本轮改动，包含新增文件和二进制变更。`result.json` 保存交付状态、逐需求状态列表、逐场景结果及本轮 `modelUsage`：顶层为总用量，`builder`、`judge` 为分组用量，`cost` 是已知费用，`unpricedTokens` 是未计价 token 数；`report.md` 提供可读报告。结束时终端打印运行目录、补丁位置与三组模型用量。`shallow-progress/progress.log` 保存可读进度，保持 untracked；当前 Judge 计划只存于私有运行目录。

恢复和写回使用终端打印的完整运行目录：

```powershell
npm.cmd start -- resume --run-dir "E:\runs\<运行目录>" --budget-ms 600000
npm.cmd start -- apply --run-dir "E:\runs\<运行目录>"
npm.cmd start -- apply --run-dir "E:\runs\<运行目录>" --allow-partial
```

`resume` 从该轮最后记录的接受检查点继续，保存中断尝试历史，为恢复轮建立新的日志与证据目录。已接受的实现通过可运行检查后继续使用；本轮重新验收，历史 verified 只保留在旧记录。需求目录内容、运行配置、提示词、DSL 与依赖锁文件须匹配；可复用匹配输入下的私有计划。恢复轮预算独立计算，缺省 0 表示不限总时间。Pi 从当前代码与架构交接开始新会话。同一工作区已有运行进程时拒绝并发恢复。此功能适用于带 `run.json` 和输入基线的新运行；较早运行可将其开发副本作为新项目接管。

`apply` 无需模型凭证，默认只接受 delivered；partial 需显式 `--allow-partial`。写回前核对补丁摘要及每个受影响文件的完整输入内容，再一次性应用补丁。受影响文件已被用户修改时拒绝写回，补丁和副本仍可检查。同时在 `shallow-progress/requirements.json` 保存已验证及明确沿用的需求合同摘要，供后续增量判断；该文件保持 untracked；未确认项在下一轮仍进入当前范围。原项目的分支、历史和暂存区保持不动，支持未初始化 Git 的项目及仓库中的子项目。新项目直接使用输出目录交付。

保留 Stage/Phase、Evolution 及显式修改描述的输入兼容。新增运行按需求本体、祖先与根合同、场景、依赖、种子和参考文件的摘要识别变化，需求 ID 保持不变也会进入修改范围。运行开始时冻结历史来源，恢复保持原增量范围。旧格式的需求 ID 来源是进度日志中的严格检查点行；输入项目自身已带 `shallow-progress/plans` 时也读取其中的历史计划——本工具新写出的 Judge 计划只存于私有运行目录。前序能力只作上下文，历史记录不授予本轮 verified。`SHALLOW_EVOLUTION_AUDIT_INHERITED=1` 包含沿用项回归；跳过项单列。

**工程验证与源码导航**

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run test:browser
npm.cmd run test:all
```

真实网关冒烟需要显式 `RUN_CREDENTIAL_SMOKE=1` 和凭证，默认跳过。完整工程检查由 test:all 顺序运行，结果区分本地回归和真实模型任务。

项目配置见 `src/project-spec.ts`；副本与补丁见 `src/project-workspace.ts`；恢复与写回见 `src/run-record.ts`；主流程见 `index.ts`、`src/pipeline.ts`；执行与验收见 `src/builder/`、`src/judge/`。修改流程、约束和测试入口见 [AGENTS.md](AGENTS.md)，迁移范围见 [REFACTOR_PLAN.md](REFACTOR_PLAN.md)。
