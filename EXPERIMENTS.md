# ARC-Bench 对照实验

实验入口默认读取相邻的 `../arc-bench-modified`，运行 `baseline`（单 Agent 全需求开发与自检）和 `shallow`（完整 Grouper / Builder / Verifier 流程），用基准中的 Playwright 测试评估最终应用。两组各自使用全新工程、私有运行目录、数据和程序缓存；配对顺序在任务与重复间交替。`--concurrency N` 控制同时执行的实验单元数，默认 1。

通过 `--methods baseline,arc,shallow` 加入 Agentic Requirement Compiler（ARC）方法，或用 `--methods arc` 单独运行。默认仍选择 `baseline,shallow`。多方法按题目与重复序号轮换执行顺序；两方法保留原有的交替顺序。

## ARC baseline

ARC 与 ShallowCode 源码仓库保持同级。默认读取 `../agentic-requirement-compiler`，可用 `--arc-root` 指定其他位置；`--arc-python` 指定已安装 ARC 依赖的 Python 3.11+，缺省为 `python`。首次使用先在 ARC 仓库初始化模板子模块，并安装其 `pyproject.toml` 中的依赖：

```powershell
git -C ../agentic-requirement-compiler submodule update --init --recursive
python -m pip install -e ../agentic-requirement-compiler
npm.cmd run experiment -- prepare --tasks bookstack --methods arc,shallow --repeats 1
```

也可在独立虚拟环境安装依赖，然后传入 `--arc-python <虚拟环境的python路径>`；实验实际从封存源码运行，不要求 editable 安装。`prepare` 在 `private/inputs/<task>/arc-requirements.yaml` 同时保存 ARC 实际使用的格式，便于生成前检查。

检查 `prepare` 打印的目录后，用相同参数续跑；`--arc-python`、`--arc-root` 如有指定也须保持一致：

```powershell
$experimentDir = "prepare 打印的输出路径"
npm.cmd run experiment -- run --tasks bookstack --methods arc,shallow --repeats 1 --output-dir $experimentDir --resume
```

ARC 使用同一基准需求包的独立副本。实验层只做确定性语法兼容：`description.text` 作为描述、图片映射到 `visual_reference`，每个 `Given/When/Then/And/But` 子句映射到原生 `keyword/content` 步骤。保留需求与场景 ID、源步骤 ID、图片身份和引用；拆分步骤 ID 为 `<源步骤ID>::<子句名>`，原 ID 另存于 `source_step_id`。不推断依赖、种子或业务预期。原始 YAML 和步骤映射仍在该单元的 `private/source-requirements/` 留档，实际输入在 `private/requirements/`。

准备阶段将 ARC 源码和模板按逐文件摘要封存到 `private/arc-source/`，排除 `.env`、Git 元数据、Python 缓存和 `node_modules`；运行调用此副本的原生 CLI，记录其实际工作流结果。协议保存源码摘要、Python 路径/版本及 Python 依赖版本，续跑检查版本与输入是否改变。ARC 算法及生成流程属于外部仓库，实验层维护桥接和运行合同。

ARC 默认沿用 Builder 的网关/模型配置，也可通过 `ARC_MODEL`、`ARC_BASE_URL`、`ARC_API_KEY` 单独覆盖。`ARC_OPENAI_API_MODE`、`ARC_OPENAI_REASONING_EFFORT` 等 ARC 原生设置直接传递；`VISUAL_MODEL`、`VISUAL_BASE_URL`、`VISUAL_API_KEY` 可配置视觉模型，缺省与 ARC 文本模型相同。`SHALLOW_REFERENCE_IMAGES` 控制所有选中方法是否使用图片，关闭时 ARC 跳过视觉分析。非密钥配置写入协议，凭证只经环境传递。ARC 单价使用 `ARC_COST_*` 覆盖，视觉模型使用 `VISUAL_COST_*`，否则沿用 `MODEL_COST_*` 或已知模型目录。

每个 ARC 单元使用独立的动态端口、工作区与生成数据库。评测复用同一外部 Playwright 测试清单及候选运行器，按 ARC Web 模板合同安装依赖、构建 frontend、在 backend 执行 `npm run start`；在独立副本使用全新 SQLite 文件，并由生成应用正常初始化需求数据。实验层写入 `shallowcode.config.json` 声明此运行合同，不将生成过程的数据库带入评分。ARC 编译失败或超时仍尝试评分。

ARC 内部工作流成功记 `completed`，完成但存在失败节点记 `partial`，初始化等阶段失败记 `failed`；原生 CLI 返回 0 不单独作为成功依据。用量读取 ARC 自己的 `.arc/model_usage.jsonl`，缓存 token 从普通输入中扣除后分别计费；缺失字段、截断记录、超时或中断标为统计不完整。`arc` 与其他方法并列进入现有 CSV/JSON 汇总。真实模型质量、耗时及费用须通过实际实验测量。

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

`prepare` 启动时打印相对当前目录的输出路径。将该路径填入 `$experimentDir`，检查通过后继续此预实验，共 1 个任务 × 2 种方法 × 1 次重复，两个单元可同时运行：

```powershell
$experimentDir = "prepare 打印的输出路径"
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

默认在当前目录的 `outputs/` 下创建“题目名 + UTC 时间戳”目录，时间戳格式为 `YYYYMMDDTHHmmssSSSZ`，精确到毫秒。单题形如 `bookstack-<时间戳>`；多题按计划顺序用 `+` 连接，形如 `bookstack+keep-<时间戳>`。不指定 `--tasks` 时使用实际发现的全部题目名；默认每组重复 2 次。`experiment.json` 与 `result.json` 以实验目录为基准记录基准仓库、任务输入和评测目录的相对路径，输出目录记为 `.`，`evaluation.json` 的目录记为 `.`；跨盘符无法表示相对路径时保留绝对路径。旧版绝对路径清单仍可按原位置续跑和汇总。`run` / `prepare` 启动时按当前目录打印输出路径。`--output-dir` 仍可覆盖默认目录；`--resume` 和 `summarize` 需要显式提供已有目录。正式任务集合与模型配置应在预实验结束后固定，并使用新的输出目录。

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
