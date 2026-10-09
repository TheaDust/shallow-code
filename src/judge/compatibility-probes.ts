import type { WorkPacket } from "../types.js";
import type { ProbeCase, ProbePlan, ProbeStep } from "./probe-schema.js";
import { declaredGlobalSearchControls, isHomeEntryStep, requirementEvidenceTexts } from "./probe-schema.js";

/**
 * Build non-verifying compatibility samples from an already grounded business
 * plan. They may expose a repairable candidate defect, but the pipeline keeps
 * their result outside the requirement verification map.
 */
export function overlayLifecyclePlan(packet: WorkPacket, businessPlan: ProbePlan | undefined): ProbePlan | undefined {
  if (!businessPlan || !packet.requirements.some(item => item.product.evolution)) return undefined;
  const evidence = requirementEvidenceTexts(packet.requirements, packet.prerequisites).join(" ");
  if (!/\b(?:dialog|menu|popover|modal)\b/i.test(evidence)) return undefined;
  // Exercise an explicit lifecycle when available. Shared menu/dialog
  // consumers also have a closed-surface contract at a grounded checkpoint.
  const lifecycle = businessPlan.cases.map(overlayReopenCase).find((value): value is ProbeCase => value !== undefined)
    ?? (/\bmenu\b/i.test(evidence)
      ? businessPlan.cases.map(closedSurfaceReadyCase).find((value): value is ProbeCase => value !== undefined) : undefined);
  return lifecycle ? { packetId: packet.id, cases: [lifecycle] } : undefined;
}

/** Replays an already-grounded home search after reaching a real nested state. */
export function globalControlCrossRoutePlan(
  packet: WorkPacket,
  businessPlan: ProbePlan | undefined,
  sources: readonly { packet: WorkPacket; plan: ProbePlan }[],
): ProbePlan | undefined {
  if (!businessPlan || !packet.requirements.some(item => item.product.evolution)) return undefined;
  const prefix = nestedPrefix(businessPlan.cases);
  if (!prefix) return undefined;
  const sequence = sources.flatMap(source => {
    const controls = declaredGlobalSearchControls(source.packet);
    if (controls.length !== 1) return [];
    return source.plan.cases.map(probeCase => globalSearchSequence(probeCase, controls[0].name));
  }).find((value): value is ProbeStep[] => value !== undefined);
  if (!sequence) return undefined;
  const source = prefix.probeCase;
  return { packetId: packet.id, cases: [{
    id: `compat-global-cross-route-${source.id}`,
    requirementIds: source.requirementIds,
    purpose: "happy_path",
    expectationBasis: source.expectationBasis,
    setupStepCount: prefix.steps.length + 1,
    steps: [...structuredClone(prefix.steps), { op: "expectAwayFromHome" }, ...structuredClone(sequence)],
  }] };
}

function nestedPrefix(cases: readonly ProbeCase[]): { probeCase: ProbeCase; steps: ProbeStep[] } | undefined {
  let fallback: { probeCase: ProbeCase; steps: ProbeStep[] } | undefined;
  for (const probeCase of cases) {
    const setupCount = probeCase.setupStepCount ?? 0;
    let lastAssertion = -1;
    let navigation = false;
    let openedLink = false;
    let extendedNavigation = false;
    for (let index = 0; index < Math.min(probeCase.steps.length, 14); index += 1) {
      const step = probeCase.steps[index];
      const link = step.op === "click" && step.locator.by === "role" && step.locator.role === "link";
      const search = (step.op === "fill" || step.op === "press" && step.key === "Enter") &&
        step.locator.by === "role" && step.locator.role === "searchbox";
      if (index >= setupCount && !link && !search && step.op !== "goto" && !step.op.startsWith("expect")) break;
      if (link || search) navigation = true;
      if (link) openedLink = true;
      if (index >= setupCount && (link || search)) extendedNavigation = true;
      if (step.op.startsWith("expect")) lastAssertion = index;
    }
    if (navigation && openedLink && lastAssertion > 1) {
      const candidate = { probeCase, steps: probeCase.steps.slice(0, lastAssertion + 1) };
      const checkpoint = probeCase.steps[lastAssertion];
      if (extendedNavigation || "locator" in checkpoint && checkpoint.locator.by === "role" && checkpoint.locator.role === "heading") return candidate;
      fallback ??= candidate;
    }
  }
  return fallback;
}
/** Shared menu/dialog consumers may leave a stale closed surface before a user
 * ever opens it. Reuse a bounded, grounded readiness checkpoint to inspect it. */
function closedSurfaceReadyCase(probeCase: ProbeCase): ProbeCase | undefined {
  if (probeCase.purpose !== "happy_path") return undefined;
  let end = -1;
  for (let index = 0; index < Math.min(probeCase.steps.length, 15); index += 1) {
    if (probeCase.steps[index].op.startsWith("expect")) end = index;
  }
  if (end < 1 || probeCase.steps[0].op !== "goto" || probeCase.steps[0].path !== "/") return undefined;
  return { id: `compat-closed-surfaces-${probeCase.id}`, requirementIds: probeCase.requirementIds,
    purpose: "happy_path", expectationBasis: probeCase.expectationBasis,
    steps: [...structuredClone(probeCase.steps.slice(0, end + 1)), { op: "expectClosedOverlaysEmpty" }] };
}

function overlayReopenCase(probeCase: ProbeCase): ProbeCase | undefined {
  const dialogIndex = probeCase.steps.findIndex(step => step.op === "expectVisible" &&
    step.locator.by === "role" && ["dialog", "alertdialog", "menu"].includes(step.locator.role));
  if (dialogIndex < 1) return undefined;
  let openerIndex = -1;
  for (let index = dialogIndex - 1; index >= 0; index -= 1) {
    if (probeCase.steps[index].op === "click") { openerIndex = index; break; }
  }
  if (openerIndex < 0) return undefined;
  const closeOffset = probeCase.steps.slice(dialogIndex + 1).findIndex(step =>
    step.op === "click" && /\b(?:cancel|close|dismiss)\b/i.test(locatorStepName(step) ?? "") ||
    step.op === "press" && step.key === "Escape");
  if (closeOffset < 0) return undefined;
  const closeIndex = dialogIndex + 1 + closeOffset;
  const setupCount = Math.min(probeCase.setupStepCount ?? openerIndex, openerIndex);
  const setup = setupCount > 0 ? probeCase.steps.slice(0, setupCount) : [];
  if (setupCount > 0 && setup.at(-1)?.op !== "goto" && !setup.at(-1)?.op.startsWith("expect")) return undefined;
  const action = probeCase.steps.slice(Math.max(setupCount, openerIndex), closeIndex + 1);
  const opener = probeCase.steps[openerIndex];
  const dialog = probeCase.steps[dialogIndex];
  if (opener.op !== "click" || dialog.op !== "expectVisible" || setup.length > 15 || action.length + 3 > 30) return undefined;
  return {
    id: `compat-overlay-reopen-${probeCase.id}`,
    requirementIds: probeCase.requirementIds,
    purpose: "happy_path",
    expectationBasis: probeCase.expectationBasis,
    ...(setupCount ? { setupStepCount: setupCount } : {}),
    steps: [...structuredClone(setup), ...structuredClone(action), { op: "expectClosedOverlaysEmpty" },
      structuredClone(opener), structuredClone(dialog)],
  };
}

function locatorStepName(step: ProbeStep): string | undefined {
  if (!("locator" in step)) return undefined;
  return step.locator.by === "role" ? step.locator.name : step.locator.text;
}

function globalSearchSequence(probeCase: ProbeCase, name: string): ProbeStep[] | undefined {
  const sameControl = (step: ProbeStep): boolean => "locator" in step && step.locator.by === "role" &&
    ["search", "searchbox"].includes(step.locator.role) && step.locator.name === name &&
    step.locator.scope?.by === "role" && step.locator.scope.role === "banner";
  const start = probeCase.steps.findIndex(step => step.op === "fill" && sameControl(step));
  if (start < 0 || !isHomeEntryStep(probeCase, start)) return undefined;
  const endOffset = probeCase.steps.slice(start + 1).findIndex(step => step.op === "expectVisible" &&
    step.locator.by === "role" && step.locator.role === "link" && step.locator.exact === true);
  if (endOffset < 0) return undefined;
  const end = start + 1 + endOffset;
  const sequence = probeCase.steps.slice(start, end + 1);
  return sequence.some(step => step.op === "press" && sameControl(step) && step.key === "Enter") ? sequence : undefined;
}
