import type { AtomicRequirement, RequirementNode } from "./types.js";

type Scenario = RequirementNode["scenarios"][number];
export type ScenarioPhase = "given" | "when" | "then" | "unassigned";

/** AND/BUT inherit their source stage; an unknown keyword has no inferred stage. */
export function scenarioStepPhases(scenario: Scenario): ScenarioPhase[] {
  let phase: ScenarioPhase = "unassigned";
  return scenario.steps.map(step => {
    const keyword = step.keyword.toUpperCase();
    if (keyword !== "AND" && keyword !== "BUT") {
      phase = keyword === "GIVEN" ? "given" : keyword === "WHEN" ? "when" : keyword === "THEN" ? "then" : "unassigned";
    }
    return phase;
  });
}

export function scenarioPhaseIndex(requirement: AtomicRequirement) {
  return (requirement.scenarioContracts ?? []).map(scenario => ({
    scenarioId: scenario.id, phases: scenarioStepPhases(scenario),
  }));
}

export interface ScenarioFact {
  phase: ScenarioPhase;
  content: string;
  sources: Array<{ scenarioId: string; stepIndex: number }>;
}

/** Exact excerpts, deduplicated only within the same phase, with every source retained. */
export function requirementScenarioFacts(requirement: AtomicRequirement): ScenarioFact[] {
  const facts = new Map<string, ScenarioFact>();
  for (const scenario of requirement.scenarioContracts ?? []) {
    const phases = scenarioStepPhases(scenario);
    scenario.steps.forEach((step, stepIndex) => {
      const phase = phases[stepIndex];
      const key = JSON.stringify([phase, step.content]);
      const fact = facts.get(key) ?? { phase, content: step.content, sources: [] };
      fact.sources.push({ scenarioId: scenario.id, stepIndex });
      facts.set(key, fact);
    });
  }
  return [...facts.values()];
}
