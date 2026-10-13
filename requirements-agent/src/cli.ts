import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Type } from "typebox";

import {
  diffRequirements,
  serializeRequirementsYaml,
  summarizeTree,
  validateForGeneration,
  type RequirementNode,
  type RequirementRef,
} from "./dsl.js";
import type { DraftStore } from "./draft-store.js";

export { createDraftStore, type DraftStore } from "./draft-store.js";

export interface ChatTurnResult {
  ok: boolean;
  error?: string;
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

const GENERATE_PATTERNS: RegExp[] = [
  /生成(需求|文档)/,
  /(需求|文档|yaml)\s*生成/i,
  /整理好(了)?/,
  /整理完成/,
  /可以生成/,
  /确认生成/,
  /导出(需求|文档)/i,
];

/** 用户是否请求生成需求文档（审阅流程的入口）。 */
export function requestsGeneration(text: string): boolean {
  return GENERATE_PATTERNS.some((pattern) => pattern.test(text));
}

const AFFIRMATIVE_WORDS = new Set([
  "是", "是的", "好", "好的", "可以", "可以生成", "行", "确认", "确认生成", "没错", "对",
  "生成", "generate", "yes", "y",
]);

/** 审阅态下的确认词：整句匹配，避免把“是，但要改”误判为确认。 */
export function isAffirmative(text: string): boolean {
  const normalized = text.trim().replace(/[。．.!！?？~～\s]+$/u, "").toLowerCase();
  return AFFIRMATIVE_WORDS.has(normalized);
}

/** 每轮向代理提供当前草案与未决问题，再附上用户输入。 */
export function buildTurnMessage(text: string, store: DraftStore): string {
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
  | { type: "review"; revision: number; tree: RequirementNode; references: ReferenceCopy[] }
  | { type: "edit" };

export type ConversationOutcome =
  | { status: "generated"; file: string }
  | { status: "ended" };

export async function runConversation(options: ConversationOptions): Promise<ConversationOutcome> {
  const { agent, store, input, out, baseDir } = options;
  if (options.onView) options.onView({ type: "intro" });
  else out(
    "Requirements Agent — 需求整理\n" +
      "用普通文字描述你的需求，我会整理草案并追问缺失信息；\n" +
      "已有写好的需求文档时，直接给出文件路径即可读取。\n" +
      "需要生成时输入“生成需求文档”；" +
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
        try {
          const file = await writeRequirementsOutput(reviewedOutput.tree, baseDir, reviewedOutput.references);
          try {
            store.clearSavedDraft();
          } catch (error) {
            out(`需求文档已写出，但草稿清理失败：${error instanceof Error ? error.message : String(error)}。下次启动仍会恢复此草稿。\n`);
          }
          out(`已生成 ${file}\n`);
          return { status: "generated", file };
        } catch (error) {
          out(`生成失败：${error instanceof Error ? error.message : String(error)}。回复“是”重试，或继续修改需求。\n\n`);
          continue;
        }
      }
      reviewedOutput = null;
      options.onView?.({ type: "edit" });
      // 非确认内容按普通修改继续对话。
    }
    const generateRequested = requestsGeneration(text);
    const before = store.tree;
    store.recordInput(text);
    const result = await agent.send(buildTurnMessage(text, store));
    if (!result.ok) {
      if (options.onView && store.tree !== before) options.onView({ type: "draft", revision: store.revision,
        tree: store.tree, questions: store.questions, changes: diffRequirements(before, store.tree) });
      out(`本轮处理失败：${result.error ?? "未知错误"}。可以重试或继续输入。\n\n`);
      continue;
    }
    store.finishTurn();
    const changes = diffRequirements(before, store.tree);
    if (options.onView) options.onView({ type: "draft", revision: store.revision,
      tree: store.tree, questions: store.questions, changes });
    else out(`${formatTurnSummary(store, changes)}\n\n`);
    if (!generateRequested) continue;
    if (!store.tree) {
      out("还不能生成这份需求文档：需求草案为空，请先描述需求。\n\n");
      continue;
    }
    const generationErrors = validateForGeneration(store.tree);
    if (generationErrors.length) {
      out(
        `还不能生成这份需求文档：\n- ${generationErrors.join("\n- ")}\n` +
          "请继续补充或修正后再生成。\n\n",
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
      reviewedOutput = await prepareRequirementsOutput(store.tree, baseDir);
    } catch (error) {
      out(`还不能生成这份需求文档：${error instanceof Error ? error.message : String(error)}。请修正参考文件后重新生成。\n\n`);
      continue;
    }
    if (options.onView) options.onView({ type: "review", revision: store.revision,
      tree: reviewedOutput.tree, references: reviewedOutput.references });
    else out(
      `──────── 需求审阅（第 ${store.revision} 版）────────\n` +
        `${serializeRequirementsYaml(reviewedOutput.tree)}` +
        (reviewedOutput.references.length
          ? `【将交接的参考文件】\n${numberList(reviewedOutput.references.map((reference) => `${reference.source} → ${reference.destination}`))}\n`
          : "") +
        "────────\n" +
        "是否生成这份需求文档？回复“是”生成；回复其他内容继续修改。\n\n",
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
}

/** 在审阅前核对本地参考文件，审阅视图与最终 YAML 使用同一份树。 */
export async function prepareRequirementsOutput(
  tree: RequirementNode,
  baseDir: string,
): Promise<PreparedRequirementsOutput> {
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
        reference = { source, destination: `references/${references.size + 1}-${basename(source)}` };
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
  return { tree: outputTree, references: [...references.values()] };
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
  const changes: string[] = [];
  if (diff.added.length) changes.push(`新增 ${diff.added.length} 项：${formatRefs(diff.added)}`);
  if (diff.changed.length) changes.push(`修改 ${diff.changed.length} 项：${formatRefs(diff.changed)}`);
  if (diff.removed.length) changes.push(`删除 ${diff.removed.length} 项：${formatRefs(diff.removed)}`);
  lines.push(changes.length ? `【本轮修改】${changes.join("；")}` : "【本轮修改】无变化");
  if (store.questions.length > 3) {
    lines.push(`【未决问题（共 ${store.questions.length} 个，显示前 3 个）】\n${numberList(store.questions.slice(0, 3))}`);
  } else if (store.questions.length) {
    lines.push(`【未决问题（共 ${store.questions.length} 个）】\n${numberList(store.questions)}`);
  } else {
    lines.push("【未决问题】无");
  }
  return lines.join("\n");
}

function formatRefs(refs: RequirementRef[]): string {
  const shown = refs.slice(0, 6).map((ref) => `${ref.name}（${ref.id}）`);
  const suffix = refs.length > 6 ? `等 ${refs.length} 项` : "";
  return shown.join("、") + suffix;
}

function numberList(items: string[]): string {
  return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}
