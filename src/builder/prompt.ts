import type {
  AtomicRequirement,
  PlatformContract,
  ProcessCommand,
  ProductContext,
  WorkPacket,
} from "../types.js";
import type {
  BuilderPromptInput,
  BuilderProjectContext,
  BuilderShadowObservation,
  DeliveryFailureObservation,
} from "./prompt-input.js";
import {
  PROMPT_FRAGMENTS,
  selectPromptFragments,
  type PromptFragmentId,
} from "./prompt-fragments.js";
import { fillTemplate, loadPrompt } from "../prompt-assets.js";

export interface CompiledBuilderPrompt {
  systemPrompt: string;
  taskPrompt: string;
  fragmentIds: PromptFragmentId[];
}

const SYSTEM_PROMPT = [
  loadPrompt("system", "builder-system"),
  loadPrompt("system", "architecture-notes"),
  loadPrompt("system", "self-test"),
].join("\n\n");

export function compileBuilderPrompt(
  request: BuilderPromptInput,
): CompiledBuilderPrompt {
  return {
    systemPrompt: SYSTEM_PROMPT,
    taskPrompt: buildBuilderTaskPrompt(request),
    fragmentIds: selectPromptFragments(request),
  };
}

export function buildBuilderTaskPrompt(request: BuilderPromptInput): string {
  const receipt = receiptSection();
  switch (request.mode) {
    case "implement": {
      const task = fillTemplate(
        loadPrompt("system", "task-implement"),
        {
          PACKET_ID: request.packet.id,
          PACKET_ATTEMPT: String(request.packet.attempt),
          OUTPUT_DIR: request.outputDir,
          ACTION: implementAction(),
          PRODUCT_CONTEXT: productContextSection(request.projectContext.product),
          PROJECT_CONTEXT: projectContextSection(request.projectContext),
          WORK_PACKET: workPacketSection(request.packet),
          PLATFORM_CONTRACT: platformContractSection(request.platformContract),
          FRAGMENTS: fragmentSection(selectPromptFragments(request)),
          RECEIPT: receipt,
        },
      );
      return task.trim();
    }
    case "repair":
    case "root_cause_repair": {
      const name =
        request.mode === "repair" ? "task-repair" : "task-root-cause-repair";
      const task = fillTemplate(loadPrompt("system", name), {
        PACKET_ID: request.packet.id,
        PACKET_ATTEMPT: String(request.packet.attempt),
        OUTPUT_DIR: request.outputDir,
        ACTION:
          request.mode === "repair"
            ? repairAction(request.shadowObservation)
            : rootCauseRepairAction(request.shadowObservation),
        PRODUCT_CONTEXT: productContextSection(request.projectContext.product),
        PROJECT_CONTEXT: projectContextSection(request.projectContext),
        WORK_PACKET: workPacketSection(request.packet),
        PLATFORM_CONTRACT: platformContractSection(request.platformContract),
        FRAGMENTS: fragmentSection(selectPromptFragments(request)),
        RECEIPT: receipt,
      });
      return task.trim();
    }
    case "delivery_repair": {
      const task = fillTemplate(
        loadPrompt("system", "task-delivery-repair"),
        {
          OUTPUT_DIR: request.outputDir,
          ACTION: deliveryRepairAction(request.deliveryFailure),
          PLATFORM_CONTRACT: platformContractSection(request.platformContract),
          FRAGMENTS: fragmentSection(selectPromptFragments(request)),
          RECEIPT: receipt,
        },
      );
      return task.trim();
    }
  }
}

function implementAction(): string {
  return loadPrompt("system", "action-implement");
}

function repairAction(observation: BuilderShadowObservation): string {
  return fillTemplate(loadPrompt("system", "action-repair"), {
    PASSED_CASE_IDS: observation.passedCaseIds.join("、") || "无",
    FAILURES: renderFailures(observation),
  });
}

function rootCauseRepairAction(observation: BuilderShadowObservation): string {
  return fillTemplate(loadPrompt("system", "action-root-cause-repair"), {
    PASSED_CASE_IDS: observation.passedCaseIds.join("、") || "无",
    FAILURES: renderFailures(observation),
  });
}

function deliveryRepairAction(
  failure: DeliveryFailureObservation,
): string {
  return fillTemplate(loadPrompt("system", "action-delivery-repair"), {
    FAILURE_STAGE: failure.stage,
    FAILURE_COMMAND: failure.command ?? "未提供",
    FAILURE_EXPECTED: failure.expected,
    FAILURE_ACTUAL: failure.actual,
  });
}

function productContextSection(product: ProductContext): string {
  return [
    "## 项目上下文",
    "",
    "产品目标：",
    product.description,
    ...(product.seedData.length > 0 ? [
      "",
      fillTemplate(loadPrompt("system", "seed-data"), {
        SEED_DATA: product.seedData.map(({ category, items }) =>
          [`### ${category}`, ...items.map((item) => `- ${item}`)].join("\n"),
        ).join("\n\n"),
      }),
    ] : []),
  ].join("\n");
}

function projectContextSection(context: BuilderProjectContext): string {
  return [
    ...(context.evolution ? [evolutionSection(context.evolution), ""]
      : context.progressiveStage ? [progressiveStageSection(context.progressiveStage), ""] : []),
    "当前功能路径：",
    context.ancestors.length > 0
      ? context.ancestors
          .map(
            (ancestor) =>
              `${ancestor.id} ${ancestor.name}：${ancestor.description}`,
          )
          .join("\n")
      : "无",
    "",
    "已有可运行实现的直接依赖：",
    context.satisfiedDependencies.length > 0
      ? context.satisfiedDependencies
          .map(
            (dependency) =>
              `${dependency.id} ${dependency.name}${dependency.contract === undefined ? "" : `：${dependency.contract}`}`,
          )
          .join("\n")
      : "无",
    "",
    "这些依赖已有可运行实现，功能仍以独立验收为准。复用现有代码；若阻碍本包需求，可按需求原文修正并在回执说明。",
  ].join("\n");
}

function evolutionSection(context: NonNullable<BuilderProjectContext["evolution"]>): string {
  const inherited = context.startingPoint === "inherited_application";
  return fillTemplate(loadPrompt("system", "evolution-context"), {
    STAGE_CONTEXT: context.stageIndex === undefined ? "" : `；Stage ${context.stageIndex}`,
    STARTING_POINT: inherited ? "已有应用"
      : context.startingPoint === "blank_template" ? "空白通用模板" : "未明确；先检查项目目录判断是否已有应用",
    EXTERNAL_PREREQUISITES: context.externalPrerequisiteIds.join("、") || "无",
    STARTING_POINT_ACTION: incrementalStartingPointAction(context.startingPoint),
    IMPLEMENTATION_SCOPE: context.changesOnly ? loadPrompt("system", "evolution-changes-only") : "",
    AUDIT_SCOPE: loadPrompt("system", context.auditInheritedRequirements === false ? "evolution-audit-changes" : "evolution-audit-all"),
  });
}

function progressiveStageSection(stage: NonNullable<BuilderProjectContext["progressiveStage"]>): string {
  const inherited = stage.startingPoint === "inherited_application";
  const startingPoint = inherited
    ? "继承自前序阶段的应用"
    : stage.startingPoint === "blank_template"
      ? "空白通用模板"
      : "未明确；先检查项目目录判断是否已有应用";
  return fillTemplate(loadPrompt("system", "progressive-stage-context"), {
    STAGE_INDEX: String(stage.index),
    STARTING_POINT: startingPoint,
    EXTERNAL_PREREQUISITES: stage.externalPrerequisiteIds.join("、") || "无",
    STARTING_POINT_ACTION: incrementalStartingPointAction(stage.startingPoint),
  });
}

function incrementalStartingPointAction(startingPoint: NonNullable<BuilderProjectContext["evolution"]>["startingPoint"]): string {
  const asset = startingPoint === "inherited_application" ? "incremental-start-inherited"
    : startingPoint === "blank_template" ? "incremental-start-blank" : "incremental-start-unknown";
  return loadPrompt("system", asset);
}

function workPacketSection(packet: WorkPacket): string {
  const seedLines = packet.requirements.flatMap((requirement) =>
    requirement.seedDeclarations.map((clause) => `- ${requirement.id}：${clause}`),
  );
  return [
    "## 当前工作包",
    "",
    packet.requirements.map(renderRequirement).join("\n\n"),
    ...(seedLines.length > 0 ? [
      "",
      "### 本包初始数据原文摘录",
      "",
      "以下按需求 ID 摘录动作前初始态，按系统合同判断作用域：相容的预置记录须完整播种，独立场景中同名对象的互斥初始值分别保留。摘录不代表全部初始数据，仍须核对需求全文。",
      ...seedLines,
    ] : []),
  ].join("\n");
}

function renderRequirement(requirement: AtomicRequirement): string {
  return [
    `### ${requirement.id}：${requirement.name}`,
    "",
    `父级路径：${requirement.folderPath.join(" / ")}`,
    "",
    "需求原文：",
    requirement.text,
    "",
    "验收场景：",
    requirement.scenarios.join("\n\n") || "无",
    "",
    "引用资料：",
    requirement.references.join("、") || "无",
    "",
    "需求中的引号原词（须按原文区分界面名称、数据值与示例）：",
    [...new Set(requirement.exactUiStrings)].join(" | ") || "无",
  ].join("\n");
}

function renderFailures(observation: BuilderShadowObservation): string {
  if (observation.failures.length === 0) return "无";
  return observation.failures
    .map((failure) => {
      const lines = [
        `- 用例 ${failure.caseId}，步骤 ${failure.stepIndex}，类别 ${failure.category}`,
        `  消息：${failure.message}`,
      ];
      if (failure.accessibilityExcerpt) {
        lines.push(`  可访问性节选：${failure.accessibilityExcerpt}`);
      }
      if (failure.inputSummary) lines.push(`  输入观测：${failure.inputSummary}`);
      return lines.join("\n");
    })
    .join("\n");
}

function platformContractSection(contract: PlatformContract): string {
  const extraPorts = contract.extraPorts ?? [];
  const extraPortsSection = extraPorts.length === 0 ? "" : fillTemplate(loadPrompt("system", "platform-extra-ports"), {
    EXTRA_PORTS: extraPorts.join("、"),
    PROBE_PORT: String(contract.port),
  });
  return fillTemplate(loadPrompt("system", "platform-contract"), {
    PROBE_PORT: String(contract.port),
    EVAL_PORT: String(contract.evaluationPort),
    EXTRA_PORTS_SECTION: extraPortsSection,
    INSTALL_COMMANDS: contract.installCommands.map(renderCommand).join("\n") || "无",
    BUILD_COMMANDS: contract.buildCommands.map(renderCommand).join("\n") || "无",
    START_COMMAND: renderCommand(contract.startCommand),
    HEALTH_PATH: contract.healthPath,
    BASE_URL: contract.baseUrl,
  });
}

function fragmentSection(fragmentIds: PromptFragmentId[]): string {
  return [
    "## 本次适用的实现规则",
    "",
    fragmentIds.map((id) => PROMPT_FRAGMENTS[id]).join("\n\n"),
  ].join("\n");
}

function receiptSection(): string {
  return loadPrompt("system", "receipt");
}

function renderCommand(command: ProcessCommand): string {
  const prefix = command.cwd === "output" ? [] : ["--prefix", command.cwd];
  return [command.executable, ...prefix, ...command.args].join(" ");
}
