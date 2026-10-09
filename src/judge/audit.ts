import { createHash } from "node:crypto";
import type { PipelineDeps, PipelineOptions, AppLifecycle } from "../pipeline.js";
import type { WorkPacket, ShadowReport, InconclusiveKind } from "../types.js";
import { probeCoverageGaps, type UncoveredOutcome } from "./probe-coverage.js";
import type { RunStateStore } from "../run-state.js";
import { ExecutionFault } from "../execution-fault.js";
import { GatewayRequestError } from "../gateway-failure.js";
import { isModelLengthCutoff, planValidationFeedback, ProbePlannerError, type ProbePlannerFeedback } from "./llm-probe-planner.js";
import { rootSearchNavigationPlan } from "./navigation-recovery.js";
import { isPreparationOnlyCorrection } from "./semantic-review.js";
import { assertLocatorOnlyRefinement, declaredLocatorRoles, groundedLocatorAnchors, groundedLocatorNames, isHomeEntryStep, locatorCandidates, matchesDeclaredLocatorRole, parseProbePlan, probePlanSha256, type ProbeLocator, type ProbePlan, type ProbeStep } from "./probe-schema.js";

interface ProbeOutcome { source: "application" | "probe"; report: ShadowReport; plan: ProbePlan; navigationRecovered?: boolean }
export interface AuditResult {
  status: "verified" | "failed" | "inconclusive";
  plan?: ProbePlan;
  report?: ShadowReport;
  reason?: string;
  /** Reviewed, reproduced preparation/control gap; diagnostic repair, not a failed verdict. */
  repairableProbeFailure?: boolean;
  failureKind?: InconclusiveKind;
  coverageGaps?: UncoveredOutcome[];
  navigationRecovered?: boolean;
}

export interface AuditPolicy {
  /**
   * Module boundary audits refine locators so a probe-side mismatch cannot be
   * mistaken for an application failure. Detection-only audits skip refinement
   * (they still run the probes), since they publish results without repairing.
   */
  refineLocators: boolean;
  /** Background planning already used its feedback retry for this packet. */
  retryPlan?: boolean;
  /** Shared across audits so an identical failed page does not ask the model again. */
  noProgressRefinements?: Set<string>;
  /** A sampled guard proves only the selected paths, not the full scenario set. */
  checkCoverage?: boolean;
}

const DEFAULT_AUDIT_POLICY: AuditPolicy = { refineLocators: true };

/** Only reproducible business failures are eligible for application repair. */
export async function auditPacket(packet: WorkPacket, cached: ProbePlan | undefined,
  options: PipelineOptions, deps: PipelineDeps, state: RunStateStore, remaining: () => number,
  policy: AuditPolicy = DEFAULT_AUDIT_POLICY,
): Promise<AuditResult> {
  const result = await performAudit(packet, cached, options, deps, state, remaining, policy);
  if (result.plan?.navigationRecovered) result.navigationRecovered = true;
  if (result.status === "verified" && result.plan && policy.checkCoverage !== false) {
    const gaps = probeCoverageGaps(result.plan, packet.requirements);
    if (gaps.length) return { ...result, status: "inconclusive", failureKind: "coverage", coverageGaps: gaps,
      reason: `${gaps.length} scenario outcomes lack verified assertion coverage` };
  }
  if (result.status === "inconclusive" && !result.failureKind) {
    result.failureKind = result.report?.failures.some(item => item.category === "precondition") ? "preparation"
      : result.report?.failures.some(item => item.category === "locator") ? "locator"
      : result.report?.failures.some(item => item.category === "runner") ? "execution" : "unreproduced";
  }
  return result;
}

async function performAudit(packet: WorkPacket, cached: ProbePlan | undefined,
  options: PipelineOptions, deps: PipelineDeps, state: RunStateStore, remaining: () => number,
  policy: AuditPolicy,
): Promise<AuditResult> {
  let plan = cached;
  try {
    if (remaining() <= 0) return { status: "inconclusive", failureKind: "budget", plan, reason: "audit budget exhausted" };
    plan ??= await planProbe(packet, options, deps, state, remaining, policy.retryPlan !== false);
    if (!plan) return { status: "inconclusive", failureKind: "planning", reason: "probe planner failed" };
    // A known coverage gap must not hide independently executable diagnostics.
    // Full plans with only an unresolved review retain the existing review gate.
    if (plan.coverageReview === "pending" && probeCoverageGaps(plan, packet.requirements).length === 0) {
      if (!policy.refineLocators) {
        return { status: "inconclusive", failureKind: "review", plan,
          reason: "probe plan completeness review is unresolved" };
      }
      const reviewedPlan = await retryCoverageReview(packet, plan, deps, state, remaining);
      if (!reviewedPlan) {
        return { status: "inconclusive", failureKind: "review", plan,
          reason: "probe plan completeness review is unresolved" };
      }
      plan = reviewedPlan;
    }
    await state.record({ at: now(), type: "probe_planned", packetId: packet.id, detail: { cases: plan.cases.length } });
    const recovery = { browserRetries: 0, locatorRefinements: 0 };
    let first = await runShadowProbes(packet, plan, options, deps, state, recovery, remaining, policy);
    plan = first.plan;
    const reviewKey = createHash("sha256").update(JSON.stringify([probePlanSha256(plan), first.report.failures])).digest("hex");
    let reviewed = policy.refineLocators && policy.noProgressRefinements?.has(`review:sound:${reviewKey}`) === true;
    const probeGap = first.report.failures.some(item => item.category === "locator" || item.category === "precondition");
    // Business review keeps its own quota even when another case cannot be
    // prepared. Pure preparation/control gaps share the locator-recovery quota.
    const reviewUsesRecoveryQuota = probeGap && !first.report.failures.some(isBehaviorFailure);
    const reviewAttempts = reviewUsesRecoveryQuota
      ? MAX_LOCATOR_REFINEMENTS - recovery.locatorRefinements : DEFAULT_SEMANTIC_REVIEW_ATTEMPTS;
    if (policy.refineLocators && first.report.verdict !== "pass" && first.source === "probe" &&
      first.report.failures.some(item => item.category !== "runner") && !reviewed && reviewAttempts > 0 && remaining() > 0) {
      if (policy.noProgressRefinements?.has(`review:unavailable:${reviewKey}`)) {
        return { status: "inconclusive", failureKind: "review", plan, report: first.report, reason: "Identical plan review previously could not establish valid evidence" };
      }
      const review = await reviewBehaviorFailures(packet, plan, first.report, deps, state, remaining, reviewAttempts,
        reviewUsesRecoveryQuota ? recovery : undefined);
      if (review.status === "unavailable") {
        if (review.failureKind !== "gateway") policy.noProgressRefinements?.add(`review:unavailable:${reviewKey}`);
        return { status: "inconclusive", failureKind: review.failureKind ?? "review", plan, report: first.report, reason: review.reason };
      }
      reviewed = true;
      if (review.status === "sound") policy.noProgressRefinements?.add(`review:sound:${reviewKey}`);
      if (review.status === "corrected") {
        plan = review.plan;
        first = await runShadowProbes(packet, plan, options, deps, state, recovery, remaining, policy);
        plan = first.plan;
      }
    }
    if (first.report.verdict === "pass") {
      if (plan.coverageReview === "pending") {
        const gaps = probeCoverageGaps(plan, packet.requirements);
        return { status: "inconclusive", failureKind: gaps.length ? "coverage" : "review", plan, report: first.report,
          ...(gaps.length ? { coverageGaps: gaps } : {}),
          reason: gaps.length ? `${gaps.length} scenario outcomes lack verified assertion coverage`
            : "probe plan completeness review is unresolved" };
      }
      if (!first.navigationRecovered) return { status: "verified", plan, report: first.report };
      if (remaining() <= 0) return { status: "inconclusive", failureKind: "budget", plan, report: first.report, reason: "navigation recovery confirmation budget exhausted" };
      const confirmed = await runShadowProbes(packet, plan, options, deps, state, recovery, remaining, { refineLocators: false });
      return confirmed.report.verdict === "pass"
        ? { status: "verified", plan, report: confirmed.report }
        : { status: "inconclusive", plan, report: confirmed.report, reason: "navigation recovery did not pass on a fresh application" };
    }
    const businessFailures = first.report.failures.filter(isBehaviorFailure);
    const diagnosis = reviewed ? diagnosticFailures(packet, plan, first.report) : [];
    if (first.source !== "probe" || (!businessFailures.length && !diagnosis.length) ||
      (policy.refineLocators && businessFailures.length > 0 && !reviewed)) {
      return { status: "inconclusive", plan, report: first.report, reason: "Judge could not establish valid behavior evidence" };
    }
    if (remaining() <= 0) return { status: "inconclusive", failureKind: "budget", plan, reason: "failure confirmation budget exhausted" };
    // Fresh application state: failed actions may have changed server-side data.
    const confirmed = await runShadowProbes(packet, plan, options, deps, state, recovery, remaining, { refineLocators: false });
    plan = confirmed.plan;
    if (diagnosis.length > 0 && businessFailures.length === 0 && confirmed.source === "probe" && confirmed.report.verdict === "pass") {
      return { status: "verified", plan, report: confirmed.report };
    }
    const repeated = confirmed.source === "probe" ? confirmed.report.failures.filter(item =>
      [...businessFailures, ...diagnosis].some(previous => failureKey(previous) === failureKey(item))) : [];
    const reproducedBusiness = repeated.filter(isBehaviorFailure);
    if (reproducedBusiness.length > 0) {
      return { status: "failed", plan, report: { ...confirmed.report, verdict: "fail", failures: reproducedBusiness } };
    }
    const reproducedDiagnosis = repeated.filter(item => diagnosis.some(previous => failureKey(previous) === failureKey(item)));
    return { status: "inconclusive", plan,
      report: reproducedDiagnosis.length ? { ...confirmed.report, verdict: "inconclusive", failures: reproducedDiagnosis } : confirmed.report,
      ...(reproducedDiagnosis.length ? { repairableProbeFailure: true,
        reason: "A reviewed preparation or required-control gap repeated on fresh application data; implementation diagnosis needed" }
        : { reason: "failure was not reproducible" }) };
  } catch (error) {
    if (error instanceof GatewayRequestError) {
      return { status: "inconclusive", failureKind: "gateway", plan, reason: "gateway recovery window exhausted" };
    }
    // Judge faults do not edit or discard the buildable application checkpoint.
    await state.record({ at: now(), type: "execution_fault", packetId: packet.id,
      detail: { source: "judge", message: errorMessage(error), retry: false } });
    return { status: "inconclusive", failureKind: error instanceof ProbePlannerError ? "planning" : "execution", plan, reason: errorMessage(error) };
  }
}

function failureKey(failure: ShadowReport["failures"][number]): string {
  return JSON.stringify([failure.caseId, failure.stepIndex, failure.category]);
}

function isBehaviorFailure(failure: ShadowReport["failures"][number]): boolean {
  return ["assertion", "navigation", "timeout"].includes(failure.category);
}

const DEFAULT_SEMANTIC_REVIEW_ATTEMPTS = 2;

type SemanticReviewOutcome =
  | { status: "sound" }
  | { status: "corrected"; plan: ProbePlan }
  | { status: "unavailable"; reason: string; failureKind?: "gateway" };

async function reviewBehaviorFailures(
  packet: WorkPacket,
  plan: ProbePlan,
  report: ShadowReport,
  deps: PipelineDeps,
  state: RunStateStore,
  remaining: () => number,
  attempts: number,
  recovery?: { locatorRefinements: number },
): Promise<SemanticReviewOutcome> {
  await state.record({ at: now(), type: "probe_review_started", packetId: packet.id,
    detail: { cases: plan.cases.length, failed: report.failures.length } });
  const beforePlanSha256 = probePlanSha256(plan);
  const preparationOnlyCaseIds = report.failures.filter(failure => failure.category === "precondition" &&
    (plan.cases.find(item => item.id === failure.caseId)?.setupStepCount ?? 0) > 0).map(item => item.caseId);
  let feedback: ProbePlannerFeedback | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (remaining() <= 0) break;
    try {
      if (recovery) recovery.locatorRefinements++;
      const review = await deps.planner.reviewPlan(packet, plan, report.failures, feedback, {
        timeoutMs: Math.max(1, remaining()),
        preparationOnlyCaseIds,
      });
      if (review.status === "sound") {
        const unprepared = report.failures.filter(failure => {
          const probeCase = plan.cases.find(item => item.id === failure.caseId);
          const seeded = packet.requirements.some(item => probeCase?.requirementIds.includes(item.id) && item.seedDeclarations.length > 0);
          if (!seeded) return false;
          if (failure.category === "precondition") {
            const step = probeCase?.steps[failure.stepIndex];
            return (step?.op === "expectValue" || step?.op === "expectText") &&
              !probeCase?.steps.slice(0, failure.stepIndex).some(step =>
              ["fill", "select", "setChecked", "drag", "uploadFile"].includes(step.op) ||
              (step.op === "press" && step.key === "ControlOrMeta+V"));
          }
          if (!isBehaviorFailure(failure)) return false;
          const count = probeCase?.setupStepCount ?? 0;
          const stateAssertion = probeCase?.steps.slice(0, count).some(step => step.op.startsWith("expect") &&
            !(step.op === "expectVisible" && step.locator.by === "role" &&
              ["main", "grid", "region", "group", "list", "dialog", "article"].includes(step.locator.role)));
          return count === 0 || failure.stepIndex < count || !stateAssertion;
        });
        if (unprepared.length) {
          throw new Error(`Sound review requires an executed initial-state checkpoint for seeded cases: ${unprepared.map(item => item.caseId).join(", ")}. ` +
            "Seed declarations and a visible page/grid do not prove the required values, identity or permissions. Reconstruct preparation with grounded state assertions and setupStepCount.");
        }
        if (report.failures.length && report.failures.every(failure => failure.category === "precondition" &&
          !isLocatorAmbiguity(failure) && !groundedPreparationTarget(packet, plan, failure))) {
          throw new Error("Sound preparation review requires requirement-grounded targets. " +
            "The missing preparation controls or containers are planner assumptions; correct the prefix using the visible page and requirement evidence.");
        }
        await state.record({ at: now(), type: "probe_reviewed", packetId: packet.id,
          detail: { verdict: "sound", rationale: review.rationale, beforePlanSha256 } });
        return { status: "sound" };
      }
      const preparationCorrections = new Set(review.corrections.filter(correction => {
        const before = plan.cases.find(item => item.id === correction.caseId)!;
        const after = review.plan.cases.find(item => item.id === correction.caseId)!;
        const preparationOnly = isPreparationOnlyCorrection(before, after);
        if (preparationOnlyCaseIds.includes(correction.caseId) && !preparationOnly) {
          throw new Error(`Preparation recovery must preserve the tested steps, inputs and assertions for ${correction.caseId}`);
        }
        return preparationOnly;
      }).map(item => item.caseId));
      const exhausted = review.corrections.filter(correction => !preparationCorrections.has(correction.caseId) &&
        state.semanticCorrectionCount(packet.id, correction.caseId) >= 1);
      if (exhausted.length > 0) {
        const reason = `semantic correction quota exhausted for: ${exhausted.map(item => item.caseId).join(", ")}`;
        await state.record({ at: now(), type: "probe_review_failed", packetId: packet.id,
          detail: { message: reason, planSha256: beforePlanSha256 } });
        return { status: "unavailable", reason };
      }
      for (const correction of review.corrections) {
        if (!preparationCorrections.has(correction.caseId)) state.noteSemanticCorrection(packet.id, correction.caseId);
      }
      await state.record({ at: now(), type: "probe_reviewed", packetId: packet.id,
        detail: { verdict: "corrected", rationale: review.rationale, beforePlanSha256,
          planSha256: probePlanSha256(review.plan), corrections: review.corrections } });
      return { status: "corrected", plan: review.plan };
    } catch (error) {
      if (error instanceof ExecutionFault || (error instanceof ProbePlannerError && error.fatal)) throw error;
      const detail = plannerFailureDetail(error);
      await state.record({ at: now(), type: "probe_review_failed", packetId: packet.id,
        detail: { ...detail, planSha256: beforePlanSha256 } });
      if (error instanceof GatewayRequestError) return { status: "unavailable", failureKind: "gateway", reason: "gateway recovery window exhausted" };
      feedback = error instanceof ProbePlannerError
        ? { validationError: String(detail.validationError ?? detail.message),
            ...(typeof detail.contentPreview === "string" ? { contentPreview: detail.contentPreview } : {}) }
        : { validationError: errorMessage(error) };
    }
  }
  return { status: "unavailable", reason: "semantic review could not establish valid probe evidence" };
}

/** Candidate misses with no equivalent visible control require path/setup review. */
function locatorPatchMayHelp(failure: ShadowReport["failures"][number], step: ProbeStep): boolean {
  if (!failure.locatorAttempts || !failure.locatorSnapshot || isLocatorAmbiguity(failure) ||
    step.op.startsWith("expect") || !("locator" in step)) return true;
  return equivalentSnapshotControls(failure, step.locator).length > 0;
}

const SNAPSHOT_CONTROL_ROLES = /^(button|link|menuitem|menuitemcheckbox|menuitemradio|checkbox|radio|switch|tab|treeitem|option|textbox|searchbox|combobox|spinbutton|gridcell|rowheader|columnheader)$/;

function equivalentSnapshotControls(failure: ShadowReport["failures"][number], locator: ProbeLocator): string[] {
  if (!failure.locatorSnapshot) return [];
  const controls = [...failure.locatorSnapshot.matchAll(/^\s*- ([a-z]+) ("(?:\\.|[^"\\])*")/gm)];
  return controls.flatMap(([, role, encoded]) => {
    if (!SNAPSHOT_CONTROL_ROLES.test(role)) return [];
    let name: string;
    try { name = JSON.parse(encoded); } catch { return []; }
    return locatorCandidates(locator).some(candidate => {
      const target = candidate.by === "role" ? candidate.name : candidate.text;
      return target === undefined ? candidate.by === "role" && role === candidate.role
        : candidate.exact === false ? name.includes(target) : name === target;
    }) ? [role] : [];
  });
}

function snapshotDisplaysControlName(snapshot: string | undefined, locator: ProbeLocator): boolean {
  if (!snapshot) return false;
  const displayNames = [...snapshot.matchAll(/^\s*- heading ("(?:\\.|[^"\\])*")|^\s*- (?:text|generic|paragraph): ([^\r\n]+)/gm)]
    .flatMap(([, heading, content]) => {
      const value = (heading ?? content).trim();
      if (value.startsWith('"')) {
        try { return [JSON.parse(value) as string]; } catch { return []; }
      }
      return [value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1).replace(/''/g, "'") : value];
    });
  return locatorCandidates(locator).some(candidate => candidate.by === "role" && candidate.name !== undefined &&
    SNAPSHOT_CONTROL_ROLES.test(candidate.role) && displayNames.some(name =>
      candidate.exact === false ? name.includes(candidate.name!) : name === candidate.name));
}

function isLocatorAmbiguity(failure: ShadowReport["failures"][number]): boolean {
  return failure.message.includes("strict mode violation") ||
    failure.locatorAttempts?.some(attempt => attempt.message.includes("strict mode violation") ||
      (attempt.matchCount ?? 0) > 1) === true;
}

function groundedPreparationTarget(packet: WorkPacket, plan: ProbePlan, failure: ShadowReport["failures"][number]): boolean {
  const probeCase = plan.cases.find(item => item.id === failure.caseId);
  const step = probeCase?.steps[failure.stepIndex];
  if (!probeCase || !step) return false;
  const locators = "locator" in step ? [step.locator] : step.op === "drag" ? [step.from, step.to] : [];
  return locators.length > 0 && locators.every(locator => groundedLocatorNames(locator, packet).length > 0 &&
    (!locator.scope || (locator.scope.by === "role" && !locator.scope.name) ||
      groundedLocatorNames(locator.scope, packet).length > 0) && groundedControlRole(locator, packet, failure, step.op,
        isHomeEntryStep(probeCase, failure.stepIndex)));
}

function groundedControlRole(locator: ProbeLocator, packet: WorkPacket, failure: ShadowReport["failures"][number], operation: ProbeStep["op"], homeEntry: boolean): boolean {
  const declared = declaredLocatorRoles(locator, packet, operation, false, homeEntry);
  if (declared.length) return locatorCandidates(locator).every(candidate => matchesDeclaredLocatorRole(candidate, declared));
  const observed = equivalentSnapshotControls(failure, locator);
  // An existing same-named control does not justify changing its role to a
  // planner assumption. Recover the locator/prefix before diagnosing the app.
  if (observed.length) return locatorCandidates(locator).some(candidate =>
    (candidate.by === "role" && observed.includes(candidate.role)) || candidate.by === "label");
  // Displayed identity/data does not establish an undeclared interactive role
  // for a preparation assertion. Recover the prefix instead of adding a control.
  return !(failure.category === "precondition" && operation.startsWith("expect") && operation !== "expectDownload" &&
    snapshotDisplaysControlName(failure.locatorSnapshot, locator));
}

function diagnosticFailures(packet: WorkPacket, plan: ProbePlan, report: ShadowReport): ShadowReport["failures"] {
  return report.failures.filter(failure => {
    if (isLocatorAmbiguity(failure)) return false;
    if (failure.category === "precondition") return groundedPreparationTarget(packet, plan, failure);
    if (failure.category !== "locator" || !failure.locatorSnapshot) return false;
    const probeCase = plan.cases.find(item => item.id === failure.caseId);
    const step = probeCase?.steps[failure.stepIndex];
    // A prior successful interaction establishes that we reached the flow;
    // an absent initial page locator alone is not evidence against the app.
    return probeCase && step && ["click", "fill", "select", "doubleClick"].includes(step.op) && "locator" in step &&
      groundedLocatorNames(step.locator, packet).length > 0 &&
      groundedControlRole(step.locator, packet, failure, step.op, isHomeEntryStep(probeCase, failure.stepIndex)) &&
      probeCase.steps.slice(0, failure.stepIndex).some(item => ["click", "fill", "select"].includes(item.op));
  });
}

async function runShadowProbes(
  packet: WorkPacket,
  plan: ProbePlan,
  options: PipelineOptions,
  deps: PipelineDeps,
  state: RunStateStore,
  recovery: { browserRetries: number; locatorRefinements: number },
  remaining: () => number,
  policy: AuditPolicy,
): Promise<ProbeOutcome> {
  await state.record({ at: now(), type: "application_starting", packetId: packet.id });
  let application: Awaited<ReturnType<AppLifecycle["start"]>>;
  try {
    application = await deps.appLifecycle.start(
      options.outputDir,
      options.platformContract,
    );
  } catch (error) {
    await state.record({
      at: now(),
      type: "application_start_failed",
      packetId: packet.id,
      detail: { message: errorMessage(error) },
    });
    return { source: "application", report: applicationFailureReport(packet.id, error), plan };
  }

  let applicationRunning = true;
  const stopApplication = async (): Promise<void> => {
    if (!applicationRunning) return;
    try {
      await application.stop();
      await application.assertUnchanged?.();
      if (application.candidate) await deps.candidate?.assertCurrent(application.candidate);
    } finally {
      applicationRunning = false;
      await state.record({ at: now(), type: "application_stopped", packetId: packet.id });
    }
  };
  try {
    await state.record({ at: now(), type: "application_ready", packetId: packet.id,
      detail: { baseUrl: application.baseUrl, ...(application.candidate ? { candidate: application.candidate } : {}) } });
    let currentPlan = plan;
    const runOptions = { stepTimeoutMs: 2_000, caseTimeoutMs: 15_000 };
    let applicationUsed = false;
    const prepareCase = async (): Promise<string> => {
      if (remaining() <= 0) throw new Error("Audit phase budget exhausted");
      if (applicationUsed) {
        await application.assertUnchanged?.();
        await stopApplication();
        await state.record({ at: now(), type: "application_starting", packetId: packet.id });
        try {
          application = await deps.appLifecycle.start(options.outputDir, options.platformContract);
          applicationRunning = true;
        } catch (error) {
          await state.record({ at: now(), type: "application_start_failed", packetId: packet.id,
            detail: { message: errorMessage(error) } });
          throw error;
        }
        await state.record({ at: now(), type: "application_ready", packetId: packet.id,
          detail: { baseUrl: application.baseUrl, ...(application.candidate ? { candidate: application.candidate } : {}) } });
      }
      applicationUsed = true;
      return application.baseUrl;
    };
    const run = async (): Promise<ShadowReport> => {
      while (true) {
        if (remaining() <= 0) throw new Error("Audit phase budget exhausted");
        const startedAt = deps.clock.nowMs();
        await state.record({ at: now(), type: "probe_started", packetId: packet.id,
          detail: { cases: currentPlan.cases.length, retryCount: recovery.browserRetries,
            planSha256: probePlanSha256(currentPlan) } });
        try {
          const report = await deps.runner.run(currentPlan, { baseUrl: application.baseUrl, ...runOptions, prepareCase,
            caseTimeoutMs: Math.max(1, Math.min(runOptions.caseTimeoutMs, remaining())) });
          await application.assertUnchanged?.();
          if (application.candidate) report.candidate = application.candidate;
          const evidenceId = await state.saveEvidence(report, currentPlan);
          await state.record({ at: now(), type: "probe_finished", packetId: packet.id,
            detail: { verdict: report.verdict, refined: recovery.locatorRefinements > 0, passed: report.passedCases.length,
              failed: report.failures.length, durationMs: Math.max(0, deps.clock.nowMs() - startedAt),
              categories: report.failures.map((failure) => failure.category), evidenceId,
              ...(report.candidate ? { candidate: report.candidate } : {}) } });
          return report;
        } catch (error) {
          if (!(error instanceof ExecutionFault)) throw error;
          const retry = error.retryable && recovery.browserRetries < 1 &&
            remaining() > 0;
          await state.record({ at: now(), type: "execution_fault", packetId: packet.id,
            detail: { source: error.source, code: error.code, retryable: error.retryable,
              retry, attempt: packet.attempt, retryCount: recovery.browserRetries } });
          if (!retry) throw error;
          recovery.browserRetries += 1;
        }
      }
    };
    let report = await run();
    let navigationRecovered = false;
    const beforeNavigationPlan = currentPlan;
    const beforeNavigationReport = report;
    for (let attempt = 0; attempt < 2 && remaining() > 0; attempt++) {
      let searchPlan: ProbePlan | undefined;
      try { searchPlan = rootSearchNavigationPlan(packet, currentPlan, report); }
      catch (error) {
        await state.record({ at: now(), type: "execution_fault", packetId: packet.id,
          detail: { source: "judge", message: `Navigation recovery plan rejected: ${errorMessage(error)}`, retry: false } });
        break;
      }
      if (!searchPlan) break;
      const beforePlan = currentPlan;
      const previousReport = report;
      currentPlan = searchPlan;
      const searched = await run();
      navigationRecovered ||= searched.passedCases.length > previousReport.passedCases.length ||
        searched.failures.some(failure => {
          const previous = previousReport.failures.find(item => item.caseId === failure.caseId);
          const step = beforePlan.cases.find(item => item.id === failure.caseId)?.steps[previous?.stepIndex ?? -1];
          if (!step || (step.op !== "click" && step.op !== "expectVisible") ||
            step.locator.by !== "role" || step.locator.role !== "link") return false;
          const targetName = step.locator.name;
          const targetIndex = currentPlan.cases.find(item => item.id === failure.caseId)?.steps.findIndex(item =>
            item.op === step.op && item.locator.by === "role" && item.locator.name === targetName) ?? -1;
          return targetIndex >= 0 && failure.stepIndex > targetIndex;
        });
      await state.record({ at: now(), type: "probe_navigation_attempted", packetId: packet.id,
        detail: { recovered: searched.verdict === "pass", improved: navigationRecovered,
          beforePlanSha256: probePlanSha256(beforePlan),
          planSha256: probePlanSha256(searchPlan) } });
      report = searched;
    }
    if (currentPlan !== beforeNavigationPlan && !navigationRecovered) {
      return { source: "probe", report: beforeNavigationReport, plan: beforeNavigationPlan };
    }
    // Accepted navigation changes establish the baseline for locator-only
    // patches. Keep its requirement anchors across successive refinements.
    const refinementBaseline = currentPlan;
    const anchoredNames = groundedLocatorAnchors(refinementBaseline, packet);

    let feedback: ProbePlannerFeedback | undefined;
    const refinableFailures = () => report.failures.filter(failure => {
      const step = currentPlan.cases.find(item => item.id === failure.caseId)?.steps[failure.stepIndex];
      const locatorFailure = failure.category === "locator" ||
        (failure.category === "precondition" && (isLocatorAmbiguity(failure) ||
          (failure.locatorAttempts?.length && failure.locatorAttempts.every(attempt => attempt.matchCount === 0) &&
            step && "locator" in step && equivalentSnapshotControls(failure, step.locator).length > 0)));
      return locatorFailure && failure.locatorSnapshot && step && "locator" in step && locatorPatchMayHelp(failure, step);
    });
    while (policy.refineLocators &&
      report.verdict !== "pass" &&
      refinableFailures().length > 0 &&
      recovery.locatorRefinements < MAX_LOCATOR_REFINEMENTS &&
      remaining() > 0) {
      const failures = refinableFailures();
      const noProgressKey = createHash("sha256").update(JSON.stringify([
        probePlanSha256(currentPlan), failures.map(item => [item.caseId, item.stepIndex, item.locatorSnapshot]),
      ])).digest("hex");
      if (policy.noProgressRefinements?.has(noProgressKey)) break;
      const refinementAttempt = ++recovery.locatorRefinements;
      const beforePlanSha256 = probePlanSha256(currentPlan);
      let refined: ProbePlan;
      try {
        // Pass a copy so a planner implementation cannot mutate the behavior being checked.
        refined = parseProbePlan(await deps.planner.refineLocators(
          structuredClone(currentPlan), structuredClone(failures), feedback,
          { timeoutMs: Math.max(1, remaining()), anchoredNames },
        ));
        assertLocatorOnlyRefinement(currentPlan, refined, failures);
        // Keep the baseline's requirement anchors across successive refinements.
        assertLocatorOnlyRefinement(refinementBaseline, refined, [], packet);
      } catch (error) {
        if (error instanceof ExecutionFault || (error instanceof ProbePlannerError && error.fatal)) throw error;
        const detail = plannerFailureDetail(error);
        feedback = {
          validationError: String(detail.validationError ?? detail.message),
          ...(typeof detail.contentPreview === "string" ? { contentPreview: detail.contentPreview } : {}),
        };
        await state.record({ at: now(), type: "probe_refinement_failed", packetId: packet.id,
          detail: { ...detail, refinementAttempt, planSha256: beforePlanSha256 } });
        if (!(error instanceof GatewayRequestError)) {
          policy.noProgressRefinements?.add(noProgressKey);
        }
        // Rejected/unchanged patches cannot repair missing steps. Reserve the
        // remaining recovery call for reviewing the navigation and preparation.
        break;
      }
      if (remaining() <= 0) break;
      currentPlan = refined;
      feedback = undefined;
      await state.record({ at: now(), type: "probe_refined", packetId: packet.id,
        detail: { refinementAttempt, beforePlanSha256, planSha256: probePlanSha256(currentPlan) } });
      // Browser failures use their own shared quota, outside the planner error handler.
      report = await run();
    }
    return { source: "probe", report, plan: currentPlan, navigationRecovered };
  } finally {
    await stopApplication();
  }
}

const MAX_LOCATOR_REFINEMENTS = 2;

async function planProbe(
  packet: WorkPacket,
  options: PipelineOptions,
  deps: PipelineDeps,
  state: RunStateStore,
  remaining: () => number,
  retry: boolean,
): Promise<ProbePlan | undefined> {
  await state.record({ at: now(), type: "probe_planning", packetId: packet.id });
  let feedback: ProbePlannerFeedback | undefined;
  try {
    return parseProbePlan(await deps.planner.plan(packet, undefined, { timeoutMs: Math.max(1, remaining()) }), packet);
  } catch (error) {
    const cutOffByModel = isModelLengthCutoff(error);
    feedback = planValidationFeedback(error);
    await state.record({
      at: now(),
      type: !retry || (error instanceof ProbePlannerError && error.fatal && !cutOffByModel)
        ? "probe_planner_failed" : "probe_planner_retry",
      packetId: packet.id,
      detail: { ...plannerFailureDetail(error), attempt: packet.attempt, retryCount: 0 },
    });
    if (error instanceof ProbePlannerError && error.fatal && !cutOffByModel) throw error;
    if (error instanceof GatewayRequestError) throw error;
  }
  if (!retry) return undefined;
  if (remaining() <= 0) return undefined;
  const retryDelayMs = options.plannerRetryDelayMs ?? 2_000;
  if (retryDelayMs > 0) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(retryDelayMs, remaining())));
  }
  if (remaining() <= 0) return undefined;
  try {
    return parseProbePlan(await deps.planner.plan(packet, feedback, { timeoutMs: Math.max(1, remaining()) }), packet);
  } catch (error) {
    await state.record({
      at: now(),
      type: "probe_planner_failed",
      packetId: packet.id,
      detail: plannerFailureDetail(error),
    });
    if (error instanceof ProbePlannerError && error.fatal) throw error;
    if (error instanceof GatewayRequestError) throw error;
    return undefined;
  }
}

/** Retry only a cached plan's missing completeness review; never regenerate its cases. */
async function retryCoverageReview(
  packet: WorkPacket,
  plan: ProbePlan,
  deps: PipelineDeps,
  state: RunStateStore,
  remaining: () => number,
): Promise<ProbePlan | undefined> {
  if (remaining() <= 0) return undefined;
  await state.record({ at: now(), type: "probe_review_started", packetId: packet.id,
    detail: { cases: plan.cases.length, failed: 0 } });
  let feedback: ProbePlannerFeedback | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const review = await deps.planner.reviewPlan(packet, plan, [], feedback, {
        timeoutMs: Math.max(1, remaining()), coverageReview: true,
      });
      const reviewed = review.status === "corrected" ? review.plan : plan;
      await state.record({ at: now(), type: "probe_reviewed", packetId: packet.id,
        detail: { verdict: review.status, rationale: review.rationale,
          beforePlanSha256: probePlanSha256(plan),
          ...(review.status === "corrected" ? { planSha256: probePlanSha256(reviewed), corrections: review.corrections } : {}) } });
      return { ...reviewed, coverageReview: "verified" };
    } catch (error) {
      if (error instanceof GatewayRequestError ||
        (error as { gatewayFailure?: unknown } | null)?.gatewayFailure !== undefined) throw error;
      const retryFeedback = planValidationFeedback(error);
      if (retryFeedback && attempt === 0 && remaining() > 0) {
        feedback = retryFeedback;
        await state.record({ at: now(), type: "probe_planner_retry", packetId: packet.id,
          detail: { ...plannerFailureDetail(error), attempt: attempt + 1, retryCount: attempt } });
        continue;
      }
      await state.record({ at: now(), type: "probe_review_failed", packetId: packet.id,
        detail: { ...plannerFailureDetail(error), planSha256: probePlanSha256(plan) } });
      return undefined;
    }
  }
  return undefined;
}

function plannerFailureDetail(error: unknown): Record<string, unknown> {
  return error instanceof ProbePlannerError
    ? { source: "planner", ...error.diagnostics }
    : { message: errorMessage(error) };
}

function applicationFailureReport(packetId: string, error: unknown): ShadowReport {
  return {
    packetId,
    verdict: "fail",
    passedCases: [],
    failures: [
      {
        caseId: "<application>",
        stepIndex: -1,
        category: "runner",
        message: errorMessage(error),
      },
    ],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


function now(): string { return new Date().toISOString(); }
