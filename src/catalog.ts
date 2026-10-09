import { readFile } from "node:fs/promises";

import { parse } from "yaml";
import { maskRequirementLiterals, requirementSentences } from "./requirement-text.js";

import type {
  AtomicRequirement,
  ProductContext,
  ProductKind,
  RequirementCatalog,
  RequirementNode,
  SeedDataCategory,
} from "./types.js";

type NodeType = "ROOT" | "FOLDER" | "ATOMIC";

interface ParsedNode extends RequirementNode {
  id: string;
  name: string;
  type: NodeType;
  description: string;
  dependencies: string[];
  children: ParsedNode[];
  scenarios: ParsedScenario[];
}

interface ParsedScenario {
  id: string;
  name: string;
  steps: Array<{ keyword: string; content: string }>;
}

export async function loadRequirementCatalog(
  requirementsFile: string,
  options: { inheritedApplication?: boolean } = {},
): Promise<RequirementCatalog & { tree: RequirementNode }> {
  const source = await readFile(requirementsFile, "utf8");
  const record = requireRecord(parse(source), "root");
  const root = parseNode(record, "root");
  const nodes = new Map<string, ParsedNode>();
  collectNodes(root, nodes);
  const evolutionProductName = stripEvolutionMarker(root.name);
  const productName = evolutionProductName ?? root.name;
  const stage = parseProgressiveStage(productName);
  // An injected application establishes an incremental starting point even
  // when the new requirement tree retains the original product title.
  const evolution = evolutionProductName !== undefined
    || (options.inheritedApplication === true && stage === undefined);
  validateDependencies(nodes, evolution || (stage?.index ?? 0) > 1);

  const requirements: AtomicRequirement[] = [];
  const product: ProductContext = {
    kind: classifyProduct(productName),
    rootId: root.id,
    rootName: root.name,
    description: root.description,
    seedData: parseSeedData(record.data),
    ...(evolution ? { evolution: true as const } : {}),
    ...(stage ? { stage } : {}),
  };
  collectAtomics(root, [], [], product, requirements);
  // Folder dependencies are completion barriers over their atomic descendants.
  // Ancestor dependencies also apply to every atomic requirement underneath
  // them, except when the dependency targets the requirement itself or one of
  // its own ancestor folders (official task data contains both forms): an
  // ancestor's completion already implies the requirement's own completion, so
  // waiting on it is vacuous and expanding it would fabricate sibling cycles.
  for (const requirement of requirements) {
    const vacuous = new Set([...requirement.folderPath, root.id, requirement.id]);
    const scopedDependencies = [...requirement.folderPath, requirement.id]
      .flatMap((scopeId) => nodes.get(scopeId)!.dependencies)
      .filter((dependency) => !vacuous.has(dependency));
    requirement.dependencyIds = [...new Set(scopedDependencies.flatMap((dependency) => {
      const target = nodes.get(dependency);
      return target ? atomicIds(target) : [];
    }))].filter((dependency) => !vacuous.has(dependency));
    const externalDependencyIds = [...new Set(scopedDependencies.filter((dependency) => !nodes.has(dependency)))];
    if (externalDependencyIds.length > 0) requirement.externalDependencyIds = externalDependencyIds;
  }
  validateDependencies(new Map(requirements.map((requirement) => [
    requirement.id,
    { id: requirement.id, dependencies: requirement.dependencyIds },
  ])));

  return {
    tree: root,
    requirements,
    statusById: Object.fromEntries(
      requirements.map((requirement) => [requirement.id, "todo"]),
    ),
  };
}

function classifyProduct(
  rootName: string,
): ProductKind {
  const productName = stripProgressiveStageSuffix(rootName);
  if (productName === "GitHub" || productName === "GitHub Collaboration Platform Core Requirements") {
    return "repository_collaboration";
  }
  if (productName === "Core Requirements for an Online Spreadsheet Data Workspace"
    || productName === "Requirements for an Online Spreadsheet Data Workspace") {
    return "spreadsheet";
  }
  return "generic_web";
}

function parseProgressiveStage(rootName: string): ProductContext["stage"] | undefined {
  const match = progressiveStageMatch(rootName);
  if (!match) return undefined;
  const index = Number(match[1]);
  if (!Number.isSafeInteger(index) || index < 1) {
    throw new Error(`Invalid progressive stage name: ${rootName}`);
  }
  return {
    index,
    currentStageTestsOnly: true,
  };
}

function stripProgressiveStageSuffix(rootName: string): string {
  const match = progressiveStageMatch(rootName);
  return match ? rootName.slice(0, match.index).trim() : rootName.trim();
}

function stripEvolutionMarker(rootName: string): string | undefined {
  const productName = rootName
    .replace(/\(\s*evolution(?:\s+\d+)?\s*\)|\[\s*evolution(?:\s+\d+)?\s*\]|(?:^|[-–—:：])\s*evolution(?:\s+\d+)?(?=\s*(?:$|[-–—:：]))/gi, "")
    .replace(/^evolution\s+(?=requirements\s+for\b)/i, "");
  if (productName === rootName) return undefined;
  return productName
    .replace(/^[\s\-–—:：()\[\]]+|[\s\-–—:：()\[\]]+$/g, "")
    .replace(/\s+/g, " ");
}

function progressiveStageMatch(rootName: string): RegExpExecArray | null {
  const name = rootName.trim();
  return /(?:^|[\s\-–—:：]+)(?:stage|phase)\s*(\d+)\s*$/i.exec(name)
    ?? /(?:^|[\s\-–—:：]+)第?\s*(\d+)\s*阶段\s*$/u.exec(name);
}

function parseSeedData(value: unknown): SeedDataCategory[] {
  if (value === undefined) return [];
  return requireArray(value, "root.data").map((entry, index) => {
    const record = requireRecord(entry, `root.data[${index}]`);
    return {
      category: requireString(record.category, `root.data[${index}].category`),
      items: requireStringArray(record.items ?? [], `root.data[${index}].items`),
    };
  });
}

function parseNode(value: unknown, location: string): ParsedNode {
  const record = requireRecord(value, location);
  const id = requireString(record.id, `${location}.id`);
  const name = requireString(record.name, `${location}.name`);
  const type = requireNodeType(record.type, `${location}.type`);
  const description = requireString(record.description ?? "", `${location}.description`);
  const dependencies = requireStringArray(
    record.dependencies ?? [],
    `${location}.dependencies`,
  ).filter((dependency) => dependency !== id);
  const children = requireArray(record.children ?? [], `${location}.children`).map(
    (child, index) => parseNode(child, `${location}.children[${index}]`),
  );
  const scenarios = requireArray(record.scenarios ?? [], `${location}.scenarios`).map(
    (scenario, index) => parseScenario(scenario, `${location}.scenarios[${index}]`, `${id}::${index}`),
  );

  const visual_reference = requireStringArray(record.visual_reference ?? [], `${location}.visual_reference`);
  return { id, name, type, description, dependencies, children, scenarios, visual_reference };
}

function parseScenario(value: unknown, location: string, defaultId: string): ParsedScenario {
  const record = requireRecord(value, location);
  const name = requireString(record.name, `${location}.name`);
  const steps = requireArray(record.steps ?? [], `${location}.steps`).map(
    (step, index) => {
      const stepRecord = requireRecord(step, `${location}.steps[${index}]`);
      return {
        keyword: requireString(
          stepRecord.keyword,
          `${location}.steps[${index}].keyword`,
        ),
        content: requireString(
          stepRecord.content,
          `${location}.steps[${index}].content`,
        ),
      };
    },
  );
  return { id: requireString(record.id ?? record.scenario_id ?? defaultId, `${location}.id`), name, steps };
}

function collectNodes(node: ParsedNode, nodes: Map<string, ParsedNode>): void {
  if (nodes.has(node.id)) {
    throw new Error(`Duplicate requirement id: ${node.id}`);
  }
  nodes.set(node.id, node);
  for (const child of node.children) {
    collectNodes(child, nodes);
  }
}

function atomicIds(node: ParsedNode): string[] {
  return node.type === "ATOMIC" ? [node.id] : node.children.flatMap(atomicIds);
}

function validateDependencies(
  nodes: Map<string, Pick<ParsedNode, "id" | "dependencies">>,
  allowExternal = false,
): void {
  for (const node of nodes.values()) {
    for (const dependency of node.dependencies) {
      if (!nodes.has(dependency) && !allowExternal) {
        throw new Error(`Unknown dependency ${dependency} referenced by ${node.id}`);
      }
    }
  }

  const colors = new Map<string, "visiting" | "visited">();
  const visit = (id: string, path: string[]): void => {
    const color = colors.get(id);
    if (color === "visiting") {
      throw new Error(`Dependency cycle: ${[...path, id].join(" -> ")}`);
    }
    if (color === "visited") return;

    colors.set(id, "visiting");
    const node = nodes.get(id);
    if (!node) throw new Error(`Unknown requirement: ${id}`);
    for (const dependency of node.dependencies) {
      if (nodes.has(dependency)) visit(dependency, [...path, id]);
    }
    colors.set(id, "visited");
  };

  for (const id of nodes.keys()) visit(id, []);
}

function collectAtomics(
  node: ParsedNode,
  folderPath: string[],
  ancestors: ParsedNode[],
  product: ProductContext,
  requirements: AtomicRequirement[],
): void {
  if (node.type === "ATOMIC") {
    const scenarios = node.scenarios.map(formatScenario);
    const descriptions = [...ancestors.map(ancestor => ancestor.description), node.description];
    const evidenceText = [...descriptions, ...scenarios].join("\n");
    requirements.push({
      id: node.id,
      folderPath,
      declarationIndex: requirements.length,
      name: node.name,
      text: node.description,
      dependencyIds: [...node.dependencies],
      scenarios,
      scenarioContracts: node.scenarios,
      references: [...new Set([node, ...ancestors].flatMap(item => [...extractReferences(item.description), ...(item.visual_reference ?? [])]))],
      exactUiStrings: extractUiStrings(evidenceText),
      seedDeclarations: extractSeedDeclarations(evidenceText, node.scenarios),
      product,
      ancestors: ancestors.map((ancestor) => ({
        id: ancestor.id,
        name: ancestor.name,
        description: ancestor.description,
      })),
    });
    return;
  }

  const nextPath = [...folderPath, node.id];
  const nextAncestors = folderPath.length === 0
    ? ancestors
    : [...ancestors, node];
  for (const child of node.children) {
    collectAtomics(child, nextPath, nextAncestors, product, requirements);
  }
}

function formatScenario(scenario: ParsedScenario): string {
  return [
    scenario.name,
    ...scenario.steps.map((step) => `${step.keyword}: ${step.content}`),
  ].join("\n");
}

function extractReferences(text: string): string[] {
  return [...text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]);
}

function extractUiStrings(text: string): string[] {
  const values: Array<{ index: number; value: string }> = [];
  for (const pattern of [/“([^”]+)”/g, /"([^"\n]+)"/g, /`([^`]+)`/g]) {
    for (const match of text.matchAll(pattern)) {
      values.push({ index: match.index, value: match[1] });
    }
  }
  return values.sort((left, right) => left.index - right.index).map(({ value }) => value);
}

function extractSeedDeclarations(text: string, scenarios: ParsedScenario[]): string[] {
  // Modern declarations and GIVEN facts are source excerpts, not inferred records or creation targets.
  const declarations: string[] = [];
  for (const match of text.matchAll(/(Seed (?:data|values):|(?:The )?evaluation seed contains)\s*(.+?)(?=\s+Seed (?:data|values):|\s+(?:The )?evaluation seed contains|[\n]|$)/gim)) {
    const clause = (match[1].toLowerCase().includes("evaluation seed contains")
      ? match[2].split(/\.(?=\s|$)/, 1)[0]
      : match[2])
      .replace(/\s+(?:Reference image:|!\[)[\s\S]*$/i, "")
      .trim()
      .replace(/\.$/, "");
    const declaration = `${match[1]} ${clause}`;
    if (clause && !declarations.includes(declaration)) declarations.push(declaration);
  }
  const provisioned = /\b(?:pre-provisions?|pre-provisioned|seed(?:ed)? (?:data|records|history) (?:provides?|includes?|contains?|consists))\b/i;
  for (const sentence of requirementSentences(text)) {
    if (provisioned.test(maskRequirementLiterals(sentence))) {
      declarations.push(sentence.replace(/^(?:GIVEN|WHEN|THEN|AND|BUT):\s*/i, ""));
    }
  }
  for (const scenario of scenarios) {
    let inGiven = false;
    for (const step of scenario.steps) {
      const keyword = step.keyword.toUpperCase();
      if (keyword !== "AND" && keyword !== "BUT") inGiven = keyword === "GIVEN";
      if (!inGiven) continue;
      for (const sentence of requirementSentences(step.content)) {
        const prose = maskRequirementLiterals(sentence);
        if (prose === sentence) continue;
        if (/\b(?:Seed (?:data|values):|evaluation seed contains)\b/i.test(prose)) continue;
        if (/\b(?:pre-provisions?|pre-provisioned|seeded|existing|already|has|have|contains|exists|authored)\b/i.test(prose) ||
          /\b(?:is|are)\s+(?!not\b|unused\b|unregistered\b)/i.test(prose)) declarations.push(sentence);
      }
    }
  }
  return [...new Set(declarations)];
}

function requireRecord(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${location} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, location: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${location} must be an array`);
  return value;
}

function requireString(value: unknown, location: string): string {
  if (typeof value !== "string") throw new Error(`${location} must be a string`);
  return value;
}

function requireStringArray(value: unknown, location: string): string[] {
  return requireArray(value, location).map((item, index) =>
    requireString(item, `${location}[${index}]`),
  );
}

function requireNodeType(value: unknown, location: string): NodeType {
  if (value === "ROOT" || value === "FOLDER" || value === "ATOMIC") return value;
  throw new Error(`${location} must be ROOT, FOLDER, or ATOMIC`);
}
