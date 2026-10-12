import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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
  /** 默认需求目录：仅在未显式给出 `--requirements-dir` 时求值。 */
  defaultRequirementsDir?: () => string;
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

  const requirementsDir = values.get("--requirements-dir") ?? options.defaultRequirementsDir?.();
  if (requirementsDir === undefined) {
    throw new Error("Missing required argument: --requirements-dir");
  }
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

/**
 * 默认需求输入：在给定目录子树中查找 `requirements.yaml`。
 * 需求文件缺失或有多个候选时都要求显式 `--requirements-dir`。
 */
export function discoverRequirementsDir(root: string): string {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === "requirements.yaml") found.push(path);
    }
  };
  visit(root);
  if (found.length === 0) {
    throw new Error(`No requirements.yaml found under ${root}; pass --requirements-dir to name the requirements directory`);
  }
  if (found.length > 1) {
    const shown = found.sort().slice(0, 5).join(", ");
    const more = found.length > 5 ? ` (+${found.length - 5} more)` : "";
    throw new Error(`Multiple requirements.yaml files found under ${root}: ${shown}${more}; pass --requirements-dir to select one`);
  }
  return dirname(found[0]);
}

function required(values: Map<string, string>, option: string): string {
  const value = values.get(option);
  if (value === undefined) {
    throw new Error(`Missing required argument: ${option}`);
  }
  return value;
}
