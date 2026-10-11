# requirements-agent

基于 Pi SDK 的独立需求整理智能体：用户通过循环对话描述、补充和纠正需求，最终得到经用户确认、可由 ShallowCode 读取的 `requirements/requirements.yaml`。

## 使用

```powershell
npm.cmd install
npm.cmd start
```

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
3. 用户请求生成 → 程序校验（结构、每个 ATOMIC 的场景与结果、未决问题）并展示完整草案。
4. 用户确认 → 程序写出 `requirements/requirements.yaml`（已有同名文件时使用新的编号目录）。

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
