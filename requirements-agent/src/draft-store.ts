import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { normalizeDraft, normalizeQuestions, type RequirementNode } from "./dsl.js";

interface DraftState {
  revision: number;
  tree: RequirementNode | null;
  questions: string[];
  pendingInputs: string[];
}

export interface DraftStore {
  readonly file: string | null;
  readonly revision: number;
  readonly tree: RequirementNode | null;
  readonly questions: string[];
  readonly pendingInputs: string[];
  /** 校验并保存完整候选草案；校验或保存失败不改变已有草案。 */
  submit(
    treeInput: unknown,
    questionsInput: unknown,
  ): { ok: true; revision: number } | { ok: false; errors: string[] };
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

  return {
    file,
    get revision() { return state.revision; },
    get tree() { return state.tree; },
    get questions() { return state.questions; },
    get pendingInputs() { return state.pendingInputs; },
    submit(treeInput, questionsInput) {
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
    },
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
    if ((tree && !tree.ok) || !questions.ok || (saved.tree === null && saved.revision !== 0)) {
      throw new Error("草稿内容未通过校验");
    }
    return { revision: saved.revision, tree: tree?.ok ? tree.tree : null,
      questions: questions.questions, pendingInputs: saved.pendingInputs };
  } catch (error) {
    throw new Error(`无法恢复需求草稿（${file}）：${error instanceof Error ? error.message : String(error)}。原文件已保留。`, { cause: error });
  }
}
