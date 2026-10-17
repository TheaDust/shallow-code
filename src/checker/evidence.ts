import type { AtomicRequirement } from "../types.js";
import { scenarioStepPhases } from "../requirement-analysis.js";
import { requirementOutcomeClauses } from "../requirement-text.js";
import type { ArtifactStore } from "./artifacts.js";
import type { CheckJob, CheckOutcome, ContentRef, EvidenceReceipt, ExecutionBindingRef, ProgramRef, TypedRef } from "./port.js";

export interface CheckerRequirements {
  requirements: AtomicRequirement[];
  prerequisites?: AtomicRequirement[];
  implementedRequirementIds?: string[];
  allRequirements?: AtomicRequirement[];
  browserEntry?: string;
}
export interface SourceClause { id: string; requirementId: string; scenarioId: string; basis: string }
export interface ContractCheckpoint {
  id: string;
  kind: "precondition" | "action" | "assertion";
  requirementId: string;
  scenarioId: string;
  clauseId?: string;
  dependsOn: string[];
  basis: string;
  expected?: unknown;
}
export interface AcceptanceContract {
  requirements: ContentRef;
  checkpoints: ContractCheckpoint[];
  clauses: Array<SourceClause & { checkpointId: string; expected: unknown }>;
}
export interface CheckerProgramDescriptor {
  source: ContentRef;
  initialState: TypedRef;
  clauses: Array<{ clauseId: string; checkpointId: string }>;
}
export interface SemanticReview {
  key: string;
  requirements: ContentRef;
  contract: ContentRef;
  program: ProgramRef;
  binding: ExecutionBindingRef;
  approved: boolean;
  reasons: string[];
  clauseIds: string[];
}
export interface CheckerManifest {
  schemaVersion: 1;
  contracts: ContentRef[];
  reviews: ContentRef[];
  receipts: ContentRef[];
  diagnostics: string[];
}
export const sameRef = (left: ContentRef, right: ContentRef): boolean => left.id === right.id && left.digest === right.digest;

/** Stable identities come from source result clauses, never the model's submitted coverage. */
export function checkerSourceClauses(input: CheckerRequirements, scope: readonly string[]): SourceClause[] {
  return input.requirements.filter(requirement => scope.includes(requirement.id)).flatMap(requirement => {
    if (requirement.scenarioContracts?.length) return requirement.scenarioContracts.flatMap(scenario => {
      const phases = scenarioStepPhases(scenario);
      return scenario.steps.flatMap((step, stepIndex) => phases[stepIndex] !== "then" ? [] :
        requirementOutcomeClauses(step.content).map((basis, index) => ({ id: `${requirement.id}:${scenario.id}:${stepIndex}:${index}`,
          requirementId: requirement.id, scenarioId: scenario.id, basis })));
    });
    return requirementOutcomeClauses(requirement.text).map((basis, index) => ({ id: `${requirement.id}:description:0:${index}`,
      requirementId: requirement.id, scenarioId: "description", basis }));
  });
}

export function validateAcceptanceContract(contract: AcceptanceContract, job: CheckJob, sources: SourceClause[], input?: CheckerRequirements): void {
  if (!sameRef(contract.requirements, job.requirements) || !Array.isArray(contract.clauses) || !Array.isArray(contract.checkpoints)) throw new Error("Invalid acceptance contract");
  const checkpoints = new Map(contract.checkpoints.map(checkpoint => [checkpoint.id, checkpoint]));
  if (checkpoints.size !== contract.checkpoints.length) throw new Error("Duplicate contract checkpoints");
  const sourceMap = new Map(sources.map(source => [source.id, source]));
  const clauses = new Set<string>();
  for (const clause of contract.clauses) {
    const source = sourceMap.get(clause.id);
    if (!source || clauses.has(clause.id) || clause.requirementId !== source.requirementId || clause.scenarioId !== source.scenarioId || clause.basis !== source.basis) throw new Error("Contract clause has no exact requirement source");
    const checkpoint = checkpoints.get(clause.checkpointId);
    if (!checkpoint || checkpoint.kind !== "assertion" || checkpoint.clauseId !== clause.id || checkpoint.requirementId !== source.requirementId || checkpoint.scenarioId !== source.scenarioId) throw new Error("Clause requires its own assertion checkpoint");
    if (clause.expected === undefined) throw new Error("Clause has no requirement expectation");
    clauses.add(clause.id);
  }
  if (!clauses.size) throw new Error("Empty acceptance contract");
  // Initial conditions and required actions are source checkpoints even if the model omits them.
  for (const requirement of input?.requirements ?? []) for (const scenario of requirement.scenarioContracts ?? []) {
    if (!contract.clauses.some(clause => clause.requirementId === requirement.id && clause.scenarioId === scenario.id)) continue;
    const phases = scenarioStepPhases(scenario);
    scenario.steps.forEach((step, index) => {
      const kind = phases[index] === "given" ? "precondition" : phases[index] === "when" ? "action" : undefined;
      if (!kind) return;
      const checkpoint = contract.checkpoints.find(item => item.requirementId === requirement.id && item.scenarioId === scenario.id
        && item.kind === kind && item.basis === step.content);
      if (!checkpoint) throw new Error("Contract omitted a source initial condition or required action");
      if (kind === "precondition" && checkpoint.expected === undefined) throw new Error("Source initial condition has no expectation");
    });
  }
  for (const checkpoint of checkpoints.values()) {
    if (!Array.isArray(checkpoint.dependsOn) || !checkpoint.basis?.trim() || !job.requirementIds.includes(checkpoint.requirementId)) throw new Error("Invalid contract checkpoint");
    for (const dependency of checkpoint.dependsOn) {
      const prerequisite = checkpoints.get(dependency);
      if (!prerequisite || prerequisite.scenarioId !== checkpoint.scenarioId || prerequisite.requirementId !== checkpoint.requirementId) throw new Error("Checkpoint dependency must belong to the same scenario");
    }
    const visit = (id: string, seen: Set<string>): void => {
      if (seen.has(id)) throw new Error("Cyclic checkpoint dependency");
      for (const dependency of checkpoints.get(id)!.dependsOn) visit(dependency, new Set([...seen, id]));
    };
    visit(checkpoint.id, new Set());
  }
  // Reject an incomplete assertion graph before any browser replay or semantic review.
  // Every source GIVEN/WHEN checkpoint in the scenario must be an ancestor of each
  // result assertion; otherwise the program can never establish the required state.
  for (const clause of contract.clauses) {
    const assertion = checkpoints.get(clause.checkpointId)!;
    const ancestors = new Set<string>();
    const collect = (id: string): void => {
      if (ancestors.has(id)) return;
      ancestors.add(id);
      checkpoints.get(id)?.dependsOn.forEach(collect);
    };
    assertion.dependsOn.forEach(collect);
    const setup = contract.checkpoints.filter(item => item.requirementId === clause.requirementId
      && item.scenarioId === clause.scenarioId && item.kind !== "assertion");
    if (setup.some(item => !ancestors.has(item.id))) {
      throw new Error(`Assertion checkpoint dependency closure omits source setup or action for ${clause.id}`);
    }
  }
}

/** Evaluate only host receipts returned by execution, from a single fresh environment. */
export async function evaluateProgramEvidence(store: ArtifactStore, job: CheckJob, program: ProgramRef,
  contract: AcceptanceContract, refs: ContentRef[]): Promise<CheckOutcome[]> {
  const jobRef = await store.putJson(job);
  const records = await Promise.all(refs.map(async ref => ({ ref, receipt: await store.getJson<EvidenceReceipt>(ref) })));
  const unique = new Set<string>();
  for (const { receipt } of records) {
    await store.validateReceipt(job, receipt);
    if (unique.has(receipt.id) || !sameRef(receipt.job, jobRef) || !sameRef(receipt.snapshot, job.snapshot) || !sameRef(receipt.binding, job.binding)) throw new Error("Evidence receipt has invalid task ownership");
    unique.add(receipt.id);
    await store.readTypedJson(receipt.environment);
    await store.readTypedJson(receipt.payload);
    for (const attachment of receipt.attachments) await store.getBytes(attachment);
    if (receipt.program && (!sameRef(receipt.program.descriptor, program.descriptor) || !sameRef(receipt.program.contract, program.contract))) throw new Error("Receipt program mismatch");
    for (const input of receipt.inputs) if (!records.some(record => sameRef(record.ref, input))) throw new Error("Receipt references an observation outside the replay");
  }
  const checkpoints = new Map(contract.checkpoints.map(checkpoint => [checkpoint.id, checkpoint]));
  const checkSatisfied = async (id: string, before: EvidenceReceipt, seen = new Set<string>()): Promise<boolean> => {
    if (seen.has(id)) return false;
    const checkpoint = checkpoints.get(id);
    if (!checkpoint) return false;
    const evidence = records.find(({ receipt }) => receipt.checkpointId === id && receipt.kind === checkpoint.kind
      && sameRef(receipt.environment, before.environment) && receipt.sequence < before.sequence);
    if (!evidence) return false;
    if (checkpoint.kind === "precondition") {
      const payload = await store.readTypedJson<{ result?: string }>(evidence.receipt.payload);
      if (payload.result !== "satisfied") return false;
      if (!evidence.receipt.inputs.length || !evidence.receipt.inputs.every(input => records.some(record => sameRef(record.ref, input)
        && record.receipt.kind === "observation" && sameRef(record.receipt.environment, evidence.receipt.environment)
        && record.receipt.sequence < evidence.receipt.sequence))) return false;
    }
    if (checkpoint.kind === "assertion" && evidence.receipt.assertion?.result !== "satisfied") return false;
    for (const dependency of checkpoint.dependsOn) if (!await checkSatisfied(dependency, evidence.receipt, new Set([...seen, id]))) return false;
    return true;
  };
  const outcomes: CheckOutcome[] = [];
  for (const clause of contract.clauses) {
    const identity = { requirementId: clause.requirementId, scenarioId: clause.scenarioId, clauseId: clause.id };
    const assertions = records.filter(({ receipt }) => receipt.kind === "assertion" && receipt.checkpointId === clause.checkpointId
      && receipt.assertion?.clauseId === clause.id && receipt.program && sameRef(receipt.program.descriptor, program.descriptor));
    if (assertions.length !== 1) {
      const dependencies = new Set<string>();
      const visit = (id: string): void => { if (dependencies.has(id)) return; dependencies.add(id); checkpoints.get(id)?.dependsOn.forEach(visit); };
      checkpoints.get(clause.checkpointId)?.dependsOn.forEach(visit);
      const failed = [];
      for (const record of records) if (record.receipt.checkpointId && dependencies.has(record.receipt.checkpointId)) {
        if (record.receipt.assertion?.result === "violated") failed.push(record.ref);
        else if (record.receipt.kind === "precondition" && (await store.readTypedJson<{ result?: string }>(record.receipt.payload)).result === "violated") failed.push(record.ref);
      }
      outcomes.push({ ...identity, status: failed.length ? "blocked" : "inconclusive", evidence: failed,
        reason: failed.length ? "Upstream checkpoint failed before this result was reached" : "Result assertion was not executed exactly once" }); continue;
    }
    const assertion = assertions[0]!;
    const readiness = records.some(({ receipt }) => receipt.kind === "readiness" && receipt.readiness?.result === "ready" && sameRef(receipt.environment, assertion.receipt.environment)
      && receipt.sequence < assertion.receipt.sequence);
    const inputs = assertion.receipt.inputs.map(input => records.find(record => sameRef(record.ref, input))!);
    const hasObservation = inputs.length > 0 && inputs.every(record => record.receipt.kind === "observation" && sameRef(record.receipt.environment, assertion.receipt.environment)
      && record.receipt.sequence < assertion.receipt.sequence);
    const checkpoint = checkpoints.get(clause.checkpointId)!;
    let prerequisites = true;
    for (const dependency of checkpoint.dependsOn) if (!await checkSatisfied(dependency, assertion.receipt)) prerequisites = false;
    // Every source setup and action in this scenario must be represented in the assertion dependency graph.
    const ancestors = new Set<string>();
    const collect = (id: string): void => { if (ancestors.has(id)) return; ancestors.add(id); checkpoints.get(id)?.dependsOn.forEach(collect); };
    checkpoint.dependsOn.forEach(collect);
    const setup = contract.checkpoints.filter(item => item.scenarioId === clause.scenarioId && item.requirementId === clause.requirementId && item.kind !== "assertion");
    if (setup.some(item => !ancestors.has(item.id))) prerequisites = false;
    const evidence = records.filter(record => sameRef(record.receipt.environment, assertion.receipt.environment)).map(record => record.ref);
    if (!readiness || !hasObservation) outcomes.push({ ...identity, status: "inconclusive", evidence, reason: "Missing readiness or host observation" });
    else if (!prerequisites) outcomes.push({ ...identity, status: "blocked", evidence, reason: "Required setup or action checkpoint did not succeed" });
    else outcomes.push({ ...identity, status: assertion.receipt.assertion!.result === "satisfied" ? "pass" : "fail", evidence,
      ...(assertion.receipt.assertion!.result === "violated" ? { reason: "Fresh replay violated the requirement; independent reproduction required" } : {}) });
  }
  return outcomes;
}
