import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { ArtifactStore } from "../src/verifier/artifacts.js";
import { evaluateProgramEvidence, validateAcceptanceContract, verifierSourceClauses,
  type AcceptanceContract, type VerifierRequirements } from "../src/verifier/evidence.js";
import type { CheckJob, ContentRef, EvidenceReceipt, ProgramRef } from "../src/verifier/port.js";
import type { AtomicRequirement } from "../src/types.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "verifier-evidence-"));
  const store = new ArtifactStore(directory, "run");
  const schema = await store.putJson(Type.Unknown());
  const typed = (value: unknown) => store.putTypedJson(value, schema);
  const identity = { requirementId: "heap", scenarioId: "undo" };
  const requirement: AtomicRequirement = { id: "heap", name: "Undo", folderPath: [], declarationIndex: 0, text: "Undo twice",
    dependencyIds: [], scenarios: [], references: [], exactUiStrings: [], seedDeclarations: [], ancestors: [],
    product: { kind: "generic_web", rootId: "root", rootName: "root", description: "", guidance: [], seedData: [] },
    scenarioContracts: [{ id: "undo", name: "Undo twice", steps: [
      { keyword: "GIVEN", content: "Heap contains 5 and 3" },
      { keyword: "WHEN", content: "Undo once" },
      { keyword: "THEN", content: "Heap contains only 5" },
      { keyword: "AND", content: "Undo again: the heap is empty" },
    ] }] };
  const input: VerifierRequirements = { requirements: [requirement] };
  const ref = await store.putJson({});
  const job: CheckJob = { jobId: "job", runId: "run", moduleId: "m", packetId: "p", attempt: 1, moduleEpoch: 0,
    snapshot: ref, requirements: await store.putJson(input), initialState: await typed({}),
    binding: { ...ref, executor: { id: "test", version: "1", digest: "test" } }, requirementIds: ["heap"],
    mode: "discover", programs: [], timeoutMs: 1000 };
  const sources = verifierSourceClauses(input, job.requirementIds);
  const contract: AcceptanceContract = { requirements: job.requirements, checkpoints: [
    { id: "given", kind: "precondition", ...identity, basis: "Heap contains 5 and 3", dependsOn: [], expected: 2 },
    { id: "undo-once", kind: "action", ...identity, basis: "Undo once", dependsOn: ["given"] },
    { id: "first-result", kind: "assertion", ...identity, basis: sources[0]!.basis, clauseId: sources[0]!.id, dependsOn: ["undo-once"] },
    { id: "undo-again", kind: "action", ...identity, basis: "Undo again", sourceStepIndex: 3, dependsOn: ["undo-once"] },
    { id: "second-result", kind: "assertion", ...identity, basis: sources[1]!.basis, clauseId: sources[1]!.id, dependsOn: ["undo-again"] },
  ], clauses: sources.map((source, index) => ({ ...source, checkpointId: index ? "second-result" : "first-result", expected: index ? 0 : 1 })) };
  const program: ProgramRef = { descriptor: await typed({}), format: "test@1", contract: await store.putJson(contract), binding: job.binding };
  const environment = await typed({});
  const jobRef = await store.putJson(job);
  let sequence = 0;
  const refs: ContentRef[] = [];
  const receipt = async (kind: EvidenceReceipt["kind"], extras: Partial<EvidenceReceipt> = {}) => {
    const ref = await store.putReceipt(job, { id: `receipt-${sequence}`, sequence: sequence++, recordedAt: new Date().toISOString(),
      kind, job: jobRef, snapshot: job.snapshot, binding: job.binding, environment, program, inputs: [], attachments: [],
      payload: await typed({ result: "satisfied" }), ...extras });
    refs.push(ref);
    return ref;
  };
  return { store, job, input, sources, contract, program, receipt, refs,
    cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("source steps allow intermediate assertions and retain strict receipt ordering", async () => {
  const f = await fixture();
  try {
    validateAcceptanceContract(f.contract, f.job, f.sources, f.input);
    await f.receipt("readiness", { readiness: { result: "ready" } });
    const initial = await f.receipt("observation");
    await f.receipt("precondition", { checkpointId: "given", inputs: [initial] });
    await f.receipt("action", { checkpointId: "undo-once" });
    const first = await f.receipt("observation");
    await f.receipt("assertion", { checkpointId: "first-result", inputs: [first], assertion: { clauseId: f.sources[0]!.id, result: "satisfied" } });
    const last = await f.receipt("observation");
    await f.receipt("assertion", { checkpointId: "second-result", inputs: [last], assertion: { clauseId: f.sources[1]!.id, result: "satisfied" } });
    await f.receipt("action", { checkpointId: "undo-again" });
    const outcomes = await evaluateProgramEvidence(f.store, f.job, f.program, f.contract, f.refs);
    assert.deepEqual(outcomes.map(item => item.status), ["pass", "inconclusive"]);
    assert.match(outcomes[1]!.reason!, /required checkpoint receipt: undo-again/);
    const valid = f.refs.slice(0, -3);
    valid.push(f.refs.at(-1)!);
    const freshObservation = await f.receipt("observation");
    const freshAssertion = await f.receipt("assertion", { checkpointId: "second-result", inputs: [freshObservation],
      assertion: { clauseId: f.sources[1]!.id, result: "satisfied" } });
    valid.push(freshObservation, freshAssertion);
    assert.deepEqual((await evaluateProgramEvidence(f.store, f.job, f.program, f.contract, valid)).map(item => item.status), ["pass", "pass"]);
  } finally { await f.cleanup(); }
});

test("source-step validation rejects future dependencies, omitted actions and misattributed source excerpts", async () => {
  const f = await fixture();
  const validate = (contract: AcceptanceContract) => validateAcceptanceContract(contract, f.job, f.sources, f.input);
  try {
    const future = structuredClone(f.contract);
    future.checkpoints[2]!.dependsOn.push("undo-again");
    assert.throws(() => validate(future), /later source step/);
    const futureAssertion = structuredClone(f.contract);
    futureAssertion.checkpoints[2]!.dependsOn.push("second-result");
    assert.throws(() => validate(futureAssertion), /later source step/);
    const omitted = structuredClone(f.contract);
    omitted.checkpoints[4]!.dependsOn = ["undo-once"];
    assert.throws(() => validate(omitted), /dependency closure/);
    const noSetup = structuredClone(f.contract);
    noSetup.checkpoints[1]!.dependsOn = [];
    assert.throws(() => validate(noSetup), /dependency closure/);
    for (const index of [-1, 1.5, 2, 9]) {
      const wrongSource = structuredClone(f.contract);
      wrongSource.checkpoints[3]!.sourceStepIndex = index;
      assert.throws(() => validate(wrongSource), /valid sourceStepIndex/);
    }
  } finally { await f.cleanup(); }
});
