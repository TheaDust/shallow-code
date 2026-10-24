import { access, copyFile, cp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
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
import { CheckerSourceIndex, checkerSourceExclusions } from "./src/checker/source-index.js";
import { ArtifactStore, atomicWrite } from "./src/checker/artifacts.js";
import type { ContentRef } from "./src/checker/port.js";
import { createCheckerAgent, createPiCheckerModel, type CheckerModelUsage } from "./src/checker/agent.js";
import type { CheckerRuntime } from "./src/checker-pipeline.js";
import type { RequirementNode } from "./src/types.js";
import { GitCliOps } from "./src/git-ops.js";
import { HumanRunFormatter } from "./src/human-log.js";
import { BuildTui, buildResult } from "./src/terminal/build-tui.js";
import { ProgressJournal, PROGRESS_DIR_NAME } from "./src/progress-journal.js";
import { GatewayRecovery } from "./src/gateway-recovery.js";
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
import { initializeProject, readProjectIntent, selectInitializationPath, type InitializationResult } from "./src/project-initialization.js";
import { verifyInitializedWebProject } from "./src/adapters/web/initialization.js";
import { RunStateStore } from "./src/run-state.js";
import { applications } from "./src/adapters/index.js";
import { checkerAdapters } from "./src/adapters/checker.js";
import { copyProjectWorkspace, hasProjectFiles, writeProjectPatch } from "./src/project-workspace.js";
import { applyRun, digest, loadPendingInitialization, loadRunRecord, lockWorkspace, readResumeCheckpoint,
  savePendingInitialization, saveRunRecord, snapshotFiles, writeRunReport, type PendingInitialization, type RunRecord } from "./src/run-record.js";
import { loadRequirementCatalog } from "./src/catalog.js";
import { readHistoricalRequirementIds, requirementDigest, saveRequirementDigests } from "./src/evolution.js";

export interface AgentExecutionContext {
  tui?: BuildTui;
  runRecord: RunRecord;
  /** 本轮输入需求树；交互终端据此展示子树完成状态。 */
  requirementTree?: RequirementNode;
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
  let pending = invocation.command === "resume" ? await loadPendingInitialization(invocation.runDirectory) : null;
  let prior: RunRecord | undefined;
  if (invocation.command === "resume") {
    if (pending) {
      // A crash can leave the pending marker behind after Checker binding was saved.
      try {
        const frozen = await loadRunRecord(invocation.runDirectory);
        if (frozen.bindingDigest) { prior = frozen; pending = null; }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } else prior = await loadRunRecord(invocation.runDirectory);
  }
  const cli: CliOptions = invocation.command === "run" ? invocation.options : {
    requirementsDir: pending?.requirementsDir ?? prior!.requirementsDir,
    outputDir: pending?.sourceProjectDir ?? pending?.outputDir ?? prior!.outputDir,
    budgetMs: invocation.budgetMs,
  };
  const mergedEnv = await mergeGatewayEnv(env, envFile);
  const requestedChecker = parseCheckerConfig(mergedEnv);
  if (prior?.checker && ((mergedEnv.SHALLOW_CHECKER_MODE && requestedChecker.mode !== prior.checker.mode) ||
    (mergedEnv.SHALLOW_CHECKER_CONCURRENCY && requestedChecker.concurrency !== prior.checker.concurrency) ||
    (mergedEnv.SHALLOW_CHECKER_SEMANTIC_REVIEW && requestedChecker.semanticReview !== prior.checker.semanticReview) ||
    (mergedEnv.SHALLOW_CHECKER_REPLAY && requestedChecker.replay !== prior.checker.replay))) {
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
  const requirementFiles = await snapshotFiles(cli.requirementsDir);
  const requirementsDigest = digest(JSON.stringify(requirementFiles));
  if (prior && prior.requirementsDigest !== requirementsDigest) {
    throw new Error("Resume inputs changed (requirements); start a new run for the updated inputs");
  }
  if (pending && pending.requirementsDigest !== requirementsDigest) {
    throw new Error("Resume requirements changed during initialization; start a new run");
  }
  const runId = `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const runDir = pending && invocation.command === "resume" ? dirname(invocation.runDirectory)
    : parseRunDirOverride(mergedEnv) ?? join(tmpdir(), "shallowcode-runs");
  const runDirectory = pending && invocation.command === "resume" ? invocation.runDirectory : join(runDir, runId);
  await assertPrivateRunDirectory(cli.outputDir, runDirectory);
  await assertPrivateRunDirectory(cli.requirementsDir, runDirectory);
  const requirementSnapshot = join(runDirectory, "requirements");
  if (!pending) for (const path of Object.keys(requirementFiles)) {
    const destination = join(requirementSnapshot, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(cli.requirementsDir, path), destination);
  }
  if (digest(JSON.stringify(await snapshotFiles(requirementSnapshot))) !== requirementsDigest) throw new Error("Requirements changed while copying the run inputs");
  const intent = await readProjectIntent(requirementSnapshot);
  const inheritedProject = pending ? pending.sourceProjectDir !== undefined : prior
    ? prior.sourceProjectDir !== undefined || prior.stageStartingPoint === "inherited_application"
    : cli.projectDir !== undefined || await hasProjectFiles(cli.outputDir);
  // Preserve injected entry tests: production alone owns project initialization.
  // No provisional default contract is constructed for a custom project.
  let initialSpec: ProjectSpec | undefined = prior?.projectSpec;
  if (!initialSpec && !pending) {
    try { initialSpec = await loadProjectSpec(cli.outputDir, undefined, (raw, origin) =>
      applications.get((raw as { adapter?: string })?.adapter ?? "web").parseSpec(raw, origin)); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("Missing project run configuration:")) {
        throw error;
      }
    }
  }
  const sourceInputFiles = pending?.inputFiles ?? (inheritedProject && !prior
    ? await snapshotFiles(cli.outputDir, initialSpec?.generatedPaths) : undefined);
  const workingDirectory = pending?.outputDir ?? (inheritedProject && !prior
    ? await copyProjectWorkspace(cli.outputDir, join(runDirectory, "workspace"), initialSpec?.generatedPaths,
      initialSpec?.dataPaths)
    : cli.outputDir);
  const inputCatalog = await loadRequirementCatalog(join(requirementSnapshot, "requirements.yaml"), { inheritedApplication: inheritedProject });
  const requirementDigests = Object.fromEntries(inputCatalog.requirements.map(r => [r.id, requirementDigest(r, requirementFiles)]));
  const initializationTui = execute === executeProduction && !prior && process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY && process.env.TERM !== "dumb"
    ? new BuildTui({ requirementIds: Object.keys(requirementDigests), requirementTree: inputCatalog.tree,
      models: { builder: builderGateway.model, checker: checkerGateway.model },
      onInterrupt: () => { process.kill(process.pid, "SIGINT"); } }) : undefined;
  let initialization: InitializationResult | undefined;
  let initializationBaseline: string | undefined = pending?.inputBaseline;
  if (execute === executeProduction && !prior) {
    initializationTui?.start();
    await initializationTui?.waitForStart();
    let release: (() => Promise<void>) | undefined;
    try {
      const git = await GitCliOps.open(workingDirectory, { allowExisting: Boolean(pending) || inheritedProject || initialSpec !== undefined,
        generatedPaths: initialSpec?.generatedPaths ?? [] });
      release = await lockWorkspace(workingDirectory);
      initializationBaseline ??= await git.captureAccepted("shallow: input before initialization");
      const pendingRecord: PendingInitialization = pending ?? {
        version: 1, requirementsDir: cli.requirementsDir, requirementsDigest,
        outputDir: workingDirectory,
        ...(inheritedProject ? { sourceProjectDir: cli.outputDir } : {}),
        inputBaseline: initializationBaseline, inputFiles: sourceInputFiles ?? {},
        path: selectInitializationPath(await hasProjectFiles(workingDirectory), initialSpec !== undefined, intent), modelUsage: [],
        ...(initialSpec ? { existingConfigContent: await readFile(join(workingDirectory, "shallowcode.config.json"), "utf8") } : {}),
      };
      await savePendingInitialization(runDirectory, pendingRecord);
      const initState = new RunStateStore({ statusByRequirementId: {}, acceptedSha: initializationBaseline,
        startedAtMs, totalBudgetMs: cli.budgetMs }, join(runDirectory, "run-ledger.jsonl"),
        createRunLogSink(join(runDirectory, "run-log.txt"), undefined, process.stderr,
          initializationTui ? (raw, line) => initializationTui.record(raw, line) : undefined),
        gatewaySecrets(builderGateway, checkerGateway));
      initialization = await initializeProject({ outputDir: workingDirectory, privateDir: runDirectory,
        verify: verifyInitializedWebProject,
        requirementsContext: await readFile(join(requirementSnapshot, "requirements.yaml"), "utf8"), intent,
        resumePath: pendingRecord.path, previousUsage: pendingRecord.modelUsage,
        existingConfigContent: pendingRecord.existingConfigContent,
        env: mergedEnv, startedAtMs, budgetMs: cli.budgetMs, applications,
        diagnosticSecrets: gatewaySecrets(builderGateway, checkerGateway),
        createBuilder: () => new PiWorkerClient(builderGateway, join(runDirectory, "pi-sessions"), undefined,
          { ...(builderModelCost ? { modelCost: builderModelCost } : {}), applications }),
        onEvent: (type, detail) => initState.record({ at: new Date().toISOString(), type, detail } as import("./src/types.js").RunEvent),
        onUsage: async usage => {
          pendingRecord.modelUsage = [...usage];
          await savePendingInitialization(runDirectory, pendingRecord);
          const item = usage.at(-1);
          if (item) await initState.record({ at: new Date().toISOString(), type: "builder_usage", packetId: "initialization",
            detail: { ...item, total: item.input + item.output + item.cacheRead + item.cacheWrite } });
        },
      });
      const initializedSha = await git.captureAccepted("shallow: runnable initialization baseline");
      initState.setAcceptedSha(initializedSha);
      await initState.record({ at: new Date().toISOString(), type: "initialization_finished",
        detail: { path: initialization.path, adapterId: initialization.contract.adapterId } });
    } catch (error) { initializationTui?.stop(); throw error; }
    finally { await release?.(); }
  }
  try {
    const spec = initialization?.spec ?? prior?.projectSpec ?? await loadProjectSpecOrDefault(cli.outputDir);
    const contractDigest = await controllerContractDigest(spec);
    if (prior && (prior.requirementsDigest !== requirementsDigest || prior.contractDigest !== contractDigest)) {
      throw new Error("Resume inputs changed (requirements, project contract, prompts or engine); start a new run for the updated inputs");
    }
    const checkpoint = prior && invocation.command === "resume" ? await readResumeCheckpoint(invocation.runDirectory, prior) : undefined;
    const applicationContract = initialization?.contract ?? await applications.get(spec.adapter ?? "web").configure(spec, mergedEnv);
    const sseCaptureDir = resolveSseCaptureDir(mergedEnv, join(runDirectory, "sse-capture"));
    const referenceImages = referenceImagesEnabled(mergedEnv);
    const sourceHistory = inheritedProject ? await readHistoricalRequirementIds(join(prior?.sourceProjectDir ?? cli.outputDir, PROGRESS_DIR_NAME)) : undefined;
    const historicalRequirements = prior?.historicalRequirements ?? (sourceHistory ? { ...sourceHistory, requirementIds: [...sourceHistory.requirementIds] } : undefined);
    const pipelineOptions: PipelineOptions = {
      checker,
      requirementDigests,
      historicalRequirements,
      requirementsFile: join(requirementSnapshot, "requirements.yaml"),
      outputDir: workingDirectory,
      ledgerFile: join(runDirectory, "run-ledger.jsonl"),
      totalBudgetMs: cli.budgetMs,
      startedAtMs,
      initializationUsage: initialization?.modelUsage,
      ...(initialization || prior?.initializationPath ? { initialization: {
        path: initialization?.path ?? prior!.initializationPath!, intent,
      } } : {}),
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
      ...(initialization ? { initializationPath: initialization.path }
        : prior?.initializationPath ? { initializationPath: prior.initializationPath } : {}),
      outputDir: workingDirectory,
      ...(prior?.sourceProjectDir ? { sourceProjectDir: prior.sourceProjectDir } : inheritedProject && !prior ? { sourceProjectDir: cli.outputDir } : {}),
      inputFiles: prior?.inputFiles ?? sourceInputFiles ?? await snapshotFiles(workingDirectory, spec.generatedPaths),
      requirementDigests,
      historicalRequirements,
      ...(prior ? { inputBaseline: prior.inputBaseline, stageStartingPoint: prior.stageStartingPoint, resumedFrom: invocation.command === "resume" ? invocation.runDirectory : undefined } : {}),
      auditInheritedRequirements: pipelineOptions.auditInheritedRequirements ?? false,
    };
    if (initializationBaseline) runRecord.inputBaseline = initializationBaseline;
    if (initialization) runRecord.stageStartingPoint = initialization.path === "default_scaffold" ? "blank_template"
      : initialization.path === "existing" || initialization.path === "complete_existing" ? "inherited_application" : "unknown";
    await saveRunRecord(runDirectory, runRecord);
    if (invocation.command === "resume" && prior) {
      await cp(join(invocation.runDirectory, "checker"), join(runDirectory, "checker"), { recursive: true,
        filter: path => !["workers", "sessions"].includes(path.split(/[\\/]/).at(-1)!) });
    }
    // 初始化 TUI 已接管终端时直接写 stderr 会破坏主屏的差量重绘定位。
    if (!initializationTui) process.stderr.write(`[ShallowCode] 运行目录：${runDirectory}\n`);
    const summary = await execute({
      ...(initializationTui ? { tui: initializationTui } : {}),
      runRecord, requirementTree: inputCatalog.tree, ...(checkpoint ? { resumeCheckpointSha: checkpoint.sha } : {}),
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
  } finally { initializationTui?.stop(); }
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

/** Legacy and injected entry paths keep their previous default-spec behavior. */
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
  const { builderGateway, checkerGateway, builderModelCost, checkerModelCost, pipelineOptions, requirementTree, modelTimeouts, builderContextWindow, sseCaptureDir, referenceImages, sourceProjectDir } = context;
  const runLogFile = join(dirname(pipelineOptions.ledgerFile), "run-log.txt");
  // Builder, Planner and Checker share one cooldown so a gateway outage pauses
  // every client instead of letting each one discover it independently.
  const gatewayRecovery = new GatewayRecovery();
  await assertPrivateRunDirectory(pipelineOptions.outputDir, dirname(runLogFile));
  const applicationAdapter = applications.get(pipelineOptions.applicationContract.adapterId);
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY && process.env.TERM !== "dumb");
  let releaseWorkspace: (() => Promise<void>) | undefined;
  let tui: BuildTui | undefined = context.tui;
  try {
    if (interactive && !tui) {
      tui = new BuildTui({
        requirementIds: Object.keys(context.runRecord.requirementDigests!),
        requirementTree,
        models: { builder: builderGateway.model, checker: checkerGateway.model },
        onInterrupt: () => { process.kill(process.pid, "SIGINT"); },
      });
      tui.start();
      // 先停留在只读状态；用户按 Enter 后才创建 Builder 并进入流水线。
      await tui.waitForStart();
    }
    // TUI 独占终端时主屏靠行差量重绘定位光标；直接写 stderr 会让后续帧错位，
    // 把旧状态留在画面上，因此这些启动信息只在无 TUI 时输出。
    if (!tui) {
      process.stderr.write(`[ShallowCode] 运行日志文件：${runLogFile}\n`);
      if (sseCaptureDir) process.stderr.write(`[ShallowCode] SSE 抓包已启用（仅诊断用途）：${sseCaptureDir}\n`);
      process.stderr.write(`[ShallowCode] 参考图片：${referenceImages ? "已开启（首次附带前预探测模型视觉能力）" : "已关闭"}\n`);
    }
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
      if (!tui) process.stderr.write(`[ShallowCode] 开发副本：${pipelineOptions.outputDir}\n`);
    }
    // Initialization already chose and validated the project shape. Legacy runs
    // retain the previous scaffold behavior when they have no initialization path.
    const starterScaffold = context.runRecord.initializationPath
      ? context.runRecord.initializationPath === "default_scaffold"
        ? { status: "installed" as const, reason: "installed and validated during initialization", files: [] }
        : { status: "skipped_existing_application" as const, reason: "initialized project", files: [] }
      : await applicationAdapter.installScaffold(pipelineOptions.outputDir, pipelineOptions.applicationContract);
    const stageStartingPoint = context.runRecord.stageStartingPoint
      ? context.runRecord.stageStartingPoint
      : sourceProjectDir !== undefined ? "inherited_application" as const : starterScaffold.status === "skipped_existing_application"
      ? "inherited_application" as const
      : starterScaffold.status === "installed"
        ? "blank_template" as const
        : "unknown" as const;
    context.runRecord.stageStartingPoint = context.resumeCheckpointSha ? context.runRecord.stageStartingPoint : stageStartingPoint;
    await saveRunRecord(dirname(runLogFile), context.runRecord);
    if (!tui) process.stderr.write(`[ShallowCode] 通用脚手架：${starterScaffold.status}（${starterScaffold.reason}）\n`);
    const promptDir = new URL("./prompts/", import.meta.url);
    const promptHash = createHash("sha256");
    for (const name of (await readdir(promptDir, { recursive: true })).filter((name) => name.endsWith(".md")).sort()) {
      const path = name.replaceAll("\\", "/");
      promptHash.update(path).update("\0").update((await readFile(new URL(path, promptDir), "utf8")).replace(/\r\n/g, "\n"));
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
      await rm(join(dirname(runLogFile), "initialization.json"), { force: true });
      let recordUsage: (item: CheckerModelUsage) => void = () => {};
      let recordUsageProgress: (item: CheckerModelUsage) => void = () => {};
      const model = createPiCheckerModel({ gateway: checkerGateway, sessionDir: join(directory, "sessions"),
        recovery: gatewayRecovery,
        ...(checkerModelCost ? { modelCost: checkerModelCost } : {}), onUsage: item => recordUsage(item),
        onProgress: item => recordUsageProgress(item) });
      const sourceIndex = new CheckerSourceIndex(snapshots, checkerSourceExclusions(pipelineOptions.applicationContract));
      checkerRuntime = { directory, artifacts, snapshots, checker: createCheckerAgent({ artifacts, adapter: execution.adapter, model, sourceIndex,
        semanticReview: pipelineOptions.checker.semanticReview === true }),
        binding: execution.adapter.binding, initialState: execution.initialState, resourceKeys: execution.declaration.resourceKeys,
        setUsageRecorder: recorder => { recordUsage = recorder; },
        setUsageProgressRecorder: recorder => { recordUsageProgress = recorder; },
        async verifyDelivery(job, signal) {
          try { return { receipts: await execution.adapter.verifyDelivery(job, signal),
            report: { ok: true, stage: "complete", message: "Frozen candidate satisfies its execution binding and delivery checks" } }; }
          catch (error) { return { receipts: (error as { readinessEvidence?: ContentRef[] }).readinessEvidence ?? [],
            report: { ok: false, stage: "readiness", message: error instanceof Error ? error.message : String(error) } }; }
        } };
    }
    const summary = await runPipeline({ ...pipelineOptions, stageStartingPoint }, {
      checker: checkerRuntime,
      grouper: new LlmFeatureGrouper({ ...checkerGateway, timeoutMs: Infinity, ...(checkerModelCost ? { cost: checkerModelCost } : {}) }),
      builder,
      git,
      clock: { nowMs: () => Date.now() },
      logSink,
      gatewayRecovery,
      diagnosticSecrets: gatewaySecrets(builderGateway, checkerGateway),
      assertContractUnchanged: async () => {
        const actual = await loadProjectSpec(pipelineOptions.outputDir, undefined, (raw, origin) =>
          applications.get((raw as { adapter?: string })?.adapter ?? "web").parseSpec(raw, origin));
        if (await controllerContractDigest(actual) !== context.runRecord.contractDigest) {
          throw new Error("Project run configuration changed after initialization; start a new run for the updated contract");
        }
      },
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
    // 瞬时展示事件只进入交互终端，不写 run-log.txt 或进度记录。
    present: (chunk) => {
      if (!present) return;
      const line = formatter.format(chunk);
      if (line !== null) present(chunk, line);
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
