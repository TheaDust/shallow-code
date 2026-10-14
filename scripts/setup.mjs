#!/usr/bin/env node
// ShallowCode 一键安装（Windows / Linux / macOS）：依赖、Chromium、.env 与全局命令。
// 只依赖 Node 内置模块，可在 npm ci 之前直接运行：node scripts/setup.mjs
import { spawn } from "node:child_process";
import { copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const AGENT_DIR = join(ROOT, "requirements-agent");
const REQUIRED_NODE = "22.19.0";
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(`ShallowCode 一键安装

用法：node scripts/setup.mjs [选项]

  --check         只检查环境并打印安装计划，不做任何修改
  --skip-browser  跳过 Playwright Chromium 下载（shallow build 的浏览器验收需要）
`);
  process.exit(0);
}

const checkOnly = args.includes("--check");
const skipBrowser = args.includes("--skip-browser");
const isWindows = process.platform === "win32";

const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
const [requiredMajor = 0, requiredMinor = 0] = REQUIRED_NODE.split(".").map(Number);
if (major < requiredMajor || (major === requiredMajor && minor < requiredMinor)) {
  process.stderr.write(`需要 Node.js >= ${REQUIRED_NODE}，当前 ${process.versions.node}。\n`);
  process.exit(1);
}

/** Windows 上通过 cmd.exe 执行 npm.cmd（避免 shell:true 的 DEP0190 弃用警告）；其它平台直接执行。 */
function runNpm(commandArgs, cwd) {
  // 所有调用点都使用固定的无空格参数，直接拼接即可；Node 会按需加引号，cmd /s 会剥掉外层引号。
  const [command, spawnArgs] = isWindows
    ? [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", ["npm.cmd", ...commandArgs].join(" ")]]
    : ["npm", commandArgs];
  return new Promise((resolve, reject) => {
    const child = spawn(command, spawnArgs, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", code => code === 0
      ? resolve()
      : reject(new Error(`npm ${commandArgs.join(" ")} 退出码 ${code}`)));
  });
}

function commandAvailable(command, commandArgs) {
  return new Promise(resolve => {
    const child = spawn(command, commandArgs, { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("close", code => resolve(code === 0));
  });
}

async function initEnvFile() {
  const target = join(ROOT, ".env");
  if (existsSync(target)) {
    console.log("  .env 已存在，保留现有内容");
    return;
  }
  await copyFile(join(ROOT, ".env.example"), target);
  console.log("  已从 .env.example 创建 .env，稍后填入凭证");
}

const steps = [
  { label: "安装仓库根依赖", detail: "npm ci", run: () => runNpm(["ci"], ROOT) },
  { label: "安装 requirements-agent 依赖", detail: "npm ci", run: () => runNpm(["ci"], AGENT_DIR) },
  ...(skipBrowser ? [] : [{
    label: "安装 Playwright Chromium", detail: "playwright install chromium",
    run: () => runNpm(["exec", "--", "playwright", "install", "chromium"], ROOT),
  }]),
  { label: "初始化本地凭证文件", detail: ".env.example → .env（已存在则保留）", run: initEnvFile },
  {
    label: "注册全局 shallow 命令", detail: "npm link",
    hint: "全局目录无写权限时，先执行 `npm config set prefix ~/.npm-global` 并把其 bin 目录加入 PATH，然后重试 `npm link`",
    run: () => runNpm(["link"], ROOT),
  },
];

const gitAvailable = await commandAvailable("git", ["--version"]);

if (checkOnly) {
  console.log("ShallowCode 安装检查");
  console.log(`  Node.js ${process.versions.node}（要求 >= ${REQUIRED_NODE}）`);
  console.log(`  Git     ${gitAvailable ? "可用" : "未找到（shallow build 需要 Git）"}`);
  console.log(`  仓库    ${ROOT}`);
  console.log(`  凭证    ${existsSync(join(ROOT, ".env")) ? ".env 已存在" : "将创建 .env"}`);
  console.log("\n安装步骤：");
  steps.forEach((step, index) => console.log(`  ${index + 1}. ${step.label} — ${step.detail}`));
  process.exit(0);
}

console.log(`ShallowCode 一键安装（${ROOT}）`);
if (!gitAvailable) console.log("提示：未找到 Git；shallow build 需要 Git。");
for (const [index, step] of steps.entries()) {
  console.log(`\n[${index + 1}/${steps.length}] ${step.label} — ${step.detail}`);
  try {
    await step.run();
  } catch (error) {
    process.stderr.write(`\n安装失败：${step.label}：${error instanceof Error ? error.message : String(error)}\n`);
    if (step.hint) process.stderr.write(`提示：${step.hint}\n`);
    process.exit(1);
  }
}

const verified = await new Promise(resolve => {
  const child = spawn(process.execPath, [join(ROOT, "bin", "shallow.mjs"), "--help"], { cwd: ROOT, stdio: "ignore" });
  child.once("error", () => resolve(false));
  child.once("close", code => resolve(code === 0));
});

console.log(`\n${verified ? "✓ 安装完成" : "! 安装步骤已完成，但入口自检未通过，请查看上面的输出"}`);
console.log("\n下一步：");
console.log(`  1. 编辑 ${join(ROOT, ".env")}，填入 OPENAI_API_KEY、OPENAI_BASE_URL、MODEL`);
console.log("  2. 在任意目录运行：shallow req（需求整理）或 shallow build（开发与交付）");
console.log("  如提示找不到 shallow，请将 npm 全局目录加入 PATH（npm prefix -g 查看位置）。");
