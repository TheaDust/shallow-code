import type { WorkPacket } from "../types.js";
import type { ProbeCase, ProbeLocator, ProbePlan, ProbeStep } from "./probe-schema.js";
import { declaredGlobalSearchControls, PROBE_LIMITS, requirementEvidenceTexts } from "./probe-schema.js";
import { probeCoverageGaps, scenarioOutcomes } from "./probe-coverage.js";
import { maskRequirementLiterals } from "../requirement-text.js";

type CompatibilityPacket = Pick<WorkPacket, "requirements"> & Partial<Pick<WorkPacket, "prerequisites">>;

export interface CompatibilityApplicability {
  url: boolean;
  authPublicEntry: boolean;
  globalControl: boolean;
  entityDetailIdentity: boolean;
  uniquePublishConflict: boolean;
}

/** Semantic triggers only: no product names, packet IDs, seed prefixes or fixture counts. */
export function compatibilityApplicability(packet: CompatibilityPacket): CompatibilityApplicability {
  const own = packet.requirements.flatMap(item => [item.text,
    ...(item.scenarioContracts ?? []).flatMap(scenario => scenario.steps.map(step => step.content))]).join(" ");
  const inherited = packet.requirements.some(item => item.product.evolution);
  const localOverlay = /\b(?:dialog|menu|popover)\b/i.test(own) &&
    !/\b(?:detail|overview)\s+page\b|\bpage\s+(?:displays?|shows?|opens?)\b/i.test(own);
  return {
    url: /\b(?:page\s+)?(?:address|url)\b/i.test(own),
    authPublicEntry: inherited && /\b(?:revok(?:e|ed|ing)|expir(?:e|ed|ing))\b[^.!?]*\b(?:session|browser)\b|\b(?:session|browser)\b[^.!?]*\b(?:revok(?:e|ed|ing)|expir(?:e|ed|ing))\b/i.test(own) &&
      /\b(?:sign[ -]?in|log[ -]?in|unauthenticated)\b/i.test(own),
    globalControl: inherited && declaredGlobalSearchControls(packet).length === 1,
    entityDetailIdentity: inherited && !localOverlay && /\bdetail\b/i.test(own) &&
      /\b(?:unique|identifier|tag)\b/i.test(own) && /\b(?:opens?|displays?|shows?)\b/i.test(own),
    uniquePublishConflict: inherited && !localOverlay && /\b(?:create|publish)(?:es|ed|ing)?\b/i.test(own) &&
      /\b(?:unique|duplicate|conflict|already exists)\b/i.test(own) && /\bform\b/i.test(own) &&
      /\b(?:detail|overview|entity|record|item)\b/i.test(own),
  };
}

/**
 * Validate the compatibility conventions that can be derived without browser
 * discovery. These checks tighten a Planner plan but never create verified
 * status; browser-only contracts are executed as separate compatibility plans.
 */
export function assertCompatibilityPlan(plan: ProbePlan, packet: CompatibilityPacket): void {
  const applies = compatibilityApplicability(packet);
  if (applies.authPublicEntry) assertAuthPublicEntry(plan, packet);
  if (applies.entityDetailIdentity) assertDetailIdentityHeadings(plan, packet);
  if (applies.uniquePublishConflict) assertUniqueConflictContext(plan, packet);
}

/** Execute conventions against the candidate, rather than discarding a useful
 * business plan because the model omitted a convention. No outcome mappings or
 * completeness metadata are copied: these samples never verify a requirement. */
export function resultCompatibilityPlan(packet: CompatibilityPacket & Pick<WorkPacket, "id">,
  plan: ProbePlan | undefined): ProbePlan | undefined {
  if (!plan || !packet.requirements.some(item => item.product.evolution)) return undefined;
  const applies = compatibilityApplicability(packet);
  const gaps = probeCoverageGaps(plan, packet.requirements);
  const cases: ProbeCase[] = [];
  const add = (source: ProbeCase, kind: string, end: number, assertions: ProbeStep[]): void => {
    const setup = source.setupStepCount ?? 0;
    if (!assertions.length || end < setup || end + 1 + assertions.length - setup > PROBE_LIMITS.businessSteps) return;
    cases.push({ id: `compat-${kind}-${source.id}-${cases.length}`, requirementIds: source.requirementIds,
      purpose: source.purpose, expectationBasis: source.expectationBasis,
      ...(setup ? { setupStepCount: setup } : {}),
      steps: [...structuredClone(source.steps.slice(0, end + 1)), ...assertions] });
  };
  for (const requirement of packet.requirements) for (const scenario of requirement.scenarioContracts ?? []) {
    const results = scenarioOutcomes([requirement]).filter(item => item.scenarioId === scenario.id);
    const then = results.map(item => item.text).join(" ");
    const when = scenario.steps.find(step => step.keyword.toUpperCase() === "WHEN")?.content ?? "";
    const given = scenario.steps.slice(0, scenario.steps.findIndex(step => step.keyword.toUpperCase() === "WHEN"))
      .map(step => step.content).join(" ");
    const sources = plan.cases.filter(item => item.outcomeChecks?.some(check => check.scenarioId === scenario.id));
    for (const source of sources.slice(0, 1)) {
      const checkpoint = Math.max(...source.outcomeChecks!.filter(check => check.scenarioId === scenario.id)
        .flatMap(check => check.assertionIndexes.map(index => index + (source.setupStepCount ?? 0))));
      if (applies.entityDetailIdentity && /\bdetail\b[^.!?]*\bdisplays?\b/i.test(then)) {
        const value = detailIdentityValue(then, when);
        if (value && !sensitive(value) && !source.steps.some(step => exactHeading(step, value))) {
          add(source, "identity", checkpoint, [{ op: "expectVisible",
            locator: { by: "role", role: "heading", name: value, exact: true } }]);
        }
      }
      if (applies.uniquePublishConflict && /\b(?:already exists|duplicate|conflict)\b/i.test(then)) {
        const value = /\b(?:existing|duplicate|conflicting)\b[^`]{0,80}`([^`]+)`/i.exec(when)?.[1];
        const filled = source.steps.findIndex(step => step.op === "fill" && step.value === value);
        const field = source.steps[filled];
        const error = source.steps.findIndex((step, index) => index > filled && (
          step.op === "expectText" && /\b(?:already exists|duplicate|conflict)\b/i.test(step.text) ||
          step.op === "expectVisible" && /\b(?:already exists|duplicate|conflict)\b/i.test("locator" in step ? locatorName(step.locator) ?? "" : "")));
        if (value && !sensitive(value) && field?.op === "fill" && error >= 0 &&
          !/(?:password|token|secret|email|api[ _-]?key)/i.test(locatorName(field.locator) ?? "")) {
          add(source, "conflict", error, [
            { op: "expectValue", locator: structuredClone(field.locator), value },
            { op: "expectFormContext", locator: structuredClone(field.locator), value },
          ]);
        }
      }
      if (applies.authPublicEntry && /\brevoked browser\b/i.test(then)) {
        const context = revocationContext(source, declaredPublicEntryLinks(packet), checkpoint);
        const reload = context?.revoked === undefined ? -1 : source.steps.findIndex((step, index) =>
          index > context.action && step.op === "reload" && context.actors[index] === context.revoked);
        const names = declaredPublicEntryLinks(packet);
        if (reload >= 0 && names.length === 1) add(source, "auth", reload, [{ op: "expectVisible",
          locator: { by: "role", role: "link", name: names[0], exact: true, scope: { by: "role", role: "main" } } }]);
      }
      const countGap = gaps.some(item => item.scenarioId === scenario.id && /count/i.test(item.reason));
      if (countGap && /\bdetail\b/i.test(requirement.text)) {
        const noun = [...maskRequirementLiterals(requirement.text).matchAll(/\b([a-z][\w-]*)\s+(?:type\s+and\s+)?counts?\b/gi)]
          .map(match => match[1]).find(value => !/^(?:a|the|existing|updated|original|current|total|own)$/i.test(value));
        if (noun) {
          const returnsEmpty = /\b(?:returns? to|original value)\b/i.test(then) &&
            /\bhas not\b/i.test(maskRequirementLiterals(given)) &&
            new RegExp(`\\bno other\\b[^.!?]{0,60}\\b${noun}s?\\b`, "i").test(maskRequirementLiterals(given));
          // This convention proves the complete count expression only. Actual
          // arithmetic stays an uncovered business fact until independently checked.
          add(source, "count", checkpoint, [{ op: "expectAccessibleCount", noun, scope: { by: "role", role: "main" },
            ...(returnsEmpty ? { exact: 0 } : { minimum: 0 }) }]);
        }
      }
      for (const outcome of results) {
        const capitalState = /\bis\s+(Active|Inactive|Archived|Revoked)\b/.exec(outcome.text)?.[1];
        if (!capitalState || !gaps.some(item => item.scenarioId === outcome.scenarioId && item.stepIndex === outcome.stepIndex &&
          (item.clauseIndex ?? 0) === (outcome.clauseIndex ?? 0) && /state fact/i.test(item.reason))) continue;
        const mapping = source.outcomeChecks!.find(check => check.scenarioId === outcome.scenarioId && check.stepIndex === outcome.stepIndex &&
          (check.clauseIndex ?? 0) === (outcome.clauseIndex ?? 0));
        if (mapping) add(source, "state", Math.max(...mapping.assertionIndexes) + (source.setupStepCount ?? 0), [{ op: "expectVisible",
          locator: { by: "text", text: capitalState, exact: true, scope: { by: "role", role: "main" } } }]);
      }
      if (/\brevoked\b/i.test(then) && /\binactive\b/i.test(then) && /\bor\b/i.test(maskRequirementLiterals(then)) &&
        /\b(?:reload|refresh)\b/i.test(scenario.steps.map(step => step.content).join(" "))) {
        const marker = [...then.matchAll(/`([^`]+)`|“([^”]+)”|"([^"\n]+)"/g)]
          .map(match => match[1] ?? match[2] ?? match[3])
          .find(value => /\b(?:revoked|inactive|ended|expired)\b/i.test(value)) ?? "revoked";
        const context = revocationContext(source, declaredPublicEntryLinks(packet), checkpoint);
        if (context) {
          const reload = source.steps.findIndex((step, index) => index > context.action && step.op === "reload" && context.actors[index] === context.owner);
          const completed = source.steps.findIndex((step, index) => index > context.action && context.actors[index] === context.owner && (
            step.op === "expectText" && [marker.toLowerCase(), "inactive"].includes(step.text.toLowerCase()) ||
            step.op === "expectVisible" && [marker.toLowerCase(), "inactive"].includes((locatorName(step.locator) ?? "").toLowerCase()) ||
            (step.op === "expectHidden" || step.op === "expectCount" && step.count === 0) &&
              JSON.stringify(step.locator) === JSON.stringify((source.steps[context.action] as Extract<ProbeStep, { op: "click" }>).locator)));
          const end = reload >= 0 ? reload : completed;
          if (end >= 0) add(source, "persistence", end, [
            ...(reload >= 0 ? [] : [{ op: "reload" as const }]),
            { op: "expectVisible", locator: { by: "text", text: marker, exact: false, scope: { by: "role", role: "main" },
              fallbacks: [{ by: "text", text: "inactive", exact: false, scope: { by: "role", role: "main" } }] } },
          ]);
        }
      }
    }
  }
  // One packet is one atomic audit; keep diagnostic browser work bounded.
  return cases.length ? { packetId: plan.packetId, cases: cases.slice(0, 3) } : undefined;
}

/** Only a known owner and its unique, equally authenticated peer establish the
 * browser to inspect. Unknown or overwritten contexts cannot authorize a guess. */
function revocationContext(source: ProbeCase, entryNames: string[], checkpoint: number):
  { action: number; owner: string; revoked?: string; actors: Array<string | undefined> } | undefined {
  let actor: string | undefined = "default";
  let ambiguous = false;
  const known = new Set(["default"]);
  const identifiers = new Map<string, string>();
  const authenticated = new Map<string, string>();
  const actors: Array<string | undefined> = [];
  let context: { action: number; owner: string; revoked?: string; actors: Array<string | undefined> } | undefined;
  for (const [index, step] of source.steps.entries()) {
    if (step.op === "newContext") {
      actor = step.actor;
      if (!actor || known.has(actor)) ambiguous = true;
      if (actor) known.add(actor);
    } else if (step.op === "switchContext") actor = step.actor;
    actors.push(actor);
    if (actor && step.op === "fill" && /\b(?:username|email)\b/i.test(locatorName(step.locator) ?? "")) identifiers.set(actor, step.value);
    if (actor && step.op === "click" && entryNames.includes(locatorName(step.locator) ?? "") && identifiers.has(actor)) authenticated.set(actor, identifiers.get(actor)!);
    if (index <= checkpoint && actor && step.op === "click" && /\b(?:revoke|expire|end session)\b/i.test(locatorName(step.locator) ?? "")) {
      const peers = [...known].filter(name => name !== actor);
      const peer = !ambiguous && peers.length === 1 && authenticated.has(actor) && authenticated.get(actor) === authenticated.get(peers[0]) ? peers[0] : undefined;
      context = { action: index, owner: actor, revoked: peer, actors };
    }
  }
  return context;
}

function assertAuthPublicEntry(plan: ProbePlan, packet: CompatibilityPacket): void {
  const names = declaredPublicEntryLinks(packet);
  if (!names.length) return;
  const relevant = relevantCases(plan, packet, text =>
    /\brevoked browser\b|\bredirected to (?:the )?(?:sign[ -]?in|log[ -]?in) page\b/i.test(text));
  if (!relevant.length) return;
  const valid = relevant.some(probeCase => {
    let revoked = -1;
    for (const [index, step] of probeCase.steps.entries()) if (step.op === "click" &&
      /\b(?:revoke|expire|end session)\b/i.test(locatorName(step.locator) ?? "")) revoked = index;
    const after = revoked < 0 ? (probeCase.setupStepCount ?? 0) : revoked;
    return probeCase.steps.some((step, index) => index > after && step.op === "expectVisible" &&
      locatorName(step.locator) !== undefined && names.includes(locatorName(step.locator)!) &&
      step.locator.by === "role" && step.locator.role === "link" && step.locator.exact === true &&
      step.locator.scope?.by === "role" && step.locator.scope.role === "main" &&
      (revoked >= 0 || probeCase.steps.slice(after, index).some(before => before.op === "reload")));
  });
  if (!valid) throw new Error("Compatibility contract requires the declared unauthenticated entry link to be visible in main after session revocation");
}

function assertDetailIdentityHeadings(plan: ProbePlan, packet: CompatibilityPacket): void {
  for (const requirement of packet.requirements) {
    if (!/\bdetail\b/i.test(requirement.text) || !/\b(?:unique|identifier|tag)\b/i.test(requirement.text)) continue;
    for (const scenario of requirement.scenarioContracts ?? []) {
      const then = scenario.steps.filter(step => ["THEN", "AND", "BUT"].includes(step.keyword.toUpperCase()))
        .map(step => step.content).join(" ");
      if (!/\bdetail\b[^.!?]*\bdisplays?\b/i.test(then)) continue;
      const value = detailIdentityValue(then, scenario.steps.find(step => step.keyword.toUpperCase() === "WHEN")?.content ?? "");
      if (!value || sensitive(value)) continue;
      const cases = plan.cases.filter(probeCase => (probeCase.outcomeChecks ?? []).some(check => check.scenarioId === scenario.id));
      if (!cases.length) continue;
      const valid = cases.some(probeCase => probeCase.steps.some(step => exactHeading(step, value)));
      if (!valid) throw new Error(`Compatibility contract requires detail identity ${JSON.stringify(value)} as an exact heading`);
    }
  }
}

function assertUniqueConflictContext(plan: ProbePlan, packet: CompatibilityPacket): void {
  for (const requirement of packet.requirements) {
    if (!/\b(?:create|publish)(?:es|ed|ing)?\b/i.test(requirement.text) ||
      !/\b(?:unique|duplicate|already exists|conflict)\b/i.test(requirement.text) || !/\bform\b/i.test(requirement.text)) continue;
    for (const scenario of requirement.scenarioContracts ?? []) {
      const then = scenario.steps.filter(step => ["THEN", "AND", "BUT"].includes(step.keyword.toUpperCase()))
        .map(step => step.content).join(" ");
      if (!/\b(?:already exists|duplicate|conflict)\b/i.test(then)) continue;
      const when = scenario.steps.find(step => step.keyword.toUpperCase() === "WHEN")?.content ?? "";
      const value = /\b(?:existing|duplicate|conflicting)\b[^`]{0,80}`([^`]+)`/i.exec(when)?.[1];
      if (!value || sensitive(value)) continue;
      const cases = plan.cases.filter(probeCase => (probeCase.outcomeChecks ?? []).some(check => check.scenarioId === scenario.id));
      if (!cases.length) continue;
      const valid = cases.some(probeCase => {
        const submitted = probeCase.steps.findIndex(step => step.op === "fill" && step.value === value);
        const failed = probeCase.steps.findIndex((step, index) => index > submitted &&
          (step.op === "expectText" && /\b(?:already exists|duplicate|conflict)\b/i.test(step.text) ||
            step.op === "expectVisible" && /\b(?:already exists|duplicate|conflict)\b/i.test(locatorName(step.locator) ?? "")));
        if (submitted < 0 || failed < 0) return false;
        const field = probeCase.steps[submitted];
        if (field.op !== "fill") return false;
        const exit = probeCase.steps.findIndex((step, index) => index > failed && (
          ["goto", "reload", "newContext", "switchContext"].includes(step.op) ||
          step.op === "click" && step.locator.by === "role" && step.locator.role === "link" ||
          step.op === "press" && step.key === "Escape"));
        const context = probeCase.steps.slice(failed + 1, exit < 0 ? undefined : exit);
        const retained = context.some(step => step.op === "expectValue" && step.value === value &&
          locatorName(step.locator) === locatorName(field.locator));
        const single = context.some(step => step.op === "expectCount" && step.count === 1 &&
          locatorName(step.locator) === value && step.locator.exact === true);
        return retained && single;
      });
      if (!valid) throw new Error(`Compatibility contract requires the non-sensitive submitted identifier ${JSON.stringify(value)} to remain in the form and appear exactly once in the conflict context`);
    }
  }
}

function relevantCases(plan: ProbePlan, packet: CompatibilityPacket, matches: (text: string) => boolean): ProbeCase[] {
  const ids = new Set(packet.requirements.flatMap(requirement => (requirement.scenarioContracts ?? [])
    .filter(scenario => scenario.steps.some(step => ["THEN", "AND", "BUT"].includes(step.keyword.toUpperCase()) && matches(step.content)))
    .map(scenario => scenario.id)));
  return plan.cases.filter(probeCase => (probeCase.outcomeChecks ?? []).some(check => ids.has(check.scenarioId)));
}

function declaredPublicEntryLinks(packet: CompatibilityPacket): string[] {
  const names = new Set<string>();
  for (const text of requirementEvidenceTexts(packet.requirements, packet.prerequisites)) {
    for (const match of text.matchAll(/\b(?:visible\s+)?link(?:\s+named)?\s*[“"']([^”"']+)[”"']/gi)) names.add(match[1]);
  }
  const authentication = [...names].filter(name => /\b(?:sign[ -]?in|log[ -]?in|login)\b/i.test(name));
  return authentication.length ? authentication : names.size === 1 ? [...names] : [];
}

function exactHeading(step: ProbeStep, value: string): boolean {
  if (!("locator" in step) || step.locator.by !== "role" || step.locator.role !== "heading" || step.locator.exact !== true) return false;
  if (step.locator.name === value && step.op === "expectVisible") return true;
  return step.op === "expectText" && step.text === value && step.exact === true;
}

function locatorName(locator: ProbeLocator): string | undefined {
  return locator.by === "role" ? locator.name : locator.text;
}

function detailIdentityValue(then: string, when: string): string | undefined {
  return /\bdetail\b[^`]{0,80}`([^`]+)`/i.exec(then)?.[1] ??
    /\bopens?\s+(?:the\s+)?(?:exact\s+)?`([^`]+)`\s+[\p{L}\p{N}_-]+\b/iu.exec(when)?.[1] ??
    /\benters?\s+(?:the\s+)?(?:unique\s+)?(?:identifier|tag|name|title)\s+`([^`]+)`/i.exec(when)?.[1];
}

function sensitive(value: string): boolean {
  return value.includes("@") || /\b(?:password|token|secret|api[_-]?key)\b/i.test(value);
}
