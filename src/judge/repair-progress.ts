import type { AuditResult } from "./audit.js";
import { sameCaseBehavior } from "./semantic-review.js";

/** Progress is measured against the same tested behavior, never a weaker new plan. */
export function repairCaseProgress(before: AuditResult, after: AuditResult): { passed: string[]; resolvedGaps: string[] } {
  const progress = { passed: [] as string[], resolvedGaps: [] as string[] };
  if (!before.plan || !before.report || !after.plan || !after.report) return progress;
  for (const failure of before.report.failures) {
    const original = before.plan.cases.find(item => item.id === failure.caseId);
    const current = after.plan.cases.find(item => item.id === failure.caseId);
    if (!original || !current || !sameCaseBehavior(original, current)) continue;
    if (after.report.passedCases.includes(failure.caseId)) {
      progress.passed.push(failure.caseId);
      continue;
    }
    // Both the original required gap and the later failure must be freshly reproduced.
    if (!before.repairableProbeFailure || (after.status !== "failed" && !after.repairableProbeFailure)) continue;
    const next = after.report.failures.find(item => item.caseId === failure.caseId);
    if (!next || !["locator", "precondition"].includes(failure.category)) continue;
    const beforeSetup = original.setupStepCount ?? 0;
    const afterSetup = current.setupStepCount ?? 0;
    if (failure.category === "precondition"
      ? next.stepIndex >= afterSetup && afterSetup > 0
      : next.stepIndex - afterSetup > failure.stepIndex - beforeSetup) {
      progress.resolvedGaps.push(failure.caseId);
    }
  }
  return progress;
}
