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
}
export interface SourceClause { id: string; requirementId: string; scenarioId: string; basis: string }
export interface ContractCheckpoint {
  id: string;
  kind: "precondition" | "action" | "condition" | "assertion";
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
  feedback?: ContentRef[];
  unsupported?: UnsupportedClause[];
}
export interface UnsupportedClause { clauseId: string; reason: string; attempts: string[]; retryable?: boolean }
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
  if (new Set(contract.clauses.map(clause => JSON.stringify([clause.requirementId, clause.scenarioId]))).size !== 1) {
    throw new Error("Each program must cover one requirement scenario; save separate contracts and programs for independent cases");
  }
  // Initial conditions and required actions are source checkpoints even if the model omits them.
  for (const requirement of input?.requirements ?? []) for (const scenario of requirement.scenarioContracts ?? []) {
    if (!contract.clauses.some(clause => clause.requirementId === requirement.id && clause.scenarioId === scenario.id)) continue;
    const phases = scenarioStepPhases(scenario);
    scenario.steps.forEach((step, index) => {
      const phase = phases[index];
      if (phase !== "given" && phase !== "when") return;
      const checkpoint = contract.checkpoints.find(item => item.requirementId === requirement.id && item.scenarioId === scenario.id
        && item.basis === step.content
        && (phase === "given" ? item.kind === "precondition" : item.kind === "action" || item.kind === "condition"));
      if (!checkpoint) throw new Error(`${phase === "given" ? "Contract omitted a source initial condition" : "Contract omitted a source action or condition"} for requirementId=${requirement.id}, scenarioId=${scenario.id}, phase=${phase}, step=${JSON.stringify(step.content)}`);
      if (phase === "given" && checkpoint.expected === undefined) throw new Error(`Source initial condition has no expectation for requirementId=${requirement.id}, scenarioId=${scenario.id}, phase=${phase}, step=${JSON.stringify(step.content)}`);
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
      throw new Error(`Assertion checkpoint dependency closure omits source setup, action, or condition for ${clause.id}`);
    }
  }
}

/**
 * Evaluate only host receipts returned by execution, from a single fresh environment.
 * Action WHEN checkpoints require an action receipt; condition WHEN checkpoints are state
 * transitions and are proven by the result assertion's own observations.
 */
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
  const receiptFor = (checkpoint: ContractCheckpoint, before: EvidenceReceipt): { ref: ContentRef; receipt: EvidenceReceipt } | undefined =>
    records.find(({ receipt }) => receipt.checkpointId === checkpoint.id && receipt.kind === checkpoint.kind
      && sameRef(receipt.environment, before.environment) && receipt.sequence < before.sequence);
  const resultOf = async (record: { ref: ContentRef; receipt: EvidenceReceipt }): Promise<string | undefined> =>
    (await store.readTypedJson<{ result?: string }>(record.receipt.payload)).result;
  const hasObservationInputs = async (record: { ref: ContentRef; receipt: EvidenceReceipt }): Promise<boolean> =>
    record.receipt.inputs.length > 0 && record.receipt.inputs.every(input => records.some(item => sameRef(item.ref, input)
      && item.receipt.kind === "observation" && sameRef(item.receipt.environment, record.receipt.environment)
      && item.receipt.sequence < record.receipt.sequence));
  const outcomes: CheckOutcome[] = [];
  for (const clause of contract.clauses) {
    const identity = { requirementId: clause.requirementId, scenarioId: clause.scenarioId, clauseId: clause.id };
    const assertions = records.filter(({ receipt }) => receipt.kind === "assertion" && receipt.checkpointId === clause.checkpointId
      && receipt.assertion?.clauseId === clause.id && receipt.program && sameRef(receipt.program.descriptor, program.descriptor));
    if (assertions.length !== 1) {
      outcomes.push({ ...identity, status: "inconclusive", evidence: assertions.map(item => item.ref),
        reason: "Result assertion was not executed exactly once" });
      continue;
    }
    const assertion = assertions[0]!;
    const readiness = records.some(({ receipt }) => receipt.kind === "readiness" && receipt.readiness?.result === "ready"
      && sameRef(receipt.environment, assertion.receipt.environment) && receipt.sequence < assertion.receipt.sequence);
    const inputs = assertion.receipt.inputs.map(input => records.find(record => sameRef(record.ref, input)));
    if (!readiness || inputs.length === 0 || inputs.some(record => !record || record.receipt.kind !== "observation"
      || !sameRef(record.receipt.environment, assertion.receipt.environment) || record.receipt.sequence >= assertion.receipt.sequence)) {
      outcomes.push({ ...identity, status: "inconclusive", evidence: [assertion.ref], reason: "Missing readiness or host observation" });
      continue;
    }
    const checkpoint = checkpoints.get(clause.checkpointId)!;
    const requiredIds = new Set<string>();
    const pending = [...checkpoint.dependsOn];
    while (pending.length) {
      const id = pending.pop()!;
      if (requiredIds.has(id)) continue;
      requiredIds.add(id);
      pending.push(...(checkpoints.get(id)?.dependsOn ?? []));
    }
    const required = contract.checkpoints.filter(item => requiredIds.has(item.id));
    const missing: string[] = [];
    const failed: string[] = [];
    const unproven: string[] = [];
    const evidence = [assertion.ref, ...assertion.receipt.inputs];
    for (const dependency of required) {
      // A condition is a state transition; the assertion's own observations prove it was reached.
      if (dependency.kind === "condition") continue;
      const record = receiptFor(dependency, assertion.receipt);
      if (!record) { missing.push(dependency.id); continue; }
      evidence.push(record.ref);
      if (dependency.kind === "precondition") {
        if (await resultOf(record) !== "satisfied") failed.push(dependency.id);
        else if (!await hasObservationInputs(record)) unproven.push(`${dependency.id} (no observation input)`);
      } else if (dependency.kind === "assertion" && record.receipt.assertion?.result !== "satisfied") failed.push(dependency.id);
    }
    for (const dependency of required) {
      const dependent = receiptFor(dependency, assertion.receipt);
      if (!dependent) continue;
      for (const prerequisite of dependency.dependsOn) {
        const point = checkpoints.get(prerequisite);
        if (!point || point.kind === "condition") continue;
        if (!receiptFor(point, dependent.receipt)) unproven.push(`${dependency.id} requires earlier ${prerequisite}`);
      }
    }
    if (missing.length) outcomes.push({ ...identity, status: "inconclusive", evidence,
      reason: `Program did not record required checkpoint receipt: ${missing.join(", ")}` });
    else if (failed.length) outcomes.push({ ...identity, status: "blocked", evidence,
      reason: `Required checkpoint did not succeed: ${failed.join(", ")}` });
    else if (unproven.length) outcomes.push({ ...identity, status: "inconclusive", evidence,
      reason: `Evidence chain is incomplete: ${unproven.join(", ")}` });
    else outcomes.push({ ...identity, status: assertion.receipt.assertion!.result === "satisfied" ? "pass" : "fail", evidence,
      ...(assertion.receipt.assertion!.result === "violated" ? { reason: "Fresh replay violated the requirement; independent reproduction required" } : {}) });
  }
  return outcomes;
}
