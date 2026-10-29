import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { NON_APPLICATION_METADATA } from "./controller-metadata.js";
import type { ProjectSpec } from "./project-spec.js";
import { parseProjectSpec } from "./project-spec.js";
import type { RunSummary } from "./pipeline.js";
import { runGit } from "./git-ops.js";
import { formatModelUsageSummary } from "./model-usage.js";
import type { VerifierConfig } from "./runtime-config.js";
import { ArtifactStore } from "./verifier/artifacts.js";
import type { EvidenceReceipt } from "./verifier/port.js";

export interface RunRecord {
  version: 4;
  requirementsDir: string;
  requirementsDigest: string;
  contractDigest: string;
  projectSpec: ProjectSpec;
  initializationPath?: import("./project-initialization.js").InitializationPath;
  outputDir: string;
  inputBaseline?: string;
  checkpointGitDirectory?: string;
  inputFiles: Record<string, string>;
  requirementDigests?: Record<string, string>;
  startingPoint?: "inherited_application" | "blank_template" | "unknown";
  verifier: VerifierConfig;
  bindingDigest?: string;
  verifierRunId?: string;
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
      if (NON_APPLICATION_METADATA.has(entry.name) || entry.name === "node_modules" ||
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
  if (record.version !== 4 || !isAbsolute(record.outputDir) || !isAbsolute(record.requirementsDir) ||
    !record.inputBaseline || !/^[0-9a-f]{40,64}$/i.test(record.inputBaseline)) throw new Error("Run format is unsupported; start a new Verifier run");
  if (!record.verifier || !record.verifierRunId || record.verifier.mode !== "active") throw new Error("Verifier run is missing its execution settings");
  record.projectSpec = parseProjectSpec(record.projectSpec, "run.json.projectSpec");
  const gitEnv = record.checkpointGitDirectory ? { GIT_DIR: record.checkpointGitDirectory, GIT_WORK_TREE: record.outputDir } : undefined;
  const root = await runGit(record.outputDir, ["rev-parse", "--show-toplevel"], false, 30_000, gitEnv);
  if (await realpath(root.stdout.trim()) !== await realpath(record.outputDir)) throw new Error("Recorded workspace is not a repository root");
  return record;
}

/** A stale owner can be recovered after a crash; a live owner keeps its workspace. */
export async function lockWorkspace(directory: string): Promise<() => Promise<void>> {
  const root = await realpath(directory);
  const key = digest(process.platform === "win32" ? root.toLowerCase() : root);
  const lockDirectory = join(tmpdir(), "shallowcode-locks");
  await mkdir(lockDirectory, { recursive: true });
  const file = join(lockDirectory, key + ".json");
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

export async function writeRunReport(runDirectory: string, summary: RunSummary): Promise<void> {
  await writeFile(join(runDirectory, "result.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
  const groups = {
    verified: summary.verifiedRequirementIds, failed: summary.failedRequirementIds,
    inconclusive: summary.inconclusiveRequirementIds, blocked: summary.blockedRequirementIds,
    todo: summary.pendingRequirementIds, skipped: summary.skippedRequirementIds,
  };
  const rows = Object.entries(groups).flatMap(([status, ids]) => (ids ?? []).map(id => `| ${id.replaceAll("|", "\\|")} | ${status} |`));
  await writeFile(join(runDirectory, "report.md"), [
    `运行结果：${summary.status}`, ``, `可运行检查点：${summary.acceptedSha}`, ``,
    ...(summary.verifier?.semanticReview !== undefined ? [
      `Verifier 设置：独立语义复核${summary.verifier.semanticReview ? "开启" : "关闭"}；历史程序重放${summary.verifier.replay ? "开启" : "关闭"}。`, "",
      ...(summary.verifier.replay === false ? ["验收结果按各功能组原检查快照汇总，逐项快照见 Verifier 验收证据。", ""] : []),
    ] : []),
    ...(summary.delivery ? [`交付检查：${summary.delivery.stage} — ${summary.delivery.message}`, ``] : []),
    "| 需求 | 当前状态 |", "| --- | --- |", ...rows, "",
    ...((summary.scenarioResults?.length ?? 0) > 0 ? [
      `场景覆盖：已验证 ${summary.scenarioResults!.filter(item => item.status === "verified").length}/${summary.scenarioResults!.length}` +
        (["failed", "inconclusive", "not_run"] as const).map(status => {
          const labels = { failed: "失败", inconclusive: "无法判断", not_run: "未运行" } as const;
          const count = summary.scenarioResults!.filter(item => item.status === status).length;
          return count ? `，${labels[status]} ${count}` : "";
        }).join(""), "",
      "| 需求 / 场景 | 当前状态 | 原因 |", "| --- | --- | --- |",
      ...summary.scenarioResults!.map(s => `| ${s.requirementId} / ${s.scenarioId} | ${s.status} | ${(s.reason ?? "").replace(/[\r\n|]/g, " ")} |`), ""] : []),
    ...(summary.modelUsage ? ["模型用量：", "", ...formatModelUsageSummary(summary.modelUsage).map(line => `- ${line}`), ""] : []),
    "完整执行记录与失败证据见同目录 run-ledger.jsonl 和 evidence/。", "",
  ].join("\n"), "utf8");
  if (summary.verifier?.outcomes) await writeVerifierExplanation(runDirectory, summary);
}

async function writeVerifierExplanation(runDirectory: string, summary: RunSummary): Promise<void> {
  const store = new ArtifactStore(join(runDirectory, "verifier"), "report-reader");
  const checkedVersion = summary.verifier!.verifiedSnapshotId
    ?? (summary.verifier!.replay === false ? "按功能组原检查快照汇总" : "尚未确认");
  const lines = ["# Verifier 验收证据", "", `当前检查版本：${checkedVersion}`, "",
    ...(summary.verifier!.semanticReview !== undefined ? [`独立语义复核：${summary.verifier!.semanticReview ? "开启" : "关闭"}；历史程序重放：${summary.verifier!.replay ? "开启" : "关闭"}`, ""] : []),
    "每项结果记录需求依据、执行观察与断言；链接指向本次运行保存的原始证据。", ""];
  const quote = (value: unknown): string => String(value).replace(/[\r\n]+/g, " ").replaceAll("|", "\\|");
  for (const outcome of summary.verifier!.outcomes!) {
    lines.push(`## ${quote(outcome.requirementId)} / ${quote(outcome.scenarioId)} / ${quote(outcome.clauseId)}`, "",
      `结论：${outcome.status}${outcome.reason ? `；${quote(outcome.reason)}` : ""}`, "");
    if (outcome.snapshotId) lines.push(`检查快照：${quote(outcome.snapshotId)}`, "");
    const seen = new Set<string>();
    for (const ref of outcome.evidence) {
      if (seen.has(ref.digest)) continue;
      seen.add(ref.digest);
      const receipt = await store.getJson<EvidenceReceipt>(ref);
      if (receipt.program && receipt.kind === "assertion") {
        const contract = await store.getJson<{ clauses: Array<{ id: string; basis: string }> }>(receipt.program.contract);
        const clause = contract.clauses.find(item => item.id === outcome.clauseId);
        if (clause) lines.push(`原文依据：${quote(clause.basis)}`, "");
      }
      const payload = await store.readTypedJson(receipt.payload);
      lines.push(`- ${receipt.kind}${receipt.checkpointId ? ` / ${quote(receipt.checkpointId)}` : ""}；环境 ${receipt.environment.id.slice(0, 12)}；[收据](verifier/objects/${ref.id})`, "",
        "```json", JSON.stringify(payload, null, 2).replaceAll("```", "\\u0060\\u0060\\u0060"), "```", "");
    }
  }
  await writeFile(join(runDirectory, "verifier-report.md"), lines.join("\n"), { encoding: "utf8", mode: 0o600 });
  await appendFile(join(runDirectory, "report.md"), "\n逐子句证据见 [Verifier 验收证据](verifier-report.md)。\n", "utf8");
}
