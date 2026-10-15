import { copyFile, lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { runGit } from "./git-ops.js";

const METADATA = new Set([".git", ".gitignore", ".arc", "requirements", ".requirements-agent", "shallow-progress", "shallowcode.config.json"]);

/** A fresh output may carry configuration and requirements before a scaffold exists. */
export async function hasProjectFiles(directory: string): Promise<boolean> {
  return (await readdir(directory)).some(name => !METADATA.has(name));
}

/** Snapshot current files, including staged and untracked source, without changing the input repository. */
export async function copyProjectWorkspace(sourceDirectory: string, workspaceDirectory: string,
  generatedPaths: readonly string[] = []): Promise<string> {
  const source = await realpath(sourceDirectory);
  const workspace = resolve(workspaceDirectory);
  const inside = (parent: string, child: string) => {
    const rel = relative(parent, child);
    return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\"));
  };
  if (inside(source, workspace) || inside(workspace, source)) throw new Error("Project workspace must be separate from its source");
  await mkdir(workspace, { recursive: true });
  if ((await lstat(workspace)).isSymbolicLink()) throw new Error("Project workspace must be a real directory");
  if (inside(source, await realpath(workspace)) || inside(await realpath(workspace), source)) throw new Error("Project workspace resolves into its source");
  if ((await readdir(workspace)).length) throw new Error("Project workspace must be empty");
  async function copy(directory: string, prefix = ""): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const rel = prefix ? prefix + "/" + entry.name : entry.name;
      if (entry.name === "node_modules" || (!prefix && [".git", ".arc", "shallow-progress"].includes(entry.name)) ||
        generatedPaths.some(p => rel === p || rel.startsWith(p + "/"))) continue;
      const from = join(directory, entry.name), to = join(workspace, rel);
      if (entry.isSymbolicLink()) throw new Error("Project links are not supported: " + rel);
      if (entry.isDirectory()) { await mkdir(to); await copy(from, rel); }
      else if (entry.isFile()) {
        const before = await lstat(from);
        await copyFile(from, to);
        const after = await lstat(from);
        if (after.isSymbolicLink() || before.ctimeMs !== after.ctimeMs || before.size !== after.size) throw new Error("Project changed while copying: " + rel);
      } else throw new Error("Unsupported project file: " + rel);
    }
  }
  await copy(source);
  return workspace;
}

/** Include untracked work in a binary-capable patch using a separate index. */
export async function writeProjectPatch(directory: string, baseline: string, runDirectory: string): Promise<string> {
  const index = join(resolve(runDirectory), "patch-index");
  const patch = join(resolve(runDirectory), "changes.patch");
  const environment = { GIT_INDEX_FILE: index };
  const paths = ["--", ".", ":(top,exclude).arc", ":(top,exclude)shallow-progress"];
  const invoke = async (args: string[]) => {
    const result = await runGit(directory, args, true, 30_000, environment);
    if (result.code !== 0) throw new Error(result.stderr.trim() || "Could not export project changes");
    return result.stdout;
  };
  await invoke(["read-tree", "HEAD"]);
  await invoke(["add", "-A", ...paths]);
  const content = await invoke(["diff", "--cached", "--binary", "--no-renames", "--no-ext-diff", "--no-textconv", baseline, ...paths]);
  await writeFile(patch, content, "utf8");
  return patch;
}
