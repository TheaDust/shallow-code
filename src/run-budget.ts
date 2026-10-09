export type PipelinePhase = "implementation" | "audit" | "repair" | "delivery";
const PHASE_END = { implementation: 0.6, audit: 0.8, repair: 0.95, delivery: 1 } as const;

/** Unused time carries forward; each phase leaves the remaining phases their reserve. */
export class RunBudget {
  constructor(private readonly totalMs: number, private readonly startedAt: number, private readonly now: () => number) {}
  remaining(phase: PipelinePhase): number {
    return this.totalMs <= 0 ? Infinity : Math.max(0, this.startedAt + this.totalMs * PHASE_END[phase] - this.now());
  }
  callTimeout(phase: PipelinePhase, ceilingMs: number): number {
    return Math.floor(Math.min(ceilingMs, this.remaining(phase)));
  }
}
