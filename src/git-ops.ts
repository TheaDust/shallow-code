import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

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

/** req 草稿目录：启动目录元数据，不进入应用历史。 */
const REQUIREMENTS_AGENT_DIR = ".requirements-agent";
const GITIGNORE_CONTENT = ["node_modules/", "dist/", "build/", ".next/", ".env", `${REQUIREMENTS_AGENT_DIR}/`, ""].join("\n");

export class GitCliOps implements GitOps {
  private constructor(private readonly repositoryRoot: string) {}

  static async open(outputDirectory: string, options: {
    allowExisting?: boolean; generatedPaths?: readonly string[];
  } = {}): Promise<GitCliOps> {
    const requested = resolve(outputDirectory);
    await mkdir(requested, { recursive: true });
    const canonical = await realpath(requested);
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
    if (options.allowExisting) await ensureLocalExclude(canonical, options.generatedPaths);
    await ensureIgnoreRules(canonical, options.generatedPaths ?? (options.allowExisting ? [] : undefined));
    return new GitCliOps(canonical);
  }

  async captureAccepted(message: string): Promise<string> {
    await this.validateRoot();
    // Keep the product-visible progress journal untracked so the platform still
    // packages it (it only filters gitignored paths) without it entering history.
    await requireGit(this.repositoryRoot, ["add", "-A", "--", ".", `:(top,exclude)${PROGRESS_DIR_NAME}`]);
    const head = await runGit(
      this.repositoryRoot,
      ["rev-parse", "--verify", "HEAD"],
      true,
    );
    const staged = await runGit(
      this.repositoryRoot,
      ["diff", "--cached", "--quiet"],
      true,
    );
    if (head.code === 0 && staged.code === 0) return head.stdout.trim();

    await requireGit(this.repositoryRoot, [
      "-c",
      "user.name=ShallowCode",
      "-c",
      "user.email=shallowcode@local.invalid",
      "commit",
      "--allow-empty",
      "-m",
      message,
    ]);
    return (await requireGit(this.repositoryRoot, ["rev-parse", "HEAD"])).stdout.trim();
  }

  async hasApplicationChanges(sinceSha: string): Promise<boolean> {
    await this.validateRoot();
    if (!/^[0-9a-f]{40,64}$/i.test(sinceSha)) throw new Error("Invalid application baseline SHA");
    const paths = ["--", ".", ":(top,exclude).arc", `:(top,exclude)${PROGRESS_DIR_NAME}`];
    const [changed, untracked] = await Promise.all([
      requireGit(this.repositoryRoot, ["diff", "--name-only", sinceSha, ...paths]),
      requireGit(this.repositoryRoot, ["ls-files", "--others", "--exclude-standard", ...paths]),
    ]);
    return Boolean(changed.stdout.trim() || untracked.stdout.trim());
  }

  async restoreAccepted(sha: string): Promise<void> {
    await this.validateRoot();
    if (!/^[0-9a-f]{40,64}$/i.test(sha)) {
      throw new Error(`${sha} is not a commit in the output repository`);
    }
    const commit = await runGit(
      this.repositoryRoot,
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
    await requireGit(this.repositoryRoot, [
      "restore", "--source", sha, "--staged", "--worktree", "--", ".",
      ":(top,exclude).arc", `:(top,exclude)${PROGRESS_DIR_NAME}`,
    ]);
    await requireGit(this.repositoryRoot, ["clean", "-fd", "-e", ".arc/", "-e", `${PROGRESS_DIR_NAME}/`]);
    await requireGit(this.repositoryRoot, [
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
    const root = await requireGit(canonical, ["rev-parse", "--show-toplevel"]);
    const actualRoot = await realpath(root.stdout.trim());
    if (!samePath(canonical, actualRoot)) {
      throw new Error("Output repository root changed after GitOps initialization");
    }
  }
}

async function requireGit(cwd: string, args: string[]): Promise<CommandResult> {
  const result = await runGit(cwd, args, true);
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
    : ["node_modules/", ".env", `${REQUIREMENTS_AGENT_DIR}/`, ...generatedPaths.map(path => `/${path}/`), ""].join("\n");
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

const FIRST_RUN_ALLOWED_ENTRIES = new Set([".gitignore", ".arc", "requirements", REQUIREMENTS_AGENT_DIR, "shallowcode.config.json"]);

async function requireEmptyOutputDirectory(root: string): Promise<void> {
  const unexpected = (await readdir(root)).filter(name => !FIRST_RUN_ALLOWED_ENTRIES.has(name));
  if (unexpected.length) throw new Error("Output directory must be empty before the first run: " + root);
}

const LOCAL_EXCLUDE_RULES = ["node_modules/", ".env", `${REQUIREMENTS_AGENT_DIR}/`];

/** Keep dependency and build output out of the base commit without rewriting
 * the template's own .gitignore, which its author still owns. */
async function ensureLocalExclude(root: string, generatedPaths: readonly string[] = []): Promise<void> {
  const infoDir = join(root, ".git", "info");
  const excludeFile = join(infoDir, "exclude");
  await mkdir(infoDir, { recursive: true });
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
    ":(top,exclude).arc",
  ]);
  return status.stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function samePath(left: string, right: string): boolean {
  return left.replace(/[\\/]$/, "").toLowerCase() === right.replace(/[\\/]$/, "").toLowerCase();
}
