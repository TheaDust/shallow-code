import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  mergeDraft,
  normalizeDraft,
  normalizeQuestions,
  type RequirementNode,
  type ScenarioRef,
} from "./dsl.js";

interface DraftState {
  revision: number;
  tree: RequirementNode | null;
  questions: string[];
  pendingInputs: string[];
  /** undefined: no decision; null: explicitly remove an existing intent. */
  projectIntent?: string | null;
}

export type DraftSubmitResult =
  | { ok: true; revision: number }
  | { ok: false; errors: string[] };

/** 增量提交：只带变化部分，删除项显式列出。 */
export interface DraftPatch {
  requirements?: unknown;
  removedNodes?: unknown;
  removedScenarios?: unknown;
  questions?: unknown;
}

export interface DraftStore {
  readonly file: string | null;
  readonly revision: number;
  readonly tree: RequirementNode | null;
  readonly questions: string[];
  readonly pendingInputs: string[];
  readonly projectIntent: string | null | undefined;
  /** 校验并保存完整候选草案；校验或保存失败不改变已有草案。 */
  submit(treeInput: unknown, questionsInput: unknown): DraftSubmitResult;
  /** 按 id 合并增量草案；校验或保存失败不改变已有草案。 */
  apply(patch: DraftPatch): DraftSubmitResult;
  setProjectIntent(intent: string | null): void;
  recordInput(text: string): void;
  finishTurn(): void;
  clearSavedDraft(): void;
}

/** 每个启动目录保留一份草稿；省略目录时供无磁盘的调用方使用。 */
export function createDraftStore(baseDir?: string): DraftStore {
  const file = baseDir ? join(baseDir, ".requirements-agent", "draft.json") : null;
  let state: DraftState = { revision: 0, tree: null, questions: [], pendingInputs: [] };
  if (file) state = readDraft(file) ?? state;

  const commit = (next: DraftState): void => {
    if (file) {
      // 同步保存使退出信号不能打断提交；临时文件替换避免截断已有草稿。
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        try {
          writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, {
            encoding: "utf8", flag: "wx", mode: 0o600, flush: true,
          });
          renameSync(temporary, file);
        } finally {
          rmSync(temporary, { force: true });
        }
      } catch (error) {
        throw new Error(`需求草稿保存失败（${file}）：${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }
    state = next;
  };

  const submitDraft = (treeInput: unknown, questionsInput: unknown): DraftSubmitResult => {
    const tree = normalizeDraft(treeInput);
    const questions = normalizeQuestions(questionsInput);
    if (!tree.ok || !questions.ok) {
      return { ok: false, errors: [
        ...(tree.ok ? [] : tree.errors),
        ...(questions.ok ? [] : questions.errors),
      ] };
    }
    commit({ ...state, revision: state.revision + 1, tree: tree.tree, questions: questions.questions });
    return { ok: true, revision: state.revision };
  };

  const applyPatch = (patch: DraftPatch): DraftSubmitResult => {
    const removedNodes = normalizeRemovedNodes(patch.removedNodes);
    if (!removedNodes.ok) return removedNodes;
    const removedScenarios = normalizeRemovedScenarios(patch.removedScenarios);
    if (!removedScenarios.ok) return removedScenarios;
    const hasRemovals = removedNodes.ids.length > 0 || removedScenarios.refs.length > 0;

    if (!state.tree) {
      if (patch.requirements === undefined) {
        return { ok: false, errors: ["当前没有草案，请提交完整根节点。"] };
      }
      if (hasRemovals) {
        return { ok: false, errors: ["当前没有草案，不能删除节点或场景。"] };
      }
      return submitDraft(patch.requirements, patch.questions ?? []);
    }
    if (patch.requirements === undefined && !hasRemovals && patch.questions === undefined) {
      return { ok: false, errors: ["没有需要提交的变更。"] };
    }

    const merged = patch.requirements === undefined && !hasRemovals
      ? { ok: true as const, tree: state.tree }
      : mergeDraft(state.tree, patch.requirements ?? {}, removedNodes.ids, removedScenarios.refs);
    if (!merged.ok) return merged;
    const questions = patch.questions === undefined
      ? { ok: true as const, questions: state.questions }
      : normalizeQuestions(patch.questions);
    if (!questions.ok) return { ok: false, errors: questions.errors };

    commit({ ...state, revision: state.revision + 1, tree: merged.tree, questions: questions.questions });
    return { ok: true, revision: state.revision };
  };

  return {
    file,
    get revision() { return state.revision; },
    get tree() { return state.tree; },
    get questions() { return state.questions; },
    get pendingInputs() { return state.pendingInputs; },
    get projectIntent() { return state.projectIntent; },
    setProjectIntent(intent) {
      if (intent !== null && (!intent.trim() || Buffer.byteLength(intent) > 32 * 1024)) {
        throw new Error("技术意图必须是非空文本且不超过 32 KiB");
      }
      commit({ ...state, revision: state.revision + 1,
        projectIntent: intent === null ? null : intent.replace(/\r\n/g, "\n").trim() });
    },
    submit: submitDraft,
    apply: applyPatch,
    recordInput(text) {
      commit({ ...state, pendingInputs: [...state.pendingInputs, text] });
    },
    finishTurn() {
      if (state.pendingInputs.length) commit({ ...state, pendingInputs: [] });
    },
    clearSavedDraft() {
      if (file) rmSync(file, { force: true });
    },
  };
}

type RemovedNodesResult =
  | { ok: true; ids: string[] }
  | { ok: false; errors: string[] };

function normalizeRemovedNodes(value: unknown): RemovedNodesResult {
  if (value === undefined) return { ok: true, ids: [] };
  if (!Array.isArray(value)) {
    return { ok: false, errors: ["removedNodes 必须是字符串数组。"] };
  }
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      return { ok: false, errors: ["removedNodes 必须是非空字符串数组。"] };
    }
    ids.push(item.trim());
  }
  return { ok: true, ids: [...new Set(ids)] };
}

type RemovedScenariosResult =
  | { ok: true; refs: ScenarioRef[] }
  | { ok: false; errors: string[] };

function normalizeRemovedScenarios(value: unknown): RemovedScenariosResult {
  if (value === undefined) return { ok: true, refs: [] };
  if (!Array.isArray(value)) {
    return { ok: false, errors: ["removedScenarios 必须是 {node, id} 数组。"] };
  }
  const refs: ScenarioRef[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, errors: ["removedScenarios 必须是 {node, id} 数组。"] };
    }
    const record = item as Record<string, unknown>;
    if (typeof record.node !== "string" || !record.node.trim() ||
        typeof record.id !== "string" || !record.id.trim()) {
      return { ok: false, errors: ["removedScenarios 的 node 与 id 必须是非空字符串。"] };
    }
    refs.push({ node: record.node.trim(), id: record.id.trim() });
  }
  return {
    ok: true,
    refs: [...new Map(refs.map((ref) => [`${ref.node}\0${ref.id}`, ref])).values()],
  };
}

function readDraft(file: string): DraftState | null {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const saved = JSON.parse(content) as DraftState;
    if (!saved || !Number.isSafeInteger(saved.revision) || saved.revision < 0 ||
        !Array.isArray(saved.pendingInputs) || saved.pendingInputs.some(text => typeof text !== "string")) {
      throw new Error("草稿状态格式不正确");
    }
    const tree = saved.tree === null ? null : normalizeDraft(saved.tree);
    const questions = normalizeQuestions(saved.questions);
    if (saved.projectIntent !== undefined && saved.projectIntent !== null &&
      (typeof saved.projectIntent !== "string" || !saved.projectIntent.trim() || Buffer.byteLength(saved.projectIntent) > 32 * 1024)) {
      throw new Error("技术意图草稿格式不正确");
    }
    if ((tree && !tree.ok) || !questions.ok ||
      (saved.tree === null && saved.revision !== 0 && saved.projectIntent === undefined)) {
      throw new Error("草稿内容未通过校验");
    }
    return { revision: saved.revision, tree: tree?.ok ? tree.tree : null,
      questions: questions.questions, pendingInputs: saved.pendingInputs,
      ...(saved.projectIntent !== undefined ? { projectIntent: saved.projectIntent } : {}) };
  } catch (error) {
    throw new Error(`无法恢复需求草稿（${file}）：${error instanceof Error ? error.message : String(error)}。原文件已保留。`, { cause: error });
  }
}
