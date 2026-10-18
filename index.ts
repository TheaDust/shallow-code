import { access, copyFile, cp, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PromptBuilder } from "./src/builder/prompt-builder.js";
import { VisionCapability } from "./src/builder/vision-probe.js";
import { PiWorkerClient } from "./src/builder/pi-worker-client.js";
import { discoverRequirementsDir, parseInvocation, type CliOptions } from "./src/cli.js";
import { SnapshotStore } from "./src/snapshot-store.js";
import { ArtifactStore, atomicWrite } from "./src/checker/artifacts.js";
import type { ContentRef } from "./src/checker/port.js";
import { createCheckerAgent, createPiCheckerModel, type CheckerModelUsage } from "./src/checker/agent.js";
import type { CheckerRuntime } from "./src/checker-pipeline.js";
import { GitCliOps } from "./src/git-ops.js";
import { HumanRunFormatter } from "./src/human-log.js";
import { BuildTui, buildResult } from "./src/terminal/build-tui.js";
import { ProgressJournal, PROGRESS_DIR_NAME } from "./src/progress-journal.js";
import { LlmFeatureGrouper } from "./src/llm-feature-grouper.js";
import {
  runPipeline,
  type PipelineOptions,
  type RunSummary,
} from "./src/pipeline.js";
import type { LogSink } from "./src/run-state.js";
import { sanitizeDiagnosticText } from "./src/diagnostics.js";
import { resolveModelRates, type ModelRates } from "./src/model-usage.js";
import {
  deriveModelTimeouts,
  parseBuilderContextWindow,
  parseCheckerConfig,
  parseEvolutionAuditInherited,
  parseRunDirOverride,
  readEnvFile,
  resolveSseCaptureDir,
  readGatewayConfig,
  referenceImagesEnabled,
  type GatewayConfig,
} from "./src/runtime-config.js";
import { loadProjectSpec, type ProjectSpec } from "./src/project-spec.js";
import { applications } from "./src/adapters/index.js";
import { checkerAdapters } from "./src/adapters/checker.js";
import { copyProjectWorkspace, hasProjectFiles, writeProjectPatch } from "./src/project-workspace.js";
import { applyRun, digest, loadRunRecord, lockWorkspace, readResumeCheckpoint, saveRunRecord, snapshotFiles, writeRunReport, type RunRecord } from "./src/run-record.js";
import { loadRequirementCatalog } from "./src/catalog.js";
import { readHistoricalRequirementIds, requirementDigest, saveRequirementDigests } from "./src/evolution.js";

export interface AgentExecutionContext {
  runRecord: RunRecord;
  resumeCheckpointSha?: string;
  sourceProjectDir?: string;
  /** Builder 侧网关（SHALLOW_BUILDER_* 覆盖，缺省公共网关）。 */
  builderGateway: GatewayConfig;
  /** Checker / 功能分组侧网关（SHALLOW_CHECKER_* 覆盖，缺省公共网关）。 */
  checkerGateway: GatewayConfig;
  /** 解析后的模型单价（USD / 百万 token）；null 表示只统计 token。 */
  builderModelCost: ModelRates | null;
  checkerModelCost: ModelRates | null;
  pipelineOptions: PipelineOptions;
  modelTimeouts: {
    builderTimeoutMs: number;
    checkerTimeoutMs: number;
  };
  /** Mainline Pi context ceiling (`SHALLOW_BUILDER_CONTEXT_WINDOW`). */
  builderContextWindow: number;
  /** Opt-in raw SSE capture directory for the Pi worker (`SHALLOW_CAPTURE_SSE`). */
  sseCaptureDir?: string | null;
  /** Whether requirement reference images may enter the model input (`SHALLOW_REFERENCE_IMAGES`). */
  referenceImages: boolean;
}

export type AgentExecution = (
  context: AgentExecutionContext,
) => Promise<RunSummary>;

/** 入口默认读取仓库根 .env：锚定模块位置，任意启动目录都能找到凭证。 */
export function defaultEnvFile(): string {
  return fileURLToPath(new URL(".env", import.meta.url));
}

export async function main(
  argv: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
  execute: AgentExecution = executeProduction,
  envFile: string | null = defaultEnvFile(),
  cwd: string = process.cwd(),
): Promise<number> {
  // 结果卡总耗时从命令开始计时，覆盖输入准备、工作区复制与整轮执行。
  const startedAtMs = Date.now();
  // 需求输入缺省在当前目录子树中查找唯一的 requirements.yaml；找不到或有多个
  // 候选时要求显式 --requirements-dir。输出目录缺省为当前目录。
  const invocation = parseInvocation(argv, {
    defaultOutputDir: cwd,
    defaultRequirementsDir: () => discoverRequirementsDir(cwd),
  });
  if (invocation.command === "apply") {
    const directory = await applyRun(invocation.runDirectory, invocation.allowPartial);
    process.stderr.write(`[ShallowCode] 已应用项目改动：${directory}\n`);
    return 0;
  }
  const prior = invocation.command === "resume" ? await loadRunRecord(invocation.runDirectory) : undefined;
  const cli: CliOptions = invocation.command === "run" ? invocation.options : {
    requirementsDir: prior!.requirementsDir, outputDir: prior!.outputDir, budgetMs: invocation.budgetMs,
  };
  const mergedEnv = await mergeGatewayEnv(env, envFile);
  const requestedChecker = parseCheckerConfig(mergedEnv);
  if (prior?.checker && ((mergedEnv.SHALLOW_CHECKER_MODE && requestedChecker.mode !== prior.checker.mode) ||
    (mergedEnv.SHALLOW_CHECKER_CONCURRENCY && requestedChecker.concurrency !== prior.checker.concurrency))) {
    throw new Error("Resume Checker settings changed; start a new run for the updated settings");
  }
  const checker = prior?.checker ?? requestedChecker;
  const builderGateway = readGatewayConfig(mergedEnv, "SHALLOW_BUILDER");
  const checkerGateway = readGatewayConfig(mergedEnv, "SHALLOW_CHECKER");
  // 单价来自内置模型目录，可被 MODEL_COST_* / SHALLOW_BUILDER_COST_* /
  // SHALLOW_CHECKER_COST_* 按字段覆盖；解析失败时只统计 token。
  const builderModelCost = resolveModelRates(builderGateway.baseUrl, builderGateway.model,
    { component: "SHALLOW_BUILDER", env: mergedEnv });
  const checkerModelCost = resolveModelRates(checkerGateway.baseUrl, checkerGateway.model,
    { component: "SHALLOW_CHECKER", env: mergedEnv });
  const requirementsFile = join(cli.requirementsDir, "requirements.yaml");
  try {
    await access(requirementsFile);
  } catch {
    throw new Error(`requirements.yaml is not readable at ${requirementsFile}`);
  }
  if (cli.projectDir) await access(cli.projectDir);
  await mkdir(cli.outputDir, { recursive: true });
  const runId = `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  // An existing Web project declares how it runs; a blank output directory gets
  // the shipped minimal-web template's declared contract.
  const spec = prior?.projectSpec ?? await loadProjectSpecOrDefault(cli.outputDir);
  const requirementFiles = await snapshotFiles(cli.requirementsDir);
  const requirementsDigest = digest(JSON.stringify(requirementFiles));
  const contractDigest = await controllerContractDigest(spec);
  if (prior && (prior.requirementsDigest !== requirementsDigest || prior.contractDigest !== contractDigest)) {
    throw new Error("Resume inputs changed (requirements, project contract, prompts or engine); start a new run for the updated inputs");
  }
  const checkpoint = prior && invocation.command === "resume" ? await readResumeCheckpoint(invocation.runDirectory, prior) : undefined;
  const applicationContract = await applications.get(spec.adapter ?? "web").configure(spec, mergedEnv);
  const runDir = parseRunDirOverride(mergedEnv) ?? join(tmpdir(), "shallowcode-runs");
  const sseCaptureDir = resolveSseCaptureDir(mergedEnv, join(runDir, runId, "sse-capture"));
  const referenceImages = referenceImagesEnabled(mergedEnv);
  const runDirectory = join(runDir, runId);
  await assertPrivateRunDirectory(cli.outputDir, runDirectory);
  await assertPrivateRunDirectory(cli.requirementsDir, runDirectory);
  const requirementSnapshot = join(runDirectory, "requirements");
  for (const path of Object.keys(requirementFiles)) {
    const destination = join(requirementSnapshot, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(cli.requirementsDir, path), destination);
  }
  if (digest(JSON.stringify(await snapshotFiles(requirementSnapshot))) !== requirementsDigest) throw new Error("Requirements changed while copying the run inputs");
  const inheritedProject = prior ? prior.sourceProjectDir !== undefined || prior.stageStartingPoint === "inherited_application" : cli.projectDir !== undefined || await hasProjectFiles(cli.outputDir);
  const workingDirectory = inheritedProject && !prior
    ? await copyProjectWorkspace(cli.outputDir, join(runDirectory, "workspace"), spec.generatedPaths,
      spec.dataPaths)
    : cli.outputDir;
  const inputCatalog = await loadRequirementCatalog(join(requirementSnapshot, "requirements.yaml"), { inheritedApplication: inheritedProject });
  const requirementDigests = Object.fromEntries(inputCatalog.requirements.map(r => [r.id, requirementDigest(r, requirementFiles)]));
  const sourceHistory = inheritedProject ? await readHistoricalRequirementIds(join(prior?.sourceProjectDir ?? cli.outputDir, PROGRESS_DIR_NAME)) : undefined;
  const historicalRequirements = prior?.historicalRequirements ?? (sourceHistory ? { ...sourceHistory, requirementIds: [...sourceHistory.requirementIds] } : undefined);
  const pipelineOptions: PipelineOptions = {
    checker,
    requirementDigests,
    historicalRequirements,
    requirementsFile: join(requirementSnapshot, "requirements.yaml"),
    outputDir: workingDirectory,
    ledgerFile: join(runDir, runId, "run-ledger.jsonl"),
    totalBudgetMs: cli.budgetMs,
    applicationContract,
    progressDir: join(workingDirectory, PROGRESS_DIR_NAME),
    ...(inheritedProject ? { historicalProgressDir: join(prior?.sourceProjectDir ?? cli.outputDir, PROGRESS_DIR_NAME), stageStartingPoint: "inherited_application" as const } : {}),
    auditInheritedRequirements: prior?.auditInheritedRequirements ?? parseEvolutionAuditInherited(mergedEnv),
    ...(checkpoint ? { resumedRequirementIds: checkpoint.requirementIds } : {}),
  };
  const runRecord: RunRecord = {
    version: 3, checker,
    checkerRunId: prior?.checkerRunId ?? runId,
    ...(prior?.bindingDigest ? { bindingDigest: prior.bindingDigest } : {}),
    requirementsDir: cli.requirementsDir, requirementsDigest, contractDigest, projectSpec: spec,
    outputDir: workingDirectory,
    ...(prior?.sourceProjectDir ? { sourceProjectDir: prior.sourceProjectDir } : inheritedProject && !prior ? { sourceProjectDir: cli.outputDir } : {}),
    inputFiles: prior?.inputFiles ?? await snapshotFiles(workingDirectory, spec.generatedPaths),
    requirementDigests,
    historicalRequirements,
    ...(prior ? { inputBaseline: prior.inputBaseline, stageStartingPoint: prior.stageStartingPoint, resumedFrom: invocation.command === "resume" ? invocation.runDirectory : undefined } : {}),
    auditInheritedRequirements: pipelineOptions.auditInheritedRequirements ?? false,
  };
  await saveRunRecord(runDirectory, runRecord);
  if (invocation.command === "resume") {
    await cp(join(invocation.runDirectory, "checker"), join(runDirectory, "checker"), { recursive: true,
      filter: path => !["workers", "sessions"].includes(path.split(/[\\/]/).at(-1)!) });
  }
  process.stderr.write(`[ShallowCode] 运行目录：${runDirectory}\n`);
  const summary = await execute({
    runRecord, ...(checkpoint ? { resumeCheckpointSha: checkpoint.sha } : {}),
    ...(runRecord.sourceProjectDir ? { sourceProjectDir: runRecord.sourceProjectDir } : {}),
    builderGateway,
    checkerGateway,
    builderModelCost,
    checkerModelCost,
    pipelineOptions,
    modelTimeouts: deriveModelTimeouts(cli.budgetMs),
    builderContextWindow: parseBuilderContextWindow(mergedEnv),
    sseCaptureDir,
    referenceImages,
  }).catch((error: unknown) => {
    throw new Error(sanitizeDiagnosticText(error instanceof Error ? error.message : String(error), gatewaySecrets(builderGateway, checkerGateway)));
  });
  const patch = runRecord.inputBaseline ? await writeProjectPatch(workingDirectory, runRecord.inputBaseline, runDirectory) : undefined;
  await saveRequirementDigests(join(workingDirectory, PROGRESS_DIR_NAME), requirementDigests,
    [...summary.verifiedRequirementIds, ...(summary.skippedRequirementIds ?? [])]);
  if (patch) process.stderr.write(`[ShallowCode] 项目改动补丁：${patch}\n`);
  await writeRunReport(runDirectory, summary, patch);
  process.stderr.write(buildResult(summary, runDirectory, patch, runRecord.sourceProjectDir ?? workingDirectory,
    Date.now() - startedAtMs,
    Boolean(process.stderr.isTTY) && mergedEnv.NO_COLOR === undefined && mergedEnv.TERM !== "dumb", process.stderr.columns ?? 80));
  return summary.status === "failed" ? 1 : summary.status === "partial" ? 2 : 0;
}

async function controllerContractDigest(spec: ProjectSpec): Promise<string> {
  const promptDir = new URL("./prompts/", import.meta.url);
  const hash = createHash("sha256").update(JSON.stringify(applications.get(spec.adapter ?? "web").parseSpec(spec)))
    .update(await readFile(new URL("./package-lock.json", import.meta.url)));
  for (const name of (await readdir(promptDir, { recursive: true })).filter(name => name.endsWith(".md")).sort()) {
    const path = name.replaceAll("\\", "/");
    hash.update(path).update("\0").update((await readFile(new URL(path, promptDir), "utf8")).replace(/\r\n/g, "\n"));
  }
  return hash.digest("hex");
}

/**
 * An existing Web project declares how it runs. A directory this run creates
 * from scratch has nothing to declare yet, so it starts from the shipped
 * minimal-web template's spec; the scaffold written into it matches.
 */
async function loadProjectSpecOrDefault(outputDir: string): Promise<ProjectSpec> {
  try {
    return await loadProjectSpec(outputDir, undefined, (raw, origin) => {
      const id = (raw as { adapter?: string })?.adapter ?? "web";
      return applications.get(id).parseSpec(raw, origin);
    });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("Missing project run configuration:")) throw error;
    if (await hasProjectFiles(outputDir)) throw error;
    return applications.get("web").defaultSpec();
  }
}

async function mergeGatewayEnv(
  env: Record<string, string | undefined>,
  envFile: string | null,
): Promise<Record<string, string | undefined>> {
  if (!envFile) return env;
  const merged: Record<string, string | undefined> = {
    ...(await readEnvFile(envFile)),
  };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/** 所有可能出现在诊断文本里的凭证，供统一脱敏。 */
function gatewaySecrets(...gateways: GatewayConfig[]): string[] {
  return [...new Set(gateways.map(gateway => gateway.apiKey))];
}

async function executeProduction(
  context: AgentExecutionContext,
): Promise<RunSummary> {
  const { builderGateway, checkerGateway, builderModelCost, checkerModelCost, pipelineOptions, modelTimeouts, builderContextWindow, sseCaptureDir, referenceImages, sourceProjectDir } = context;
  const runLogFile = join(dirname(pipelineOptions.ledgerFile), "run-log.txt");
  await assertPrivateRunDirectory(pipelineOptions.outputDir, dirname(runLogFile));
  process.stderr.write(`[ShallowCode] 运行日志文件：${runLogFile}\n`);
  if (sseCaptureDir) process.stderr.write(`[ShallowCode] SSE 抓包已启用（仅诊断用途）：${sseCaptureDir}\n`);
  process.stderr.write(`[ShallowCode] 参考图片：${referenceImages ? "已开启（首次附带前预探测模型视觉能力）" : "已关闭"}\n`);
  const applicationAdapter = applications.get(pipelineOptions.applicationContract.adapterId);
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY && process.env.TERM !== "dumb");
  let releaseWorkspace: (() => Promise<void>) | undefined;
  let tui: BuildTui | undefined;
  try {
    const builder = new PromptBuilder(new PiWorkerClient(builderGateway, join(dirname(runLogFile), "pi-sessions"), sseCaptureDir ?? undefined, {
      ...(builderModelCost ? { modelCost: builderModelCost } : {}),
      heartbeat: !interactive,
      applications,
      onProgress: progress => { tui?.view.liveUsage(progress); },
    }), {
      timeoutMs: modelTimeouts.builderTimeoutMs,
      requirementsDir: dirname(pipelineOptions.requirementsFile),
      contextWindow: builderContextWindow,
      referenceImages,
      visionProbe: new VisionCapability(builderGateway),
      ...(builderModelCost ? { modelCost: builderModelCost } : {}),
    });
    const git = await GitCliOps.open(pipelineOptions.outputDir, {
      allowExisting: sourceProjectDir !== undefined || context.resumeCheckpointSha !== undefined, generatedPaths: pipelineOptions.applicationContract.generatedPaths,
    });
    releaseWorkspace = await lockWorkspace(pipelineOptions.outputDir);
    if (context.resumeCheckpointSha) {
      if (await git.hasApplicationChanges(context.resumeCheckpointSha)) await git.captureAccepted("shallow: interrupted work before resume");
      await git.restoreAccepted(context.resumeCheckpointSha);
      const actualSpec = await loadProjectSpecOrDefault(pipelineOptions.outputDir);
      if (await controllerContractDigest(actualSpec) !== context.runRecord.contractDigest) throw new Error("Checkpoint project configuration changed; start a new run using that project configuration");
    }
    const inputBaseline = context.runRecord.inputBaseline ?? await git.captureAccepted("shallow: input baseline");
    context.runRecord.inputBaseline = inputBaseline;
    await saveRunRecord(dirname(runLogFile), context.runRecord);
    if (sourceProjectDir) {
      await writeFile(join(dirname(runLogFile), "workspace.json"), JSON.stringify({
        sourceDirectory: sourceProjectDir, directory: pipelineOptions.outputDir, baseline: inputBaseline,
      }, null, 2) + "\n", "utf8");
      process.stderr.write(`[ShallowCode] 开发副本：${pipelineOptions.outputDir}\n`);
    }
    // Git owns rollback from this point onward. Install the generic shell before
    // runPipeline captures its initial baseline, and never touch an existing app.
    const starterScaffold = await applicationAdapter.installScaffold(
      pipelineOptions.outputDir,
      pipelineOptions.applicationContract,
    );
    const stageStartingPoint = context.resumeCheckpointSha && context.runRecord.stageStartingPoint
      ? context.runRecord.stageStartingPoint
      : sourceProjectDir !== undefined ? "inherited_application" as const : starterScaffold.status === "skipped_existing_application"
      ? "inherited_application" as const
      : starterScaffold.status === "installed"
        ? "blank_template" as const
        : "unknown" as const;
    context.runRecord.stageStartingPoint = context.resumeCheckpointSha ? context.runRecord.stageStartingPoint : stageStartingPoint;
    await saveRunRecord(dirname(runLogFile), context.runRecord);
    process.stderr.write(`[ShallowCode] 通用脚手架：${starterScaffold.status}（${starterScaffold.reason}）\n`);
    const promptDir = new URL("./prompts/", import.meta.url);
    const promptHash = createHash("sha256");
    for (const name of (await readdir(promptDir, { recursive: true })).filter((name) => name.endsWith(".md")).sort()) {
      const path = name.replaceAll("\\", "/");
      promptHash.update(path).update("\0").update((await readFile(new URL(path, promptDir), "utf8")).replace(/\r\n/g, "\n"));
    }
    if (interactive) {
      tui = new BuildTui({
        requirementIds: Object.keys(context.runRecord.requirementDigests!),
        models: { builder: builderGateway.model, checker: checkerGateway.model },
        onInterrupt: () => { process.kill(process.pid, "SIGINT"); },
      });
      tui.start();
    }
    const logSink = createRunLogSink(runLogFile, new ProgressJournal(pipelineOptions.outputDir), process.stderr,
      tui ? (rawLine, line) => tui!.record(rawLine, line) : undefined);
    let checkerRuntime!: CheckerRuntime;
    {
      const directory = join(dirname(runLogFile), "checker");
      const artifacts = new ArtifactStore(directory, context.runRecord.checkerRunId!);
      const snapshots = new SnapshotStore(join(directory, "snapshots"));
      let initialDataSnapshot: ContentRef;
      try { initialDataSnapshot = JSON.parse(await readFile(join(directory, "baseline.json"), "utf8")) as ContentRef; await snapshots.open(initialDataSnapshot); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || context.runRecord.resumedFrom) throw error;
        initialDataSnapshot = (await snapshots.seal({ sourceDirectory: pipelineOptions.outputDir,
          sourceSha: await git.captureAccepted("shallow: Checker input baseline"), packetId: "input-baseline",
          generatedPaths: pipelineOptions.applicationContract.generatedPaths, dataPaths: pipelineOptions.applicationContract.dataPaths })).ref;
        await atomicWrite(join(directory, "baseline.json"), JSON.stringify(initialDataSnapshot) + "\n");
      }
      const execution = await checkerAdapters.get(pipelineOptions.applicationContract.adapterId)({ artifacts, snapshots, spec: context.runRecord.projectSpec,
        workspace: join(directory, "workers"), initialDataSnapshot,
        applicationContract: pipelineOptions.applicationContract });
      if (context.runRecord.bindingDigest && context.runRecord.bindingDigest !== execution.adapter.binding.digest) throw new Error("Checker execution binding changed; start a new run");
      context.runRecord.bindingDigest = execution.adapter.binding.digest;
      await saveRunRecord(dirname(runLogFile), context.runRecord);
      let recordUsage: (item: CheckerModelUsage) => void = () => {};
      const model = createPiCheckerModel({ gateway: checkerGateway, sessionDir: join(directory, "sessions"),
        ...(checkerModelCost ? { modelCost: checkerModelCost } : {}), onUsage: item => recordUsage(item) });
      checkerRuntime = { directory, artifacts, snapshots, checker: createCheckerAgent({ artifacts, adapter: execution.adapter, model }),
        binding: execution.adapter.binding, initialStates: execution.declaration.initialStates, resourceKeys: execution.declaration.resourceKeys,
        setUsageRecorder: recorder => { recordUsage = recorder; },
        async verifyDelivery(job, signal) {
          try { await execution.adapter.verifyDelivery(job, signal); return { ok: true, stage: "complete", message: "Frozen candidate satisfies its execution binding and delivery checks" }; }
          catch (error) { return { ok: false, stage: "readiness", message: error instanceof Error ? error.message : String(error) }; }
        } };
    }
    const summary = await runPipeline({ ...pipelineOptions, stageStartingPoint }, {
      checker: checkerRuntime,
      grouper: new LlmFeatureGrouper({ ...checkerGateway, timeoutMs: Infinity, ...(checkerModelCost ? { cost: checkerModelCost } : {}) }),
      builder,
      git,
      clock: { nowMs: () => Date.now() },
      logSink,
      diagnosticSecrets: gatewaySecrets(builderGateway, checkerGateway),
      runMetadata: { model: builderGateway.model, checkerModel: checkerGateway.model,
        builderTimeoutMs: modelTimeouts.builderTimeoutMs,
        builderContextWindow,
        starterScaffold,
        promptSha256: promptHash.digest("hex"),
      },
    });
    return summary;
  } finally {
    tui?.stop();
    await releaseWorkspace?.();
  }
}

export async function assertPrivateRunDirectory(outputDir: string, runDir: string): Promise<void> {
  const contained = (candidate: string, controller: string): boolean => {
    const path = relative(candidate, controller);
    return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith("..\\") && !path.startsWith("../"));
  };
  if (contained(resolve(outputDir), resolve(runDir))) throw new Error("Run diagnostics directory must be outside the candidate output directory");
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  if (contained(await realpath(outputDir), await realpath(runDir))) throw new Error("Run diagnostics directory resolves inside the candidate output directory");
}

/** 完整文本日志持续写入文件；交互终端可将同一事件投影为摘要。 */
export function createRunLogSink(
  runLogFile: string,
  journal?: ProgressJournal,
  stream: { write(chunk: string): void } = process.stderr,
  present?: (rawLine: string, line: string) => void,
): LogSink {
  const runLogDir = dirname(runLogFile);
  const formatter = new HumanRunFormatter();
  return {
    write: (chunk) => {
      const line = formatter.format(chunk);
      if (line === null) return;
      mkdirSync(runLogDir, { recursive: true });
      appendFileSync(runLogFile, `${line}\n`, "utf8");
      journal?.appendLine(line);
      if (present) present(chunk, line);
      else stream.write(`${line}\n`);
    },
  };
}

/** CLI 启动：把运行结果或诊断映射为进程退出码；直接执行与全局命令共用。 */
export async function runMain(
  argv: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  try {
    process.exitCode = await main(argv, env);
  } catch (error: unknown) {
    console.error(sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  void runMain();
}
