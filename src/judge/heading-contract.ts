import type { AtomicRequirement } from "../types.js";
import type { ProbeCase, ProbeStep, ProbeLocator } from "./probe-schema.js";

/** Enforce explicit owner/name result-heading templates. */
export function validateHeadingContract(probeCase: ProbeCase, requirements: readonly AtomicRequirement[]): void {
  if (probeCase.purpose !== "happy_path" && probeCase.purpose !== "persistence") return;
  const source = requirements.flatMap(item => [item.text, ...item.ancestors.map(ancestor => ancestor.description)]).join("\n");
  const templates = [...source.matchAll(/(?:heading|title|titled)[^\n.!?]{0,60}[“"`]([\w -]+) name\s*\/\s*([\w -]+) name[”"`]/gi)];
  if (!templates.length) return;
  const assertions = probeCase.steps.slice(probeCase.setupStepCount ?? 0).filter(isHeadingAssertion);
  for (const template of templates) {
    const ownerKind = template[1].trim();
    const objectKind = template[2].trim();
    const scenarioIds = new Set(probeCase.outcomeChecks?.map(item => item.scenarioId));
    const context = requirements.flatMap(item => [item.text, ...item.seedDeclarations,
      ...(scenarioIds.size ? (item.scenarioContracts ?? []).filter(item => scenarioIds.has(item.id)).flatMap(item => item.steps.map(step => step.content)) : item.scenarios)]).join("\n");
    const declared = (kind: string) => [...context.matchAll(new RegExp(`\\b${kind.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+([\x60\"])([^\x60\"]+)\\1`, "gi"))].map(match => match[2]);
    const enteredNames = (kind: string) => probeCase.steps.flatMap(step => {
      if (step.op !== "fill") return [];
      const label = step.locator.by === "role" ? step.locator.name : step.locator.text;
      return label && label.toLowerCase().includes(kind.toLowerCase()) && /name|title/i.test(label) ? [step.value] : [];
    });
    const owners = [...new Set([...declared(ownerKind), ...enteredNames(ownerKind)])];
    const objects = [...new Set([...declared(objectKind), ...enteredNames(objectKind)])];
    const complete = assertions.some(step => headingValues(step).every(value => value.includes("/") &&
      (owners.length !== 1 || value.startsWith(`${owners[0]}/`)) &&
      (objects.length !== 1 || value.endsWith(`/${objects[0]}`))) && strongHeadingAssertion(step));
    if (!complete) throw new Error(`Case ${probeCase.id} must assert the complete ${ownerKind} name/${objectKind} name heading with exact matching`);
  }
}

type HeadingAssertion = Extract<ProbeStep, { op: "expectText" | "expectVisible" }>;
function locatorCandidates(locator: ProbeLocator): ProbeLocator[] {
  return [locator, ...(locator.fallbacks ?? [])];
}
function isHeadingAssertion(step: ProbeStep): step is HeadingAssertion {
  return (step.op === "expectText" || step.op === "expectVisible") && step.locator.by === "role" && step.locator.role === "heading";
}
function headingValues(step: HeadingAssertion): string[] {
  return step.op === "expectText" ? step.anyOf ?? [step.text]
    : locatorCandidates(step.locator).map(item => item.by === "role" ? item.name ?? "" : item.text);
}
function strongHeadingAssertion(step: HeadingAssertion): boolean {
  if (step.op === "expectText") return step.exact !== false && locatorCandidates(step.locator).every(item => item.by === "role" && item.role === "heading");
  return locatorCandidates(step.locator).every(item => item.by === "role" && item.role === "heading" && item.exact === true);
}
