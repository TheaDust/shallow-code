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

在真实终端中启动后使用内置的 **轻量 TUI**：多行编辑、输入历史、Markdown 流式回复与紧凑的工具活动行。输入区上方持续显示草案版本、功能与场景数、待确认问题。Enter 提交，Shift+Enter 换行，Esc 中止当前回合；F2 打开草案预览，方向键和 PgUp/PgDn 滚动，v 切换完整 YAML，Enter 或 Esc 返回对话。Ctrl+C 清空输入，空输入时连续两次 Ctrl+C 退出，Ctrl+D 在空输入时退出。回合处理期间再提交的文字会保留在编辑器，待本轮完成后继续提交。`NO_COLOR` 关闭界面配色。

用普通文字描述需求，智能体整理草案并追问；回答、补充或纠正后继续下一轮。已经有写好的需求文档时，直接给出文件路径，智能体会用 Pi 内置的 `read` 工具读取文本内容并整理进草案（相对路径以启动目录为基准）。需要生成时输入“生成需求文档”或“整理好了”，程序展示完整可读草案与场景并询问确认，F2 可滚动审阅或查看同一份草案的 YAML；回答“是”后写出文件，并显示可复制的 `shallow build` 命令。重定向或脚本管道输入使用纯文本模式，行尾加 `\` 可以续行。

草稿自动保存在启动目录的 `.requirements-agent/draft.json`：每次草案更新都会先保存完整需求树、版本和未决问题；用户输入在发给模型前保存，回合中断时也能找回。中途退出、关闭终端或处理失败后，在**同一目录**重新运行 `shallow req` 即可恢复；F2 可查看恢复的草案，此前未完成的输入会随下一轮一起提供给智能体。恢复后需要重新请求生成、审阅并确认。成功生成文档后清理当前草稿，下次启动开始新需求；未生成时保留草稿。不同目录各自保存一份草稿。草稿损坏会明确报错并保留原文件。

## 流程

1. 用户描述需求，或给出写好的需求文档路径由 Pi 内置 `read` 工具读取 → 智能体调用 `update_requirements` 提交完整候选草案与未决问题。
2. 程序校验结构并自动保存后替换草案；每轮展示改动摘要与最多三个优先问题。保存失败不会替换已有草案。
3. 用户请求生成 → 程序校验完整的 GIVEN / WHEN / THEN、展开后的功能依赖和未决问题，核对参考文件，并展示完整草案与参考文件清单。
4. 用户确认 → 程序写出审阅过的 `requirements/requirements.yaml`，参考文件复制到 `references/` 并使用相对引用（已有需求目录时使用新的编号目录）。写出失败会保留当前会话，允许重试或修改。

提供参考资料时，直接在对话中给出本地文件路径；相对路径以启动目录为基准。文本类需求文档由智能体用 Pi 内置 `read` 工具在对话中读取：内容超过 2000 行或 50 KB 时截断，可按工具提示继续读取；只读取用户提供的文件。图片等参考资料不要读取内容，仍按参考文件交接。相同来源只复制一次，不同目录中的同名文件分别保留。模型回复截断、取消或恢复尚未完成时不会进入生成审阅。

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
