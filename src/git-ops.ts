import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
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

const GITIGNORE_CONTENT = ["node_modules/", "dist/", "build/", ".next/", ".env", ""].join("\n");

export class GitCliOps implements GitOps {
  private constructor(private readonly repositoryRoot: string) {}

  static async open(outputDirectory: string): Promise<GitCliOps> {
    const requested = resolve(outputDirectory);
    await mkdir(requested, { recursive: true });
    const canonical = await realpath(requested);
    const rootResult = await runGit(canonical, ["rev-parse", "--show-toplevel"], true);
    const existingRoot = rootResult.code === 0 ? await realpath(rootResult.stdout.trim()) : undefined;
    // A parent repository (such as the ShallowCode workspace) is never the output
    // repository: only a directory that is its own top level counts as one.
    const hadRepository = existingRoot !== undefined && samePath(existingRoot, canonical);
    // A directory that already holds a delivered application is an evolution
    // template: the platform hands one back as the next run's output directory.
    const evolutionTemplate = await isDeliveredApplication(canonical);
    if (!hadRepository) {
      await requireEmptyOutputDirectory(canonical, evolutionTemplate);
      await requireGit(canonical, ["init"]);
    }
    const actualRoot = await requireGit(canonical, ["rev-parse", "--show-toplevel"]);
    if (!samePath(await realpath(actualRoot.stdout.trim()), canonical)) {
      throw new Error(`Output directory must be a Git repository root: ${canonical}`);
    }
    if (hadRepository) {
      await discardPreviousRunResidue(canonical, evolutionTemplate);
    }
    if (evolutionTemplate) {
      await ensureLocalExclude(canonical);
    }
    await ensureIgnoreRules(canonical);
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
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawnProcess("git", args, {
      cwd,
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

async function ensureIgnoreRules(root: string): Promise<void> {
  const gitignorePath = join(root, ".gitignore");
  try {
    await readFile(gitignorePath, "utf8");
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFile(gitignorePath, GITIGNORE_CONTENT, "utf8");
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

const SHALLOW_ROOT_COMMIT_SUBJECTS = new Set([
  "shallow: initial state",
  "chore: add ShallowCode ignore rules",
]);

const FIRST_RUN_ALLOWED_ENTRIES = new Set([".gitignore", ".arc", "requirements"]);

/** A delivered application: frontend/ and backend/ both exist as directories. */
async function isDeliveredApplication(root: string): Promise<boolean> {
  const isDirectory = async (name: string): Promise<boolean> => {
    try {
      return (await stat(join(root, name))).isDirectory();
    } catch {
      return false;
    }
  };
  return (await isDirectory("frontend")) && (await isDirectory("backend"));
}

async function requireEmptyOutputDirectory(root: string, evolutionTemplate = false): Promise<void> {
  if (evolutionTemplate) return;
  const entries = await readdir(root);
  const unexpected = entries.filter((name) => !FIRST_RUN_ALLOWED_ENTRIES.has(name));
  if (unexpected.length > 0) {
    throw new Error(
      `Output directory must be empty before the first run: ${root} (found: ${unexpected.slice(0, 5).join(", ")})`,
    );
  }
}

const LOCAL_EXCLUDE_RULES = ["node_modules/", "dist/", "build/", ".next/", ".env"];

/** Keep dependency and build output out of the base commit without rewriting
 * the template's own .gitignore, which its author still owns. */
async function ensureLocalExclude(root: string): Promise<void> {
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
  const missing = LOCAL_EXCLUDE_RULES.filter((rule) => !present.has(rule));
  if (missing.length === 0) return;
  const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  await writeFile(excludeFile, `${content}${separator}${missing.join("\n")}\n`, "utf8");
}

async function discardPreviousRunResidue(root: string, evolutionTemplate = false): Promise<void> {
  const rootCommit = await runGit(root, ["rev-list", "--max-parents=0", "HEAD"], true);
  const dirt = await uncommittedEntries(root);
  const ours =
    rootCommit.code === 0 &&
    SHALLOW_ROOT_COMMIT_SUBJECTS.has(
      (await requireGit(root, ["log", "-1", "--format=%s", rootCommit.stdout.trim()]))
        .stdout.trim(),
    );
  if (!ours) {
    if (dirt.length > 0 && !evolutionTemplate) {
      throw new Error(
        `Output directory has uncommitted changes from outside ShallowCode: ${root} (${dirt.length} entries: ${dirt
          .slice(0, 3)
          .map((entry) => entry.slice(3))
          .join(", ")})`,
      );
    }
    return;
  }
  // Delivered files are the platform's new baseline, including staged edits,
  // deletions and untracked source. Old Shallow history does not authorize
  // resetting them to the previous run's HEAD.
  if (dirt.length > 0 && !evolutionTemplate) {
    await requireGit(root, ["reset", "--hard", "HEAD"]);
    await requireGit(root, ["clean", "-fd", "-e", ".arc/", "-e", `${PROGRESS_DIR_NAME}/`]);
  }
  await rm(join(root, ".arc", "runner-events.jsonl"), { force: true });
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
