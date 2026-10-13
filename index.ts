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
import { FinalVerifier } from "./src/final-verifier.js";
import { CandidateRuntime } from "./src/candidate-runtime.js";
import { GitCliOps } from "./src/git-ops.js";
import { HumanRunFormatter } from "./src/human-log.js";
import { BuildTui, buildResult } from "./src/terminal/build-tui.js";
import { ProgressJournal, PROGRESS_DIR_NAME } from "./src/progress-journal.js";
import { installStarterScaffold } from "./src/starter-scaffold.js";
import { LlmProbePlanner } from "./src/judge/llm-probe-planner.js";
import { LlmFeatureGrouper } from "./src/llm-feature-grouper.js";
import { PlaywrightProbeRunner } from "./src/judge/playwright-probe-runner.js";
import {
  runPipeline,
  type PipelineOptions,
  type RunSummary,
} from "./src/pipeline.js";
import type { LogSink } from "./src/run-state.js";
import { sanitizeDiagnosticText } from "./src/diagnostics.js";
import { PROBE_PLAN_JSON_SCHEMA } from "./src/judge/probe-schema.js";
import {
  deriveModelTimeouts,
  parseBuilderContextWindow,
  parseEvaluationPort,
  parseEvolutionAuditInherited,
  parseFinalAuditGeneratePlan,
  parseProbePortOverride,
  parseRunDirOverride,
  pickFreePort,
  readEnvFile,
  resolveSseCaptureDir,
  readGatewayConfig,
  referenceImagesEnabled,
  type GatewayConfig,
} from "./src/runtime-config.js";
import { loadProjectSpec, minimalWebProjectSpec, npmExecutable, resolveRuntimeContract, type ProjectSpec } from "./src/project-spec.js";
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
  /** Judge / Planner 侧网关（SHALLOW_JUDGE_* 覆盖，缺省公共网关）。 */
  judgeGateway: GatewayConfig;
  pipelineOptions: PipelineOptions;
  modelTimeouts: {
    builderTimeoutMs: number;
    plannerTimeoutMs: number;
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
  const builderGateway = readGatewayConfig(mergedEnv, "SHALLOW_BUILDER");
  const judgeGateway = readGatewayConfig(mergedEnv, "SHALLOW_JUDGE");
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
  const evaluationPort = parseEvaluationPort(mergedEnv);
  const declaredExtraPorts = spec.extraPorts ?? [];
  const probePortOverride = parseProbePortOverride(mergedEnv);
  if (probePortOverride !== null && (probePortOverride === evaluationPort || declaredExtraPorts.includes(probePortOverride))) {
    throw new Error(
      `SHALLOW_PROBE_PORT must differ from the evaluation port ${evaluationPort} and the project extra ports ${declaredExtraPorts.join(", ") || "(none)"}`,
    );
  }
  const probePort = probePortOverride ?? (await pickFreePort([...(evaluationPort === null ? [] : [evaluationPort]), ...declaredExtraPorts]));
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
    ? await copyProjectWorkspace(cli.outputDir, join(runDirectory, "workspace"), spec.generatedPaths)
    : cli.outputDir;
  const inputCatalog = await loadRequirementCatalog(join(requirementSnapshot, "requirements.yaml"), { inheritedApplication: inheritedProject });
  const requirementDigests = Object.fromEntries(inputCatalog.requirements.map(r => [r.id, requirementDigest(r, requirementFiles)]));
  const sourceHistory = inheritedProject ? await readHistoricalRequirementIds(join(prior?.sourceProjectDir ?? cli.outputDir, PROGRESS_DIR_NAME)) : undefined;
  const historicalRequirements = prior?.historicalRequirements ?? (sourceHistory ? { ...sourceHistory, requirementIds: [...sourceHistory.requirementIds] } : undefined);
  const pipelineOptions: PipelineOptions = {
    requirementDigests,
    historicalRequirements,
    requirementsFile: join(requirementSnapshot, "requirements.yaml"),
    outputDir: workingDirectory,
    ledgerFile: join(runDir, runId, "run-ledger.jsonl"),
    totalBudgetMs: cli.budgetMs,
    platformContract: resolveRuntimeContract(spec, {
      port: probePort,
      ...(evaluationPort === null ? {} : { evaluationPort }),
      ...(declaredExtraPorts.length > 0 ? { extraPorts: declaredExtraPorts } : {}),
    }),
    progressDir: join(workingDirectory, PROGRESS_DIR_NAME),
    ...(inheritedProject ? { historicalProgressDir: join(prior?.sourceProjectDir ?? cli.outputDir, PROGRESS_DIR_NAME), stageStartingPoint: "inherited_application" as const } : {}),
    auditInheritedRequirements: prior?.auditInheritedRequirements ?? parseEvolutionAuditInherited(mergedEnv),
    generateFinalAuditPlans: prior?.generateFinalAuditPlans ?? parseFinalAuditGeneratePlan(mergedEnv),
    ...(checkpoint ? { resumedRequirementIds: checkpoint.requirementIds } : {}),
  };
  const runRecord: RunRecord = {
    version: 1, requirementsDir: cli.requirementsDir, requirementsDigest, contractDigest, projectSpec: spec,
    outputDir: workingDirectory,
    ...(prior?.sourceProjectDir ? { sourceProjectDir: prior.sourceProjectDir } : inheritedProject && !prior ? { sourceProjectDir: cli.outputDir } : {}),
    inputFiles: prior?.inputFiles ?? await snapshotFiles(workingDirectory, spec.generatedPaths),
    requirementDigests,
    historicalRequirements,
    ...(prior ? { inputBaseline: prior.inputBaseline, stageStartingPoint: prior.stageStartingPoint, resumedFrom: invocation.command === "resume" ? invocation.runDirectory : undefined } : {}),
    auditInheritedRequirements: pipelineOptions.auditInheritedRequirements ?? false,
    generateFinalAuditPlans: pipelineOptions.generateFinalAuditPlans ?? false,
  };
  await saveRunRecord(runDirectory, runRecord);
  if (invocation.command === "resume") {
    try { await cp(join(invocation.runDirectory, "plans"), join(runDirectory, "plans"), { recursive: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  process.stderr.write(`[ShallowCode] 运行目录：${runDirectory}\n`);
  const summary = await execute({
    runRecord, ...(checkpoint ? { resumeCheckpointSha: checkpoint.sha } : {}),
    ...(runRecord.sourceProjectDir ? { sourceProjectDir: runRecord.sourceProjectDir } : {}),
    builderGateway,
    judgeGateway,
    pipelineOptions,
    modelTimeouts: deriveModelTimeouts(cli.budgetMs),
    builderContextWindow: parseBuilderContextWindow(mergedEnv),
    sseCaptureDir,
    referenceImages,
  }).catch((error: unknown) => {
    throw new Error(sanitizeDiagnosticText(error instanceof Error ? error.message : String(error), gatewaySecrets(builderGateway, judgeGateway)));
  });
  const patch = runRecord.inputBaseline ? await writeProjectPatch(workingDirectory, runRecord.inputBaseline, runDirectory) : undefined;
  await saveRequirementDigests(join(workingDirectory, PROGRESS_DIR_NAME), requirementDigests,
    [...summary.verifiedRequirementIds, ...(summary.skippedRequirementIds ?? [])]);
  if (patch) process.stderr.write(`[ShallowCode] 项目改动补丁：${patch}\n`);
  await writeRunReport(runDirectory, summary, patch);
  process.stderr.write(buildResult(summary, runDirectory, patch, runRecord.sourceProjectDir ?? workingDirectory,
    Boolean(process.stderr.isTTY) && mergedEnv.NO_COLOR === undefined && mergedEnv.TERM !== "dumb", process.stderr.columns ?? 80));
  return summary.status === "failed" ? 1 : summary.status === "partial" ? 2 : 0;
}

async function controllerContractDigest(spec: ProjectSpec): Promise<string> {
  const promptDir = new URL("./prompts/", import.meta.url);
  const hash = createHash("sha256").update(JSON.stringify(resolveRuntimeContract(spec, { port: 1 })))
    .update(JSON.stringify(PROBE_PLAN_JSON_SCHEMA)).update(await readFile(new URL("./package-lock.json", import.meta.url)));
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
    return await loadProjectSpec(outputDir);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("Missing project run configuration:")) throw error;
    if (await hasProjectFiles(outputDir)) throw error;
    return minimalWebProjectSpec(npmExecutable());
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
  const { builderGateway, judgeGateway, pipelineOptions, modelTimeouts, builderContextWindow, sseCaptureDir, referenceImages, sourceProjectDir } = context;
  const runLogFile = join(dirname(pipelineOptions.ledgerFile), "run-log.txt");
  await assertPrivateRunDirectory(pipelineOptions.outputDir, dirname(runLogFile));
  process.stderr.write(`[ShallowCode] 运行日志文件：${runLogFile}\n`);
  process.stderr.write(`[ShallowCode] 项目声明的额外端口：${pipelineOptions.platformContract.extraPorts?.join(", ") || "无"}\n`);
  if (sseCaptureDir) process.stderr.write(`[ShallowCode] SSE 抓包已启用（仅诊断用途）：${sseCaptureDir}\n`);
  process.stderr.write(`[ShallowCode] 参考图片：${referenceImages ? "已开启（首次附带前预探测模型视觉能力）" : "已关闭"}\n`);
  process.stderr.write(`[ShallowCode] 最终验收补生成 plan：${pipelineOptions.generateFinalAuditPlans ? "已开启" : "已关闭（仅复用已有 plan）"}\n`);
  const candidate = new CandidateRuntime(pipelineOptions.outputDir,
    join(dirname(runLogFile), "candidate"), pipelineOptions.platformContract);
  let releaseWorkspace: (() => Promise<void>) | undefined;
  let tui: BuildTui | undefined;
  try {
    const builder = new PromptBuilder(new PiWorkerClient(builderGateway, join(dirname(runLogFile), "pi-sessions"), sseCaptureDir ?? undefined), {
      timeoutMs: modelTimeouts.builderTimeoutMs,
      requirementsDir: dirname(pipelineOptions.requirementsFile),
      contextWindow: builderContextWindow,
      referenceImages,
      visionProbe: new VisionCapability(builderGateway),
    });
    const planner = new LlmProbePlanner({
      ...judgeGateway,
      browserPath: pipelineOptions.platformContract.browserPath,
      timeoutMs: modelTimeouts.plannerTimeoutMs,
    });
    const runner = new PlaywrightProbeRunner();
    const lifecycle = candidate;
    const git = await GitCliOps.open(pipelineOptions.outputDir, {
      allowExisting: sourceProjectDir !== undefined || context.resumeCheckpointSha !== undefined, generatedPaths: pipelineOptions.platformContract.generatedPaths,
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
    const starterScaffold = await installStarterScaffold(
      pipelineOptions.outputDir,
      pipelineOptions.platformContract,
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
    const finalVerifier = new FinalVerifier(runner, lifecycle, candidate, context.runRecord.projectSpec);
    const promptDir = new URL("./prompts/", import.meta.url);
    const promptHash = createHash("sha256");
    for (const name of (await readdir(promptDir, { recursive: true })).filter((name) => name.endsWith(".md")).sort()) {
      const path = name.replaceAll("\\", "/");
      promptHash.update(path).update("\0").update((await readFile(new URL(path, promptDir), "utf8")).replace(/\r\n/g, "\n"));
    }
    if (process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY && process.env.TERM !== "dumb") {
      tui = new BuildTui({
        requirementIds: Object.keys(context.runRecord.requirementDigests!),
        onInterrupt: () => { process.kill(process.pid, "SIGINT"); },
      });
      tui.start();
    }
    const logSink = createRunLogSink(runLogFile, new ProgressJournal(pipelineOptions.outputDir), process.stderr,
      tui ? (rawLine, line) => tui!.record(rawLine, line) : undefined);
    const summary = await runPipeline({ ...pipelineOptions, stageStartingPoint }, {
      grouper: new LlmFeatureGrouper({ ...judgeGateway, timeoutMs: Infinity }),
      builder,
      planner,
      runner,
      git,
      appLifecycle: lifecycle,
      candidate,
      clock: { nowMs: () => Date.now() },
      finalVerifier,
      logSink,
      diagnosticSecrets: gatewaySecrets(builderGateway, judgeGateway),
      runMetadata: { model: builderGateway.model, judgeModel: judgeGateway.model,
        builderTimeoutMs: modelTimeouts.builderTimeoutMs,
        builderContextWindow,
        starterScaffold,
        promptSha256: promptHash.digest("hex"),
        probeSchemaSha256: createHash("sha256").update(JSON.stringify(PROBE_PLAN_JSON_SCHEMA)).digest("hex"),
      },
    });
    return summary;
  } finally {
    tui?.stop();
    try {
      await candidate.dispose();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[ShallowCode] 候选工作区清理失败：${sanitizeDiagnosticText(message, gatewaySecrets(builderGateway, judgeGateway))}\n`);
    }
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
