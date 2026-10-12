import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TREE = {
  id: "task-app",
  name: "任务管理",
  type: "ROOT",
  description: "用户管理自己的任务，刷新后保留。",
  dependencies: [],
  children: [
    {
      id: "create-task",
      name: "创建任务",
      type: "ATOMIC",
      description: "标题必填，新任务初始状态为待办。",
      dependencies: [],
      scenarios: [
        {
          id: "create-task-success",
          name: "创建后刷新仍可看到任务",
          steps: [
            { keyword: "GIVEN", content: "列表中不存在“准备会议”任务。" },
            { keyword: "WHEN", content: "用户填写标题“准备会议”并提交创建。" },
            { keyword: "THEN", content: "列表中出现该任务。" },
            { keyword: "AND", content: "刷新页面后该任务仍然可见。" },
          ],
        },
      ],
    },
  ],
};

interface GatewayRequest {
  toolNames: string[];
  lastUserText: string;
  toolResultText: string;
  hasToolResult: boolean;
  hasSystemPrompt: boolean;
}

function startFakeGateway(): Promise<{ port: number; requests: GatewayRequest[]; close: () => void }> {
  const requests: GatewayRequest[] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      messages?: Array<{ role: string; content: unknown }>;
      tools?: Array<{ function?: { name?: string }; name?: string }>;
    };
    const messages = body.messages ?? [];
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    const lastUserText = typeof lastUser?.content === "string"
      ? lastUser.content
      : JSON.stringify(lastUser?.content ?? "");
    const toolMessages = messages.filter((message) => message.role === "tool");
    requests.push({
      toolNames: (body.tools ?? []).map((tool) => tool.function?.name ?? tool.name ?? ""),
      lastUserText,
      toolResultText: toolMessages.map((message) => JSON.stringify(message.content ?? "")).join("\n"),
      hasToolResult: toolMessages.length > 0,
      hasSystemPrompt: messages.some(
        (message) => message.role === "system" && String(message.content).includes("需求整理助手"),
      ),
    });

    const chunk = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    const wrap = (delta: unknown, finish: string | null) => chunk({
      id: "fake-chunk",
      object: "chat.completion.chunk",
      created: 0,
      model: "fake-model",
      choices: [{ index: 0, delta, finish_reason: finish }],
    });

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    if (lastUserText.includes("生成")) {
      res.write(wrap({ role: "assistant", content: "需求已就绪，" }, null));
      res.write(wrap({ content: "可以生成文档。" }, null));
      res.write(wrap({}, "stop"));
    } else if (toolMessages.length === 0) {
      res.write(wrap({ role: "assistant", content: "我先读取你的需求文件。" }, null));
      res.write(wrap({
        tool_calls: [{
          index: 0,
          id: "call_read",
          type: "function",
          function: {
            name: "read",
            arguments: JSON.stringify({ path: "需求.md" }),
          },
        }],
      }, null));
      res.write(wrap({}, "tool_calls"));
    } else if (toolMessages.length === 1) {
      res.write(wrap({ role: "assistant", content: "我来整理一版草案。" }, null));
      res.write(wrap({
        tool_calls: [{
          index: 0,
          id: "call_1",
          type: "function",
          function: {
            name: "update_requirements",
            arguments: JSON.stringify({ requirements: TREE, questions: [] }),
          },
        }],
      }, null));
      res.write(wrap({}, "tool_calls"));
    } else {
      res.write(wrap({ role: "assistant", content: "已记录。" }, null));
      res.write(wrap({}, "stop"));
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ port, requests, close: () => server.close() });
    });
  });
}

test("本地模拟网关端到端：读取需求文件 → 对话 → 更新草案 → 审阅 → 确认生成", { timeout: 120_000 }, async (t) => {
  const tsxCli = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
  const mainTs = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  const base = await mkdtemp(join(tmpdir(), "requirements-agent-smoke-"));
  await writeFile(join(base, "需求.md"), "需求文档：必须支持导出 CSV。\n", "utf8");
  const gateway = await startFakeGateway();
  let child: ChildProcess | undefined;
  t.after(async () => {
    child?.kill();
    gateway.close();
    await rm(base, { recursive: true, force: true }).catch(() => {});
  });

  child = spawn(process.execPath, [tsxCli, mainTs], {
    cwd: base,
    env: {
      ...process.env,
      OPENAI_API_KEY: "fake-key",
      OPENAI_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
      MODEL: "fake-model",
      // 组件变量也固定为假网关，避免仓库根 .env 的覆盖泄入测试。
      REQUIREMENTS_AGENT_API_KEY: "fake-key",
      REQUIREMENTS_AGENT_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
      REQUIREMENTS_AGENT_MODEL: "fake-model",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (data: Buffer) => { stdout += data.toString("utf8"); });
  child.stderr!.on("data", (data: Buffer) => { stderr += data.toString("utf8"); });

  const write = (text: string) => child!.stdin!.write(text);
  await new Promise((resolve) => setTimeout(resolve, 600));
  write("需求要点都写在 需求.md 里，请读取并整理。\n");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  write("生成需求文档\n");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  write("是\n");
  setTimeout(() => child?.stdin?.end(), 500);

  let guard: NodeJS.Timeout | undefined;
  const exitCode = await Promise.race([
    new Promise<number | null>((resolve) => child!.on("exit", (code) => {
      if (guard) clearTimeout(guard);
      resolve(code);
    })),
    new Promise<null>((resolve) => {
      guard = setTimeout(() => {
        child?.kill();
        resolve(null);
      }, 90_000);
    }),
  ]);

  assert.equal(exitCode, 0, `CLI 退出码异常；stdout:\n${stdout}\nstderr:\n${stderr}`);
  assert.ok(!stderr.includes("启动失败"), `启动失败：${stderr}`);
  assert.match(stdout, /Requirements Agent/);
  assert.match(stdout, /我先读取你的需求文件/, "流式回复未显示");
  assert.match(stdout, /正在读取文件/, "读取工具执行标记缺失");
  assert.match(stdout, /整理一版草案/, "流式回复未显示");
  assert.match(stdout, /正在更新需求草案/, "工具执行标记缺失");
  assert.match(stdout, /create-task/, "草案变更摘要缺失");
  assert.match(stdout, /是否生成这份需求文档/, "审阅询问缺失");
  assert.match(stdout, /已生成/, "生成结果缺失");

  const file = join(base, "requirements", "requirements.yaml");
  assert.ok(existsSync(file), `requirements.yaml 未生成；stdout:\n${stdout}`);
  const yaml = await readFile(file, "utf8");
  assert.match(yaml, /^id: task-app$/m);
  assert.match(yaml, /keyword: AND/);
  assert.match(yaml, /“准备会议”/);

  assert.equal(gateway.requests.length, 4, "模型请求次数异常");
  for (const request of gateway.requests) {
    assert.deepEqual([...request.toolNames].sort(), ["read", "update_requirements"], "工具白名单异常");
    assert.ok(request.hasSystemPrompt, "系统提示词缺失");
  }
  assert.ok(gateway.requests.some((request) => request.hasToolResult), "工具结果未回传给模型");
  assert.ok(
    gateway.requests.some((request) => request.toolResultText.includes("导出 CSV")),
    "读取到的需求文件内容未回传给模型",
  );
});
