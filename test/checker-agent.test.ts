import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { CheckerCleanupError, createCheckerAgent, createPiCheckerModel } from "../src/checker/agent.js";
import { ArtifactStore } from "../src/checker/artifacts.js";
import { type AcceptanceContract, type CheckerManifest, type CheckerRequirements, type SourceClause } from "../src/checker/evidence.js";
import type { CheckerModel, CheckerModelRequest, CheckerModelUsage } from "../src/checker/model.js";
import type { AdapterDeclaration, CheckerProgress, CheckJob, ContentRef, EvidenceReceipt, ExecutionAdapter, ExecutionBinding, ExecutionBindingRef, ProgramRef } from "../src/checker/port.js";
import type { AtomicRequirement } from "../src/types.js";

async function fixture(config: { failures?: number[]; omitSecond?: boolean; rejectReview?: boolean; source?: string; forgeInput?: boolean; dependencies?: string[]; omitSetup?: boolean; omitDependency?: boolean; failPrecondition?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "checker-agent-"));
  const store = new ArtifactStore(directory, "run-1");
  const schema = await store.putJson(Type.Unknown());
  const typed = (value: unknown) => store.putTypedJson(value, schema);
  const initialState = await typed({ mode: "empty" });
  const executor = { id: "fake-host", version: "1", digest: "host-v1" };
  const declaration: AdapterDeclaration = { schemaVersion: 1, id: "fake", version: "1", implementation: executor,
    execution: await typed({}), initialStates: [initialState], resourceKeys: [], capabilities: [{ id: "inspect", version: "1", description: "observe", inputSchema: schema, outputSchema: schema }],
    programFormat: { id: "fake.javascript", version: "1", schema, mediaType: "text/javascript" }, observations: [], attachments: [], prompts: [] };
  const bindingContent: ExecutionBinding = { schemaVersion: 1, declaration: await store.putJson(declaration), executor, schemas: [schema], dependencies: {}, promptDigest: "test-prompts" };
  const binding: ExecutionBindingRef = { ...await store.putJson(bindingContent), executor };
  const requirement: AtomicRequirement = { id: "r1", folderPath: [], declarationIndex: 0, name: "Cancel order", text: "Cancellation persists.", guidance: ["Implementation-only guidance"], dependencyIds: config.dependencies ?? [],
    scenarios: [], scenarioContracts: [{ id: "cancel", name: "Cancellation", steps: [{ keyword: "GIVEN", content: "Order is unpaid" },
      { keyword: "WHEN", content: "Cancel the order" }, { keyword: "THEN", content: "Order is cancelled and seats are restored" }] }], references: [], exactUiStrings: [], seedDeclarations: [], ancestors: [],
    product: { kind: "generic_web", rootId: "root", rootName: "root", description: "", guidance: ["Root implementation guidance"], seedData: [] } };
  const input: CheckerRequirements = { requirements: [requirement], implementedRequirementIds: [] };
  const job: CheckJob = { jobId: "job-1", runId: store.runId, moduleId: "module", packetId: "packet", attempt: 1, moduleEpoch: 1,
    snapshot: await store.putJson({ sha: "source-1" }), requirements: await store.putJson(input), binding, initialState,
    requirementIds: ["r1"], mode: "discover", programs: [], budget: { deadlineAt: Date.now() + 30_000, maxModelTokens: 100_000 } };
  let environments = 0, closed = 0, replays = 0;
  const roles: string[] = [];
  const reviewPrompts: string[] = [];
  const explorationPrompts: string[] = [];
  const toolSchemas: Array<{ role: string; name: string; parameters: unknown }> = [];
  const adapter: ExecutionAdapter = { binding, async prepare(currentJob) {
    const environment = await typed({ instance: ++environments });
    const jobRef = await store.putJson(currentJob);
    let sequence = 0;
    const receipt = async (kind: EvidenceReceipt["kind"], payload: unknown, extras: Partial<EvidenceReceipt> = {}): Promise<ContentRef> => store.putReceipt(currentJob, {
      id: `${currentJob.jobId}:${environments}:${sequence}`, job: jobRef, snapshot: currentJob.snapshot, binding, environment,
      sequence: sequence++, recordedAt: new Date().toISOString(), kind, inputs: [], payload: await typed(payload), attachments: [], ...extras });
    const readiness = await receipt("readiness", {}, { readiness: { result: "ready" } });
    return { execution: environment, readinessEvidence: [readiness],
      async invoke() { return { output: await typed({ text: "Unpaid" }), receipts: [] }; },
      async replay(program) {
        const fail = config.failures?.includes(replays);
        replays++;
        const contract = await store.getJson<AcceptanceContract>(program.contract);
        const refs: ContentRef[] = [];
        const initialObservation = await receipt("observation", { value: "unpaid" }, { program });
        refs.push(initialObservation);
        refs.push(await receipt("precondition", { result: config.failPrecondition ? "violated" : "satisfied" }, { program, checkpointId: "given", inputs: [initialObservation] }));
        refs.push(await receipt("action", {}, { program, checkpointId: "when" }));
        for (const clause of contract.clauses) {
          const observation = await receipt("observation", { value: fail && clause.id.endsWith(":1") ? 4 : 5 }, { program });
          if (!config.forgeInput) refs.push(observation);
          refs.push(await receipt("assertion", {}, { program, checkpointId: clause.checkpointId, inputs: [observation],
            assertion: { clauseId: clause.id, result: fail && clause.id.endsWith(":1") ? "violated" : "satisfied" } }));
        }
        return refs;
      }, async close() { closed++; },
    };
  } };
  const model: CheckerModel = { async run(request) {
    roles.push(request.role);
    for (const tool of request.tools) toolSchemas.push({ role: request.role, name: tool.name, parameters: tool.parameters });
    if (request.role === "semantic_review") reviewPrompts.push(request.prompt);
    else explorationPrompts.push(request.prompt);
    const tool = (name: string, args: unknown) => request.tools.find(item => item.name === name)!.execute(args);
    const promptInput = JSON.parse(request.prompt) as { sourceClauses: SourceClause[]; contract?: AcceptanceContract };
    const clauses = (request.role === "semantic_review" ? promptInput.contract!.clauses : promptInput.sourceClauses).slice(0, config.omitSecond ? 1 : undefined);
    if (request.role === "semantic_review") {
      assert.deepEqual(request.tools.map(item => item.name), ["finish"]);
      await tool("finish", { approved: !config.rejectReview, reasons: config.rejectReview ? ["Constant predicate does not test source result"] : [], clauseIds: clauses.map(item => item.id) });
    } else {
      assert.deepEqual(request.tools.map(item => item.name), ["invoke", "save_artifact", "finish"]);
      await assert.rejects(tool("invoke", { capabilityId: "shell", input: {} }), /Undeclared/);
      await tool("invoke", { capabilityId: "inspect", input: {} });
      const contract: AcceptanceContract = { requirements: job.requirements,
        checkpoints: [{ id: "given", kind: "precondition", requirementId: "r1", scenarioId: "cancel", dependsOn: [], basis: "Order is unpaid", expected: { operator: "equal", value: "unpaid" } },
          { id: "when", kind: "action", requirementId: "r1", scenarioId: "cancel", dependsOn: ["given"], basis: "Cancel the order" },
          ...clauses.map((clause, index) => ({ id: `result-${index}`, kind: "assertion" as const, clauseId: clause.id, requirementId: clause.requirementId, scenarioId: clause.scenarioId, dependsOn: config.omitDependency ? [] : ["when"], basis: clause.basis }))],
        clauses: clauses.map((clause, index) => ({ ...clause, checkpointId: `result-${index}`, expected: { operator: "equal", value: 5 } })) };
      if (config.omitSetup) {
        contract.checkpoints = contract.checkpoints.filter(item => item.kind === "assertion");
        contract.checkpoints.forEach(item => { item.dependsOn = []; });
      }
      const contractRef = await tool("save_artifact", { kind: "contract", contract });
      const program = await tool("save_artifact", { kind: "program", contract: contractRef, source: config.source ?? "await check.expect('source-result', [observation.id]);",
        clauses: contract.clauses.map(clause => ({ clauseId: clause.id, checkpointId: clause.checkpointId })) });
      await tool("finish", { programs: [program] });
    }
    return { totalTokens: 100 };
  } };
  return { directory, store, job, adapter, model, roles, reviewPrompts, explorationPrompts, toolSchemas, get environments() { return environments; }, get closed() { return closed; }, get replays() { return replays; },
    checker: createCheckerAgent({ artifacts: store, adapter, model }), cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("Checker discovers, replays, independently reviews and reproduces one failed AND clause", async () => {
  const f = await fixture({ failures: [0, 1] });
  try {
    const report = await f.checker.check(f.job, new AbortController().signal);
    assert.deepEqual(report.outcomes.map(item => item.status), ["pass", "fail"]);
    assert.match(report.outcomes[1]!.reason!, /independent fresh environment/);
    assert.deepEqual(f.roles, ["exploration", "semantic_review"]);
    assert.equal(f.environments, 3); assert.equal(f.closed, 3);
    const manifest = await f.store.getJson<CheckerManifest>(report.manifest);
    assert.equal(manifest.reviews.length, 1); assert.equal(manifest.diagnostics.length, 0);
  } finally { await f.cleanup(); }
});

test("Checker keeps an unreproduced violation inconclusive", async () => {
  const f = await fixture({ failures: [0] });
  try {
    const report = await f.checker.check(f.job, new AbortController().signal);
    assert.deepEqual(report.outcomes.map(item => item.status), ["pass", "inconclusive"]);
    assert.match(report.outcomes[1]!.reason!, /did not reproduce/);
  } finally { await f.cleanup(); }
});

test("Checker tool schemas keep an object root because the gateway rejects a root union", async () => {
  const f = await fixture({ failures: [0] });
  try {
    await f.checker.check(f.job, new AbortController().signal);
    assert.deepEqual([...new Set(f.toolSchemas.map(item => item.role))].sort(), ["exploration", "semantic_review"]);
    for (const tool of f.toolSchemas) {
      const schema = tool.parameters as Record<string, unknown>;
      assert.equal(schema.type, "object", `${tool.role}/${tool.name} must declare an object root`);
      for (const keyword of ["anyOf", "oneOf", "allOf"]) assert.equal(schema[keyword], undefined, `${tool.role}/${tool.name} must not use a root ${keyword}`);
    }
    const save = f.toolSchemas.find(item => item.name === "save_artifact")!;
    assert.deepEqual(Object.keys((save.parameters as { properties: Record<string, unknown> }).properties).sort(),
      ["clauses", "contract", "kind", "source"]);
    assert.deepEqual((save.parameters as { required: string[] }).required, ["kind", "contract"]);
  } finally { await f.cleanup(); }
});

test("Checker reports replay, independent review, confirmation and cached approval at their actual stages", async () => {
  const f = await fixture({ failures: [0, 1] });
  const events: CheckerProgress[] = [];
  try {
    const first = await f.checker.check(f.job, new AbortController().signal, async progress => { events.push(progress); });
    const stages = events.map(item => item.stage);
    assert(stages.indexOf("exploration") < stages.indexOf("replay"));
    assert(stages.indexOf("replay") < stages.indexOf("semantic_review"));
    assert(stages.indexOf("review_approved") < stages.indexOf("confirmation"));
    assert.equal(stages.at(-1), "cleanup");
    assert.deepEqual(events.find(item => item.stage === "confirmation")!.clauseIds, [first.outcomes[1]!.clauseId]);
    events.length = 0;
    await f.checker.check({ ...f.job, jobId: "cached", mode: "replay", programs: first.programs }, new AbortController().signal,
      async progress => { events.push(progress); });
    assert(events.some(item => item.stage === "replay"));
    assert(events.some(item => item.stage === "review_cached" && item.cached && item.programId === first.programs[0]!.descriptor.id));
    assert(!events.some(item => item.stage === "semantic_review" || item.stage === "exploration"));
  } finally { await f.cleanup(); }
});

test("progress sink failures cannot change evidence or prevent environment cleanup", async () => {
  const f = await fixture();
  try {
    const report = await f.checker.check(f.job, new AbortController().signal, async () => { throw new Error("Presentation unavailable"); });
    assert(report.outcomes.every(item => item.status === "pass"));
    assert.equal(f.closed, f.environments);
  } finally { await f.cleanup(); }
});

test("Checker never grants missing source AND clause through submitted coverage", async () => {
  const f = await fixture({ omitSecond: true });
  try {
    const report = await f.checker.check(f.job, new AbortController().signal);
    assert.deepEqual(report.outcomes.map(item => item.status), ["pass", "inconclusive"]);
    assert.match(report.outcomes[1]!.reason!, /No reviewed program/);
  } finally { await f.cleanup(); }
});

test("Checker rejects fabricated observations and independent semantic rejection", async t => {
  for (const config of [{ forgeInput: true }, { rejectReview: true }]) await t.test(JSON.stringify(config), async () => {
    const f = await fixture(config);
    try {
      const report = await f.checker.check(f.job, new AbortController().signal);
      assert(report.outcomes.every(item => item.status === "inconclusive"));
      assert(report.outcomes.some(item => /outside the replay|Semantic review rejected/.test(item.reason!)));
    } finally { await f.cleanup(); }
  });
});

test("Checker rejects an incomplete dependency closure before replay and review", async () => {
  const f = await fixture({ omitDependency: true });
  try {
    const report = await f.checker.check(f.job, new AbortController().signal);
    const manifest = await f.store.getJson<CheckerManifest>(report.manifest);
    assert.equal(f.environments, 1, "exploration readiness is the only environment needed to reject the contract");
    assert.deepEqual(f.roles, ["exploration"]);
    assert.equal(f.reviewPrompts.length, 0);
    assert(report.outcomes.every(item => item.status === "inconclusive"));
    assert.match(manifest.diagnostics.join(" "), /dependency closure/);
  } finally { await f.cleanup(); }
});

test("Checker semantic review payload is scoped and stably ordered", async () => {
  const f = await fixture();
  try {
    await f.checker.check(f.job, new AbortController().signal);
    const payload = JSON.parse(f.reviewPrompts[0]!);
    assert.deepEqual(Object.keys(payload), ["requirements", "sourceClauses", "capabilities", "contract", "descriptor", "source", "receipts"]);
    assert.equal(payload.requirements.length, 1);
    assert.equal(payload.requirements[0].guidance, undefined);
    assert.equal(payload.requirements[0].product.guidance, undefined);
    assert.equal(payload.receipts[0].receipt.job, undefined);
    assert.equal(payload.receipts[0].receipt.attachments, undefined);
    assert.equal(payload.receipts[0].receipt.recordedAt, undefined);
  } finally { await f.cleanup(); }
});

test("Checker rediscovers only missing clauses on replay and replaces incompatible requirement contracts", async () => {
  const f = await fixture({ omitSecond: true });
  try {
    const first = await f.checker.check(f.job, new AbortController().signal);
    const second = await f.checker.check({ ...f.job, jobId: "partial-replay", mode: "replay", programs: first.programs }, new AbortController().signal);
    assert(second.outcomes.every(outcome => outcome.status === "pass"));
    assert.equal(second.programs.length, 2);
    assert.deepEqual(f.roles, ["exploration", "semantic_review", "exploration", "semantic_review"]);
    const original = await f.store.getJson<CheckerRequirements>(f.job.requirements);
    const changedInput = await f.store.putJson({ ...original, browserEntry: "/new-entry" });
    const third = await f.checker.check({ ...f.job, jobId: "changed-input", requirements: changedInput, mode: "replay", programs: second.programs }, new AbortController().signal);
    assert.equal(third.programs.length, 1);
    const manifest = await f.store.getJson<CheckerManifest>(third.manifest);
    assert(manifest.diagnostics.some(message => /requires rediscovery/.test(message)));
    assert.equal(f.roles.filter(role => role === "exploration").length, 3);
  } finally { await f.cleanup(); }
});

test("controlled preparation failure preserves actual readiness diagnostics for the controller", async () => {
  const f = await fixture();
  try {
    const actual = await f.adapter.prepare(f.job, new AbortController().signal);
    const ready = await f.store.getJson<EvidenceReceipt>(actual.readinessEvidence[0]!);
    await actual.close();
    const failed = await f.store.putReceipt(f.job, { ...ready, id: "failed-readiness", readiness: { result: "failed" } });
    const checker = createCheckerAgent({ artifacts: f.store, model: f.model, adapter: { binding: f.job.binding, async prepare() {
      const error = new Error("Application startup failed") as Error & { readinessEvidence: ContentRef[] };
      error.readinessEvidence = [failed]; throw error;
    } } });
    const report = await checker.check(f.job, new AbortController().signal);
    const manifest = await f.store.getJson<CheckerManifest>(report.manifest);
    assert.deepEqual(manifest.receipts, [failed]);
    assert.match(manifest.diagnostics.join(" "), /Application startup failed/);
    assert(report.outcomes.every(outcome => outcome.status === "inconclusive"));
  } finally { await f.cleanup(); }
});

test("Checker replays reusable programs without another model session and invalidates changed source", async () => {
  const f = await fixture();
  try {
    const first = await f.checker.check(f.job, new AbortController().signal);
    assert(first.outcomes.every(item => item.status === "pass"));
    const second = await f.checker.check({ ...f.job, jobId: "job-2", mode: "replay", programs: first.programs }, new AbortController().signal);
    assert(second.outcomes.every(item => item.status === "pass"));
    assert.deepEqual(f.roles, ["exploration", "semantic_review"]);
    const descriptor = await f.store.readTypedJson<{ source: ContentRef }>(first.programs[0]!.descriptor);
    const modified = { ...await f.store.readTypedJson<Record<string, unknown>>(first.programs[0]!.descriptor), source: await f.store.putBytes("// changed\n" + (await f.store.getBytes(descriptor.source)).toString()) };
    const changed: ProgramRef = { ...first.programs[0]!, descriptor: await f.store.putTypedJson(modified, first.programs[0]!.descriptor.schema) };
    await f.checker.check({ ...f.job, jobId: "job-3", mode: "replay", programs: [changed] }, new AbortController().signal);
    assert.deepEqual(f.roles, ["exploration", "semantic_review", "semantic_review"]);
  } finally { await f.cleanup(); }
});

test("Checker keeps unavailable dependencies blocked and prepares without model calls", async () => {
  const f = await fixture({ dependencies: ["future-feature"] });
  try {
    const blocked = await f.checker.check(f.job, new AbortController().signal);
    assert(blocked.outcomes.every(item => item.status === "blocked")); assert.equal(f.environments, 0);
    const readiness = await f.checker.check({ ...f.job, mode: "prepare" }, new AbortController().signal);
    assert.equal(readiness.outcomes.length, 0); assert.equal(f.environments, 1); assert.equal(f.closed, 1); assert.deepEqual(f.roles, []);
  } finally { await f.cleanup(); }
});

test("source GIVEN/WHEN omissions cannot claim an initial state and failed setup blocks results", async t => {
  for (const config of [{ omitSetup: true }, { failPrecondition: true }]) await t.test(JSON.stringify(config), async () => {
    const f = await fixture(config);
    try {
      const report = await f.checker.check(f.job, new AbortController().signal);
      assert(report.outcomes.every(item => item.status === (config.omitSetup ? "inconclusive" : "blocked")));
      if (config.omitSetup) assert.match(report.outcomes[0]!.reason!, /omitted a source initial condition/);
    } finally { await f.cleanup(); }
  });
});

test("rejected programs survive restart as feedback and cannot be replayed or resubmitted unchanged", async () => {
  const f = await fixture({ rejectReview: true });
  try {
    const first = await f.checker.check(f.job, new AbortController().signal);
    const checker = createCheckerAgent({ artifacts: new ArtifactStore(f.directory, f.store.runId), adapter: f.adapter, model: f.model });
    const progress: CheckerProgress[] = [];
    const second = await checker.check({ ...f.job, jobId: "job-retry", mode: "replay", programs: first.programs }, new AbortController().signal,
      async detail => { progress.push(detail); });
    assert(progress.some(item => item.stage === "review_rejected" && item.cached && item.reason?.includes("Constant predicate")));
    assert(progress.some(item => item.stage === "rediscovery"));
    assert(progress.some(item => item.stage === "diagnostic"));
    assert(!progress.some(item => item.stage === "replay" || item.stage === "semantic_review"));
    assert.deepEqual(f.roles, ["exploration", "semantic_review", "exploration"]);
    assert.equal(f.replays, 1, "the rejected program is not replayed again");
    assert.equal(f.environments, 3, "retry prepares only an exploration environment");
    assert.equal(f.closed, f.environments);
    assert(second.outcomes.every(item => item.status === "inconclusive"));
    assert.match(second.outcomes[0]!.reason!, /Program was rejected.*Constant predicate/);
    const feedback = JSON.parse(f.explorationPrompts[1]!).rejectedPrograms;
    assert.deepEqual(feedback.map((item: { program: ProgramRef }) => item.program), first.programs);
    assert.deepEqual(feedback[0].reasons, ["Constant predicate does not test source result"]);
    assert.deepEqual(feedback[0].clauseIds, first.outcomes.map(item => item.clauseId));
    assert.equal(feedback[0].source, "await check.expect('source-result', [observation.id]);");
    const firstManifest = await f.store.getJson<CheckerManifest>(first.manifest);
    const secondManifest = await f.store.getJson<CheckerManifest>(second.manifest);
    assert.deepEqual(secondManifest.reviews, firstManifest.reviews);
  } finally { await f.cleanup(); }
});

test("rejected coverage is rediscovered, revised programs are reviewed, and approved replacements are reused", async () => {
  const config = { rejectReview: true, omitSecond: true, source: "// rejected test" };
  const f = await fixture(config);
  try {
    const first = await f.checker.check(f.job, new AbortController().signal);
    config.rejectReview = false; config.omitSecond = false; config.source = "// revised test";
    const second = await f.checker.check({ ...f.job, jobId: "module-boundary", mode: "replay", programs: first.programs,
      snapshot: await f.store.putJson({ sha: "source-2" }) }, new AbortController().signal);
    assert(second.outcomes.every(item => item.status === "pass"));
    assert.deepEqual(JSON.parse(f.explorationPrompts[1]!).sourceClauses.map((item: SourceClause) => item.id), first.outcomes.map(item => item.clauseId));
    assert.equal(second.programs.length, 2, "history retains the rejected attempt alongside its replacement");
    assert.deepEqual(f.roles, ["exploration", "semantic_review", "exploration", "semantic_review"]);
    assert.equal(f.replays, 2, "only the replacement is replayed during rediscovery");
    const third = await f.checker.check({ ...f.job, jobId: "final", mode: "replay", programs: second.programs }, new AbortController().signal);
    assert(third.outcomes.every(item => item.status === "pass"));
    assert.equal(f.roles.length, 4, "final replay reuses the replacement review");
    assert.equal(f.replays, 3);
  } finally { await f.cleanup(); }
});

test("changed requirement context invalidates a cached rejection", async () => {
  const config = { rejectReview: true };
  const f = await fixture(config);
  try {
    const first = await f.checker.check(f.job, new AbortController().signal);
    config.rejectReview = false;
    const input = await f.store.getJson<CheckerRequirements>(f.job.requirements);
    const second = await f.checker.check({ ...f.job, jobId: "changed-context", mode: "replay", programs: first.programs,
      requirements: await f.store.putJson({ ...input, browserEntry: "/new-entry" }) }, new AbortController().signal);
    assert(second.outcomes.every(item => item.status === "pass"));
    assert.equal(f.replays, 2);
    assert.deepEqual(f.roles, ["exploration", "semantic_review", "exploration", "semantic_review"]);
    assert.equal(JSON.parse(f.explorationPrompts[1]!).rejectedPrograms, undefined);
  } finally { await f.cleanup(); }
});

test("failed rediscovery leaves approved sibling programs eligible for current replay", async () => {
  const config = { omitSecond: true, rejectReview: false };
  const f = await fixture(config);
  try {
    const first = await f.checker.check(f.job, new AbortController().signal);
    config.rejectReview = true;
    const second = await f.checker.check({ ...f.job, jobId: "partial", mode: "replay", programs: first.programs }, new AbortController().signal);
    assert.deepEqual(second.outcomes.map(item => item.status), ["pass", "inconclusive"]);
    const third = await f.checker.check({ ...f.job, jobId: "retry", mode: "replay", programs: second.programs }, new AbortController().signal);
    assert.deepEqual(third.outcomes.map(item => item.status), ["pass", "inconclusive"]);
    assert.match(third.outcomes[1]!.reason!, /Program was rejected/);
    assert.equal(f.replays, 4, "approved sibling still replays while the rejected program is skipped");
    assert.equal(f.reviewPrompts.length, 2, "neither program needs another semantic review");
    assert.equal(f.closed, f.environments);
  } finally { await f.cleanup(); }
});

test("cleanup failure rejects the job instead of publishing acceptance", async () => {
  const f = await fixture();
  try {
    const adapter: ExecutionAdapter = { binding: f.adapter.binding, async prepare(job, signal) {
      const session = await f.adapter.prepare(job, signal);
      return { ...session, async close() { await session.close(); throw new Error("browser process still alive"); } };
    } };
    await assert.rejects(createCheckerAgent({ artifacts: f.store, adapter, model: f.model }).check({ ...f.job, mode: "prepare" }, new AbortController().signal), CheckerCleanupError);
  } finally { await f.cleanup(); }
});

test("Checker cancellation awaits cleanup and returns unconfirmed results", async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    const checker = createCheckerAgent({ artifacts: f.store, adapter: f.adapter, model: { async run(request: CheckerModelRequest) {
      controller.abort(new Error("Cancelled test job")); request.signal.throwIfAborted(); return { totalTokens: 0 };
    } } });
    const report = await checker.check(f.job, controller.signal);
    assert(report.outcomes.every(item => item.status === "inconclusive"));
    assert.equal(f.environments, 1); assert.equal(f.closed, 1);
  } finally { await f.cleanup(); }
});

test("production Pi Checker session exposes only declared tools, calls finish and attributes usage", async () => {
  const f = await fixture();
  const payloads: Array<Record<string, unknown>> = [];
  let finished = false;
  const usage: CheckerModelUsage[] = [];
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
    const payload = JSON.parse(Buffer.concat(parts).toString()) as Record<string, unknown>;
    payloads.push(payload);
    const tool = payloads.length === 1;
    const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: "finish-1", type: "function", function: { name: "finish", arguments: "{}" } }] } : { role: "assistant", content: "Review submitted." };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "checker", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "checker", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, completion_tokens_details: { reasoning_tokens: 1 } } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert(address && typeof address !== "string");
    const model = createPiCheckerModel({ gateway: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-test", model: "test-checker" }, sessionDir: join(f.directory, "sessions"), onUsage: item => usage.push(item) });
    await model.run({ role: "semantic_review", job: f.job, systemPrompt: "Use finish.", prompt: "Review.", maxModelTokens: 10_000,
      tools: [{ name: "finish", description: "Submit review", parameters: Type.Object({}), async execute() { finished = true; return {}; } }], signal: new AbortController().signal });
    assert.equal(finished, true); assert.equal(payloads.length, 2);
    for (const payload of payloads) {
      const tools = payload.tools as Array<{ function: { name: string } }>;
      assert.deepEqual(tools.map(item => item.function.name), ["finish"]);
      assert(!JSON.stringify(payload).includes("E:\\\\my-works"));
    }
    assert.equal(usage.length, 1); assert.equal(usage[0]!.role, "semantic_review"); assert.equal(usage[0]!.jobId, f.job.jobId);
    assert.equal(usage[0]!.input, 20); assert.equal(usage[0]!.output, 6);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await f.cleanup();
  }
});
