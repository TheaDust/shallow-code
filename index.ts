import { access, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import { PromptBuilder } from "./src/builder/prompt-builder.js";
import { VisionCapability } from "./src/builder/vision-probe.js";
import { PiWorkerClient } from "./src/builder/pi-worker-client.js";
import { ArcEventSink } from "./src/arc-protocol.js";
import { localDefaultOutputDir, parseCliArgs } from "./src/cli.js";
import { FinalVerifier } from "./src/final-verifier.js";
import { CandidateRuntime } from "./src/candidate-runtime.js";
import { GitCliOps } from "./src/git-ops.js";
import { HumanRunFormatter } from "./src/human-log.js";
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
  createArcPlatformContract,
  FALLBACK_EXTRA_PORTS,
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

export interface AgentExecutionContext {
  gateway: GatewayConfig;
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

export async function main(
  argv: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
  execute: AgentExecution = executeProduction,
  envFile: string | null = ".env",
): Promise<number> {
  const cli = parseCliArgs(argv, { defaultOutputDir: localDefaultOutputDir("main") });
  const mergedEnv = await mergeGatewayEnv(env, envFile);
  const gateway = readGatewayConfig(mergedEnv);
  const requirementsFile = join(cli.requirementsDir, "requirements.yaml");
  try {
    await access(requirementsFile);
  } catch {
    throw new Error(`requirements.yaml is not readable at ${requirementsFile}`);
  }
  await mkdir(cli.outputDir, { recursive: true });
  const runId = `${process.pid}-${Date.now()}`;
  const evaluationPort = parseEvaluationPort(mergedEnv) ?? 3000;
  // Finals prohibit inspecting unpublished tests, including port discovery.
  const extraPorts = FALLBACK_EXTRA_PORTS.filter(port => port !== evaluationPort);
  const probePortOverride = parseProbePortOverride(mergedEnv);
  if (probePortOverride !== null && (probePortOverride === evaluationPort || extraPorts.includes(probePortOverride))) {
    throw new Error(
      `SHALLOW_PROBE_PORT must differ from the evaluation port ${evaluationPort} and the platform extra ports ${extraPorts.join(", ") || "(none)"}`,
    );
  }
  const probePort = probePortOverride ?? (await pickFreePort([evaluationPort, ...extraPorts]));
  const runDir = parseRunDirOverride(mergedEnv) ?? join(tmpdir(), "shallowcode-runs");
  const sseCaptureDir = resolveSseCaptureDir(mergedEnv, join(runDir, runId, "sse-capture"));
  const referenceImages = referenceImagesEnabled(mergedEnv);
  const pipelineOptions: PipelineOptions = {
    requirementsFile,
    outputDir: cli.outputDir,
    ledgerFile: join(runDir, runId, "run-ledger.jsonl"),
    totalBudgetMs: cli.budgetMs,
    platformContract: createArcPlatformContract(process.platform, probePort, evaluationPort, extraPorts),
    progressDir: join(cli.outputDir, PROGRESS_DIR_NAME),
    auditInheritedRequirements: parseEvolutionAuditInherited(mergedEnv),
    generateFinalAuditPlans: parseFinalAuditGeneratePlan(mergedEnv),
  };
  const summary = await execute({
    gateway,
    pipelineOptions,
    modelTimeouts: deriveModelTimeouts(cli.budgetMs),
    builderContextWindow: parseBuilderContextWindow(mergedEnv),
    sseCaptureDir,
    referenceImages,
  }).catch((error: unknown) => {
    throw new Error(sanitizeDiagnosticText(error instanceof Error ? error.message : String(error), [gateway.apiKey]));
  });
  return summary.status === "failed" ? 1 : 0;
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

async function executeProduction(
  context: AgentExecutionContext,
): Promise<RunSummary> {
  const { gateway, pipelineOptions, modelTimeouts, builderContextWindow, sseCaptureDir, referenceImages } = context;
  const runLogFile = join(dirname(pipelineOptions.ledgerFile), "run-log.txt");
  await assertPrivateRunDirectory(pipelineOptions.outputDir, dirname(runLogFile));
  process.stderr.write(`[ShallowCode] 运行日志文件：${runLogFile}\n`);
  process.stderr.write(`[ShallowCode] 平台额外端口（公共运行合同）：${pipelineOptions.platformContract.extraPorts?.join(", ") || "无"}\n`);
  if (sseCaptureDir) process.stderr.write(`[ShallowCode] SSE 抓包已启用（仅诊断用途）：${sseCaptureDir}\n`);
  process.stderr.write(`[ShallowCode] 参考图片：${referenceImages ? "已开启（首次附带前预探测模型视觉能力）" : "已关闭"}\n`);
  process.stderr.write(`[ShallowCode] 最终验收补生成 plan：${pipelineOptions.generateFinalAuditPlans ? "已开启" : "已关闭（仅复用已有 plan）"}\n`);
  const candidate = new CandidateRuntime(pipelineOptions.outputDir,
    join(dirname(runLogFile), "candidate"), pipelineOptions.platformContract);
  try {
    const builder = new PromptBuilder(new PiWorkerClient(gateway, join(dirname(runLogFile), "pi-sessions"), sseCaptureDir ?? undefined), {
      timeoutMs: modelTimeouts.builderTimeoutMs,
      requirementsDir: dirname(pipelineOptions.requirementsFile),
      contextWindow: builderContextWindow,
      referenceImages,
      visionProbe: new VisionCapability(gateway),
    });
    const planner = new LlmProbePlanner({
      ...gateway,
      timeoutMs: modelTimeouts.plannerTimeoutMs,
    });
    const runner = new PlaywrightProbeRunner();
    const lifecycle = candidate;
    const git = await GitCliOps.open(pipelineOptions.outputDir);
    // Git owns rollback from this point onward. Install the generic shell before
    // runPipeline captures its initial baseline, and never touch an existing app.
    const starterScaffold = await installStarterScaffold(
      pipelineOptions.outputDir,
      pipelineOptions.platformContract,
    );
    const stageStartingPoint = starterScaffold.status === "skipped_existing_application"
      ? "inherited_application" as const
      : starterScaffold.status === "installed"
        ? "blank_template" as const
        : "unknown" as const;
    process.stderr.write(`[ShallowCode] 通用脚手架：${starterScaffold.status}（${starterScaffold.reason}）\n`);
    const finalVerifier = new FinalVerifier(runner, lifecycle, candidate);
    const logSink = createRunLogSink(runLogFile, new ProgressJournal(pipelineOptions.outputDir));
    const projectionWarning = (error: unknown): void => {
      try { logSink.write(`${JSON.stringify({ at: new Date().toISOString(), type: "arc_projection_failed",
        detail: { message: sanitizeDiagnosticText(String(error), [gateway.apiKey]) } })}\n`); } catch { /* Diagnostic only. */ }
    };
    const arcEvents = new ArcEventSink(pipelineOptions.outputDir, {
      journalFile: join(dirname(runLogFile), "arc-projection.jsonl"),
    });
    await arcEvents.init().catch(projectionWarning);
    const promptDir = new URL("./prompts/", import.meta.url);
    const promptHash = createHash("sha256");
    for (const name of (await readdir(promptDir, { recursive: true })).filter((name) => name.endsWith(".md")).sort()) {
      const path = name.replaceAll("\\", "/");
      promptHash.update(path).update("\0").update((await readFile(new URL(path, promptDir), "utf8")).replace(/\r\n/g, "\n"));
    }
    try {
      return await runPipeline({ ...pipelineOptions, stageStartingPoint }, {
        grouper: new LlmFeatureGrouper({ ...gateway, timeoutMs: Infinity }),
        builder,
        planner,
        runner,
        git,
        appLifecycle: lifecycle,
        candidate,
        clock: { nowMs: () => Date.now() },
        finalVerifier,
        arcEvents,
        logSink,
        diagnosticSecrets: [gateway.apiKey],
        runMetadata: { model: gateway.model, builderTimeoutMs: modelTimeouts.builderTimeoutMs,
          builderContextWindow,
          starterScaffold,
          promptSha256: promptHash.digest("hex"),
          probeSchemaSha256: createHash("sha256").update(JSON.stringify(PROBE_PLAN_JSON_SCHEMA)).digest("hex"),
        },
      });
    } finally {
      await arcEvents.rebuild().catch(projectionWarning);
    }
  } finally {
    try {
      await candidate.dispose();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[ShallowCode] 候选工作区清理失败：${sanitizeDiagnosticText(message, [gateway.apiKey])}\n`);
    }
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

function createRunLogSink(runLogFile: string, journal?: ProgressJournal): LogSink {
  const runLogDir = dirname(runLogFile);
  const formatter = new HumanRunFormatter();
  return {
    write: (chunk) => {
      process.stderr.write(chunk);
      const line = formatter.format(chunk);
      if (line === null) return;
      mkdirSync(runLogDir, { recursive: true });
      appendFileSync(runLogFile, `${line}\n`, "utf8");
      journal?.appendLine(line);
    },
  };
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)));
      process.exitCode = 1;
    });
}
