import type { WorkPacket } from "../types.js";
import { maskRequirementLiterals } from "../requirement-text.js";
import { declaredGlobalSearchControls, parseProbePlan, requirementEvidenceTexts, type ProbePlan } from "./probe-schema.js";

/** A structural sample, kept separate from complete scenario plans and verdicts. */
export function publicEntryPlan(packet: WorkPacket): ProbePlan | undefined {
  // Do not invent login, credentials or a visitor entry for a protected search.
  const visitorHome = requirementEvidenceTexts(packet.requirements).some(text =>
    /\b(?:visitor|unauthenticated)\b[^.!?]*\bhome\s+page\b|\bhome\s+page\b[^.!?]*\b(?:visitor|unauthenticated)\b/i
      .test(maskRequirementLiterals(text.replace(/\r?\n/g, " "))));
  if (!visitorHome) return undefined;
  const visitorSearch = packet.requirements.some(requirement =>
    /\bvisitors?\s+(?:or\s+(?:signed-in|authenticated)\s+users?\s+)?(?:can|may)\s+search\b/i
      .test(maskRequirementLiterals(requirement.text.replace(/\r?\n/g, " "))));
  if (!visitorSearch) return undefined;
  const controls = declaredGlobalSearchControls({ requirements: packet.requirements });
  if (controls.length !== 1) return undefined;
  const control = controls[0];
  const banner = { by: "role", role: "banner" } as const;
  const search = { by: "role", role: control.role, name: control.name, exact: true, scope: banner } as const;
  // This is deliberately not a full scenario: no outcome mappings or plan cache.
  return parseProbePlan({ packetId: packet.id, cases: [{
    id: "public-entry-contract", requirementIds: packet.requirementIds,
    purpose: "happy_path", expectationBasis: [control.evidence], steps: [
      { op: "goto", path: "/" },
      { op: "expectCount", locator: banner, count: 1 },
      { op: "expectCount", locator: search, count: 1 },
      { op: "expectVisible", locator: search },
      { op: "expectEnabled", locator: search },
    ],
  }] });
}
