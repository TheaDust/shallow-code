# ARC 两组对照实验

实验入口默认读取相邻的 `../arc-bench-modified`（当前路径 `E:\my-works\coding\arc-bench-modified`），运行 `baseline`（单 Agent 全需求开发与自检）和 `shallow`（完整 Grouper / Builder / Verifier 流程），用基准中的 Playwright 测试评估最终应用。两组各自使用全新工程、私有运行目录、数据和程序缓存；配对顺序在任务与重复间交替。`--concurrency N` 控制同时执行的实验单元数，默认 1。

## 环境与输入

先完成 README 的 `npm.cmd run setup`，在仓库 `.env` 配置模型网关。进程环境变量覆盖 `.env`。默认基准目录结构为：

```text
../arc-bench-modified/
  setup-playwright.cjs
  arc-bench/<task>/
    requirements/requirements.yaml
    requirements/reference/
    tests/
```

使用 `--bench-root` 指定另一个 ARC 仓库。入口只读基准目录，测试在应用工作区外加载；开发 Agent 接收转换后的需求与原有参考文件。ARC 的 `description.text`、图片和 `Given/When/Then` 结构由实验层确定性转换为 Shallow DSL，保留需求与场景 ID、结果原文、步骤顺序和图片路径，步骤引用保存在需求上下文。原始 YAML 和转换后输入均留档。引用关系作为原文上下文提供，调度依赖由 Shallow 的正常流程处理。

`private/inputs/<task>/conversion-map.json` 记录每个原始步骤 ID、原始步骤位置、对应的转换后步骤下标、引用，以及图片 ID、路径和页面元数据；下标从 0 开始。每个开发单元在 `private/source-requirements/` 保留相同映射和原始 YAML，映射用于审计，不加入开发输入。已是 Shallow 格式的 YAML 原样传递，映射为 `null`。转换遇到未支持字段、重复身份或非叶节点场景时明确报错；发现图片缺失或越出需求目录时，在生成前报错。种子和场景初态原文保持不变，转换器不推断数据记录或依赖边。

## 先检查，再运行

以下命令从 ShallowCode 仓库根目录执行。`list` 与 `plan` 只读；`prepare` 生成协议记录并枚举官方测试，不调用模型。

```powershell
$env:SHALLOW_VERIFIER_REPLAY = "1"
$env:SHALLOW_VERIFIER_SEMANTIC_REVIEW = "0"
npm.cmd run experiment -- list
npm.cmd run experiment -- plan --tasks bookstack --repeats 1 --concurrency 2
npm.cmd run experiment -- prepare --tasks bookstack --repeats 1 --concurrency 2
```

`prepare` 启动时打印完整输出路径。将该路径填入 `$experimentDir`，检查通过后继续此预实验，共 1 个任务 × 2 种方法 × 1 次重复，两个单元可同时运行：

```powershell
$experimentDir = "prepare 打印的完整输出路径"
npm.cmd run experiment -- run --tasks bookstack --repeats 1 --concurrency 2 --output-dir $experimentDir --resume
```

直接开始新实验可以省略 `--output-dir`：

```powershell
npm.cmd run experiment -- run --tasks bookstack --repeats 1 --concurrency 2
```

只运行一组方法时使用 `--methods baseline` 或 `--methods shallow`；省略时运行两组。选中的方法写入 `experiment.json` 的 `methods` 与 `cells`，汇总只包含选中方法：

```powershell
npm.cmd run experiment -- run --tasks bookstack --methods baseline --repeats 1 --concurrency 1
```

默认在当前目录的 `outputs/` 下创建“题目名 + UTC 时间戳”目录，时间戳格式为 `YYYYMMDDTHHmmssSSSZ`，精确到毫秒。单题形如 `bookstack-<时间戳>`；多题按计划顺序用 `+` 连接，形如 `bookstack+keep-<时间戳>`。不指定 `--tasks` 时使用实际发现的全部题目名；默认每组重复 2 次。完整路径写入 `experiment.json`，并在 `run` / `prepare` 启动时打印。`--output-dir` 仍可覆盖默认目录；`--resume` 和 `summarize` 需要显式提供已有目录。正式任务集合与模型配置应在预实验结束后固定，并使用新的输出目录。

重新汇总已有结果：

```powershell
npm.cmd run experiment -- summarize --output-dir $experimentDir
```

## 资源和模型配置

一个实验单元是一个题目、一次重复和一种方法的完整生成及外部评测。单元按协议顺序领取，最多同时执行 `--concurrency` 指定的数量，完成顺序由实际耗时决定；题目测试清单在调度前统一冻结，各单元完成后串行更新公共汇总。并发度记录在 `experiment.json`，续跑使用相同值。Web 入口动态分配端口，各单元的数据与运行记录独立；Shallow 内部 Verifier 并发仍由 `SHALLOW_VERIFIER_CONCURRENCY` 单独控制。并行运行会共享机器和网关资源，比较耗时与成本时应保持并发配置一致。

实验层默认不设置生成和外部评测的总墙钟上限，协议中的 `generationTimeoutMs` 与 `evaluationTimeoutMs` 记录为 `null`。baseline 开发会话默认不限时；两组的初始化与技术检查、Shallow 内部各阶段的固定超时，以及 ARC 原有单项测试超时继续生效。Ctrl+C 仍会停止进程树并保留已有产物。

需要限制总生成用时时，显式设置 `--generation-timeout-ms`；两组共用该上限，涵盖初始化、开发、内部验收与交付检查。超时后终止进程树，保留当前应用并尝试外部评测。例如：

```powershell
npm.cmd run experiment -- run --tasks bookstack --repeats 2 --concurrency 2 --generation-timeout-ms 10800000
```

外部评测可通过 `--evaluation-timeout-ms` 显式设置总墙钟上限，省略时不限制。两个参数均接受 1 至 2,147,483,647 的整数毫秒。相同墙钟上限并不等于相同 token 或费用；汇总分别记录两者。正常结束时读取最终用量报告；强制终止或报告缺失时用量标记为不完整，费用未知项保持空值。

模型与价格沿用 `MODEL`、`OPENAI_BASE_URL`、`SHALLOW_BUILDER_*`、`SHALLOW_GROUPER_*`、`SHALLOW_VERIFIER_*` 和 `MODEL_COST_*`。比较同一底座模型时，让三种角色的模型覆盖一致；不同配置也可以运行，但须按实际配置解释结果。参考图片由 `SHALLOW_REFERENCE_IMAGES=1` 开启，两组设置相同。语义复核与最终全量重放沿用 `.env` 中的明确设置并记录到协议。`SHALLOW_VERIFIER_REPLAY` 只控制模块全部完成后的全量检查和集中修复后的最终收口；功能组检查完成即发布本组结果，局部程序诊断及修复目标检查始终可用；业务集中修复最多一轮。本研究实验使用 `SHALLOW_VERIFIER_REPLAY=1`、`SHALLOW_VERIFIER_SEMANTIC_REVIEW=0`。协议固定代码和配置，旧版准备目录须使用新输出目录重新 `prepare`。

## 评分和输出

评测复用当前安装的 Playwright，使用基准仓库提供的 `setup-playwright.cjs` 生成配置，保留其 workers、retries、超时、时区与浏览器设置，仅将 reporter 切换为 JSON。每项应用依据其 `shallowcode.config.json` 在隔离副本中安装、构建、启动，数据使用独立目录。官方测试发现的问题只进入实验结果。

生成失败、超时和中断也会保留并尝试评分；无法启动时记为全部测试未执行、通过数为 0。通过率的分母来自生成前冻结的完整测试清单，包含失败、跳过和未执行项。方法级主指标先平均同一应用的重复结果，再对应用取平均；实验未完成时主指标为空。

```text
outputs/bookstack-<UTC时间戳>/
  experiment.json                 输入、代码、依赖版本、配置、并发度与执行顺序
  private/catalog/<task>/         官方测试清单和枚举记录
  private/inputs/<task>/          转换后的需求检查记录
  <task>/repeat-1/<method>/
    app/                         生成应用
    private/                     原始需求、开发输入、模型运行记录
    generation.log               开发日志
    generation.json              开发状态和用量
    evaluation-1/                独立测试、配置、日志、trace 和 playwright.json
    result.json                  本次完整结果与最终源码摘要
  summary.json                   完整结构化汇总
  summary.csv                    方法级对比
  tasks.csv                      应用级对比
  runs.csv                       每次运行的成绩、费用与耗时
```

`--resume` 要求任务、重复次数、并发度、限制、模型配置、代码及输入摘要保持一致，完成的单元包括失败结果均直接保留。若进程被中断且没有生成结算报告，该单元记录为 `interrupted`，保留现有源码并评分，继续剩余单元；不会自动把它当成一次全新生成。中断的评测在新的 `evaluation-N` 目录重新执行，之前的记录保留。用户中断或某个单元抛出异常时停止领取新单元，取消其余在途进程，并等待清理结束后释放实验目录锁。

退出码：0 表示全部运行完成且没有生成或评测基础设施故障，行为测试可以有失败；2 表示至少一次生成失败、超时、中断或外部评测异常；1 表示参数、协议、环境检查失败或用户中断。真实模型实验需要显式执行 `run`。
