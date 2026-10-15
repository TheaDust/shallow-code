import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Type } from "typebox";
import { parse } from "yaml";

import {
  diffRequirements,
  normalizeDraft,
  serializeRequirementsYaml,
  summarizeTree,
  validateForGeneration,
  type RequirementNode,
  type RequirementRef,
} from "./dsl.js";
import type { DraftStore } from "./draft-store.js";

export { createDraftStore, type DraftStore } from "./draft-store.js";

export type RequirementsOutputMode = "create" | "update";

export interface ChatTurnResult {
  ok: boolean;
  error?: string;
  output?: RequirementsOutputMode;
}

/** 对话代理：一次 send 对应一个完整的用户回合（含工具循环与自动重试）。 */
export interface ChatAgent {
  send(text: string): Promise<ChatTurnResult>;
  abort(): Promise<void> | void;
  dispose(): void;
}

const parameters = Type.Object({
  requirements: Type.Unknown({
    description:
      "完整候选需求树的根节点对象（type 为 ROOT）。每次提交都是基于当前草案的完整替换，未修改的节点原样保留、沿用同一 id。",
  }),
  questions: Type.Array(Type.String(), {
    description: "当前仍未解决、会影响实现或验收的问题，按优先级排列；已解决的不要列出。",
  }),
});

/** 需求专用工具：模型的唯一需求修改通道。 */
export function createRequirementsTool(store: DraftStore) {
  return {
    name: "update_requirements",
    label: "更新需求草案",
    description:
      "提交完整候选需求树与当前未决问题，替换当前草案。requirements 是根节点对象：" +
      "每个节点包含 id、name、type（ROOT/FOLDER/ATOMIC）、description、dependencies、children 与 scenarios；" +
      "scenario 包含 id、name、steps，step 由 keyword（GIVEN/WHEN/THEN/AND/BUT）与 content 组成；" +
      "节点可包含 guidance 字符串数组：用户提出但无法从界面或行为独立验收的期望（页面主题、配色、风格、美观、语气等），" +
      "按用户原措辞逐条保留在最相关的节点上，不要为它们编造场景；" +
      "根节点可包含 data 初始数据（每项含 category 与 items 字符串数组）。" +
      "用户提供的参考文件路径放在对应节点的 visual_reference 字符串数组中，保留原路径，程序导出时复制并改为相对路径。" +
      "校验失败会返回具体错误，请在本回合内修正后重新提交。",
    promptSnippet: "update_requirements: 提交完整候选需求树与未决问题",
    parameters,
    async execute(
      _toolCallId: string,
      params: { requirements: unknown; questions: string[] },
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      _ctx?: unknown,
    ) {
      const result = store.submit(params.requirements, params.questions);
      if (!result.ok) {
        throw new Error(`需求草案校验失败：\n- ${result.errors.join("\n- ")}`);
      }
      return {
        content: [
          { type: "text" as const, text: `已更新需求草案（第 ${result.revision} 版）。` },
        ],
        details: { revision: result.revision },
      };
    },
  };
}

/** 模型表达文件操作意图；这里只请求审阅，确认与写入仍由对话程序执行。 */
export function createReviewTool(request: (mode: RequirementsOutputMode) => void) {
  return {
    name: "review_requirements",
    label: "审阅需求文档",
    description:
      "用户要求生成、保存、导出需求文档，或根据最新草案更新、同步现有需求时调用。" +
      "create 创建新需求目录，update 更新启动目录下的 requirements/requirements.yaml。" +
      "先完成用户要求的草案修改；草案没有变化时也可直接调用。" +
      "程序在本回合成功结束后校验并展示草案与目标文件，用户确认后才写入。",
    parameters: Type.Object({ mode: Type.Union([Type.Literal("create"), Type.Literal("update")]) }),
    async execute(_toolCallId: string, params: { mode: RequirementsOutputMode }) {
      request(params.mode);
      return {
        content: [{ type: "text" as const, text: "已请求需求审阅；本回合结束后由程序展示，确认后写入。" }],
        details: { mode: params.mode },
      };
    },
  };
}

const GENERATE_COMMANDS = new Set([
  "生成", "生成需求", "生成文档", "生成需求文档", "需求生成", "文档生成", "yaml生成",
  "整理好", "整理好了", "整理完成", "可以生成", "确认生成",
  "导出需求", "导出文档", "导出需求文档", "generate",
]);

/** 纯生成指令的快捷入口；其他自然语言意图通过 review_requirements 表达。 */
export function requestsGeneration(text: string): boolean {
  return GENERATE_COMMANDS.has(normalizeReply(text));
}

const AFFIRMATIVE_WORDS = new Set([
  "是", "是的", "好", "好的", "可以", "可以生成", "行", "确认", "确认生成", "没错", "对",
  "生成", "generate", "yes", "y",
]);

/** 审阅态下的确认词：整句匹配，避免把“是，但要改”误判为确认。 */
export function isAffirmative(text: string): boolean {
  return AFFIRMATIVE_WORDS.has(normalizeReply(text));
}

function normalizeReply(text: string): string {
  return text.trim().replace(/[。．.!！?？~～\s]+$/u, "").toLowerCase();
}

/** 每轮向代理提供当前草案与未决问题，再附上用户输入。 */
export function buildTurnMessage(text: string, store: DraftStore, outputFile?: string): string {
  const sections: string[] = [];
  if (store.tree) {
    sections.push(
      `【当前需求草案（第 ${store.revision} 版）】\n\`\`\`yaml\n${serializeRequirementsYaml(store.tree)}\`\`\``,
    );
  } else {
    sections.push("【当前需求草案】尚未建立，请根据用户输入整理第一版完整草案。");
  }
  sections.push(
    store.questions.length
      ? `【未决问题】\n${numberList(store.questions)}`
      : "【未决问题】无。",
  );
  if (outputFile) sections.push(`【需求文档路径】\n${outputFile}\n更新现有需求文档时使用此路径；创建新文档由程序选择新目录。`);
  // 最后一项是本轮输入；前面的项来自中断或失败的回合。
  const unfinished = store.pendingInputs.slice(0, -1);
  if (unfinished.length) sections.push(`【此前未完成的输入】\n${numberList(unfinished)}`);
  sections.push(`【用户输入】\n${text}`);
  return sections.join("\n\n");
}

export async function* assembleInputLines(lines: AsyncIterable<string>): AsyncGenerator<string> {
  let buffer: string[] = [];
  for await (const line of lines) {
    const trimmedEnd = line.trimEnd();
    if (trimmedEnd.endsWith("\\")) {
      buffer.push(trimmedEnd.slice(0, -1));
      continue;
    }
    if (buffer.length) {
      buffer.push(line);
      yield buffer.join("\n");
      buffer = [];
    } else {
      yield line;
    }
  }
  if (buffer.length) yield buffer.join("\n");
}

export interface ConversationOptions {
  agent: ChatAgent;
  store: DraftStore;
  input: AsyncIterable<string>;
  out: (text: string) => void;
  /** 生成目录的上级目录（启动目录）。 */
  baseDir: string;
  /** 当前输入界面的快捷键提示；纯文本模式使用行尾续行。 */
  inputHelp?: string;
  /** Interactive presentation; plain-text callers keep the existing transcript. */
  onView?: (view: ConversationView) => void;
}

export type ConversationView =
  | { type: "intro" }
  | { type: "draft"; revision: number; tree: RequirementNode | null; questions: string[];
      changes: ReturnType<typeof diffRequirements>; restored?: boolean }
  | { type: "review"; revision: number; tree: RequirementNode; references: ReferenceCopy[];
      file?: string; changes?: ReturnType<typeof diffRequirements> }
  | { type: "edit" };

export type ConversationOutcome =
  | { status: "generated" | "updated"; file: string }
  | { status: "ended" };

export async function runConversation(options: ConversationOptions): Promise<ConversationOutcome> {
  const { agent, store, input, out, baseDir } = options;
  if (options.onView) options.onView({ type: "intro" });
  else out(
    "Requirements Agent — 需求整理\n" +
      "用普通文字描述你的需求，我会整理草案并追问缺失信息；\n" +
      "已有写好的需求文档时，直接给出文件或目录路径即可读取。\n" +
      "需要生成时输入“生成”；更新文档可说“按最新草案更新需求文档”；" +
      (options.inputHelp ?? "行尾加 \\ 可以续行；Ctrl+C 退出。") + "\n\n",
  );
  if (store.tree || store.pendingInputs.length) {
    out(`已恢复需求草稿${store.file ? `：${store.file}` : ""}。可继续补充或生成需求文档。\n`);
    if (options.onView) options.onView({ type: "draft", revision: store.revision, tree: store.tree,
      questions: store.questions, changes: diffRequirements(store.tree, store.tree), restored: true });
    else out(`${formatTurnSummary(store, diffRequirements(store.tree, store.tree))}\n`);
    if (store.questions.length && options.onView) out(`【未决问题】\n${numberList(store.questions)}\n`);
    if (store.pendingInputs.length) out(`【此前未完成的输入】\n${numberList(store.pendingInputs)}\n`);
    out("\n");
  }
  let reviewedOutput: PreparedRequirementsOutput | null = null;
  for await (const raw of input) {
    const text = raw.trim();
    if (!text) continue;
    if (reviewedOutput) {
      if (isAffirmative(text)) {
        const action = reviewedOutput.update ? "更新" : "生成";
        try {
          const file = reviewedOutput.update
            ? await writeRequirementsUpdate(reviewedOutput.tree, reviewedOutput.update, reviewedOutput.references)
            : await writeRequirementsOutput(reviewedOutput.tree, baseDir, reviewedOutput.references);
          try {
            store.clearSavedDraft();
          } catch (error) {
            out(`需求文档已写出，但草稿清理失败：${error instanceof Error ? error.message : String(error)}。下次启动仍会恢复此草稿。\n`);
          }
          out(`已${action} ${file}\n`);
          return { status: reviewedOutput.update ? "updated" : "generated", file };
        } catch (error) {
          out(`${action}失败：${error instanceof Error ? error.message : String(error)}。回复“是”重试，或继续修改需求。\n\n`);
          continue;
        }
      }
      reviewedOutput = null;
      options.onView?.({ type: "edit" });
      // 非确认内容按普通修改继续对话。
    }
    let outputMode: RequirementsOutputMode | undefined = requestsGeneration(text) ? "create" : undefined;
    // 纯生成指令直接审阅；混合修改或中断后尚未完成的输入仍交给代理处理。
    if (!outputMode || store.pendingInputs.length) {
      const before = store.tree;
      store.recordInput(text);
      const result = await agent.send(buildTurnMessage(text, store, join(baseDir, "requirements", "requirements.yaml")));
      if (!result.ok) {
        if (options.onView && store.tree !== before) options.onView({ type: "draft", revision: store.revision,
          tree: store.tree, questions: store.questions, changes: diffRequirements(before, store.tree) });
        out(`本轮处理失败：${result.error ?? "未知错误"}。可以重试或继续输入。\n\n`);
        continue;
      }
      outputMode = result.output ?? outputMode;
      store.finishTurn();
      const changes = diffRequirements(before, store.tree);
      if (options.onView) options.onView({ type: "draft", revision: store.revision,
        tree: store.tree, questions: store.questions, changes });
      else out(`${formatTurnSummary(store, changes)}\n\n`);
    }
    if (!outputMode) continue;
    const action = outputMode === "update" ? "更新" : "生成";
    if (!store.tree) {
      out(`还不能${action}这份需求文档：需求草案为空，请先描述需求。\n\n`);
      continue;
    }
    const generationErrors = validateForGeneration(store.tree);
    if (generationErrors.length) {
      out(
        `还不能${action}这份需求文档：\n- ${generationErrors.join("\n- ")}\n` +
          "请继续补充或修正后再请求审阅。\n\n",
      );
      continue;
    }
    if (store.questions.length) {
      out(
        `还有 ${store.questions.length} 个未决问题需要先解决或确认：\n` +
          `${numberList(store.questions.slice(0, 3))}\n` +
          "请先回答这些问题；确认无需处理时也可以让智能体把问题移出列表。\n\n",
      );
      continue;
    }
    try {
      reviewedOutput = await prepareRequirementsOutput(store.tree, baseDir, outputMode);
    } catch (error) {
      out(`还不能${action}这份需求文档：${error instanceof Error ? error.message : String(error)}。请修正后重新请求审阅。\n\n`);
      continue;
    }
    if (options.onView) options.onView({ type: "review", revision: store.revision,
      tree: reviewedOutput.tree, references: reviewedOutput.references,
      ...(reviewedOutput.update ? { file: reviewedOutput.update.file, changes: reviewedOutput.changes } : {}) });
    else out(
      `──────── 需求审阅（第 ${store.revision} 版）────────\n` +
        (reviewedOutput.update ? `【将更新原文件】${reviewedOutput.update.file}\n` +
          `【相较原文件】${formatChanges(reviewedOutput.changes!)}\n` : "") +
        `${serializeRequirementsYaml(reviewedOutput.tree)}` +
        (reviewedOutput.references.length
          ? `【将交接的参考文件】\n${numberList(reviewedOutput.references.map((reference) => `${reference.source} → ${reference.destination}`))}\n`
          : "") +
        "────────\n" +
        `是否${action}这份需求文档？回复“是”${action}；回复其他内容继续修改。\n\n`,
    );
  }
  out("未生成需求文档，本次会话结束。" +
    (store.file && (store.tree || store.pendingInputs.length) ? `草稿已保留：${store.file}。\n` : "\n"));
  return { status: "ended" };
}

interface ReferenceCopy {
  source: string;
  destination: string;
}

interface PreparedRequirementsOutput {
  tree: RequirementNode;
  references: ReferenceCopy[];
  update?: { file: string; content: string };
  changes?: ReturnType<typeof diffRequirements>;
}

/** 在审阅前核对本地参考文件，审阅视图与最终 YAML 使用同一份树。 */
export async function prepareRequirementsOutput(
  tree: RequirementNode,
  baseDir: string,
  mode: RequirementsOutputMode = "create",
): Promise<PreparedRequirementsOutput> {
  const file = resolve(baseDir, "requirements", "requirements.yaml");
  const update = mode === "update" ? { file, content: await readFile(file, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`待更新的需求文档不存在：${file}`);
    throw error;
  }) } : undefined;
  const previous = update ? normalizeDraft(parse(update.content)) : undefined;
  if (previous && !previous.ok) throw new Error(`现有需求文档格式无效：${previous.errors.join("；")}`);
  const referenceDirectory = update ? `references/update-${randomUUID()}` : "references";
  const outputTree = structuredClone(tree);
  const references = new Map<string, ReferenceCopy>();
  const visit = async (node: RequirementNode): Promise<void> => {
    const paths = [...new Set([
      ...(node.visual_reference ?? []),
      ...[...node.description.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]),
    ])];
    const rewritten = new Map<string, string>();
    for (const path of paths) {
      const source = resolve(baseDir, path);
      let reference = references.get(source);
      if (!reference) {
        const file = await stat(source).catch(() => {
          throw new Error(`参考文件不存在或不可读取：${path}`);
        });
        if (!file.isFile()) throw new Error(`参考路径必须是普通文件：${path}`);
        reference = { source, destination: `${referenceDirectory}/${references.size + 1}-${basename(source)}` };
        references.set(source, reference);
      }
      rewritten.set(path, reference.destination);
    }
    if (node.visual_reference) node.visual_reference = node.visual_reference.map((path) => rewritten.get(path)!);
    node.description = node.description.replace(/(!\[[^\]]*\]\()([^)]+)(\))/g,
      (_match, prefix: string, path: string, suffix: string) => `${prefix}${rewritten.get(path)}${suffix}`);
    for (const child of node.children) await visit(child);
  };
  await visit(outputTree);
  return { tree: outputTree, references: [...references.values()],
    ...(update && previous?.ok ? { update, changes: diffRequirements(previous.tree, outputTree) } : {}) };
}

/** 先复制本次引用并写好临时 YAML，再替换原文件；失败不删除或改写原文档及其引用。 */
async function writeRequirementsUpdate(
  tree: RequirementNode,
  target: { file: string; content: string },
  references: ReferenceCopy[],
): Promise<string> {
  const directory = dirname(target.file);
  const temporary = join(directory, `.requirements-${randomUUID()}.tmp`);
  const referenceDirectory = references.length ? join(directory, dirname(references[0].destination)) : undefined;
  let referencesCreated = false;
  let written = false;
  try {
    if (referenceDirectory) {
      await mkdir(join(directory, "references"), { recursive: true });
      await mkdir(referenceDirectory);
      referencesCreated = true;
    }
    for (const reference of references) await copyFile(reference.source, join(directory, reference.destination));
    await writeFile(temporary, serializeRequirementsYaml(tree), { encoding: "utf8", flag: "wx" });
    if (await readFile(target.file, "utf8") !== target.content) {
      throw new Error("原文件在审阅后已改变，请重新请求审阅");
    }
    await rename(temporary, target.file);
    written = true;
    return target.file;
  } finally {
    await rm(temporary, { force: true });
    if (!written && referencesCreated) await rm(referenceDirectory!, { recursive: true, force: true });
  }
}

export async function writeRequirementsOutput(
  tree: RequirementNode,
  baseDir: string,
  references: ReferenceCopy[] = [],
): Promise<string> {
  for (let index = 1; ; index += 1) {
    const directory = join(baseDir, index === 1 ? "requirements" : `requirements-${index}`);
    const file = join(directory, "requirements.yaml");
    try {
      await mkdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    try {
      if (references.length) await mkdir(join(directory, "references"));
      for (const reference of references) await copyFile(reference.source, join(directory, reference.destination));
      await writeFile(file, serializeRequirementsYaml(tree), { encoding: "utf8", flag: "wx" });
      return file;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
}

function formatTurnSummary(
  store: DraftStore,
  diff: { added: RequirementRef[]; removed: RequirementRef[]; changed: RequirementRef[] },
): string {
  const lines: string[] = [];
  if (store.tree) {
    const summary = summarizeTree(store.tree);
    lines.push(`【草案（第 ${store.revision} 版）】${summary.atomics} 个功能，${summary.scenarios} 个场景`);
  } else {
    lines.push("【草案】尚未建立");
  }
  lines.push(`【本轮修改】${formatChanges(diff)}`);
  if (store.questions.length > 3) {
    lines.push(`【未决问题（共 ${store.questions.length} 个，显示前 3 个）】\n${numberList(store.questions.slice(0, 3))}`);
  } else if (store.questions.length) {
    lines.push(`【未决问题（共 ${store.questions.length} 个）】\n${numberList(store.questions)}`);
  } else {
    lines.push("【未决问题】无");
  }
  return lines.join("\n");
}

function formatChanges(diff: ReturnType<typeof diffRequirements>): string {
  const changes: string[] = [];
  if (diff.added.length) changes.push(`新增 ${diff.added.length} 项：${formatRefs(diff.added)}`);
  if (diff.changed.length) changes.push(`修改 ${diff.changed.length} 项：${formatRefs(diff.changed)}`);
  if (diff.removed.length) changes.push(`删除 ${diff.removed.length} 项：${formatRefs(diff.removed)}`);
  return changes.length ? changes.join("；") : "无变化";
}

function formatRefs(refs: RequirementRef[]): string {
  const shown = refs.slice(0, 6).map((ref) => `${ref.name}（${ref.id}）`);
  const suffix = refs.length > 6 ? `等 ${refs.length} 项` : "";
  return shown.join("、") + suffix;
}

function numberList(items: string[]): string {
  return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}
