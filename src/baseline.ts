import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { applications } from "./adapters/index.js";
import { verifyInitializedWebProject } from "./adapters/web/initialization.js";
import type { ApplicationContract } from "./application/port.js";
import type { CodingAgentPort, CodingAgentRequest } from "./builder/execution-port.js";
import type { BuilderResult } from "./builder/port.js";
import { PiWorkerClient } from "./builder/pi-worker-client.js";
import { VisionCapability } from "./builder/vision-probe.js";
import { loadRequirementCatalog } from "./catalog.js";
import { sanitizeDiagnosticText } from "./diagnostics.js";
import { resolveModelRates, UsageTotals, usageCost } from "./model-usage.js";
import { initializeProject, readProjectIntent } from "./project-initialization.js";
import { loadProjectSpec, PROJECT_SPEC_FILENAME } from "./project-spec.js";
import { hasProjectFiles } from "./project-workspace.js";
import { fillTemplate, loadPrompt } from "./prompt-assets.js";
import { assertPrivateRunDirectory, digest, lockWorkspace, snapshotFiles } from "./run-record.js";
import { parseBuilderContextWindow, readGatewayConfig, referenceImagesEnabled,
  resolveSseCaptureDir } from "./runtime-config.js";

export interface BaselineOptions {
  requirementsDir: string;
  outputDir: string;
  runDirectory: string;
  env: Record<string, string | undefined>;
  /** Optional limit for development and reference-image preflight; null or omitted means no limit. */
  timeoutMs?: number | null;
}

export interface BaselineDependencies {
  createBuilder?(sessionDirectory: string): CodingAgentPort;
  verifyProject?(outputDir: string, contract: ApplicationContract, privateDir: string): Promise<void>;
}

export interface BaselineResult {
  method: "builder-self-check";
  status: "completed" | "failed" | "timed_out";
  startedAt: string;
  durationMs: number;
  modelUsage: ReturnType<UsageTotals["summary"]>;
  usageComplete: boolean;
  builder?: BuilderResult;
  runtimeCheck: "not_run" | "passed" | "failed";
  finalFiles?: Record<string, string>;
  finalDigest?: string;
  error?: string;
}

/** One whole-project coding session with the same Pi tools and initialization as Shallow. */
export async function runBaseline(options: BaselineOptions, dependencies: BaselineDependencies = {}): Promise<BaselineResult> {
  const { env } = options;
  const outputDir = resolve(options.outputDir), requirementsDir = resolve(options.requirementsDir);
  const runDirectory = resolve(options.runDirectory);
  const timeoutMs = options.timeoutMs ?? null;
  if (timeoutMs !== null && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)) {
    throw new Error("Baseline timeout must be an integer from 1 to 2147483647 ms");
  }
  const gateway = readGatewayConfig(env, "builder");
  const rates = resolveModelRates(gateway.baseUrl, gateway.model, { agent: "builder", env });
  const contextWindow = parseBuilderContextWindow(env);
  const referenceImages = referenceImagesEnabled(env);
  await mkdir(outputDir, { recursive: true });
  await assertPrivateRunDirectory(outputDir, runDirectory);
  await assertPrivateRunDirectory(requirementsDir, runDirectory);
  // A run is immutable; accidentally reusing its path must not overwrite prior results.
  await writeFile(join(runDirectory, "baseline.json"), JSON.stringify({ method: "builder-self-check" }) + "\n", { flag: "wx" });
  const release = await lockWorkspace(outputDir);
  const started = Date.now();
  const usage = new UsageTotals();
  const result: BaselineResult = { method: "builder-self-check", status: "failed", startedAt: new Date(started).toISOString(),
    durationMs: 0, modelUsage: usage.summary(), usageComplete: true, runtimeCheck: "not_run" };
  const verifyProject = dependencies.verifyProject ?? verifyInitializedWebProject;
  const createBuilder = dependencies.createBuilder ?? ((sessionDirectory: string) => new PiWorkerClient(gateway, sessionDirectory,
    resolveSseCaptureDir(env, join(runDirectory, "sse-capture")) ?? undefined,
    { applications, ...(rates ? { modelCost: rates } : {}) }));
  let builder: CodingAgentPort | undefined;
  let contract: ApplicationContract | undefined;
  try {
    const requirementFiles = await snapshotFiles(requirementsDir);
    const requirementSnapshot = join(runDirectory, "requirements");
    for (const path of Object.keys(requirementFiles)) {
      const destination = join(requirementSnapshot, path);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(requirementsDir, path), destination);
    }
    if (digest(JSON.stringify(await snapshotFiles(requirementSnapshot))) !== digest(JSON.stringify(requirementFiles))) {
      throw new Error("Requirements changed while copying the run inputs");
    }
    const inheritedApplication = await hasProjectFiles(outputDir);
    const catalog = await loadRequirementCatalog(join(requirementSnapshot, "requirements.yaml"), { inheritedApplication });
    const requirementsContext = await readFile(join(requirementSnapshot, "requirements.yaml"), "utf8");
    const intent = await readProjectIntent(requirementSnapshot);
    const parseSpec = () => loadProjectSpec(outputDir, undefined, (raw, origin) =>
      applications.get((raw as { adapter?: string }).adapter ?? "web").parseSpec(raw, origin));
    const initialSpec = (await readdir(outputDir)).includes(PROJECT_SPEC_FILENAME) ? await parseSpec() : undefined;
    const inputFiles = await snapshotFiles(outputDir, initialSpec?.generatedPaths);
    const record = { method: result.method, startedAt: result.startedAt, outputDir, requirementsDir,
      requirementsDigest: digest(JSON.stringify(requirementFiles)), requirementFiles, inputFiles,
      startingPoint: inheritedApplication ? "inherited_application" : "blank_template",
      gateway: { baseUrl: gateway.baseUrl, model: gateway.model }, modelRates: rates, contextWindow, referenceImages, timeoutMs };
    const saveRecord = async (extra: object = {}) => writeFile(join(runDirectory, "baseline.json"),
      JSON.stringify({ ...record, ...extra }, null, 2) + "\n");
    await saveRecord();
    const initialization = await initializeProject({ outputDir, privateDir: runDirectory, requirementsContext, intent, env,
      applications, verify: verifyProject, diagnosticSecrets: [gateway.apiKey],
      createBuilder: () => {
        const client = createBuilder(join(runDirectory, "initialization-sessions"));
        return { async run(request) {
          const response = await client.run(request);
          if (response.execution?.usage.status !== "available") result.usageComplete = false;
          return response;
        }, close: () => client.close() };
      },
      onUsage: async items => { usage.add(items.at(-1)!); },
    });
    contract = initialization.contract;
    await saveRecord({ initializationPath: initialization.path, projectSpec: initialization.spec, applicationContract: contract,
      initializedFiles: await snapshotFiles(outputDir, contract.generatedPaths) });
    const prompt = {
      systemPrompt: [loadPrompt("builder", "baseline-system"), loadPrompt("builder", "architecture-notes"),
        loadPrompt("builder", "self-test")].join("\n\n"),
      taskPrompt: fillTemplate(loadPrompt("builder", "baseline-task"), { OUTPUT_DIR: outputDir,
        PROJECT_INTENT: intent ?? "沿用已初始化工程的技术栈与目录。",
        RUN_CONTRACT: contract.builderInstructions ?? JSON.stringify(contract, null, 2) })
        + "\n\n## 完整需求原文\n\n" + requirementsContext
        + "\n\n## 场景标识\n\n" + JSON.stringify(catalog.requirements.map(requirement => ({ requirementId: requirement.id,
          scenarios: requirement.scenarioContracts?.map(scenario => ({ id: scenario.id, name: scenario.name })) ?? [] })), null, 2),
    };
    await writeFile(join(runDirectory, "prompt.json"), JSON.stringify(prompt, null, 2) + "\n");
    builder = createBuilder(join(runDirectory, "pi-sessions"));
    const deadline = timeoutMs === null ? Infinity : Date.now() + timeoutMs;
    const remainingTimeout = () => timeoutMs === null ? null : Math.max(1, deadline - Date.now());
    const references = [...new Set(catalog.requirements.flatMap(requirement => requirement.references))];
    let visionUnsupported = false;
    if (referenceImages && references.length) {
      visionUnsupported = await new VisionCapability(gateway).supports(timeoutMs === null ? Infinity : Math.floor(timeoutMs / 10), observed => {
        usage.add({ ...observed, ...(rates ? { cost: usageCost(observed, rates) } : {}) });
      }) === "unsupported";
    }
    const request: CodingAgentRequest = { ...prompt, outputDir, timeoutMs: remainingTimeout(),
      applicationContract: contract, requirementsDir: requirementSnapshot, references, contextWindow,
      attachReferences: referenceImages && !visionUnsupported, visionUnsupported };
    const account = (response: BuilderResult) => {
      if (response.execution?.usage.status === "available") usage.add(response.execution.usage);
      else result.usageComplete = false;
    };
    let response = await builder.run(request);
    account(response);
    if (response.imageUnsupported && referenceImages && !visionUnsupported && Date.now() < deadline) {
      response = await builder.run({ ...request, textOnly: true, timeoutMs: remainingTimeout() });
      account(response);
    }
    result.builder = { ...response, summary: sanitizeDiagnosticText(response.summary, [gateway.apiKey], 8_000) };
    result.status = response.outcome;
    await writeFile(join(runDirectory, "self-check.md"), result.builder.summary + "\n");
    // The final technical check produces no feedback to the coding session.
    if (response.outcome === "completed") {
      result.runtimeCheck = "failed";
      if (digest(JSON.stringify(await parseSpec())) !== digest(JSON.stringify(initialization.spec))) {
        throw new Error("Project run configuration changed from the initialized contract");
      }
      await verifyProject(outputDir, contract, join(runDirectory, "final-runtime"));
      result.runtimeCheck = "passed";
    }
  } catch (error) {
    result.status = "failed";
    result.error = sanitizeDiagnosticText(error instanceof Error ? error.message : String(error), [gateway.apiKey]);
    if (!result.builder) result.usageComplete = false;
  } finally {
    try {
      try { await builder?.close(); }
      catch (error) { result.status = "failed"; result.error = sanitizeDiagnosticText(String(error), [gateway.apiKey]); }
      try {
        result.finalFiles = await snapshotFiles(outputDir, contract?.generatedPaths);
        result.finalDigest = digest(JSON.stringify(result.finalFiles));
      } catch (error) {
        result.status = "failed";
        result.error = sanitizeDiagnosticText(String(error), [gateway.apiKey]);
      }
      result.durationMs = Date.now() - started;
      result.modelUsage = usage.summary();
      await writeFile(join(runDirectory, "result.json"), JSON.stringify(result, null, 2) + "\n");
    } finally { await release(); }
  }
  return result;
}
