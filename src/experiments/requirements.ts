import { parse, stringify } from "yaml";

export interface ArcSourceMap {
  images: Array<{ requirementId: string; id: string; reference: string; page?: string }>;
  steps: Array<{ requirementId: string; scenarioId: string; stepId: string; sourceStepIndex: number;
    normalizedStepIndices: number[]; references: string[] }>;
}

/** Syntax conversion only. Source wording and reference relationships remain development inputs. */
export function normalizeArcRequirements(source: string): {
  yaml: string; requirements: number; scenarios: number; sourceMap: ArcSourceMap | null;
} {
  const root = parse(source);
  let requirements = 0, scenarios = 0;
  if (root?.type) {
    const count = (node: { type: string; scenarios?: unknown[]; children?: typeof root[] }) => {
      if (node.type === "ATOMIC") requirements++;
      scenarios += node.scenarios?.length ?? 0;
      for (const child of node.children ?? []) count(child);
    };
    count(root);
    return { yaml: source, requirements, scenarios, sourceMap: null };
  }
  const sourceMap: ArcSourceMap = { images: [], steps: [] };
  const seen = new Set<string>();
  const convert = (value: unknown, isRoot = false): object => {
    const node = record(value, "requirement", ["id", "name", "description", "scenarios", "children"]);
    const id = text(node.id, "requirement.id");
    const name = text(node.name, `${id}.name`);
    if (!id || seen.has(id)) throw new Error(`Missing or duplicate ARC requirement ID: ${id}`);
    seen.add(id);
    const description = record(node.description, `${id}.description`, ["text", "image"]);
    const descriptionText = text(description.text, `${id}.description.text`);
    const children = list(node.children ?? [], `${id}.children`);
    const sourceScenarios = list(node.scenarios ?? [], `${id}.scenarios`);
    if ((isRoot || children.length) && sourceScenarios.length) throw new Error(`ARC folder has its own scenarios: ${id}`);
    if (!isRoot && !children.length) requirements++;
    const referenceNotes: string[] = [];
    const scenarioIds = new Set<string>();
    const convertedScenarios = sourceScenarios.map(value => {
      const scenario = record(value, `${id}.scenario`, ["id", "name", "steps"]);
      const scenarioId = text(scenario.id, `${id}.scenario.id`);
      const scenarioName = text(scenario.name, `${scenarioId}.name`);
      if (!scenarioId || scenarioIds.has(scenarioId)) throw new Error(`Missing or duplicate ARC scenario ID: ${id}/${scenarioId}`);
      scenarioIds.add(scenarioId);
      scenarios++;
      const stepIds = new Set<string>();
      let nextIndex = 0;
      const steps = list(scenario.steps, `${scenarioId}.steps`).flatMap((value, sourceStepIndex) => {
        const step = record(value, `${scenarioId}.step`, ["id", "references", "Given", "When", "Then", "And", "But"]);
        const stepId = text(step.id, `${scenarioId}.step.id`);
        if (!stepId || stepIds.has(stepId)) throw new Error(`Missing or duplicate ARC step ID: ${scenarioId}/${stepId}`);
        stepIds.add(stepId);
        const references = list(step.references ?? [], `${stepId}.references`).map(value => text(value, `${stepId}.references`));
        if (references.length) referenceNotes.push(`${scenarioId}/${stepId}: ${JSON.stringify(references)}`);
        const converted = Object.entries(step).flatMap(([key, value]) => {
          if (["id", "references"].includes(key)) return [];
          return [{ keyword: key.toUpperCase(), content: text(value, `${stepId}.${key}`) }];
        });
        if (!converted.length) throw new Error(`ARC step has no behavioral clauses: ${stepId}`);
        sourceMap.steps.push({ requirementId: id, scenarioId, stepId, sourceStepIndex,
          normalizedStepIndices: converted.map(() => nextIndex++), references });
        return converted;
      });
      return { id: scenarioId, name: scenarioName, steps };
    });
    const images = list(description.image ?? [], `${id}.description.image`).map(value => {
      const image = record(value, `${id}.image`, ["id", "reference", "page"]);
      const converted = { id: text(image.id, `${id}.image.id`), reference: text(image.reference, `${id}.image.reference`),
        ...(image.page === undefined ? {} : { page: text(image.page, `${id}.image.page`) }) };
      sourceMap.images.push({ requirementId: id, ...converted });
      return converted;
    });
    const convertedDescription = [descriptionText,
      ...images.map(image => `![${image.id}${image.page ? `; page=${image.page}` : ""}](${image.reference})`),
      ...(referenceNotes.length ? ["Source step references:", ...referenceNotes] : [])].join("\n\n");
    return { id, name, type: isRoot ? "ROOT" : children.length ? "FOLDER" : "ATOMIC",
      description: convertedDescription, dependencies: [], visual_reference: images.map(image => image.reference),
      scenarios: convertedScenarios, children: children.map(child => convert(child)) };
  };
  const converted = convert(root, true);
  return { yaml: stringify(converted, { lineWidth: 0 }), requirements, scenarios, sourceMap };
}

function record(value: unknown, location: string, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`ARC ${location} must be an object`);
  for (const key of Object.keys(value)) if (!fields.includes(key)) throw new Error(`Unsupported ARC ${location} field ${key}`);
  return value as Record<string, unknown>;
}

function text(value: unknown, location: string): string {
  if (typeof value !== "string") throw new Error(`ARC ${location} must be a string`);
  return value;
}

function list(value: unknown, location: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`ARC ${location} must be an array`);
  return value;
}
