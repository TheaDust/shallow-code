import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runBaseline, type BaselineDependencies } from "./baseline.js";
import { discoverRequirementsDir, parseCliArgs } from "./cli.js";
import { sanitizeDiagnosticText } from "./diagnostics.js";
import { parseRunDirOverride, readEnvFile } from "./runtime-config.js";

export function parseBaselineArgs(argv: string[], cwd: string) {
  const shared: string[] = [];
  let timeoutMs: number | null = null;
  for (let index = 0; index < argv.length; index += 2) {
    if (argv[index] === "--timeout-ms") {
      timeoutMs = Number(argv[index + 1]);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
        throw new Error("--timeout-ms must be an integer from 1 to 2147483647");
      }
    } else shared.push(...argv.slice(index, index + 2));
  }
  return { ...parseCliArgs(shared, { defaultOutputDir: cwd, defaultRequirementsDir: () => discoverRequirementsDir(cwd) }), timeoutMs };
}

export async function baselineMain(argv = process.argv.slice(2), env: Record<string, string | undefined> = process.env,
  dependencies: BaselineDependencies = {}, envFile: string | null = fileURLToPath(new URL("../.env", import.meta.url)),
  cwd = process.cwd()): Promise<number> {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
    process.stdout.write("Builder self-check baseline\n\nnpm run baseline -- --requirements-dir <dir> --output-dir <app> [--timeout-ms <ms>]\nDevelopment has no time limit by default. Use --project <app> for an existing application.\n");
    return 0;
  }
  const cli = parseBaselineArgs(argv, cwd);
  if (cli.projectDir) await access(cli.projectDir);
  const merged = { ...(envFile ? await readEnvFile(envFile) : {}) } as Record<string, string | undefined>;
  for (const [key, value] of Object.entries(env)) if (value !== undefined) merged[key] = value;
  const runDirectory = join(parseRunDirOverride(merged) ?? join(tmpdir(), "shallowcode-runs"),
    `baseline-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`);
  process.stderr.write(`[ShallowCode baseline] 运行目录：${runDirectory}\n`);
  const result = await runBaseline({ ...cli, runDirectory, env: merged }, dependencies);
  process.stderr.write(`[ShallowCode baseline] ${result.status}; runtime=${result.runtimeCheck}; tokens=${result.modelUsage.total}\n`);
  if (result.error) process.stderr.write(result.error + "\n");
  return result.status === "completed" ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void baselineMain().then(code => { process.exitCode = code; }, error => {
    console.error(sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
