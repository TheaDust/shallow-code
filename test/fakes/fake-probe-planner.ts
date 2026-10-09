import type { ProbePlanner, ProbePlannerFeedback, ProbeRefinementOptions } from "../../src/judge/llm-probe-planner.js";
import type { ProbePlan } from "../../src/judge/probe-schema.js";
import type { PlanReview } from "../../src/judge/semantic-review.js";
import type { ProbeFailure, WorkPacket } from "../../src/types.js";
import { scenarioOutcomes } from "../../src/judge/probe-coverage.js";

export class FakeProbePlanner implements ProbePlanner {
  readonly packets: WorkPacket[] = [];
  readonly refinements: Array<{ original: ProbePlan; failures: ProbeFailure[]; feedback?: ProbePlannerFeedback; anchoredNames?: readonly string[] }> = [];
  readonly reviews: Array<{ plan: ProbePlan; failures: ProbeFailure[] }> = [];
  private planIndex = 0;

  constructor(private readonly plans: ProbePlan[]) {}

  async plan(packet: WorkPacket): Promise<ProbePlan> {
    this.packets.push(packet);
    const plan = this.plans[this.planIndex] ?? this.plans.at(-1);
    this.planIndex += 1;
    if (!plan) throw new Error("FakeProbePlanner has no plan");
    const copy = structuredClone(plan);
    for (const item of copy.cases) {
      if (item.outcomeChecks) continue;
      const outcomes = scenarioOutcomes(packet.requirements.filter(requirement => item.requirementIds.includes(requirement.id)));
      if (outcomes.length) item.outcomeChecks = outcomes.map(outcome => ({ scenarioId: outcome.scenarioId, stepIndex: outcome.stepIndex,
        assertionIndexes: [item.steps.length - (item.setupStepCount ?? 0) - 1] }));
    }
    return copy;
  }

  async refineLocators(original: ProbePlan, failures: ProbeFailure[], feedback?: ProbePlannerFeedback, options?: ProbeRefinementOptions): Promise<ProbePlan> {
    this.refinements.push({ original: structuredClone(original), failures: structuredClone(failures), feedback, anchoredNames: options?.anchoredNames });
    const plan = this.plans[this.planIndex] ?? this.plans.at(-1);
    this.planIndex += 1;
    if (!plan) throw new Error("FakeProbePlanner has no refinement plan");
    return structuredClone(plan);
  }

  async reviewPlan(_packet: WorkPacket, original: ProbePlan, failures: ProbeFailure[]): Promise<PlanReview> {
    this.reviews.push({ plan: structuredClone(original), failures: structuredClone(failures) });
    return { status: "sound", rationale: "fake semantic review: plan is grounded" };
  }
}
