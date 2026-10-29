import { access, copyFile, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PromptBuilder } from "./src/builder/prompt-builder.js";
import { VisionCapability } from "./src/builder/vision-probe.js";
import { PiWorkerClient } from "./src/builder/pi-worker-client.js";
import { discoverRequirementsDir, parseCliArgs } from "./src/cli.js";
import { SnapshotStore } from "./src/snapshot-store.js";
import { VerifierSourceIndex, verifierSourceExclusions } from "./src/verifier/source-index.js";
import { VerifierProgramCache } from "./src/verifier/program-cache.js";
import { ArtifactStore, atomicWrite } from "./src/verifier/artifacts.js";
import type { ContentRef } from "./src/verifier/port.js";
import { createVerifierAgent, createPiVerifierModel, type VerifierModelUsage } from "./src/verifier/agent.js";
import type { VerifierRuntime } from "./src/verifier-pipeline.js";
import type { RequirementNode } from "./src/types.js";
import { GitCliOps } from "./src/git-ops.js";
import { HumanRunFormatter } from "./src/human-log.js";
import { BuildTui, buildResult } from "./src/terminal/build-tui.js";
import { ProgressJournal, PROGRESS_DIR_NAME } from "./src/progress-journal.js";
import { GatewayRecovery } from "./src/gateway-recovery.js";
import { PiFeatureGrouper } from "./src/llm-feature-grouper.js";
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
  parseVerifierConfig,
  parseEvolutionAuditInherited,
  parseRunDirOverride,
  readEnvFile,
  resolveSseCaptureDir,
  readGatewayConfig,
  referenceImagesEnabled,
  type GatewayConfig,
} from "./src/runtime-config.js";
import { loadProjectSpec, type ProjectSpec } from "./src/project-spec.js";
import { initializeProject, readProjectIntent, type InitializationResult } from "./src/project-initialization.js";
import { verifyInitializedWebProject } from "./src/adapters/web/initialization.js";
import { RunStateStore } from "./src/run-state.js";
import { applications } from "./src/adapters/index.js";
import { verifierAdapters } from "./src/adapters/verifier.js";
import { hasProjectFiles } from "./src/project-workspace.js";
import { digest, lockWorkspace, saveRunRecord, snapshotFiles, writeRunReport, type RunRecord } from "./src/run-record.js";
import { loadRequirementCatalog } from "./src/catalog.js";
import { readHistoricalRequirementIds, readImplementationDigests, requirementDigest, saveRequirementDigests } from "./src/evolution.js";

export interface AgentExecutionContext {
  tui?: BuildTui;
  runRecord: RunRecord;
  /** 本轮输入需求树；交互终端据此展示子树完成状态。 */
  requirementTree?: RequirementNode;
  /** Builder 侧网关（SHALLOW_BUILDER_* 覆盖，缺省公共网关）。 */
  builderGateway: GatewayConfig;
  /** Verifier 侧网关（SHALLOW_VERIFIER_* 覆盖，缺省公共网关）。 */
  verifierGateway: GatewayConfig;
  /** Grouper 侧网关（SHALLOW_GROUPER_* 覆盖，缺省公共网关）。 */
  grouperGateway: GatewayConfig;
  /** 解析后的模型单价（USD / 百万 token）；null 表示只统计 token。 */
  builderModelCost: ModelRates | null;
  verifierModelCost: ModelRates | null;
  grouperModelCost: ModelRates | null;
  pipelineOptions: PipelineOptions;
  modelTimeouts: {
    builderTimeoutMs: number;
    verifierTimeoutMs: number;
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
  const startedAtMs = Date.now();
  const cli = parseCliArgs(argv[0] === "run" ? argv.slice(1) : argv, {
    defaultOutputDir: cwd,
    defaultRequirementsDir: () => discoverRequirementsDir(cwd),
  });
  const mergedEnv = await mergeGatewayEnv(env, envFile);
  const verifier = parseVerifierConfig(mergedEnv);
  const builderGateway = readGatewayConfig(mergedEnv, "builder");
  const verifierGateway = readGatewayConfig(mergedEnv, "verifier");
  const grouperGateway = readGatewayConfig(mergedEnv, "grouper");
  const builderModelCost = resolveModelRates(builderGateway.baseUrl, builderGateway.model,
    { agent: "builder", env: mergedEnv });
  const verifierModelCost = resolveModelRates(verifierGateway.baseUrl, verifierGateway.model,
    { agent: "verifier", env: mergedEnv });
  const grouperModelCost = resolveModelRates(grouperGateway.baseUrl, grouperGateway.model,
    { agent: "grouper", env: mergedEnv });
  const requirementsFile = join(cli.requirementsDir, "requirements.yaml");
  try { await access(requirementsFile); }
  catch { throw new Error(`requirements.yaml is not readable at ${requirementsFile}`); }
  if (cli.projectDir) await access(cli.projectDir);
  await mkdir(cli.outputDir, { recursive: true });
  const workingDirectory = cli.outputDir;
  const runId = `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const runDirectory = join(parseRunDirOverride(mergedEnv) ?? join(tmpdir(), "shallowcode-runs"), runId);
  await assertPrivateRunDirectory(workingDirectory, runDirectory);
  await assertPrivateRunDirectory(cli.requirementsDir, runDirectory);
  const requirementFiles = await snapshotFiles(cli.requirementsDir);
  const requirementsDigest = digest(JSON.stringify(requirementFiles));
  const requirementSnapshot = join(runDirectory, "requirements");
  for (const path of Object.keys(requirementFiles)) {
    const destination = join(requirementSnapshot, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(cli.requirementsDir, path), destination);
  }
  if (digest(JSON.stringify(await snapshotFiles(requirementSnapshot))) !== requirementsDigest) {
    throw new Error("Requirements changed while copying the run inputs");
  }
  const inheritedProject = cli.projectDir !== undefined || await hasProjectFiles(workingDirectory);
  const intent = await readProjectIntent(requirementSnapshot);
  let initialSpec: ProjectSpec | undefined;
  try {
    initialSpec = await loadProjectSpec(workingDirectory, undefined, (raw, origin) =>
      applications.get((raw as { adapter?: string })?.adapter ?? "web").parseSpec(raw, origin));
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("Missing project run configuration:")) throw error;
  }
  const requirementsContext = await readFile(join(requirementSnapshot, "requirements.yaml"), "utf8");
  const inputCatalog = await loadRequirementCatalog(join(requirementSnapshot, "requirements.yaml"), { inheritedApplication: inheritedProject });
  const requirementDigests = Object.fromEntries(inputCatalog.requirements.map(r => [r.id, requirementDigest(r, requirementFiles)]));
  const progressDir = join(workingDirectory, PROGRESS_DIR_NAME);
  const sourceHistory = inheritedProject ? await readHistoricalRequirementIds(progressDir) : undefined;
  const historicalRequirements = sourceHistory ? { ...sourceHistory, requirementIds: [...sourceHistory.requirementIds] } : undefined;
  const previousImplementations = inheritedProject ? await readImplementationDigests(progressDir) : {};
  const resumedRequirementIds = Object.keys(requirementDigests).filter(id => previousImplementations[id] === requirementDigests[id]);
  const initializationTui = execute === executeProduction && process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY && process.env.TERM !== "dumb"
    ? new BuildTui({ requirementIds: Object.keys(requirementDigests), requirementTree: inputCatalog.tree,
      requirementsText: requirementsContext,
      models: { grouper: grouperGateway.model, builder: builderGateway.model, verifier: verifierGateway.model },
      onInterrupt: () => { process.kill(process.pid, "SIGINT"); } }) : undefined;
  let activeTui = initializationTui;
  let release: (() => Promise<void>) | undefined;
  try {
    let initialization: InitializationResult | undefined;
    let initializationBaseline: string | undefined;
    let inputFiles: Record<string, string> | undefined;
    const checkpointGitDirectory = join(runDirectory, "checkpoints.git");
    if (execute === executeProduction) {
      initializationTui?.start();
      await initializationTui?.waitForStart();
      release = await lockWorkspace(workingDirectory);
      inputFiles = await snapshotFiles(workingDirectory, initialSpec?.generatedPaths);
      const git = await GitCliOps.open(workingDirectory, {
        checkpointDirectory: checkpointGitDirectory, generatedPaths: initialSpec?.generatedPaths ?? [],
      });
      initializationBaseline = await git.captureAccepted("shallow: input before initialization");
      const initState = new RunStateStore({ statusByRequirementId: {}, acceptedSha: initializationBaseline,
        startedAtMs, totalBudgetMs: cli.budgetMs }, join(runDirectory, "run-ledger.jsonl"),
        createRunLogSink(join(runDirectory, "run-log.txt"), undefined, process.stderr,
          initializationTui ? (raw, line) => initializationTui.record(raw, line) : undefined),
        gatewaySecrets(builderGateway, verifierGateway, grouperGateway));
      initialization = await initializeProject({
        outputDir: workingDirectory, privateDir: runDirectory, verify: verifyInitializedWebProject,
        requirementsContext, intent, env: mergedEnv, startedAtMs, budgetMs: cli.budgetMs, applications,
        diagnosticSecrets: gatewaySecrets(builderGateway, verifierGateway, grouperGateway),
        createBuilder: () => new PiWorkerClient(builderGateway, join(runDirectory, "pi-sessions"), undefined,
          { ...(builderModelCost ? { modelCost: builderModelCost } : {}), applications }),
        onEvent: (type, detail) => initState.record({ at: new Date().toISOString(), type, detail } as import("./src/types.js").RunEvent),
        onUsage: async usage => {
          const item = usage.at(-1);
          if (item) await initState.record({ at: new Date().toISOString(), type: "builder_usage", packetId: "initialization",
            detail: { ...item, total: item.input + item.output + item.cacheRead + item.cacheWrite } });
        },
      });
      initState.setAcceptedSha(await git.captureAccepted("shallow: runnable initialization baseline"));
      await initState.record({ at: new Date().toISOString(), type: "initialization_finished",
        detail: { path: initialization.path, adapterId: initialization.contract.adapterId } });
    }
    const spec = initialization?.spec ?? await loadProjectSpecOrDefault(workingDirectory);
    const contractDigest = await controllerContractDigest(spec);
    const applicationContract = initialization?.contract ?? await applications.get(spec.adapter ?? "web").configure(spec, mergedEnv);
    const pipelineOptions: PipelineOptions = {
      verifier, requirementDigests, historicalRequirements,
      requirementsFile: join(requirementSnapshot, "requirements.yaml"),
      outputDir: workingDirectory, ledgerFile: join(runDirectory, "run-ledger.jsonl"),
      totalBudgetMs: cli.budgetMs, startedAtMs, initializationUsage: initialization?.modelUsage,
      ...(initialization ? { initialization: { path: initialization.path, intent } } : {}),
      applicationContract, progressDir,
      ...(inheritedProject ? { historicalProgressDir: progressDir, stageStartingPoint: "inherited_application" as const } : {}),
      auditInheritedRequirements: parseEvolutionAuditInherited(mergedEnv),
      ...(Object.keys(previousImplementations).length ? { resumedRequirementIds } : {}),
    };
    const runRecord: RunRecord = {
      version: 4, verifier, verifierRunId: runId,
      requirementsDir: cli.requirementsDir, requirementsDigest, contractDigest, projectSpec: spec,
      ...(initialization ? { initializationPath: initialization.path } : {}),
      outputDir: workingDirectory, inputFiles: inputFiles ?? await snapshotFiles(workingDirectory, spec.generatedPaths),
      requirementDigests, historicalRequirements,
      auditInheritedRequirements: pipelineOptions.auditInheritedRequirements ?? false,
      ...(initializationBaseline ? { inputBaseline: initializationBaseline, checkpointGitDirectory } : {}),
      stageStartingPoint: inheritedProject ? "inherited_application"
        : initialization?.path === "default_scaffold" ? "blank_template" : "unknown",
    };
    await saveRunRecord(runDirectory, runRecord);
    if (!initializationTui) process.stderr.write(`[ShallowCode] 运行目录：${runDirectory}\n`);
    const context: AgentExecutionContext = {
      ...(initializationTui ? { tui: initializationTui } : {}),
      runRecord, requirementTree: inputCatalog.tree,
      builderGateway, verifierGateway, grouperGateway, builderModelCost, verifierModelCost, grouperModelCost,
      pipelineOptions, modelTimeouts: deriveModelTimeouts(cli.budgetMs),
      builderContextWindow: parseBuilderContextWindow(mergedEnv),
      sseCaptureDir: resolveSseCaptureDir(mergedEnv, join(runDirectory, "sse-capture")),
      referenceImages: referenceImagesEnabled(mergedEnv),
    };
    const summary = await execute(context).catch((error: unknown) => {
      throw new Error(sanitizeDiagnosticText(error instanceof Error ? error.message : String(error), gatewaySecrets(builderGateway, verifierGateway, grouperGateway)));
    });
    activeTui = context.tui ?? activeTui;
    await saveRequirementDigests(progressDir, requirementDigests,
      [...summary.verifiedRequirementIds, ...(summary.skippedRequirementIds ?? [])]);
    await writeRunReport(runDirectory, summary);
    await release?.();
    release = undefined;
    const elapsedMs = Date.now() - startedAtMs;
    if (activeTui) {
      activeTui.complete({ status: summary.status, runDirectory, projectDirectory: workingDirectory, elapsedMs });
      await activeTui.waitForExit();
    } else {
      process.stderr.write(buildResult(summary, runDirectory, undefined, workingDirectory, elapsedMs,
        Boolean(process.stderr.isTTY) && mergedEnv.NO_COLOR === undefined && mergedEnv.TERM !== "dumb", process.stderr.columns ?? 80));
    }
    return summary.status === "failed" ? 1 : summary.status === "partial" ? 2 : 0;
  } finally {
    activeTui?.stop();
    await release?.();
  }
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
  const { builderGateway, verifierGateway, grouperGateway, builderModelCost, verifierModelCost, grouperModelCost, pipelineOptions, requirementTree, modelTimeouts, builderContextWindow, sseCaptureDir, referenceImages } = context;
  const runLogFile = join(dirname(pipelineOptions.ledgerFile), "run-log.txt");
  // Builder, Grouper and Verifier share one cooldown so a gateway outage pauses
  // every client instead of letting each one discover it independently.
  const gatewayRecovery = new GatewayRecovery();
  await assertPrivateRunDirectory(pipelineOptions.outputDir, dirname(runLogFile));
  const applicationAdapter = applications.get(pipelineOptions.applicationContract.adapterId);
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY && process.env.TERM !== "dumb");
  let tui: BuildTui | undefined = context.tui;
  let keepTui = false;
  try {
    if (interactive && !tui) {
      tui = new BuildTui({
        requirementIds: Object.keys(context.runRecord.requirementDigests!),
        requirementTree,
        requirementsText: await readFile(pipelineOptions.requirementsFile, "utf8").catch(() => undefined),
        models: { grouper: grouperGateway.model, builder: builderGateway.model, verifier: verifierGateway.model },
        onInterrupt: () => { process.kill(process.pid, "SIGINT"); },
      });
      context.tui = tui;
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
      checkpointDirectory: context.runRecord.checkpointGitDirectory,
      generatedPaths: pipelineOptions.applicationContract.generatedPaths,
    });
    const inputBaseline = context.runRecord.inputBaseline ?? await git.captureAccepted("shallow: input baseline");
    context.runRecord.inputBaseline = inputBaseline;
    await saveRunRecord(dirname(runLogFile), context.runRecord);
    if (!tui) process.stderr.write(`[ShallowCode] 开发目录：${pipelineOptions.outputDir}\n`);
    // Initialization already chose and validated the project shape. Legacy runs
    // retain the previous scaffold behavior when they have no initialization path.
    const starterScaffold = context.runRecord.initializationPath
      ? context.runRecord.initializationPath === "default_scaffold"
        ? { status: "installed" as const, reason: "installed and validated during initialization", files: [] }
        : { status: "skipped_existing_application" as const, reason: "initialized project", files: [] }
      : await applicationAdapter.installScaffold(pipelineOptions.outputDir, pipelineOptions.applicationContract);
    const stageStartingPoint = context.runRecord.stageStartingPoint
      ? context.runRecord.stageStartingPoint
      : starterScaffold.status === "skipped_existing_application"
      ? "inherited_application" as const
      : starterScaffold.status === "installed"
        ? "blank_template" as const
        : "unknown" as const;
    context.runRecord.stageStartingPoint = stageStartingPoint;
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
    let verifierRuntime!: VerifierRuntime;
    {
      const directory = join(dirname(runLogFile), "verifier");
      const artifacts = new ArtifactStore(directory, context.runRecord.verifierRunId!);
      const snapshots = new SnapshotStore(join(directory, "snapshots"));
      let initialDataSnapshot: ContentRef;
      try { initialDataSnapshot = JSON.parse(await readFile(join(directory, "baseline.json"), "utf8")) as ContentRef; await snapshots.open(initialDataSnapshot); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || context.runRecord.resumedFrom) throw error;
        initialDataSnapshot = (await snapshots.seal({ sourceDirectory: pipelineOptions.outputDir,
          sourceSha: await git.captureAccepted("shallow: Verifier input baseline"), packetId: "input-baseline",
          generatedPaths: pipelineOptions.applicationContract.generatedPaths, dataPaths: pipelineOptions.applicationContract.dataPaths })).ref;
        await atomicWrite(join(directory, "baseline.json"), JSON.stringify(initialDataSnapshot) + "\n");
      }
      const execution = await verifierAdapters.get(pipelineOptions.applicationContract.adapterId)({ artifacts, snapshots, spec: context.runRecord.projectSpec,
        workspace: join(directory, "workers"), initialDataSnapshot,
        applicationContract: pipelineOptions.applicationContract });
      if (context.runRecord.bindingDigest && context.runRecord.bindingDigest !== execution.adapter.binding.digest) throw new Error("Verifier execution binding changed; start a new run");
      context.runRecord.bindingDigest = execution.adapter.binding.digest;
      await saveRunRecord(dirname(runLogFile), context.runRecord);
      let recordUsage: (item: VerifierModelUsage) => void = () => {};
      let recordUsageProgress: (item: VerifierModelUsage) => void = () => {};
      const model = createPiVerifierModel({ gateway: verifierGateway, sessionDir: join(directory, "sessions"),
        recovery: gatewayRecovery,
        ...(verifierModelCost ? { modelCost: verifierModelCost } : {}), onUsage: item => recordUsage(item),
        onProgress: item => recordUsageProgress(item) });
      const sourceIndex = new VerifierSourceIndex(snapshots, verifierSourceExclusions(pipelineOptions.applicationContract));
      const projectPath = await realpath(pipelineOptions.outputDir);
      const programCacheDirectory = join(dirname(dirname(runLogFile)), ".verifier-programs",
        digest(process.platform === "win32" ? projectPath.toLowerCase() : projectPath));
      await assertPrivateRunDirectory(pipelineOptions.outputDir, programCacheDirectory);
      const baseline = await snapshots.open(initialDataSnapshot);
      const programCache = await VerifierProgramCache.open({ directory: programCacheDirectory, artifacts, binding: execution.adapter.binding,
        initialData: baseline.manifest.files.filter(file => pipelineOptions.applicationContract.dataPaths?.some(path => file.path === path || file.path.startsWith(path + "/"))),
        requirements: (await loadRequirementCatalog(pipelineOptions.requirementsFile, { inheritedApplication: stageStartingPoint === "inherited_application" })).requirements,
        requirementDigests: pipelineOptions.requirementDigests ?? {} });
      verifierRuntime = { directory, artifacts, snapshots, verifier: createVerifierAgent({ artifacts, adapter: execution.adapter, model, sourceIndex,
        semanticReview: pipelineOptions.verifier.semanticReview === true, programCache }),
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
      verifier: verifierRuntime,
      grouper: new PiFeatureGrouper({ gateway: grouperGateway, sessionDir: join(dirname(runLogFile), "grouper-sessions"),
        recovery: gatewayRecovery, ...(grouperModelCost ? { modelCost: grouperModelCost } : {}) }),
      builder,
      git,
      clock: { nowMs: () => Date.now() },
      logSink,
      gatewayRecovery,
      diagnosticSecrets: gatewaySecrets(builderGateway, verifierGateway, grouperGateway),
      assertContractUnchanged: async () => {
        const actual = await loadProjectSpec(pipelineOptions.outputDir, undefined, (raw, origin) =>
          applications.get((raw as { adapter?: string })?.adapter ?? "web").parseSpec(raw, origin));
        if (await controllerContractDigest(actual) !== context.runRecord.contractDigest) {
          throw new Error("Project run configuration changed after initialization; start a new run for the updated contract");
        }
      },
      runMetadata: { model: builderGateway.model, verifierModel: verifierGateway.model, grouperModel: grouperGateway.model,
        builderTimeoutMs: modelTimeouts.builderTimeoutMs,
        builderContextWindow,
        starterScaffold,
        promptSha256: promptHash.digest("hex"),
      },
    });
    // 成功路径把 TUI 留给入口完成收尾并等待用户主动退出；异常路径仍立即恢复终端。
    keepTui = true;
    return summary;
  } finally {
    if (!keepTui) tui?.stop();
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
