import type { AtomicRequirement, ShadowReport, WorkPacket } from "../types.js";
import { parseProbePlan, PROBE_LIMITS, type ProbePlan, type ProbeStep } from "./probe-schema.js";

/** Recover requirement-backed seed navigation using the visible search and declared object identity. */
export function rootSearchNavigationPlan(packet: WorkPacket, plan: ProbePlan, report: ShadowReport): ProbePlan | undefined {
  if (report.verdict === "pass" || report.failures.length === 0) return undefined;
  const changes = new Map<string, { index: number; steps: ProbeStep[]; inserted: number; replaced: number }>();
  for (const failure of report.failures) {
    if (failure.category !== "locator" && failure.category !== "precondition") continue;
    const probeCase = plan.cases.find(item => item.id === failure.caseId);
    const start = probeCase?.steps[0];
    const entry = probeCase?.steps[failure.stepIndex];
    if (!probeCase || start?.op !== "goto" || start.path !== "/" ||
      !entry || (entry.op !== "click" && entry.op !== "expectVisible") ||
      entry.locator.by !== "role" || entry.locator.role !== "link" || !entry.locator.name) continue;
    const target = entry.locator.name;
    const evidence = [...packet.requirements.filter(requirement => probeCase.requirementIds.includes(requirement.id)),
      ...(packet.prerequisites ?? [])];
    const objects = evidence.flatMap(requirement => requirement.seedDeclarations.flatMap(declaredObjects))
      .filter(object => object.name === target);
    if (!objects.length) continue;
    const snapshot = failure.locatorSnapshot ?? "";
    const owners = new Set(objects.flatMap(object => object.owner ? [object.owner] : []));
    const scopes = owners.size === 1 ? visibleObjectScopes(snapshot, target, objects) : [];
    if (!entry.locator.scope && scopes.length === 1) {
      let begin = failure.stepIndex;
      while (begin > 0 && probeCase.steps[begin - 1].op === "expectVisible" &&
        isTargetLink(probeCase.steps[begin - 1], target)) begin--;
      let end = failure.stepIndex + 1;
      if (entry.op === "expectVisible") {
        while (isTargetLink(probeCase.steps[end], target)) {
          if (probeCase.steps[end++].op === "click") break;
        }
      }
      changes.set(probeCase.id, { index: begin, inserted: 0, replaced: end - begin,
        steps: probeCase.steps.slice(begin, end).map(step => {
          if (!isTargetLink(step, target) || step.locator.scope) return step;
          return { ...step, locator: { ...step.locator, scope: scopes[0],
            ...(step.locator.fallbacks ? { fallbacks: step.locator.fallbacks.map(locator =>
              locator.by === "role" && locator.role === "link" && locator.name === target && !locator.scope
                ? { ...locator, scope: scopes[0] } : locator) } : {}) } };
        }) });
      continue;
    }
    // A visible but ambiguous target needs identity evidence, not another search.
    if (snapshot.includes(`- link "${target}"`) || !allowsSearchEntry(evidence, objects) ||
      probeCase.steps.length > PROBE_LIMITS.totalSteps - 2 ||
      // Search repairs preparation; a tested entry/result keeps its original route.
      (probeCase.setupStepCount && failure.stepIndex >= probeCase.setupStepCount) ||
      probeCase.outcomeChecks?.some(check => check.assertionIndexes.includes(failure.stepIndex - (probeCase.setupStepCount ?? 0)))) continue;
    const searchboxes = [...snapshot.matchAll(/^\s*- searchbox "([^"\n]+)"/gm)];
    if (searchboxes.length !== 1) continue;
    if (probeCase.steps.slice(0, failure.stepIndex).some(step => step.op === "fill" && step.value === target &&
      step.locator.by === "role" && step.locator.role === "searchbox")) continue;
    const locator = { by: "role" as const, role: "searchbox", name: searchboxes[0][1], exact: true };
    changes.set(probeCase.id, { index: failure.stepIndex, inserted: 2, replaced: 1, steps: [
      { op: "fill", locator, value: target },
      { op: "press", locator, key: "Enter" },
      entry,
    ] });
  }
  if (changes.size === 0) return undefined;
  const alternative = { ...plan, navigationRecovered: true, cases: plan.cases.map(item => {
    const change = changes.get(item.id);
    return change ? { ...item,
      ...(item.setupStepCount && change.index < item.setupStepCount ? { setupStepCount: item.setupStepCount + change.inserted } : {}),
      ...(item.outcomeChecks && change.index >= (item.setupStepCount ?? 0) ? { outcomeChecks: item.outcomeChecks.map(check => ({ ...check,
        assertionIndexes: check.assertionIndexes.map(index => index >= change.index - (item.setupStepCount ?? 0) ? index + change.inserted : index) })) } : {}),
      steps: [...item.steps.slice(0, change.index), ...change.steps, ...item.steps.slice(change.index + change.replaced)] } : item;
  }) };
  return parseProbePlan(alternative, packet);
}

function isTargetLink(step: ProbeStep | undefined, name: string): step is Extract<ProbeStep, { op: "click" | "expectVisible" }> {
  return Boolean(step && (step.op === "click" || step.op === "expectVisible") &&
    step.locator.by === "role" && step.locator.role === "link" && step.locator.name === name);
}

interface DeclaredObject { kind: string; name: string; owner?: string }

/** Mask literals without changing offsets, so data values cannot authorize navigation. */
function unquotedText(text: string): string {
  return text.replace(/([`"])([^`"]+)\1/g, literal => " ".repeat(literal.length));
}

/** Preserve an explicit adjacent owner field; other named values establish no ownership. */
function declaredObjects(declaration: string): DeclaredObject[] {
  const end = unquotedText(declaration).search(/[.!?](?=\s|$)|[\r\n]/);
  const seed = end < 0 ? declaration : declaration.slice(0, end);
  const fields = [...seed.matchAll(/\b([\w-]+)\s+([`"])([^`"]+)\2/g)];
  return fields.flatMap((field, index) => {
    const kind = field[1].toLowerCase();
    if (kind === "owner") return [];
    const next = fields[index + 1];
    const owner = next?.[1].toLowerCase() === "owner" &&
      /^[,\s]+$/.test(seed.slice(field.index! + field[0].length, next.index)) ? next[3] : undefined;
    return [{ kind, name: field[3], ...(owner ? { owner } : {}) }];
  });
}

/** Only explicit target names, or generic references to its declared kind, bind an entry clause. */
function mentionsTarget(text: string, objects: DeclaredObject[]): boolean {
  const names = [...text.matchAll(/([`"])([^`"]+)\1/g)].map(match => match[2]);
  if (names.length) return objects.some(object => names.includes(object.name));
  const words: string[] = unquotedText(text).toLowerCase().match(/\b[\w-]+\b/g) ?? [];
  return objects.some(object => words.includes(object.kind) || words.includes(`${object.kind}s`));
}

/** Keep deterministic search recovery limited to explicit navigation clauses for this target. */
function allowsSearchEntry(evidence: AtomicRequirement[], objects: DeclaredObject[]): boolean {
  const statements = evidence.flatMap(requirement => [requirement.text, ...requirement.scenarios,
    ...requirement.ancestors.map(ancestor => ancestor.description)])
    .flatMap(text => {
      const parts: string[] = [];
      let start = 0;
      for (const separator of unquotedText(text).matchAll(/(?<=[.!?])\s+|[\r\n]+/g)) {
        parts.push(text.slice(start, separator.index));
        start = separator.index! + separator[0].length;
      }
      return [...parts, text.slice(start)];
    });
  if (statements.some(text => /\b(?:home page|homepage)\b/i.test(unquotedText(text)) &&
    /\b(?:link|entry|entries)\b/i.test(unquotedText(text)) && mentionsTarget(text, objects))) return false;
  const entries = [
    /\bsearch(?:es|ing)?(?: results?)?\s+opens?\s+([^,;.!?\n]+)/i,
    /\bopen(?:s|ing)?\s+([^,;.!?\n]+?)\s+(?:via|through|from|using)\s+(?:a\s+|the\s+)?(?:global\s+)?search(?: results?)?\b/i,
    /\bsearch results?\b[^;.!?\n]*?\b(?:for|of)\s+([^,;.!?\n]+)/i,
  ];
  return statements.some(text => {
    if (/(?:\bSeed (?:data|values):|\bevaluation seed contains\b)/i.test(text)) return false;
    const prose = unquotedText(text);
    return entries.some(pattern => {
      const match = pattern.exec(prose);
      if (!match) return false;
      const start = match.index + match[0].indexOf(match[1]);
      return mentionsTarget(text.slice(start, start + match[1].length), objects);
    });
  });
}

function visibleObjectScopes(snapshot: string, target: string, objects: DeclaredObject[]) {
  const lines = snapshot.split("\n");
  const scopes: Array<{ start: number; end: number; scope: { by: "role"; role: string; hasText: string } }> = [];
  for (let index = 0; index < lines.length; index++) {
    const container = lines[index].match(/^(\s*)- (listitem|row|article)(?:\s|:|$)/);
    if (!container) continue;
    let end = index + 1;
    while (end < lines.length && (!lines[end].trim() || lines[end].search(/\S/) > container[1].length)) end++;
    const block = lines.slice(index + 1, end);
    if (!block.some(line => line.includes(`- link "${target}"`))) continue;
    const identity = block.map(line => /^- (?:paragraph|text): (.+)$/.exec(line.trim())?.[1])
      .find(candidate => candidate !== undefined && objects.some(object =>
        object.owner !== undefined && candidate === `${object.owner}/${target}`));
    if (identity !== undefined) {
      scopes.push({ start: index, end, scope: { by: "role", role: container[2], hasText: identity } });
    }
  }
  // Nested listitem/article containers describe one result. Keep its innermost
  // identity-bearing container; distinct same-identity results remain ambiguous.
  return scopes.filter(outer => !scopes.some(inner => inner.start > outer.start && inner.end <= outer.end))
    .map(item => item.scope);
}
