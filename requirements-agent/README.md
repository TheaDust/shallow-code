# requirements-agent

基于 Pi SDK 的独立需求整理智能体：用户通过循环对话描述、补充和纠正需求，最终得到经用户确认、可由 ShallowCode 读取的 `requirements/requirements.yaml`。

## 使用

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

启动后直接进入对话。用普通文字描述需求，智能体整理草案并追问；回答、补充或纠正后继续下一轮。多行输入时在行尾加 `\` 续行。需要生成时输入“生成需求文档”或“整理好了”，程序展示完整草案并询问确认，回答“是”后写出文件。Ctrl+C 退出（未生成的草案只在本次运行内保留）。

## 流程

1. 用户描述需求 → 智能体调用 `update_requirements` 提交完整候选草案与未决问题。
2. 程序校验结构后替换草案；每轮展示改动摘要与最多三个优先问题。
3. 用户请求生成 → 程序校验完整的 GIVEN / WHEN / THEN、展开后的功能依赖和未决问题，核对参考文件，并展示完整草案与参考文件清单。
4. 用户确认 → 程序写出审阅过的 `requirements/requirements.yaml`，参考文件复制到 `references/` 并使用相对引用（已有需求目录时使用新的编号目录）。写出失败会保留当前会话，允许重试或修改。

提供参考资料时，直接在对话中给出本地文件路径；相对路径以启动目录为基准。相同来源只复制一次，不同目录中的同名文件分别保留。模型回复截断、取消或恢复尚未完成时不会进入生成审阅。

## 开发

```powershell
npm.cmd test
npm.cmd typecheck
```

`npm.cmd test` 包含单元测试、对话流程测试，以及一个使用本地模拟网关的端到端测试（无需凭证）：它会真实启动 CLI，覆盖流式回复、工具白名单、草案更新、审阅与生成。真实模型对话需要自备凭证。

生成结果可用 ShallowCode 消费：

```powershell
npm.cmd start -- --requirements-dir "<requirements-agent>\requirements" --project "<项目目录>"
```

（该命令在 ShallowCode 目录运行。）
