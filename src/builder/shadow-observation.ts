import type { ShadowReport } from "../types.js";
import type { BuilderShadowObservation } from "./prompt-input.js";
import { sanitizeDiagnosticText } from "../diagnostics.js";

export function toBuilderShadowObservation(
  report: ShadowReport,
  secrets: readonly string[] = [],
): BuilderShadowObservation {
  return {
    packetId: report.packetId,
    passedCaseIds: [...report.passedCases],
    failures: report.failures.map((failure) => ({
      caseId: failure.caseId,
      stepIndex: failure.stepIndex,
      category: failure.category,
      message: sanitizeDiagnosticText(failure.message, secrets),
      ...(failure.inputSummary ? { inputSummary: sanitizeDiagnosticText(failure.inputSummary, secrets) } : {}),
      ...(failure.locatorSnapshot
        ? {
            accessibilityExcerpt: sanitizeDiagnosticText(
              failure.locatorSnapshot, secrets,
            ),
          }
        : {}),
    })),
    applicationStartupFailed: report.failures.some(
      (failure) => failure.caseId === "<application>",
    ),
  };
}
