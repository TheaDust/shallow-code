import { parse, stringify } from "yaml";

interface ArcNode {
  id: string;
  name: string;
  description: { text: string; image?: Array<{ id: string; reference: string; page?: string }> };
  scenarios: Array<{ id: string; name: string; steps: Array<Record<string, unknown>> }>;
  children: ArcNode[];
}

/** Syntax conversion only. Source wording and reference relationships remain development inputs. */
export function normalizeArcRequirements(source: string): { yaml: string; requirements: number; scenarios: number } {
  const root = parse(source);
  let requirements = 0, scenarios = 0;
  if (root.type) {
    const count = (node: { type: string; scenarios?: unknown[]; children?: typeof root[] }) => {
      if (node.type === "ATOMIC") requirements++;
      scenarios += node.scenarios?.length ?? 0;
      for (const child of node.children ?? []) count(child);
    };
    count(root);
    return { yaml: source, requirements, scenarios };
  }
  const seen = new Set<string>();
  const convert = (node: ArcNode, isRoot = false): object => {
    if (!node.id || seen.has(node.id)) throw new Error(`Missing or duplicate ARC requirement ID: ${node.id}`);
    seen.add(node.id);
    for (const key of Object.keys(node)) if (!["id", "name", "description", "scenarios", "children"].includes(key)) {
      throw new Error(`Unsupported ARC requirement field ${node.id}.${key}`);
    }
    if (typeof node.description?.text !== "string") throw new Error(`ARC description.text is required: ${node.id}`);
    const children = node.children ?? [];
    if (children.length && node.scenarios?.length) throw new Error(`ARC folder has its own scenarios: ${node.id}`);
    if (!isRoot && !children.length) requirements++;
    const referenceNotes: string[] = [];
    const convertedScenarios = (node.scenarios ?? []).map(scenario => {
      scenarios++;
      const steps = scenario.steps.flatMap(step => {
        if (step.references) referenceNotes.push(`${scenario.id}/${step.id}: ${JSON.stringify(step.references)}`);
        return Object.entries(step).flatMap(([key, value]) => {
          if (["id", "references"].includes(key)) return [];
          if (!["Given", "When", "Then", "And", "But"].includes(key) || typeof value !== "string") {
            throw new Error(`Unsupported ARC step field ${scenario.id}.${key}`);
          }
          return [{ keyword: key.toUpperCase(), content: value }];
        });
      });
      return { id: scenario.id, name: scenario.name, steps };
    });
    const images = node.description.image ?? [];
    const description = [node.description.text,
      ...images.map(image => `![${image.id}${image.page ? `; page=${image.page}` : ""}](${image.reference})`),
      ...(referenceNotes.length ? ["Source step references:", ...referenceNotes] : [])].join("\n\n");
    return { id: node.id, name: node.name, type: isRoot ? "ROOT" : children.length ? "FOLDER" : "ATOMIC",
      description, dependencies: [], visual_reference: images.map(image => image.reference),
      scenarios: convertedScenarios, children: children.map(child => convert(child)) };
  };
  const converted = convert(root, true);
  return { yaml: stringify(converted, { lineWidth: 0 }), requirements, scenarios };
}
