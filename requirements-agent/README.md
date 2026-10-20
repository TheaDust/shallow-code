# requirements-agent

基于 Pi SDK 的独立需求整理智能体：用户通过循环对话描述、补充和纠正需求，最终得到经用户确认、可由 ShallowCode 读取的 `requirements/requirements.yaml`。

## 使用

需要 Node.js >=22.19.0；Pi SDK 与 TUI 精确固定为 `@earendil-works/*@1.2.0`。

```powershell
npm.cmd install
npm.cmd start
```

在 ShallowCode 仓库根执行一次 `npm.cmd link` 注册全局命令 `shallow` 后，可在任意目录启动：

```powershell
shallow req
```

产物写在启动目录下的 `requirements/`，相对参考路径也以启动目录为基准；仓库根 `.env` 与提示词按模块位置解析，不随启动目录变化。

## 配置

模型凭证按下列顺序合并：**进程环境变量 > 当前目录 `.env` > 仓库根目录 `.env`**（即与 ShallowCode 的 builder、judge 共用的那份配置）。

- 公共值：`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`MODEL`
- 本 agent 单独覆盖：`REQUIREMENTS_AGENT_API_KEY`、`REQUIREMENTS_AGENT_BASE_URL`、`REQUIREMENTS_AGENT_MODEL`（字段级回退公共值）
- 可选模型单价（USD / 百万 token）：缺省按网关地址与模型 id 匹配 pi-ai 内置目录的标价；`MODEL_COST_INPUT` / `MODEL_COST_OUTPUT` / `MODEL_COST_CACHE_READ` / `MODEL_COST_CACHE_WRITE`，或 `REQUIREMENTS_AGENT_COST_*` 按字段覆盖。目录与配置均无价格时只统计 token。

网关为 opencode.ai（Zen/Go）时会自动附带该网关要求的 `x-opencode-session` 会话头。

仓库根 `.env` 示例（参见 ShallowCode 的 `.env.example`）：

```dotenv
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://gateway.example.com/v1
MODEL=provider/model

# 可选：三个组件分别指定
SHALLOW_BUILDER_MODEL=provider/builder
SHALLOW_JUDGE_MODEL=provider/judge
REQUIREMENTS_AGENT_MODEL=provider/requirements
```

在真实终端中启动后使用内置的 **轻量 TUI**：进入时清空控制台页面，从全新页面开始渲染。多行编辑、输入历史、Markdown 流式回复与紧凑的工具活动行。输入区上方持续显示当前模型、草案版本、功能与场景数、待确认问题，并在模型回复后刷新累计 token 与花费（价格未知时只显示 token）。Enter 提交，Shift+Enter 换行，Esc 中止当前回合；F2 打开草案预览，方向键、PgUp/PgDn 或鼠标滚轮滚动，v 切换完整 YAML，Enter 或 Esc 返回对话。Ctrl+C 清空输入，空输入时连续两次 Ctrl+C 退出，Ctrl+D 在空输入时退出。回合处理期间再提交的文字会保留在编辑器，待本轮完成后继续提交。`NO_COLOR` 关闭界面配色。退出时输出一行累计用量。

用普通文字描述需求，智能体整理草案并追问；回答、补充或纠正后继续下一轮。无法独立验收的期望（页面主题、风格、美观、语气等）不会被丢弃：它们写入对应节点的 `guidance` 实现指引，随需求文档交接给 Builder 按原文实现，正式验收仍以可观察场景为准。已经有写好的需求文档时，直接给出文件或目录路径：智能体会用 Pi 内置的 `read` 工具读取文本内容，给出目录时先用 `ls` 列出目录内容、再读取其中相关的文本文件（相对路径以启动目录为基准）。需要写出时可以说“生成”，也可以说“根据最新草案更新需求”“把刚才整理的内容同步进 YAML”；智能体通过 `review_requirements` 请求相应操作，程序校验并展示完整草案，回答“是”后写出。更新操作会显示原文件路径与改动摘要，写回启动目录的 `requirements/requirements.yaml`；创建新文档时使用新的需求目录。F2 可滚动审阅或查看同一份草案的 YAML，完成后显示可复制的 `shallow build` 命令。“生成”“生成需求文档”“整理好了”等纯生成指令直接由程序处理；同一句中包含需求修改，或仍有此前未完成的输入时，先由智能体处理再进入审阅。重定向或脚本管道输入使用纯文本模式，行尾加 `\` 可以续行。生成的场景按 Builder/Checker 的验收合同组织：每个 ATOMIC 的场景独立可准备，THEN 给出可判定结果，共享种子与场景初态分开；`guidance` 只保留不可独立验收的期望。

草稿自动保存在启动目录的 `.requirements-agent/draft.json`：每次草案更新都会先保存完整需求树、版本和未决问题；用户输入在发给模型前保存，回合中断时也能找回。中途退出、关闭终端或处理失败后，在**同一目录**重新运行 `shallow req` 即可恢复；F2 可查看恢复的草案，此前未完成的输入会随下一轮一起提供给智能体。恢复后需要重新请求生成、审阅并确认。成功生成文档后清理当前草稿，下次启动开始新需求；未生成时保留草稿。不同目录各自保存一份草稿。草稿损坏会明确报错并保留原文件。

## 流程

1. 用户描述需求，或给出写好的需求文档路径（或目录，先由 `ls` 列出文件）由 Pi 内置 `read` 工具读取 → 智能体调用 `update_requirements` 提交完整候选草案与未决问题。
2. 程序校验结构并自动保存后替换草案；每轮展示改动摘要与最多三个优先问题。保存失败不会替换已有草案。
3. 用户请求生成或更新文档 → 智能体用 `review_requirements` 表达创建或更新意图（纯生成指令走快捷入口）；程序校验完整的 GIVEN / WHEN / THEN、展开后的功能依赖和未决问题，核对参考文件，并展示完整草案与参考文件清单。更新时同时展示原文件路径与改动摘要。
4. 用户确认 → 创建操作写到新的需求目录；更新操作将审阅过的 YAML 写回现有 `requirements/requirements.yaml`。参考文件使用相对引用；更新时先复制到本次独立的引用目录、写好临时 YAML 后再替换原文件。原文件在审阅后被其他程序改动时，需重新审阅。写出失败会保留原文件与草稿，允许重试或修改。

提供参考资料时，直接在对话中给出本地文件或目录路径；相对路径以启动目录为基准。文本类需求文档由智能体用 Pi 内置 `read` 工具在对话中读取（目录先用 `ls` 列出内容）：内容超过 2000 行或 50 KB 时截断，可按工具提示继续读取；只读取用户提供的文件与目录中的内容。图片等参考资料不要读取内容，仍按参考文件交接。相同来源只复制一次，不同目录中的同名文件分别保留。模型回复截断、取消或恢复尚未完成时不会进入生成审阅。

## 开发

```powershell
npm.cmd test
npm.cmd typecheck
```

`npm.cmd test` 包含单元测试、对话流程测试，以及纯文本和轻量 TUI 两条本地模拟网关端到端测试（无需凭证）：真实启动 CLI，覆盖流式回复、工具白名单、草案更新、审阅与生成；TUI 用例还核对用户输入回显、多行编辑与最新草案上下文。真实模型对话需要自备凭证。

生成结果可用 ShallowCode 消费：

```powershell
npm.cmd start -- --requirements-dir "<requirements-agent>\requirements" --project "<项目目录>"
```

（该命令在 ShallowCode 目录运行。）
