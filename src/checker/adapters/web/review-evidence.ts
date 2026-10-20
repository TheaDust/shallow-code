import { hashBytes } from "../../artifacts.js";
import type { ReviewEvidence } from "../../port.js";

/** Keep binary evidence in artifacts; the model receives its identity and host metadata. */
export function webReviewEvidence(evidence: ReviewEvidence[]): ReviewEvidence[] {
  const binaries = new Map<string, unknown>();
  for (const { receipt, payload } of evidence) {
    const value = payload as Record<string, unknown> | null;
    if (receipt.kind !== "observation" || value?.kind !== "download" || value.encoding !== "base64" || typeof value.value !== "string" || !value.value.length) continue;
    const bytes = Buffer.from(value.value, "base64");
    binaries.set(value.value, { encoding: "base64", bytes: bytes.length, sha256: hashBytes(bytes), artifact: receipt.payload });
  }
  const project = (value: unknown): unknown => {
    if (typeof value === "string") return binaries.get(value) ?? value;
    if (Array.isArray(value)) return value.map(project);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, project(item)]));
    return value;
  };
  return evidence.map(item => ({ ...item, payload: project(item.payload) }));
}
