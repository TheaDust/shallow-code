import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface CliOptions {
  requirementsDir: string;
  /**
   * Directory this run develops in: a new application at `outputDir`, or an
   * existing Web project passed with `--project`.
   */
  outputDir: string;
  budgetMs: number;
  /** Root of an existing Web project, when the run takes one over. */
  projectDir?: string;
}

export interface CliParseOptions {
  defaultOutputDir?: string;
}

export type CliInvocation = { command: "run"; options: CliOptions }
  | { command: "resume"; runDirectory: string; budgetMs: number }
  | { command: "apply"; runDirectory: string; allowPartial: boolean };

export function parseInvocation(argv: string[], options: CliParseOptions = {}): CliInvocation {
  if (argv[0] !== "resume" && argv[0] !== "apply") {
    return { command: "run", options: parseCliArgs(argv[0] === "run" ? argv.slice(1) : argv, options) };
  }
  const command = argv[0];
  const values = new Map<string, string>();
  let allowPartial = false;
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i];
    if (command === "apply" && key === "--allow-partial") { allowPartial = true; continue; }
    if (key !== "--run-dir" && !(command === "resume" && key === "--budget-ms")) throw new Error(`Unknown argument: ${key}`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    if (values.has(key)) throw new Error(`Duplicate argument: ${key}`);
    values.set(key, value);
  }
  const runDirectory = resolve(required(values, "--run-dir"));
  if (command === "apply") return { command, runDirectory, allowPartial };
  const budgetMs = Number(values.get("--budget-ms") ?? "0");
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 0) throw new Error("--budget-ms must be a non-negative integer");
  return { command, runDirectory, budgetMs };
}

export function localDefaultOutputDir(entry: "main" | "baseline"): string {
  return join(tmpdir(), "shallowcode-local", entry);
}

const KNOWN_OPTIONS = new Set([
  "--requirements-dir",
  "--output-dir",
  "--project",
  "--budget-ms",
]);

export function parseCliArgs(
  argv: string[],
  options: CliParseOptions = {},
): CliOptions {
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    if (!KNOWN_OPTIONS.has(option)) {
      throw new Error(`Unknown argument: ${option}`);
    }

    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${option}`);
    }
    values.set(option, value);
  }

  const requirementsDir = required(values, "--requirements-dir");
  const projectDir = values.get("--project");
  const outputDir = projectDir ?? values.get("--output-dir") ?? options.defaultOutputDir;
  if (outputDir === undefined) {
    throw new Error("Missing required argument: --output-dir");
  }
  if (projectDir !== undefined && values.get("--output-dir") !== undefined) {
    throw new Error("--project already names the directory this run develops in; pass either --project or --output-dir, not both");
  }
  const budgetText = values.get("--budget-ms") ?? "0";
  const budgetMs = Number(budgetText);
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 0) {
    throw new Error(`--budget-ms must be a non-negative integer, received: ${budgetText}`);
  }

  return {
    requirementsDir: resolve(requirementsDir),
    outputDir: resolve(outputDir),
    budgetMs,
    ...(projectDir === undefined ? {} : { projectDir: resolve(projectDir) }),
  };
}

function required(values: Map<string, string>, option: string): string {
  const value = values.get(option);
  if (value === undefined) {
    throw new Error(`Missing required argument: ${option}`);
  }
  return value;
}
