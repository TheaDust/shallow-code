import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ApplicationRegistry } from "./application/registry.js";
import type { ApplicationContract } from "./application/port.js";
import type { CodingAgentPort } from "./builder/execution-port.js";
import { PROJECT_SPEC_FILENAME, loadProjectSpec, type ProjectSpec } from "./project-spec.js";
import { hasProjectFiles } from "./project-workspace.js";
import { sanitizeDiagnosticText } from "./diagnostics.js";

export type InitializationPath = "existing" | "complete_existing" | "default_scaffold" | "custom" | "declared_empty";

export function selectInitializationPath(hasCode: boolean, hasConfig: boolean, intent: string | null): InitializationPath {
  if (hasCode) return hasConfig ? "existing" : "complete_existing";
  if (hasConfig) return "declared_empty";
  return intent ? "custom" : "default_scaffold";
}

export async function readProjectIntent(requirementsDir: string): Promise<string | null> {
  let content: string;
  try { content = await readFile(join(requirementsDir, "project-intent.md"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (Buffer.byteLength(content) > 32 * 1024) throw new Error("project-intent.md exceeds 32 KiB");
  const intent = content.trim();
  if (!intent) throw new Error("project-intent.md is empty; remove it when no technology is specified");
  return intent;
}

export interface InitializationResult {
  path: InitializationPath;
  spec: ProjectSpec;
  contract: ApplicationContract;
  modelUsage: Array<{ input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost?: number }>;
}

export interface InitializationOptions {
  outputDir: string;
  privateDir: string;
  requirementsContext: string;
  intent: string | null;
  resumePath?: InitializationPath;
  existingConfigContent?: string;
  previousUsage?: InitializationResult["modelUsage"];
  env: Record<string, string | undefined>;
  diagnosticSecrets?: readonly string[];
  startedAtMs: number;
  budgetMs: number;
  applications: ApplicationRegistry;
  createBuilder(): CodingAgentPort;
  onEvent?(type: "initialization_started" | "initialization_attempt" | "initialization_verification_started" |
    "initialization_validation_failed" | "initialization_verified", detail: Record<string, unknown>): Promise<void>;
  onUsage?(usage: InitializationResult["modelUsage"]): Promise<void>;
  verify(outputDir: string, contract: ApplicationContract, privateDir: string): Promise<void>;
}

export async function initializeProject(options: InitializationOptions): Promise<InitializationResult> {
  const { outputDir, applications } = options;
  const configExists = (await readdir(outputDir)).includes(PROJECT_SPEC_FILENAME);
  const hasCode = await hasProjectFiles(outputDir);
  const path = options.resumePath ?? selectInitializationPath(hasCode, configExists, options.intent);
  const explicitConfig = (path === "existing" || path === "declared_empty")
    ? options.existingConfigContent ?? (configExists ? await readFile(join(outputDir, PROJECT_SPEC_FILENAME), "utf8") : undefined)
    : undefined;
  await options.onEvent?.("initialization_started", { path, hasCode, hasConfig: configExists, intentPresent: options.intent !== null });
  const parse = () => loadProjectSpec(outputDir, undefined, (raw, origin) =>
    applications.get((raw as { adapter?: string })?.adapter ?? "web").parseSpec(raw, origin));
  let workingContract: ApplicationContract | undefined;
  let verificationAttempt = 0;
  const validate = async (): Promise<{ spec: ProjectSpec; contract: ApplicationContract }> => {
    await options.onEvent?.("initialization_verification_started", { path, attempt: verificationAttempt });
    if (explicitConfig !== undefined && await readFile(join(outputDir, PROJECT_SPEC_FILENAME), "utf8") !== explicitConfig) {
      throw new Error("Existing project run configuration changed during initialization");
    }
    const spec = await parse();
    const contract = await applications.get(spec.adapter ?? "web").configure(spec, options.env);
    workingContract = contract;
    await options.verify(outputDir, contract, options.privateDir);
    return { spec, contract };
  };
  const usage: InitializationResult["modelUsage"] = [...(options.previousUsage ?? [])];
  let feedback = "";
  if (path === "default_scaffold") {
    const adapter = applications.get("web");
    const contract = await adapter.configure(adapter.defaultSpec(), options.env);
    await adapter.installScaffold(outputDir, contract);
    let actual: { spec: ProjectSpec; contract: ApplicationContract };
    try { actual = await validate(); }
    catch (error) {
      await options.onEvent?.("initialization_validation_failed", { path, attempt: 0,
        message: sanitizeDiagnosticText(error instanceof Error ? error.message : String(error), options.diagnosticSecrets) });
      throw error;
    }
    await options.onEvent?.("initialization_verified", { path, adapterId: actual.contract.adapterId });
    return { path, ...actual, modelUsage: usage };
  }
  if (path === "existing" && !options.intent) {
    try {
      const actual = await validate();
      await options.onEvent?.("initialization_verified", { path, adapterId: actual.contract.adapterId });
      return { path, ...actual, modelUsage: usage };
    } catch (error) {
      feedback = sanitizeDiagnosticText(error instanceof Error ? error.message : String(error), options.diagnosticSecrets);
      await options.onEvent?.("initialization_validation_failed", { path, attempt: 0, message: feedback });
    }
  }
  if (options.resumePath && path !== "existing" && path !== "declared_empty") {
    try {
      const actual = await validate();
      await options.onEvent?.("initialization_verified", { path, adapterId: actual.contract.adapterId, resumed: true });
      return { path, ...actual, modelUsage: usage };
    } catch { /* Retain generated files and continue the interrupted initializer. */ }
  }
  let builder: CodingAgentPort | undefined;
  try {
    if ((path === "existing" || path === "declared_empty") && options.intent) {
      builder = options.createBuilder();
      const remaining = options.budgetMs <= 0 ? 180_000 : options.startedAtMs + options.budgetMs - Date.now();
      if (remaining <= 0) throw new Error("Project initialization budget exhausted; resume this run to continue");
      const inspection = await builder.run({
        systemPrompt: await readFile(new URL("../prompts/builder/project-intent-inspection.md", import.meta.url), "utf8"),
        taskPrompt: `用户技术要求：\n${options.intent}`,
        outputDir, timeoutMs: Math.min(remaining, 180_000), sessionKey: "initialization-inspect", toolMode: "read_only",
      });
      if (inspection.execution?.usage.status === "available") {
        usage.push(inspection.execution.usage);
        await options.onUsage?.(usage);
      }
      const answer = inspection.summary.trim();
      if (inspection.outcome !== "completed" || !(answer.startsWith("COMPATIBLE") || answer.startsWith("CONFLICT:"))) {
        throw new Error(`Could not confirm whether existing project configuration matches project-intent.md: ${answer}`);
      }
      if (answer.startsWith("CONFLICT:")) throw new Error(answer);
      if (path === "existing") {
        try {
          const actual = await validate();
          await options.onEvent?.("initialization_verified", { path, adapterId: actual.contract.adapterId });
          return { path, ...actual, modelUsage: usage };
        } catch (error) {
          feedback = sanitizeDiagnosticText(error instanceof Error ? error.message : String(error), options.diagnosticSecrets);
          await options.onEvent?.("initialization_validation_failed", { path, attempt: 0, message: feedback });
        }
      }
    }
    for (let attempt = 1; attempt <= 4; attempt++) {
      const remaining = options.budgetMs <= 0 ? 900_000 : options.startedAtMs + options.budgetMs - Date.now();
      if (remaining <= 0) throw new Error("Project initialization budget exhausted; resume this run to continue");
      await options.onEvent?.("initialization_attempt", { path, attempt });
      verificationAttempt = attempt;
      builder ??= options.createBuilder();
      const adapterId = workingContract?.adapterId ?? (explicitConfig === undefined ? "web" : (JSON.parse(explicitConfig) as { adapter?: string }).adapter ?? "web");
      const initializationInstructions = applications.get(adapterId).initializationInstructions;
      const result = await builder.run({
        systemPrompt: [await readFile(new URL("../prompts/builder/project-initialization.md", import.meta.url), "utf8"), initializationInstructions].filter(Boolean).join("\n\n"),
        taskPrompt: [
          `初始化路径：${path}`,
          `用户明确技术要求：\n${options.intent ?? "无；沿用现有项目技术栈与目录"}`,
          `需求背景（只用于理解工程形态，不实现功能）：\n${options.requirementsContext.slice(0, 12_000)}`,
          explicitConfig === undefined
            ? "已有运行配置：无；请创建 shallowcode.config.json。"
            : "已有运行配置：有；保留其中明确的运行要求。",
          feedback ? `上一次控制器验证失败：${feedback}\n请修正并重新检查。` : "",
        ].filter(Boolean).join("\n\n"),
        outputDir, timeoutMs: Math.min(remaining, 900_000), sessionKey: "project-initialization",
        ...(workingContract ? { applicationContract: workingContract } : {}),
      });
      if (result.execution?.usage.status === "available") {
        usage.push(result.execution.usage);
        await options.onUsage?.(usage);
      }
      if (result.summary.trim().startsWith("CONFLICT:")) throw new Error(result.summary.trim());
      try {
        const actual = await validate();
        await options.onEvent?.("initialization_verified", { path, adapterId: actual.contract.adapterId, attempt });
        return { path, ...actual, modelUsage: usage };
      } catch (error) {
        feedback = sanitizeDiagnosticText(error instanceof Error ? error.message : String(error), options.diagnosticSecrets);
        await options.onEvent?.("initialization_validation_failed", { path, attempt, message: feedback });
      }
    }
    throw new Error(`Project initialization did not pass validation after four attempts: ${feedback}`);
  } finally { await builder?.close(); }
}
