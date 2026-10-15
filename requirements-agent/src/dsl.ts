import { stringify } from "yaml";

export type RequirementType = "ROOT" | "FOLDER" | "ATOMIC";
export type StepKeyword = "GIVEN" | "WHEN" | "THEN" | "AND" | "BUT";

export interface RequirementStep {
  keyword: StepKeyword;
  content: string;
}

export interface RequirementScenario {
  id: string;
  name: string;
  steps: RequirementStep[];
}

export interface SeedDataCategory {
  category: string;
  items: string[];
}

export interface RequirementNode {
  id: string;
  name: string;
  type: RequirementType;
  description: string;
  /** 用户提出但无法独立验收的期望（主题、风格、美观、语气等）；按原文保留。 */
  guidance?: string[];
  dependencies: string[];
  children: RequirementNode[];
  scenarios: RequirementScenario[];
  visual_reference?: string[];
  /** 仅根节点：初始数据声明。 */
  data?: SeedDataCategory[];
}

export interface RequirementRef {
  id: string;
  name: string;
}

export type NormalizeResult =
  | { ok: true; tree: RequirementNode }
  | { ok: false; errors: string[] };

export type QuestionsResult =
  | { ok: true; questions: string[] }
  | { ok: false; errors: string[] };

const TYPES = new Set<RequirementType>(["ROOT", "FOLDER", "ATOMIC"]);
const KEYWORDS = new Set<StepKeyword>(["GIVEN", "WHEN", "THEN", "AND", "BUT"]);

/**
 * 把模型提交的候选草案规格化为内部需求树并做结构校验。
 * 草案允许尚待澄清的业务内容；身份、形状与引用必须一致。
 */
export function normalizeDraft(input: unknown): NormalizeResult {
  const errors: string[] = [];
  if (!isRecord(input)) {
    return { ok: false, errors: ["需求草案必须是一个对象（根节点）。"] };
  }
  const tree = normalizeNode(input, "根节点", true, errors);
  if (tree.type !== "ROOT") {
    errors.push(`根节点 type 必须是 ROOT，当前是 ${tree.type}。`);
  }
  const index = new Map<string, RequirementNode>();
  collectNodes(tree, index, errors);
  validateDependencies(index, errors);
  if (!errors.length) validateAtomicDependencies(tree, index, errors);
  return errors.length ? { ok: false, errors } : { ok: true, tree };
}

/** 未决问题列表：非空字符串数组，空项被丢弃。 */
export function normalizeQuestions(input: unknown): QuestionsResult {
  if (!Array.isArray(input)) {
    return { ok: false, errors: ["questions 必须是非空字符串数组。"] };
  }
  const questions: string[] = [];
  for (const item of input) {
    if (typeof item !== "string") {
      return { ok: false, errors: ["questions 必须是非空字符串数组。"] };
    }
    const text = item.trim();
    if (text) questions.push(text);
  }
  return { ok: true, questions };
}

/** 生成前的完整性检查：结构之外的场景与结果要求。返回阻塞项（空数组表示通过）。 */
export function validateForGeneration(tree: RequirementNode | null): string[] {
  if (!tree) return ["需求草案为空，请先描述需求。"];
  const errors: string[] = [];
  const atomics: RequirementNode[] = [];
  const visit = (node: RequirementNode): void => {
    if (node.type === "ATOMIC") atomics.push(node);
    for (const child of node.children) visit(child);
  };
  visit(tree);
  if (!atomics.length) {
    errors.push("需求草案至少需要一个 ATOMIC 需求。");
  }
  for (const atomic of atomics) {
    if (!atomic.scenarios.length) {
      errors.push(`${atomic.id} 缺少场景：每个 ATOMIC 至少需要一个可验收的场景；不可验收的期望写入 guidance。`);
      continue;
    }
    for (const scenario of atomic.scenarios) {
      const label = `${atomic.id} 的场景「${scenario.name}」`;
      const phases = ["GIVEN", "WHEN", "THEN"] as const;
      for (const keyword of phases) {
        if (!scenario.steps.some((step) => step.keyword === keyword)) {
          errors.push(`${label}${keyword === "THEN" ? "缺少可观察结果" : "缺少初始状态或操作"}（${keyword} 步骤）。`);
        }
      }
      let phase = -1;
      for (const step of scenario.steps) {
        if (step.keyword === "AND" || step.keyword === "BUT") {
          if (phase < 0) errors.push(`${label}的 AND/BUT 必须跟随 GIVEN、WHEN 或 THEN。`);
          continue;
        }
        const nextPhase = phases.indexOf(step.keyword);
        if (nextPhase < phase) {
          errors.push(`${label}的步骤须按 GIVEN → WHEN → THEN 顺序排列。`);
          break;
        }
        phase = nextPhase;
      }
    }
  }
  return errors;
}

/** 按 ShallowCode 需求 YAML 的字段顺序序列化；省略空数组。 */
export function serializeRequirementsYaml(tree: RequirementNode): string {
  return stringify(toPlainNode(tree), { lineWidth: 0 });
}

export function diffRequirements(
  before: RequirementNode | null,
  after: RequirementNode | null,
): { added: RequirementRef[]; removed: RequirementRef[]; changed: RequirementRef[] } {
  const beforeIndex = flattenNodes(before);
  const afterIndex = flattenNodes(after);
  const added: RequirementRef[] = [];
  const removed: RequirementRef[] = [];
  const changed: RequirementRef[] = [];
  for (const [id, node] of afterIndex) {
    if (!beforeIndex.has(id)) added.push({ id, name: node.name });
  }
  for (const [id, node] of beforeIndex) {
    if (!afterIndex.has(id)) removed.push({ id, name: node.name });
  }
  for (const [id, node] of afterIndex) {
    const previous = beforeIndex.get(id);
    if (previous && ownSignature(previous) !== ownSignature(node)) {
      changed.push({ id, name: node.name });
    }
  }
  return { added, removed, changed };
}

export function summarizeTree(tree: RequirementNode): { atomics: number; scenarios: number } {
  let atomics = 0;
  let scenarios = 0;
  const visit = (node: RequirementNode): void => {
    if (node.type === "ATOMIC") {
      atomics += 1;
      scenarios += node.scenarios.length;
    }
    for (const child of node.children) visit(child);
  };
  visit(tree);
  return { atomics, scenarios };
}

function normalizeNode(
  value: Record<string, unknown>,
  path: string,
  isRoot: boolean,
  errors: string[],
): RequirementNode {
  const id = requiredText(value.id, `${path}.id`, errors);
  if (id && /\s/.test(id)) errors.push(`${path}.id 不能包含空白字符。`);
  const name = requiredText(value.name, `${path}.name`, errors);
  const description = requiredText(value.description, `${path}.description`, errors);
  // 非验收期望：自由文本数组，与依赖/参考图共用非空字符串校验。
  const guidance = normalizeTextList(value.guidance, `${path}.guidance`, errors);
  const type = normalizeType(value.type, `${path}.type`, errors);
  const dependencies = normalizeTextList(value.dependencies, `${path}.dependencies`, errors);

  const children: RequirementNode[] = [];
  if (value.children !== undefined && !Array.isArray(value.children)) {
    errors.push(`${path}.children 必须是数组。`);
  } else {
    const raw = (value.children ?? []) as unknown[];
    if (type === "ATOMIC" && raw.length) {
      errors.push(`${path}：ATOMIC 不能包含子节点。`);
    } else if (type !== "ATOMIC") {
      raw.forEach((child, index) => {
        const childPath = isRoot ? `children[${index}]` : `${path}.children[${index}]`;
        if (!isRecord(child)) {
          errors.push(`${childPath} 必须是对象。`);
          return;
        }
        children.push(normalizeNode(child, childPath, false, errors));
      });
    }
  }

  const scenarios: RequirementScenario[] = [];
  if (value.scenarios !== undefined && !Array.isArray(value.scenarios)) {
    errors.push(`${path}.scenarios 必须是数组。`);
  } else {
    const raw = (value.scenarios ?? []) as unknown[];
    if (type !== "ATOMIC" && raw.length) {
      errors.push(`${path} 只有 ATOMIC 可以包含场景。`);
    } else if (type === "ATOMIC") {
      raw.forEach((scenario, index) => {
        const scenarioPath = `${path}.scenarios[${index}]`;
        if (!isRecord(scenario)) {
          errors.push(`${scenarioPath} 必须是对象。`);
          return;
        }
        scenarios.push(normalizeScenario(scenario, scenarioPath, id, index, errors));
      });
      const seen = new Set<string>();
      for (const scenario of scenarios) {
        if (seen.has(scenario.id)) errors.push(`重复场景 id：${scenario.id}（同一 ATOMIC 内必须唯一）。`);
        seen.add(scenario.id);
      }
    }
  }

  const node: RequirementNode = { id, name, type, description, dependencies, children, scenarios };
  if (guidance.length) node.guidance = guidance;
  const references = normalizeTextList(value.visual_reference, `${path}.visual_reference`, errors);
  if (references.length) node.visual_reference = references;
  if (isRoot) {
    const data = normalizeSeedData(value.data, `${path}.data`, errors);
    if (data) node.data = data;
  }
  return node;
}

function normalizeScenario(
  value: Record<string, unknown>,
  path: string,
  nodeId: string,
  index: number,
  errors: string[],
): RequirementScenario {
  let id = `${nodeId}::${index}`;
  if (value.id !== undefined) {
    id = requiredText(value.id, `${path}.id`, errors) || id;
    if (/\s/.test(id)) errors.push(`${path}.id 不能包含空白字符。`);
  }
  const name = requiredText(value.name, `${path}.name`, errors);
  const steps: RequirementStep[] = [];
  if (value.steps !== undefined && !Array.isArray(value.steps)) {
    errors.push(`${path}.steps 必须是数组。`);
  } else {
    ((value.steps ?? []) as unknown[]).forEach((step, stepIndex) => {
      const stepPath = `${path}.steps[${stepIndex}]`;
      if (!isRecord(step)) {
        errors.push(`${stepPath} 必须是对象。`);
        return;
      }
      const rawKeyword = typeof step.keyword === "string" ? step.keyword.trim().toUpperCase() : "";
      const keyword = rawKeyword as StepKeyword;
      if (!KEYWORDS.has(keyword)) {
        errors.push(`${stepPath}.keyword 不是有效关键字，必须是 GIVEN、WHEN、THEN、AND 或 BUT 之一。`);
        return;
      }
      steps.push({ keyword, content: requiredText(step.content, `${stepPath}.content`, errors) });
    });
  }
  return { id, name, steps };
}

function normalizeSeedData(
  value: unknown,
  path: string,
  errors: string[],
): SeedDataCategory[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push(`${path} 必须是数组。`);
    return undefined;
  }
  const categories: SeedDataCategory[] = [];
  value.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${entryPath} 必须是对象。`);
      return;
    }
    const category = requiredText(entry.category, `${entryPath}.category`, errors);
    const items: string[] = [];
    if (entry.items !== undefined && !Array.isArray(entry.items)) {
      errors.push(`${entryPath}.items 必须是字符串数组。`);
    } else {
      ((entry.items ?? []) as unknown[]).forEach((item, itemIndex) => {
        if (typeof item !== "string" || !item.trim()) {
          errors.push(`${entryPath}.items[${itemIndex}] 必须是非空字符串。`);
          return;
        }
        items.push(item.trim());
      });
    }
    if (category) categories.push({ category, items });
  });
  return categories.length ? categories : undefined;
}

function normalizeType(value: unknown, path: string, errors: string[]): RequirementType {
  if (typeof value === "string" && TYPES.has(value as RequirementType)) {
    return value as RequirementType;
  }
  errors.push(`${path} 必须是 ROOT、FOLDER 或 ATOMIC 之一。`);
  return "ATOMIC";
}

/** 非空字符串数组：修剪空白、拒绝空项并去重；用于依赖、参考路径与实现指引。 */
function normalizeTextList(value: unknown, path: string, errors: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`${path} 必须是字符串数组。`);
    return [];
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      errors.push(`${path} 必须是非空字符串数组。`);
      continue;
    }
    result.push(item.trim());
  }
  return [...new Set(result)];
}

function requiredText(value: unknown, path: string, errors: string[]): string {
  if (value === undefined) {
    errors.push(`${path} 不能为空。`);
    return "";
  }
  if (typeof value !== "string") {
    errors.push(`${path} 必须是字符串。`);
    return "";
  }
  const text = value.trim();
  if (!text) {
    errors.push(`${path} 不能为空。`);
    return "";
  }
  return text;
}

function collectNodes(
  node: RequirementNode,
  index: Map<string, RequirementNode>,
  errors: string[],
): void {
  if (index.has(node.id)) {
    errors.push(`重复 id：${node.id}（每个节点 id 必须唯一）。`);
  } else {
    index.set(node.id, node);
  }
  for (const child of node.children) collectNodes(child, index, errors);
}

function validateDependencies(
  index: Map<string, RequirementNode>,
  errors: string[],
): void {
  for (const [id, node] of index) {
    for (const dependency of node.dependencies) {
      if (dependency !== id && !index.has(dependency)) {
        errors.push(`节点 ${id} 的依赖 ${dependency} 不存在。`);
      }
    }
  }
  validateDependencyCycles(index, errors);
}

/** 与消费者一致：文件夹依赖展开为后代 ATOMIC，祖先依赖沿层级继承。 */
function validateAtomicDependencies(
  tree: RequirementNode,
  index: Map<string, RequirementNode>,
  errors: string[],
): void {
  const graph = new Map<string, { dependencies: string[] }>();
  const atomicIds = (node: RequirementNode): string[] => node.type === "ATOMIC"
    ? [node.id]
    : node.children.flatMap(atomicIds);
  const visit = (node: RequirementNode, ancestors: RequirementNode[]): void => {
    if (node.type === "ATOMIC") {
      const vacuous = new Set([tree.id, node.id, ...ancestors.map((ancestor) => ancestor.id)]);
      const dependencies = [...ancestors, node]
        .flatMap((scope) => scope.dependencies)
        .filter((id) => !vacuous.has(id))
        .flatMap((id) => atomicIds(index.get(id)!))
        .filter((id) => !vacuous.has(id));
      graph.set(node.id, { dependencies: [...new Set(dependencies)] });
      return;
    }
    const nextAncestors = node === tree ? ancestors : [...ancestors, node];
    for (const child of node.children) visit(child, nextAncestors);
  };
  visit(tree, []);
  validateDependencyCycles(graph, errors);
}

function validateDependencyCycles(
  index: Map<string, { dependencies: string[] }>,
  errors: string[],
): void {
  const colors = new Map<string, "visiting" | "visited">();
  const visit = (id: string, stack: string[]): void => {
    const color = colors.get(id);
    if (color === "visiting") {
      errors.push(`依赖环：${[...stack, id].join(" -> ")}。`);
      return;
    }
    if (color === "visited") return;
    colors.set(id, "visiting");
    const node = index.get(id);
    if (node) {
      for (const dependency of node.dependencies) {
        if (dependency !== id && index.has(dependency)) visit(dependency, [...stack, id]);
      }
    }
    colors.set(id, "visited");
  };
  for (const id of index.keys()) visit(id, []);
}

function flattenNodes(tree: RequirementNode | null): Map<string, RequirementNode> {
  const index = new Map<string, RequirementNode>();
  const visit = (node: RequirementNode): void => {
    if (!index.has(node.id)) index.set(node.id, node);
    for (const child of node.children) visit(child);
  };
  if (tree) visit(tree);
  return index;
}

function ownSignature(node: RequirementNode): string {
  return JSON.stringify({
    name: node.name,
    type: node.type,
    description: node.description,
    guidance: node.guidance ?? [],
    dependencies: node.dependencies,
    scenarios: node.scenarios,
    visual_reference: node.visual_reference ?? [],
    data: node.data ?? null,
  });
}

function toPlainNode(node: RequirementNode): Record<string, unknown> {
  const plain: Record<string, unknown> = {
    id: node.id,
    name: node.name,
    type: node.type,
    dependencies: node.dependencies,
    description: node.description,
  };
  if (node.guidance?.length) plain.guidance = node.guidance;
  if (node.children.length) plain.children = node.children.map(toPlainNode);
  if (node.visual_reference?.length) plain.visual_reference = node.visual_reference;
  if (node.scenarios.length) {
    plain.scenarios = node.scenarios.map((scenario) => ({
      id: scenario.id,
      name: scenario.name,
      steps: scenario.steps.map((step) => ({ keyword: step.keyword, content: step.content })),
    }));
  }
  if (node.data?.length) {
    plain.data = node.data.map((category) => ({ category: category.category, items: category.items }));
  }
  return plain;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
