#!/usr/bin/env node
// ShallowCode 全局命令：shallow req（需求整理）| shallow build（开发与交付）。
const USAGE = `ShallowCode —— shallow <子命令>

子命令：
  req       需求整理：对话生成 requirements/requirements.yaml（写在当前目录）
  build     开发与交付：按需求开发或修改 Web 应用并独立验收

示例：
  shallow req
  shallow build                                # 查找当前目录及其子目录中的 requirements.yaml，产物输出到当前目录
  shallow build --requirements-dir <需求目录> --output-dir <新项目目录>
  shallow build --requirements-dir <需求目录> --project <已有项目目录>
  shallow build resume --run-dir <运行目录>
  shallow build apply --run-dir <运行目录>
`;

const [subcommand, ...rest] = process.argv.slice(2);

if (subcommand === undefined) {
  process.stderr.write(USAGE);
  process.exitCode = 1;
} else if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
  process.stdout.write(USAGE);
} else if (subcommand === "req") {
  if (rest.length) {
    process.stderr.write(`shallow req 不接受额外参数：${rest.join(" ")}\n`);
    process.exitCode = 1;
  } else {
    const { register } = await import("tsx/esm/api");
    register();
    await import("../requirements-agent/src/main.ts");
  }
} else if (subcommand === "build") {
  const { register } = await import("tsx/esm/api");
  register();
  const { runMain } = await import("../index.ts");
  await runMain(rest);
} else {
  process.stderr.write(`未知子命令：${subcommand}\n\n${USAGE}`);
  process.exitCode = 1;
}
