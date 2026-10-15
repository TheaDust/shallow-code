import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { stringify } from "yaml";

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
  systemText: string;
}

function startFakeGateway(pauseAfterUpdate = false): Promise<{ port: number; requests: GatewayRequest[]; close: () => void }> {
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
      : Array.isArray(lastUser?.content)
        ? lastUser.content.map((part: { text?: string }) => part.text ?? "").join("\n")
        : "";
    const toolMessages = messages.filter((message) => message.role === "tool");
    const userInput = lastUserText.split("【用户输入】\n").at(-1) ?? lastUserText;
    requests.push({
      toolNames: (body.tools ?? []).map((tool) => tool.function?.name ?? tool.name ?? ""),
      lastUserText,
      toolResultText: toolMessages.map((message) => JSON.stringify(message.content ?? "")).join("\n"),
      hasToolResult: toolMessages.length > 0,
      hasSystemPrompt: messages.some(
        (message) => message.role === "system" && String(message.content).includes("需求整理助手"),
      ),
      systemText: messages.filter((message) => message.role === "system")
        .map((message) => String(message.content)).join("\n"),
    });
    // 草稿工具已提交，最终回复仍在等待：用于验证回合中途退出。
    if (pauseAfterUpdate && toolMessages.length >= 3 && !userInput.includes("生成")) return;

    const chunk = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    const wrap = (delta: unknown, finish: string | null) => chunk({
      id: "fake-chunk",
      object: "chat.completion.chunk",
      created: 0,
      model: "fake-model",
      choices: [{ index: 0, delta, finish_reason: finish }],
    });

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    if (userInput === "根据最新草案更新需求") {
      if (messages.at(-1)?.role === "tool") {
        res.write(wrap({ role: "assistant", content: "按最新草案准备更新现有文档。" }, null));
        res.write(wrap({}, "stop"));
      } else {
        res.write(wrap({ role: "assistant", content: "我来准备原文件的更新审阅。" }, null));
        res.write(wrap({ tool_calls: [{ index: 0, id: "call_review", type: "function",
          function: { name: "review_requirements", arguments: JSON.stringify({ mode: "update" }) } }] }, null));
        res.write(wrap({}, "tool_calls"));
      }
    } else if (userInput.includes("生成")) {
      res.write(wrap({ role: "assistant", content: "需求已就绪，" }, null));
      res.write(wrap({ content: "可以生成文档。" }, null));
      res.write(wrap({}, "stop"));
    } else if (toolMessages.length === 0) {
      // 用户给出目录：先列目录，再读取其中的文件。
      res.write(wrap({ role: "assistant", content: "我先查看你给出的目录。" }, null));
      res.write(wrap({
        tool_calls: [{
          index: 0,
          id: "call_ls",
          type: "function",
          function: {
            name: "ls",
            arguments: JSON.stringify({ path: "docs" }),
          },
        }],
      }, null));
      res.write(wrap({}, "tool_calls"));
    } else if (toolMessages.length === 1) {
      res.write(wrap({ role: "assistant", content: "我读取目录里的需求文件。" }, null));
      res.write(wrap({
        tool_calls: [{
          index: 0,
          id: "call_read",
          type: "function",
          function: {
            name: "read",
            arguments: JSON.stringify({ path: "docs/需求.md" }),
          },
        }],
      }, null));
      res.write(wrap({}, "tool_calls"));
    } else if (toolMessages.length === 2) {
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
      resolve({ port, requests, close: () => { server.closeAllConnections(); server.close(); } });
    });
  });
}

for (const interactive of [false, true]) {
for (const updating of [false, true]) {
test(`${interactive ? "轻量 TUI" : "纯文本 CLI"} 模拟网关端到端：读取 → 更新草案 → 审阅 → 确认${updating ? "更新原文件" : "生成"}`, { timeout: 120_000 }, async (t) => {
  const tsxCli = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
  const tsxLoader = new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href;
  const mainTs = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  const base = await mkdtemp(join(tmpdir(), "requirements-agent-smoke-"));
  await mkdir(join(base, "docs"), { recursive: true });
  await writeFile(join(base, "docs", "需求.md"), "需求文档：必须支持导出 CSV。\n", "utf8");
  const file = join(base, "requirements", "requirements.yaml");
  const original = stringify({ ...TREE, description: "此前导出的旧需求。" });
  if (updating) {
    await mkdir(join(base, "requirements"));
    await writeFile(file, original);
  }
  const ttyImport = join(base, "tty.mjs");
  if (interactive) {
    // Exercise the custom TUI and keyboard processing without requiring the
    // test runner itself to have a console. Enter submits as CR in raw mode.
    await writeFile(ttyImport,
      "Object.defineProperty(process.stdin, 'isTTY', { value: true });\n" +
      "Object.defineProperty(process.stdout, 'isTTY', { value: true });\n", "utf8");
  }
  const gateway = await startFakeGateway();
  let child: ChildProcess | undefined;
  t.after(async () => {
    child?.kill();
    gateway.close();
    await rm(base, { recursive: true, force: true }).catch(() => {});
  });

  child = spawn(process.execPath, interactive
    ? ["--import", pathToFileURL(ttyImport).href, "--import", tsxLoader, mainTs] : [tsxCli, mainTs], {
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
      PI_OFFLINE: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (data: Buffer) => { stdout += data.toString("utf8"); });
  child.stderr!.on("data", (data: Buffer) => { stderr += data.toString("utf8"); });

  const write = (text: string) => child!.stdin!.write(text);
  const waitFor = async (pattern: RegExp) => {
    const deadline = Date.now() + 30_000;
    while (!pattern.test(stdout)) {
      if (child!.exitCode !== null || Date.now() >= deadline) {
        assert.fail(`CLI 未显示 ${pattern}；stdout:\n${stdout}\nstderr:\n${stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const enter = interactive ? "\r" : "\n";
  await waitFor(/需要生成时输入/);
  write(interactive
    ? `需求要点都写在 docs 目录里。\n请查看并整理。${enter}`
    : `需求要点都写在 docs 目录里，请查看并整理。${enter}`);
  await waitFor(interactive ? /草案更新.*r1/ : /【本轮修改】/);
  write(`继续整理。${enter}`);
  await waitFor(interactive ? /本轮草案无变化/ : /【本轮修改】无变化/);
  const requestsBeforeGeneration = gateway.requests.length;
  write(`${updating ? "根据最新草案更新需求" : interactive ? "生成" : "生成需求文档"}${enter}`);
  await waitFor(updating ? /是否更新这份需求文档/ : /是否生成这份需求文档/);
  if (updating) {
    assert.equal(await readFile(file, "utf8"), original, "确认前原文件应保持原样");
    assert.ok(stripVTControlCharacters(stdout).replace(/\s/g, "").includes(file.replace(/\s/g, "")),
      "审阅应完整展示即将更新的文件路径，允许按终端宽度换行");
    assert.match(stdout, /相较原文件/);
  }
  write(`是${enter}`);
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
  assert.match(stdout, interactive ? /Shallow Code/ : /Requirements Agent/);
  assert.match(stdout, /我先查看你给出的目录/, "流式回复未显示");
  assert.match(stdout, /我读取目录里的需求文件/, "流式回复未显示");
  if (!interactive) assert.match(stdout, /正在查看目录/, "目录工具执行标记缺失");
  if (!interactive) assert.match(stdout, /正在读取文件/, "读取工具执行标记缺失");
  assert.match(stdout, /整理一版草案/, "流式回复未显示");
  if (!interactive) assert.match(stdout, /正在更新需求草案/, "工具执行标记缺失");
  assert.match(stdout, /create-task/, "草案变更摘要缺失");
  assert.match(stdout, updating ? /是否更新这份需求文档/ : /是否生成这份需求文档/, "审阅询问缺失");
  assert.match(stdout, updating ? /已更新/ : /已生成/, "写出结果缺失");

  assert.ok(existsSync(file), `requirements.yaml 未生成；stdout:\n${stdout}`);
  const yaml = await readFile(file, "utf8");
  assert.match(yaml, /^id: task-app$/m);
  assert.match(yaml, /keyword: AND/);
  assert.match(yaml, /“准备会议”/);

  assert.equal(gateway.requests.length, updating ? 7 : 5, "模型请求次数异常");
  assert.equal(gateway.requests.length, requestsBeforeGeneration + (updating ? 2 : 0), "确认时不应再次请求模型");
  if (updating) {
    assert.doesNotMatch(yaml, /此前导出的旧需求/);
    assert.equal(existsSync(join(base, "requirements-2")), false, "更新应写回原文件");
    assert.equal(existsSync(join(base, ".requirements-agent", "draft.json")), false);
  }
  for (const request of gateway.requests) {
    assert.deepEqual([...request.toolNames].sort(), ["ls", "read", "review_requirements", "update_requirements"], "工具白名单异常");
    assert.ok(request.hasSystemPrompt, "系统提示词缺失");
  }
  assert.ok(gateway.requests.some((request) => request.hasToolResult), "工具结果未回传给模型");
  assert.ok(
    gateway.requests.some((request) => request.toolResultText.includes("导出 CSV")),
    "读取到的需求文件内容未回传给模型",
  );
  assert.match(gateway.requests[0].lastUserText, /【用户输入】/, "回合消息缺少用户输入段");
  assert.match(gateway.requests.at(-1)!.lastUserText, /【当前需求草案（第 1 版）】/,
    "回合消息缺少最新草案上下文");
  if (interactive) {
    assert.match(stdout, /F2 草案预览/, "草案预览入口缺失");
    assert.match(stdout, /shallow build --requirements-dir/, "生成后交接命令缺失");
    assert.match(stdout, /›/, "TUI 未回显用户输入");
    assert.ok(!stdout.includes("Ctrl+O"), "TUI 不应出现 Pi 命令面板提示");
    assert.ok(gateway.requests[0].lastUserText.includes("需求要点都写在 docs 目录里。\n请查看并整理。"),
      "多行编辑未传入同一回合");
  }
});
}
}

for (const interactive of [false, true]) {
test(`${interactive ? "轻量 TUI" : "纯文本 CLI"} 在模型回合中被终止后恢复草稿并生成`, { timeout: 60_000 }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), "requirements-restart-"));
  await mkdir(join(base, "docs"), { recursive: true });
  await writeFile(join(base, "docs", "需求.md"), "任务列表刷新后仍保留。\n");
  const ttyImport = join(base, "tty.mjs");
  if (interactive) await writeFile(ttyImport,
    "Object.defineProperty(process.stdin, 'isTTY', { value: true });\n" +
    "Object.defineProperty(process.stdout, 'isTTY', { value: true });\n");
  const gateway = await startFakeGateway(true);
  const children: Array<{ child: ChildProcess; exit: Promise<number | null> }> = [];
  t.after(async () => {
    for (const { child, exit } of children) { child.kill(); await exit; }
    gateway.close();
    await rm(base, { recursive: true, force: true });
  });
  const launch = () => {
    const mainTs = fileURLToPath(new URL("../src/main.ts", import.meta.url));
    const child = spawn(process.execPath, interactive ? [
      "--import", pathToFileURL(ttyImport).href,
      "--import", new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href, mainTs,
    ] : [fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url)), mainTs], {
      cwd: base,
      env: { ...process.env, REQUIREMENTS_AGENT_API_KEY: "fake-key",
        REQUIREMENTS_AGENT_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
        REQUIREMENTS_AGENT_MODEL: "fake-model", PI_OFFLINE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (data: Buffer) => { stdout += data.toString("utf8"); });
    child.stderr!.on("data", (data: Buffer) => { stderr += data.toString("utf8"); });
    const exit = new Promise<number | null>(resolve => child.once("close", resolve));
    children.push({ child, exit });
    return { child, exit, stdout: () => stdout,
      async waitFor(check: () => boolean) {
        const deadline = Date.now() + 20_000;
        while (!check()) {
          assert.ok(child.exitCode === null && Date.now() < deadline,
            `未达到预期状态；stdout:\n${stdout}\nstderr:\n${stderr}`);
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      } };
  };
  const enter = interactive ? "\r" : "\n";
  const first = launch();
  await first.waitFor(() => /需要生成时输入/.test(first.stdout()));
  first.child.stdin!.write(`需求要点都写在 docs 目录里，请查看并整理。${enter}`);
  const draftFile = join(base, ".requirements-agent", "draft.json");
  await first.waitFor(() => gateway.requests.length === 4 && existsSync(draftFile));
  first.child.kill();
  await first.exit;
  const saved = JSON.parse(await readFile(draftFile, "utf8"));
  assert.equal(saved.revision, 1);
  assert.equal(saved.tree.id, "task-app");
  assert.deepEqual(saved.pendingInputs, ["需求要点都写在 docs 目录里，请查看并整理。"]);

  const second = launch();
  await second.waitFor(() => /已恢复需求草稿/.test(second.stdout()));
  if (interactive) {
    await second.waitFor(() => /草案恢复.*r1/.test(second.stdout()));
    second.child.stdin!.write("\x1bOQ");
    await second.waitFor(() => /需求草案 · r1/.test(second.stdout()));
    second.child.stdin!.write("\r");
  }
  second.child.stdin!.write(`生成需求文档${enter}`);
  await second.waitFor(() => /是否生成这份需求文档/.test(second.stdout()));
  second.child.stdin!.write(`是${enter}`);
  assert.equal(await second.exit, 0);
  assert.ok(existsSync(join(base, "requirements", "requirements.yaml")));
  assert.equal(existsSync(draftFile), false);
  assert.equal(gateway.requests.length, 5);
  assert.match(gateway.requests[4].lastUserText, /【当前需求草案（第 1 版）】/);
  assert.match(gateway.requests[4].lastUserText, /【此前未完成的输入】/);
  assert.match(gateway.requests[4].lastUserText, /create-task/);
});
}
