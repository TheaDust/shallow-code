import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ProjectSpec } from "./project-spec.js";
import { parseProjectSpec } from "./project-spec.js";
import type { RunSummary } from "./pipeline.js";
import { runGit } from "./git-ops.js";
import { saveRequirementDigests, type HistoricalRequirements } from "./evolution.js";
import { formatModelUsageSummary } from "./model-usage.js";

export interface RunRecord {
  version: 1;
  requirementsDir: string;
  requirementsDigest: string;
  contractDigest: string;
  projectSpec: ProjectSpec;
  outputDir: string;
  sourceProjectDir?: string;
  inputBaseline?: string;
  inputFiles: Record<string, string>;
  requirementDigests?: Record<string, string>;
  historicalRequirements?: HistoricalRequirements;
  stageStartingPoint?: "inherited_application" | "blank_template" | "unknown";
  auditInheritedRequirements: boolean;
  generateFinalAuditPlans: boolean;
  resumedFrom?: string;
}

export function digest(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Hash bytes rather than Git state: an input may contain staged and untracked edits. */
export async function snapshotFiles(directory: string, excludes: readonly string[] = []): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function walk(prefix: string): Promise<void> {
    for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if ([".git", ".arc", "shallow-progress", "node_modules"].includes(entry.name) ||
        excludes.some(p => path === p || path.startsWith(p + "/"))) continue;
      if (entry.isSymbolicLink()) throw new Error(`Input links are not supported: ${path}`);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files[path] = digest(await readFile(join(directory, path)));
      else throw new Error(`Unsupported input file: ${path}`);
    }
  }
  await walk("");
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

export async function saveRunRecord(runDirectory: string, record: RunRecord): Promise<void> {
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  const file = join(runDirectory, "run.json");
  await writeFile(file + ".tmp", JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  await rename(file + ".tmp", file);
}

export async function loadRunRecord(runDirectory: string): Promise<RunRecord> {
  const record = JSON.parse(await readFile(join(runDirectory, "run.json"), "utf8")) as RunRecord;
  if (record.version !== 1 || !isAbsolute(record.outputDir) || !isAbsolute(record.requirementsDir) ||
    !record.inputBaseline || !/^[0-9a-f]{40,64}$/i.test(record.inputBaseline)) throw new Error("Run has no resumable input baseline");
  record.projectSpec = parseProjectSpec(record.projectSpec, "run.json.projectSpec");
  const root = await runGit(record.outputDir, ["rev-parse", "--show-toplevel"], false);
  if (await realpath(root.stdout.trim()) !== await realpath(record.outputDir)) throw new Error("Recorded workspace is not a repository root");
  return record;
}

/** A stale owner can be recovered after a crash; a live owner keeps its workspace. */
export async function lockWorkspace(directory: string): Promise<() => Promise<void>> {
  const file = join(directory, ".git", "shallowcode-owner.json");
  try { await writeFile(file, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const owner = JSON.parse(await readFile(file, "utf8")) as { pid: number };
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error("Invalid workspace owner record");
    try { process.kill(owner.pid, 0); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
      await unlink(file);
      return lockWorkspace(directory);
    }
    throw new Error(`Workspace is in use by process ${owner.pid}`);
  }
  return () => unlink(file);
}

export async function readResumeCheckpoint(runDirectory: string, record: RunRecord): Promise<{ sha: string; requirementIds: string[] }> {
  let contents: string;
  try { contents = await readFile(join(runDirectory, "run-ledger.jsonl"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    contents = "";
  }
  let sha = record.inputBaseline!;
  const ids = new Set<string>();
  const lines = contents.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let event: { acceptedSha?: string; type: string; detail?: { requirementIds?: string[]; implementedRequirementIds?: string[] } };
    try { event = JSON.parse(lines[i]); }
    catch {
      // Only a torn final append is recoverable; interior corruption loses provenance.
      if (lines.slice(i + 1).some(line => line.trim())) throw new Error("Run ledger is corrupted before its final entry");
      break;
    }
    if (event.acceptedSha && /^[0-9a-f]{40,64}$/i.test(event.acceptedSha)) sha = event.acceptedSha;
    if (event.type === "checkpoint_saved") for (const id of event.detail?.requirementIds ?? []) ids.add(id);
    if (event.type === "pipeline_finished") {
      ids.clear();
      for (const id of event.detail?.implementedRequirementIds ?? []) ids.add(id);
    }
  }
  await runGit(record.outputDir, ["cat-file", "-e", `${sha}^{commit}`], false);
  return { sha, requirementIds: [...ids] };
}

export async function writeRunReport(runDirectory: string, summary: RunSummary, patchFile?: string): Promise<void> {
  const result = { ...summary, ...(patchFile ? { patchSha256: digest(await readFile(patchFile)) } : {}) };
  await writeFile(join(runDirectory, "result.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  const groups = {
    verified: summary.verifiedRequirementIds, failed: summary.failedRequirementIds,
    inconclusive: summary.inconclusiveRequirementIds, blocked: summary.blockedRequirementIds,
    todo: summary.pendingRequirementIds, skipped: summary.skippedRequirementIds,
  };
  const rows = Object.entries(groups).flatMap(([status, ids]) => (ids ?? []).map(id => `| ${id.replaceAll("|", "\\|")} | ${status} |`));
  await writeFile(join(runDirectory, "report.md"), [
    `运行结果：${summary.status}`, ``, `可运行检查点：${summary.acceptedSha}`, ``,
    ...(summary.delivery ? [`交付检查：${summary.delivery.stage} — ${summary.delivery.message}`, ``] : []),
    "| 需求 | 当前状态 |", "| --- | --- |", ...rows, "",
    ...((summary.scenarioResults?.length ?? 0) > 0 ? ["| 需求 / 场景 | 当前状态 | 原因 |", "| --- | --- | --- |",
      ...summary.scenarioResults!.map(s => `| ${s.requirementId} / ${s.scenarioId} | ${s.status} | ${(s.reason ?? "").replace(/[\r\n|]/g, " ")} |`), ""] : []),
    ...(summary.modelUsage ? ["模型用量：", "", ...formatModelUsageSummary(summary.modelUsage).map(line => `- ${line}`), ""] : []),
    "完整执行记录与失败证据见同目录 run-ledger.jsonl 和 evidence/。", "",
  ].join("\n"), "utf8");
}

/** Exact touched-file checks precede Git's atomic patch application; the user's index is never used. */
export async function applyRun(runDirectory: string, allowPartial = false): Promise<string> {
  const record = await loadRunRecord(runDirectory);
  if (!record.sourceProjectDir) throw new Error("This run created a new project; its output directory is already the delivery");
  const result = JSON.parse(await readFile(join(runDirectory, "result.json"), "utf8")) as RunSummary & { patchSha256?: string };
  if (result.status !== "delivered" && !(allowPartial && result.status === "partial")) throw new Error("Apply requires delivered status; partial results require --allow-partial");
  const patch = join(resolve(runDirectory), "changes.patch");
  const bytes = await readFile(patch);
  if (digest(bytes) !== result.patchSha256) throw new Error("Delivery patch changed after the report was written");
  if (/^(?:new file mode|old mode|new mode) (?:120000|160000)$/m.test(bytes.toString("utf8"))) throw new Error("Delivery links and submodules cannot be applied");
  const target = await realpath(record.sourceProjectDir);
  if (record.requirementDigests) {
    try { if ((await lstat(join(target, "shallow-progress"))).isSymbolicLink()) throw new Error("Progress directory must not be a link"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (record.inputFiles["shallowcode.config.json"] && digest(await readFile(join(target, "shallowcode.config.json"))) !== record.inputFiles["shallowcode.config.json"]) {
    throw new Error("Project run configuration changed since the input baseline");
  }
  const saveProvenance = async () => {
    if (record.requirementDigests) await saveRequirementDigests(join(target, "shallow-progress"), record.requirementDigests,
      [...result.verifiedRequirementIds, ...(result.skippedRequirementIds ?? [])]);
  };
  if (!bytes.length) { await saveProvenance(); return target; }
  const invoke = (args: string[]) => runGit(target, ["--git-dir=" + join(record.outputDir, ".git"),
    "--work-tree=" + target, "-c", "core.autocrlf=false", "apply", ...args, patch], false);
  const stats = await invoke(["--numstat", "-z"]);
  for (const line of stats.stdout.split("\0").filter(Boolean)) {
    const path = line.slice(line.indexOf("\t", line.indexOf("\t") + 1) + 1);
    const parts = path.split(/[\\/]/);
    if (isAbsolute(path) || /^[A-Za-z]:/.test(path) || parts.some(p => ["..", ".git", ".arc", "shallow-progress"].includes(p.toLowerCase()))) throw new Error(`Invalid patch path: ${path}`);
    const rel = relative(target, resolve(target, path));
    if (!rel || isAbsolute(rel) || rel.startsWith("..")) throw new Error(`Patch path escapes project: ${path}`);
    let ancestor = target;
    for (const part of parts) {
      ancestor = join(ancestor, part);
      try { if ((await lstat(ancestor)).isSymbolicLink()) throw new Error(`Patch path contains a link: ${path}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    let current: string | undefined;
    try { current = digest(await readFile(join(target, path))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (current !== record.inputFiles[path]) throw new Error(`Project changed since the input baseline: ${path}. Patch and workspace are retained.`);
  }
  await invoke(["--check", "--whitespace=nowarn"]);
  await invoke(["--whitespace=nowarn"]);
  await saveProvenance();
  return target;
}
