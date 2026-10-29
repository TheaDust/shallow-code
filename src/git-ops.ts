import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  CONTROLLER_METADATA,
  EXCLUDED_METADATA_NAMES,
  IGNORED_METADATA_RULES,
} from "./controller-metadata.js";
import { spawnProcess } from "./process-spawn.js";
import { PROGRESS_DIR_NAME } from "./progress-journal.js";

export interface GitOps {
  captureAccepted(message: string): Promise<string>;
  restoreAccepted(sha: string): Promise<void>;
  hasApplicationChanges(sinceSha: string): Promise<boolean>;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

const GIT_TIMEOUT_MS = 30_000;

const pathspecExcludes = (names: readonly string[]): string[] => names.map(name => `:(top,exclude)${name}`);
const cleanExcludes = (names: readonly string[]): string[] => names.flatMap(name => ["-e", `${name}/`]);

const GITIGNORE_CONTENT = ["node_modules/", "dist/", "build/", ".next/", ".env", ...IGNORED_METADATA_RULES, ""].join("\n");

export class GitCliOps implements GitOps {
  private constructor(private readonly repositoryRoot: string, private readonly environment?: NodeJS.ProcessEnv) {}

  static async open(outputDirectory: string, options: {
    allowExisting?: boolean; generatedPaths?: readonly string[];
    /** Keep controller history and index outside the application repository. */
    checkpointDirectory?: string;
  } = {}): Promise<GitCliOps> {
    const requested = resolve(outputDirectory);
    await mkdir(requested, { recursive: true });
    const canonical = await realpath(requested);
    if (options.checkpointDirectory) {
      const gitDirectory = resolve(options.checkpointDirectory);
      await mkdir(gitDirectory, { recursive: true });
      await requireGit(canonical, ["init", "--bare", gitDirectory]);
      const environment = { GIT_DIR: gitDirectory, GIT_WORK_TREE: canonical };
      await requireGit(canonical, ["config", "core.autocrlf", "false"], environment);
      await ensureLocalExclude(canonical, options.generatedPaths ?? [], environment);
      return new GitCliOps(canonical, environment);
    }
    const rootResult = await runGit(canonical, ["rev-parse", "--show-toplevel"], true);
    const existingRoot = rootResult.code === 0 ? await realpath(rootResult.stdout.trim()) : undefined;
    const hadRepository = existingRoot !== undefined && samePath(existingRoot, canonical);
    if (!hadRepository) {
      if (!options.allowExisting) await requireEmptyOutputDirectory(canonical);
      await requireGit(canonical, ["init"]);
      if (options.allowExisting) await requireGit(canonical, ["config", "core.autocrlf", "false"]);
    } else if (!options.allowExisting) {
      const dirt = await uncommittedEntries(canonical);
      if (dirt.length) throw new Error("Output directory has uncommitted changes from outside ShallowCode; use an isolated project workspace");
    }
    const actualRoot = await requireGit(canonical, ["rev-parse", "--show-toplevel"]);
    if (!samePath(await realpath(actualRoot.stdout.trim()), canonical)) {
      throw new Error("Output directory must be a Git repository root: " + canonical);
    }
    // 首轮运行也要写本地 exclude：即使仓库自带 .gitignore，元数据忽略规则也必须生效。
    await ensureLocalExclude(canonical, options.generatedPaths ?? []);
    await ensureIgnoreRules(canonical, options.generatedPaths ?? (options.allowExisting ? [] : undefined));
    return new GitCliOps(canonical);
  }

  async captureAccepted(message: string): Promise<string> {
    await this.validateRoot();
    // Keep the product-visible progress journal untracked so the platform still
    // packages it (it only filters gitignored paths) without it entering history.
    // 被忽略的元数据目录不能出现在 exclude 路径规格里（git add 会因此报错），
    // 它们由 .gitignore / 本地 exclude 规则排除。
    await this.require(["add", "-A", "--", ".", `:(top,exclude)${PROGRESS_DIR_NAME}`]);
    const head = await this.run(
      ["rev-parse", "--verify", "HEAD"],
      true,
    );
    const staged = await this.run(
      ["diff", "--cached", "--quiet"],
      true,
    );
    if (head.code === 0 && staged.code === 0) return head.stdout.trim();

    await this.require([
      "-c",
      "user.name=ShallowCode",
      "-c",
      "user.email=shallowcode@local.invalid",
      "commit",
      "--allow-empty",
      "-m",
      message,
    ]);
    return (await this.require(["rev-parse", "HEAD"])).stdout.trim();
  }

  async hasApplicationChanges(sinceSha: string): Promise<boolean> {
    await this.validateRoot();
    if (!/^[0-9a-f]{40,64}$/i.test(sinceSha)) throw new Error("Invalid application baseline SHA");
    const paths = ["--", ".", ...pathspecExcludes(EXCLUDED_METADATA_NAMES)];
    const [changed, untracked] = await Promise.all([
      this.require(["diff", "--name-only", sinceSha, ...paths]),
      this.require(["ls-files", "--others", "--exclude-standard", ...paths]),
    ]);
    return Boolean(changed.stdout.trim() || untracked.stdout.trim());
  }

  async restoreAccepted(sha: string): Promise<void> {
    await this.validateRoot();
    if (!/^[0-9a-f]{40,64}$/i.test(sha)) {
      throw new Error(`${sha} is not a commit in the output repository`);
    }
    const commit = await this.run(
      ["cat-file", "-e", `${sha}^{commit}`],
      true,
    );
    if (commit.code !== 0) {
      throw new Error(`${sha} is not a commit in the output repository`);
    }
    // Rejected attempts stay reachable: sync index and worktree back to the
    // accepted tree (excluding .arc, which holds run-wide audit records), then
    // record the rewind as a forward-moving recovery commit instead of
    // deleting history.
    await this.require([
      "restore", "--source", sha, "--staged", "--worktree", "--", ".",
      ...pathspecExcludes(EXCLUDED_METADATA_NAMES),
    ]);
    await this.require(["clean", "-fd", ...cleanExcludes(EXCLUDED_METADATA_NAMES)]);
    await this.require([
      "-c",
      "user.name=ShallowCode",
      "-c",
      "user.email=shallowcode@local.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "shallow: restore accepted state",
    ]);
  }

  private async validateRoot(): Promise<void> {
    const canonical = await realpath(this.repositoryRoot);
    const root = await this.require(["rev-parse", "--show-toplevel"]);
    const actualRoot = await realpath(root.stdout.trim());
    if (!samePath(canonical, actualRoot)) {
      throw new Error("Output repository root changed after GitOps initialization");
    }
  }

  private run(args: string[], allowFailure: boolean): Promise<CommandResult> {
    return runGit(this.repositoryRoot, args, allowFailure, GIT_TIMEOUT_MS, this.environment);
  }

  private require(args: string[]): Promise<CommandResult> {
    return requireGit(this.repositoryRoot, args, this.environment);
  }
}

async function requireGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<CommandResult> {
  const result = await runGit(cwd, args, true, GIT_TIMEOUT_MS, env);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result;
}

export function runGit(
  cwd: string,
  args: string[],
  allowFailure: boolean,
  timeoutMs: number = GIT_TIMEOUT_MS,
  env?: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawnProcess("git", args, {
      cwd,
      ...(env ? { env: { ...process.env, ...env } } : {}),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const hardTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`git ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs + 2_000);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardTimer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardTimer);
      if (timedOut) {
        reject(new Error(`git ${args.join(" ")} timed out after ${timeoutMs}ms`));
        return;
      }
      const result = { code: code ?? -1, stdout, stderr };
      if (!allowFailure && result.code !== 0) {
        reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`));
      } else {
        resolvePromise(result);
      }
    });
  });
}

async function ensureIgnoreRules(root: string, generatedPaths?: readonly string[]): Promise<void> {
  const gitignorePath = join(root, ".gitignore");
  try {
    await readFile(gitignorePath, "utf8");
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const content = generatedPaths === undefined ? GITIGNORE_CONTENT
    : ["node_modules/", ".env", ...IGNORED_METADATA_RULES, ...generatedPaths.map(path => `/${path}/`), ""].join("\n");
  await writeFile(gitignorePath, content, "utf8");
  await requireGit(root, ["add", ".gitignore"]);
  await requireGit(root, [
    "-c",
    "user.name=ShallowCode",
    "-c",
    "user.email=shallowcode@local.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "chore: add ShallowCode ignore rules",
  ]);
}

/**
 * 首轮运行允许预先存在的控制器元数据；`.git` 由 GitOps 单独判定
 * （走到这里说明该目录还不是仓库根）。
 */
const FIRST_RUN_ALLOWED_ENTRIES = new Set([...CONTROLLER_METADATA].filter(name => name !== ".git"));

async function requireEmptyOutputDirectory(root: string): Promise<void> {
  const unexpected = (await readdir(root)).filter(name => !FIRST_RUN_ALLOWED_ENTRIES.has(name));
  if (unexpected.length) throw new Error("Output directory must be empty before the first run: " + root);
}

const LOCAL_EXCLUDE_RULES = ["node_modules/", ".env", ...IGNORED_METADATA_RULES];

/** Keep dependency and build output out of the base commit without rewriting
 * the template's own .gitignore, which its author still owns. */
async function ensureLocalExclude(root: string, generatedPaths: readonly string[] = [], env?: NodeJS.ProcessEnv): Promise<void> {
  const gitPath = await requireGit(root, ["rev-parse", "--git-path", "info/exclude"], env);
  const excludeFile = resolve(root, gitPath.stdout.trim());
  await mkdir(dirname(excludeFile), { recursive: true });
  let content = "";
  try {
    content = await readFile(excludeFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const present = new Set(content.split(/\r?\n/).map((line) => line.trim()));
  const rules = [...LOCAL_EXCLUDE_RULES, ...generatedPaths.map(path => `/${path}/`)];
  const missing = rules.filter((rule) => !present.has(rule));
  if (missing.length === 0) return;
  const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  await writeFile(excludeFile, `${content}${separator}${missing.join("\n")}\n`, "utf8");
}

async function uncommittedEntries(root: string): Promise<string[]> {
  const status = await requireGit(root, [
    "status",
    "--porcelain",
    "--",
    ".",
    ...pathspecExcludes(EXCLUDED_METADATA_NAMES),
  ]);
  return status.stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function samePath(left: string, right: string): boolean {
  return left.replace(/[\\/]$/, "").toLowerCase() === right.replace(/[\\/]$/, "").toLowerCase();
}
