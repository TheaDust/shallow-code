# ShallowCode

ShallowCode 是面向结构化需求的 Web 应用开发与交付智能体。它读取需求树，按依赖和功能分组交给 Pi Builder 实现，再由独立浏览器 Judge 验收，管理可运行检查点、修复回归和交付结果。

需求输入沿用 `requirements.yaml` 的 ROOT/FOLDER/ATOMIC、祖先描述、依赖、场景、数据声明和参考图。项目运行方式由独立的 `shallowcode.config.json` 声明。

**运行流程**

需求解析与依赖校验 → 功能分组 → 实现与开发检查 → 候选安装、构建和启动 → 模块边界浏览器验收 → 有界修复与回归 → 当前范围最终验收 → 交付检查。

Builder 是目标业务代码的唯一实现者。Judge 依据需求及浏览器观察工作，与目标源码、diff、Builder 会话和自述隔离。构建成功、开发测试通过和需求获得 `verified` 分别记账。

**安装与网关配置**

需要 Node.js >=20.18.1、npm、Git 和 Playwright Chromium。控制器依赖版本由锁文件固定。

```powershell
npm.cmd ci
npx.cmd playwright install chromium
Copy-Item .env.example .env
```

在仓库 `.env` 或进程环境中配置 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`MODEL`，真实环境变量优先。凭证用于控制器和 Pi Worker 的模型请求。

**创建和修改 Web 应用**

```powershell
npm.cmd start -- --requirements-dir E:\requirements\demo --output-dir E:\projects\new-web
npm.cmd start -- --requirements-dir E:\requirements\demo --project E:\projects\existing-web
```

`--project` 与 `--output-dir` 互斥。已有项目须提供运行配置；控制器把其当前源码复制到独立开发目录，包含 staged 和未跟踪文件，原目录及其 Git index、分支和历史保持不动。已有应用作为增量起点，沿用原技术栈和布局。

空输出目录使用随附的 React/Vite/TypeScript + Node Web 模板，安装时写入可复用的运行配置。`--budget-ms` 是非负毫秒，缺省或 0 表示不限本轮总调度时间，单次调用仍有上限。

**项目运行配置**

下面是 Windows 上单项目目录布局的配置示例；Linux/macOS 使用 `npm` 替换 `npm.cmd`。

```json
{
  "install": [{ "executable": "npm.cmd", "args": ["ci"], "cwd": "." }],
  "build": [{ "executable": "npm.cmd", "args": ["run", "build"], "cwd": "." }],
  "tests": [{ "id": "unit", "executable": "npm.cmd", "args": ["run", "test", "--"], "cwd": "." }],
  "start": { "executable": "npm.cmd", "args": ["run", "start"], "cwd": "." },
  "readyPath": "/health",
  "env": { "APP_MODE": "local" },
  "dependencyPaths": ["."],
  "generatedPaths": ["dist"],
  "dataPaths": ["storage"],
  "dataEnvVar": "APP_DATA_DIR"
}
```

命令的 cwd 是项目相对路径，缺省为根目录；可选 `timeoutMs` 覆盖该命令的阶段时限。`start` 必填；install、build、tests 可按项目声明。路径解析拒绝绝对路径及 `..` 越界。

`env` 提供本轮项目进程环境，安装、构建、开发测试和应用启动共享声明。控制器为启动设置本次 `PORT`，并为数据环境变量注入独立目录。`readyPath` 用于 HTTP 就绪检测；应用入口须能在真实浏览器中打开，现有交付检查要求首页具备可访问的 main 区域。

`dependencyPaths` 限定依赖清单的输入目录；`generatedPaths` 声明生成目录，候选从源码重新构建。`dataPaths` 是同一逻辑存储的候选目录，复制唯一存在者；多个同时存在时报告歧义。`dataEnvVar` 缺省为 `SHALLOW_DATA_DIR`，应用须从该变量接受运行数据目录。应用自身负责迁移和种子补充，检查包含空数据与继承数据。

`extraPorts` 可声明交付时的额外服务端口。缺省不预留评测端口；显式 `SHALLOW_EVAL_PORT` 才产生预留约束。开发探针使用独立分配的端口。

**开发工具与独立验收**

Builder 的 `run_tests` 使用声明的目标 ID；`all` 顺序执行全部目标，`filter` 作为一个额外参数传给目标命令。模板目标保留单 worker。默认实际运行，仅在确定性测试与输入未改变时可显式 `reuse=true`。

`app` 按相同合同启动、观察和停止开发应用，返回浏览器地址。重建前停止，构建后重新启动。候选验收每个 case 使用隔离数据，同一 case 的刷新和新浏览器会话保留该 case 的服务端状态。

Judge 保留 GIVEN/WHEN/THEN 的准备和结果语义。所有明示结果分别映射断言，定位保持严格唯一，角色和对象身份以需求为准。证据关联候选源码、构建和计划；变更后需要复验。

`acceptedSha` 表示可运行检查点；`verified` 表示独立行为证据。`delivered` 要求当前范围全部验证且交付检查通过；`partial` 列出已完成及未确认项；`failed` 表示交付失败。进程退出码为 0 也可能对应 partial。

**运行产物与增量**

`SHALLOW_RUN_DIR` 缺省指向系统临时目录下的 `shallowcode-runs`，每轮建立日志目录。`run-log.txt`、`run-ledger.jsonl`、Judge 计划、证据、Pi 会话和候选构建位于私有运行目录。

已有项目的开发副本保留在该轮 `workspace` 中，`workspace.json` 记录来源和输入基线，`changes.patch` 导出本轮改动，包含新增文件和二进制变更。结束时终端打印副本与补丁位置，供检查和后续交付。`shallow-progress/progress.log` 保存可读进度，保持 untracked；当前 Judge 计划只存于私有运行目录。

保留 Stage/Phase、Evolution 及显式修改描述的输入兼容。需求 ID 来源是进度日志中的严格检查点行；输入项目自身已带 `shallow-progress/plans` 时也读取其中的历史计划——本工具新写出的 Judge 计划只存于私有运行目录。前序能力只作上下文，历史记录不授予本轮 verified。`SHALLOW_EVOLUTION_AUDIT_INHERITED=1` 包含沿用项回归；跳过项单列。

**工程验证与源码导航**

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run test:browser
npm.cmd run test:all
```

真实网关冒烟需要显式 `RUN_CREDENTIAL_SMOKE=1` 和凭证，默认跳过。完整工程检查由 test:all 顺序运行，结果区分本地回归和真实模型任务。

项目配置见 `src/project-spec.ts`；副本与补丁见 `src/project-workspace.ts`；主流程见 `index.ts`、`src/pipeline.ts`；执行与验收见 `src/builder/`、`src/judge/`。修改流程、约束和测试入口见 [AGENTS.md](AGENTS.md)，迁移范围见 [REFACTOR_PLAN.md](REFACTOR_PLAN.md)。
