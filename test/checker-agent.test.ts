import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { CheckerCleanupError, createCheckerAgent, createPiCheckerModel } from "../src/checker/agent.js";
import { GatewayRecovery } from "../src/gateway-recovery.js";
import { ArtifactStore } from "../src/checker/artifacts.js";
import { type AcceptanceContract, type CheckerManifest, type CheckerRequirements, type SourceClause } from "../src/checker/evidence.js";
import type { CheckerModel, CheckerModelRequest, CheckerModelUsage } from "../src/checker/model.js";
import type { AdapterDeclaration, CheckerProgress, CheckJob, ContentRef, EvidenceReceipt, ExecutionAdapter, ExecutionBinding, ExecutionBindingRef, ProgramRef } from "../src/checker/port.js";
import type { AtomicRequirement } from "../src/types.js";

async function fixture(config: { failures?: number[]; omitSecond?: boolean; rejectReview?: boolean; source?: string; forgeInput?: boolean; dependencies?: string[]; omitSetup?: boolean; omitDependency?: boolean; failPrecondition?: boolean; conditionWhen?: boolean; omitActionReceipt?: boolean; stringifyToolArguments?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "checker-agent-"));
  const store = new ArtifactStore(directory, "run-1");
  const schema = await store.putJson(Type.Unknown());
  const inputSchema = await store.putJson(Type.Object({}, { additionalProperties: true }));
  const typed = (value: unknown) => store.putTypedJson(value, schema);
  const initialState = await typed({ mode: "empty" });
  const executor = { id: "fake-host", version: "1", digest: "host-v1" };
  const declaration: AdapterDeclaration = { schemaVersion: 1, id: "fake", version: "1", implementation: executor,
    execution: await typed({}), initialStates: [initialState], resourceKeys: [], capabilities: [{ id: "inspect", version: "1", description: "observe", inputSchema, outputSchema: schema }],
    programFormat: { id: "fake.javascript", version: "1", schema, mediaType: "text/javascript" }, observations: [], attachments: [], prompts: [] };
  const bindingContent: ExecutionBinding = { schemaVersion: 1, declaration: await store.putJson(declaration), executor, schemas: [schema, inputSchema], dependencies: {}, promptDigest: "test-prompts" };
  const binding: ExecutionBindingRef = { ...await store.putJson(bindingContent), executor };
  const requirement: AtomicRequirement = { id: "r1", folderPath: [], declarationIndex: 0, name: "Cancel order", text: "Cancellation persists.", guidance: ["Implementation-only guidance"], dependencyIds: config.dependencies ?? [],
    scenarios: [], scenarioContracts: [{ id: "cancel", name: "Cancellation", steps: [{ keyword: "GIVEN", content: "Order is unpaid" },
      { keyword: "WHEN", content: "Cancel the order" }, { keyword: "THEN", content: "Order is cancelled and seats are restored" }] }], references: [], exactUiStrings: [], seedDeclarations: [], ancestors: [],
    product: { kind: "generic_web", rootId: "root", rootName: "root", description: "", guidance: ["Root implementation guidance"], seedData: [] } };
  const input: CheckerRequirements = { requirements: [requirement], implementedRequirementIds: [] };
  const job: CheckJob = { jobId: "job-1", runId: store.runId, moduleId: "module", packetId: "packet", attempt: 1, moduleEpoch: 1,
    snapshot: await store.putJson({ sha: "source-1" }), requirements: await store.putJson(input), binding, initialState,
    requirementIds: ["r1"], mode: "discover", programs: [], budget: { deadlineAt: Date.now() + 30_000 } };
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
        if (!config.conditionWhen && !config.omitActionReceipt) refs.push(await receipt("action", {}, { program, checkpointId: "when" }));
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
    const tool = async (name: string, args: unknown) => {
      const definition = request.tools.find(item => item.name === name)!;
      return definition.execute(definition.prepareArguments?.(args) ?? args);
    };
    const argument = (value: unknown) => config.stringifyToolArguments ? JSON.stringify(value) : value;
    const promptInput = JSON.parse(request.prompt) as { sourceClauses: SourceClause[]; contract?: AcceptanceContract };
    const clauses = (request.role === "semantic_review" ? promptInput.contract!.clauses : promptInput.sourceClauses).slice(0, config.omitSecond ? 1 : undefined);
    if (request.role === "semantic_review") {
      assert.deepEqual(request.tools.map(item => item.name), ["finish"]);
      await tool("finish", { approved: !config.rejectReview, reasons: config.rejectReview ? ["Constant predicate does not test source result"] : [], clauseIds: clauses.map(item => item.id) });
    } else {
      assert.deepEqual(request.tools.map(item => item.name), ["invoke", "save_artifact", "finish"]);
      await assert.rejects(tool("invoke", { capabilityId: "shell", input: {} }), /Undeclared/);
      await assert.rejects(tool("invoke", { capabilityId: "inspect", input: "{not json" }), /not valid JSON/);
      await tool("invoke", { capabilityId: "inspect", input: argument({}) });
      const programs: unknown[] = [];
      const grouped = new Map<string, SourceClause[]>();
      for (const clause of clauses) {
        const key = JSON.stringify([clause.requirementId, clause.scenarioId]);
        grouped.set(key, [...grouped.get(key) ?? [], clause]);
      }
      for (const cases of grouped.values()) {
        const contract: AcceptanceContract = { requirements: job.requirements,
          checkpoints: [{ id: "given", kind: "precondition", requirementId: cases[0]!.requirementId, scenarioId: cases[0]!.scenarioId, dependsOn: [], basis: "Order is unpaid", expected: { operator: "equal", value: "unpaid" } },
            { id: "when", kind: config.conditionWhen ? "condition" : "action", requirementId: cases[0]!.requirementId, scenarioId: cases[0]!.scenarioId, dependsOn: ["given"], basis: "Cancel the order" },
            ...cases.map((clause, index) => ({ id: `result-${index}`, kind: "assertion" as const, clauseId: clause.id, requirementId: clause.requirementId, scenarioId: clause.scenarioId, dependsOn: config.omitDependency ? [] : ["when"], basis: clause.basis }))],
          clauses: cases.map((clause, index) => ({ ...clause, checkpointId: `result-${index}`, expected: { operator: "equal", value: 5 } })) };
        if (config.omitSetup) {
          contract.checkpoints = contract.checkpoints.filter(item => item.kind === "assertion");
          contract.checkpoints.forEach(item => { item.dependsOn = []; });
        }
        const contractRef = await tool("save_artifact", { kind: "contract", contract: argument(contract) });
        const program = await tool("save_artifact", { kind: "program", contract: argument(contractRef), source: config.source ?? "await check.expect('source-result', [observation.id]);",
          clauses: contract.clauses.map(clause => ({ clauseId: clause.id, checkpointId: clause.checkpointId })) });
        programs.push(program);
      }
      await tool("finish", { programs: argument(programs) });
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
    const invoke = f.toolSchemas.find(item => item.name === "invoke")!;
    assert.equal(((invoke.parameters as { properties: Record<string, { type?: string }> }).properties.input.type), "object");
    assert.deepEqual((invoke.parameters as { properties: { capabilityId: { enum: string[] } } }).properties.capabilityId.enum, ["inspect"]);
    assert.equal(((save.parameters as { properties: Record<string, { type?: string }> }).properties.contract.type), "object");
  } finally { await f.cleanup(); }
});

test("Checker corrects a nested finish call and permits a corrected independent review", async () => {
  const f = await fixture();
  try {
    const model: CheckerModel = { async run(request) {
      if (request.role === "exploration") {
        const invoke = request.tools.find(tool => tool.name === "invoke")!;
        const args = { capabilityId: "finish", input: { programs: [] } };
        assert.throws(() => invoke.prepareArguments!(args), /Call the separate Checker tools.*finish directly/);
        await assert.rejects(invoke.execute(args), /Call the separate Checker tools.*finish directly/);
      } else {
        const finish = request.tools[0]!;
        const ids = (JSON.parse(request.prompt).contract as AcceptanceContract).clauses.map(clause => clause.id);
        for (const clauseIds of [[ids[0]], [ids[0], ids[0]], [ids[0], "unknown-clause"]]) {
          await assert.rejects(finish.execute({ approved: true, reasons: [], clauseIds }), /each contract clause exactly once/);
        }
      }
      return f.model.run(request);
    } };
    const report = await createCheckerAgent({ artifacts: f.store, adapter: f.adapter, model }).check(f.job, new AbortController().signal);
    assert(report.outcomes.every(outcome => outcome.status === "pass"));
    const manifest = await f.store.getJson<CheckerManifest>(report.manifest);
    assert.equal(manifest.reviews.length, 1);
    assert.deepEqual(manifest.diagnostics, []);
  } finally { await f.cleanup(); }
});

test("Checker accepts JSON-encoded tool arguments from a stringifying gateway", async () => {
  const f = await fixture({ stringifyToolArguments: true });
  try {
    const report = await f.checker.check(f.job, new AbortController().signal);
    assert(report.outcomes.every(item => item.status === "pass"));
    assert.equal(f.roles.filter(role => role === "exploration").length, 1);
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

test("Checker accepts a state WHEN without an action receipt", async () => {
  const f = await fixture({ conditionWhen: true });
  try {
    const report = await f.checker.check(f.job, new AbortController().signal);
    assert(report.outcomes.every(item => item.status === "pass"));
  } finally { await f.cleanup(); }
});

test("Checker reports a missing action WHEN receipt as inconclusive, not blocked", async () => {
  const f = await fixture({ omitActionReceipt: true });
  try {
    const report = await f.checker.check(f.job, new AbortController().signal);
    assert(report.outcomes.every(item => item.status === "inconclusive"));
    assert.match(report.outcomes[0]!.reason!, /did not record required checkpoint receipt: when/);
  } finally { await f.cleanup(); }
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
    assert.deepEqual(f.roles, ["exploration", "semantic_review", "exploration", "exploration"]);
    assert.equal(f.replays, 1, "the rejected program is not replayed again");
    assert.equal(f.environments, 4, "initial rejection gets one correction; restart prepares only exploration");
    assert.equal(f.closed, f.environments);
    assert(second.outcomes.every(item => item.status === "inconclusive"));
    assert.match(second.outcomes[0]!.reason!, /Program was rejected.*Constant predicate/);
    const feedback = JSON.parse(f.explorationPrompts.at(-1)!).rejectedPrograms;
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
    assert.deepEqual(JSON.parse(f.explorationPrompts.at(-1)!).sourceClauses.map((item: SourceClause) => item.id), first.outcomes.map(item => item.clauseId));
    assert.equal(second.programs.length, 2, "history retains the rejected attempt alongside its replacement");
    assert.deepEqual(f.roles, ["exploration", "semantic_review", "exploration", "exploration", "semantic_review"]);
    assert.equal(f.replays, 2, "only the replacement is replayed during rediscovery");
    const third = await f.checker.check({ ...f.job, jobId: "final", mode: "replay", programs: second.programs }, new AbortController().signal);
    assert(third.outcomes.every(item => item.status === "pass"));
    assert.equal(f.roles.length, 5, "final replay reuses the replacement review");
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
    assert.deepEqual(f.roles, ["exploration", "semantic_review", "exploration", "exploration", "semantic_review"]);
    assert.equal(JSON.parse(f.explorationPrompts.at(-1)!).rejectedPrograms, undefined);
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

test("an unsubmitted review leaves sibling programs verifiable and can be retried without rediscovery", async () => {
  const f = await fixture();
  try {
    const original = (await f.checker.check(f.job, new AbortController().signal)).programs[0]!;
    const contract = await f.store.getJson<AcceptanceContract>(original.contract);
    const descriptor = await f.store.readTypedJson<Record<string, unknown>>(original.descriptor);
    const programs = await Promise.all(contract.clauses.map(async clause => ({ ...original,
      contract: await f.store.putJson({ ...contract, clauses: [clause],
        checkpoints: contract.checkpoints.filter(checkpoint => checkpoint.kind !== "assertion" || checkpoint.clauseId === clause.id) }),
      descriptor: await f.store.putTypedJson({ ...descriptor, clauses: [{ clauseId: clause.id, checkpointId: clause.checkpointId }] }, original.descriptor.schema),
    })));
    let reviews = 0;
    const checker = createCheckerAgent({ artifacts: f.store, adapter: f.adapter, model: { async run(request) {
      if (request.role === "semantic_review" && reviews++ === 0) return { totalTokens: 100 };
      return f.model.run(request);
    } } });
    const partial = await checker.check({ ...f.job, jobId: "partial-review", mode: "replay", programs }, new AbortController().signal);
    assert.deepEqual(partial.outcomes.map(outcome => outcome.status), ["inconclusive", "pass"]);
    assert.match(partial.outcomes[0]!.reason!, /Independent semantic review did not call finish/);
    assert.equal(partial.programs.length, 2, "both programs remain available for retry");
    const manifest = await f.store.getJson<CheckerManifest>(partial.manifest);
    assert.equal(manifest.reviews.length, 1, "an unsubmitted review is not cached");
    const retried = await f.checker.check({ ...f.job, jobId: "review-retry", mode: "replay", programs: partial.programs }, new AbortController().signal);
    assert(retried.outcomes.every(outcome => outcome.status === "pass"));
    assert.equal(f.roles.filter(role => role === "exploration").length, 1);
    assert.equal(f.closed, f.environments);
  } finally { await f.cleanup(); }
});

test("one local correction repairs only rejected coverage and retains approved sibling replay", async () => {
  const config = { source: "// original" };
  const f = await fixture(config);
  try {
    const original = (await f.checker.check(f.job, new AbortController().signal)).programs[0]!;
    const contract = await f.store.getJson<AcceptanceContract>(original.contract);
    const descriptor = await f.store.readTypedJson<Record<string, unknown>>(original.descriptor);
    const split = await Promise.all(contract.clauses.map(async (clause, index) => ({ ...original,
      contract: await f.store.putJson({ ...contract, clauses: [clause],
        checkpoints: contract.checkpoints.filter(point => point.kind !== "assertion" || point.clauseId === clause.id) }),
      descriptor: await f.store.putTypedJson({ ...descriptor, source: await f.store.putBytes(index ? "// sibling" : "// invalid"),
        clauses: [{ clauseId: clause.id, checkpointId: clause.checkpointId }] }, original.descriptor.schema),
    })));
    const requests: CheckerModelRequest[] = [];
    const checker = createCheckerAgent({ artifacts: f.store, adapter: f.adapter, model: { async run(request) {
      requests.push(request);
      const payload = JSON.parse(request.prompt);
      if (request.role === "semantic_review" && payload.source === "// invalid") {
        await request.tools[0]!.execute({ approved: false, reasons: ["Incorrect source expectation"], clauseIds: payload.contract.clauses.map((clause: SourceClause) => clause.id) });
        return { totalTokens: 100 };
      }
      if (request.role === "exploration") {
        assert.equal(payload.repair, true);
        assert(payload.remainingMs > 0 && payload.remainingMs <= 10 * 60_000);
        assert.deepEqual(payload.sourceClauses.map((clause: SourceClause) => clause.id), [contract.clauses[0]!.id]);
        assert.equal(payload.rejectedPrograms.length, 1);
        assert.equal(payload.rejectedPrograms[0].source, "// invalid");
        assert.deepEqual(payload.rejectedPrograms[0].contract.clauses, [contract.clauses[0]]);
        assert(payload.rejectedPrograms[0].observations.some((item: { payload: { value: unknown } }) => item.payload.value === 5));
        config.source = "// corrected";
      }
      return f.model.run(request);
    } } });
    const report = await checker.check({ ...f.job, mode: "replay", programs: split }, new AbortController().signal);
    assert(report.outcomes.every(outcome => outcome.status === "pass"));
    assert.deepEqual(requests.map(request => request.role), ["semantic_review", "semantic_review", "exploration", "semantic_review"]);
    assert.equal(report.programs.length, 3, "rejected history is retained with the sibling and replacement");
    assert.equal(f.replays, 4, "one initial fixture replay, then each sibling and the replacement exactly once");
    const final = await checker.check({ ...f.job, jobId: "final-local-repair", mode: "replay", programs: report.programs }, new AbortController().signal);
    assert(final.outcomes.every(outcome => outcome.status === "pass"));
    assert.equal(requests.length, 4, "the approved replacement is reused without rediscovery or review");
    assert.equal(f.replays, 6);
    assert.equal(f.closed, f.environments);
  } finally { await f.cleanup(); }
});

test("fresh rejection gets at most one local correction and remains inconclusive if rejected again", async () => {
  const config = { rejectReview: true, source: "" };
  const f = await fixture(config);
  let attempts = 0;
  try {
    const checker = createCheckerAgent({ artifacts: f.store, adapter: f.adapter, model: { async run(request) {
      if (request.role === "exploration") config.source = `// attempt ${++attempts}`;
      return f.model.run(request);
    } } });
    const report = await checker.check(f.job, new AbortController().signal);
    assert.equal(attempts, 2);
    assert.equal(f.replays, 2);
    assert.equal(report.programs.length, 2);
    assert(report.outcomes.every(outcome => outcome.status === "inconclusive" && /Semantic review rejected/.test(outcome.reason!)));
    assert.equal(f.closed, f.environments);
  } finally { await f.cleanup(); }
});

test("model-defined unverifiable gaps need no limitation list and expire with changed snapshot or context", async () => {
  const f = await fixture();
  let explorations = 0;
  const model: CheckerModel = { async run(request) {
    assert.equal(request.role, "exploration"); explorations++;
    const payload = JSON.parse(request.prompt);
    assert.equal("limitations" in payload, false);
    const unsupported = payload.sourceClauses.map((clause: SourceClause) => ({ clauseId: clause.id, reason: "The cross-window animation cannot be observed with sufficient timing evidence",
      attempts: ["Inspected both windows and tried the available state observations; intermediate frames remain unobservable"], retryable: false }));
    const finish = request.tools.find(tool => tool.name === "finish")!;
    await assert.rejects(finish.execute({ programs: [], unsupported: [{ ...unsupported[0], attempts: [] }] }), /reason and attempts/);
    await assert.rejects(finish.execute({ programs: [], unsupported: [{ ...unsupported[0], clauseId: "invented" }] }), /source clause/);
    await finish.execute({ programs: [], unsupported });
    return { totalTokens: 100 };
  } };
  try {
    const checker = createCheckerAgent({ artifacts: f.store, adapter: f.adapter, model });
    const first = await checker.check(f.job, new AbortController().signal);
    assert(first.outcomes.every(outcome => outcome.status === "inconclusive" && /Unable to verify:.*cross-window animation/.test(outcome.reason!)));
    const progress: CheckerProgress[] = [];
    const restarted = createCheckerAgent({ artifacts: new ArtifactStore(f.directory, f.store.runId), adapter: f.adapter, model });
    const second = await restarted.check({ ...f.job, jobId: "gap-replay" }, new AbortController().signal,
      async event => { progress.push(event); });
    assert.equal(explorations, 1);
    assert.equal(f.environments, 1, "an explicitly non-retryable gap on the same snapshot needs no new exploration environment");
    assert(second.outcomes.every(outcome => outcome.status === "inconclusive"));
    assert.equal(progress.filter(event => event.cached && event.stage === "diagnostic").length, 2);
    const manifest = await f.store.getJson<CheckerManifest>(second.manifest);
    assert.equal(manifest.unsupported!.length, 2);
    await checker.check({ ...f.job, jobId: "new-gap-snapshot", snapshot: await f.store.putJson({ sha: "new-source" }) }, new AbortController().signal);
    assert.equal(explorations, 2, "a new application snapshot requires another attempt");
    const input = await f.store.getJson<CheckerRequirements>(f.job.requirements);
    await checker.check({ ...f.job, jobId: "changed-gap-context", requirements: await f.store.putJson({ ...input, contextVersion: 2 }) }, new AbortController().signal);
    assert.equal(explorations, 3, "requirement changes require a fresh assessment");
    assert.equal(f.closed, f.environments);
  } finally { await f.cleanup(); }
});

test("unverifiable-gap reuse preserves a verifiable sibling and expires when adapter capabilities change", async () => {
  const f = await fixture();
  const model: CheckerModel = { async run(request) {
    if (request.role !== "exploration") return f.model.run(request);
    const payload = JSON.parse(request.prompt);
    const gap = { clauseId: payload.sourceClauses[0].id, reason: "Required evidence cannot be obtained in this execution context", attempts: ["Inspected the application and tried the applicable observation tools"], retryable: false };
    const finish = request.tools.find(tool => tool.name === "finish")!;
    return f.model.run({ ...request, prompt: JSON.stringify({ ...payload, sourceClauses: payload.sourceClauses.slice(1) }),
      tools: request.tools.map(tool => tool.name === "finish" ? { ...tool, execute: args => finish.execute({ ...(args as object), unsupported: [gap] }) } : tool) });
  } };
  try {
    const checker = createCheckerAgent({ artifacts: f.store, adapter: f.adapter, model });
    const first = await checker.check(f.job, new AbortController().signal);
    assert.deepEqual(first.outcomes.map(outcome => outcome.status), ["inconclusive", "pass"]);
    const second = await checker.check({ ...f.job, jobId: "gap-with-sibling", programs: first.programs }, new AbortController().signal);
    assert.deepEqual(second.outcomes.map(outcome => outcome.status), ["inconclusive", "pass"]);
    assert.deepEqual(f.roles, ["exploration", "semantic_review"]);
    assert.equal(f.replays, 2, "the verifiable sibling replays against the current job");
    const oldBinding = await f.store.getJson<ExecutionBinding>(f.job.binding);
    const declaration = await f.store.getJson<AdapterDeclaration>(oldBinding.declaration);
    const binding = { ...await f.store.putJson({ ...oldBinding, declaration: await f.store.putJson({ ...declaration, version: "2" }) }), executor: f.job.binding.executor };
    let prepares = 0;
    const changed = createCheckerAgent({ artifacts: f.store, model, adapter: { binding, async prepare() {
      prepares++; throw new Error("Fresh exploration with changed adapter");
    } } });
    const report = await changed.check({ ...f.job, jobId: "changed-capabilities", binding }, new AbortController().signal);
    assert.equal(prepares, 1);
    assert.equal((await f.store.getJson<CheckerManifest>(report.manifest)).unsupported, undefined);
    assert(report.outcomes.every(outcome => /changed adapter/.test(outcome.reason!)));
  } finally { await f.cleanup(); }
});

test("unverifiable gaps retry by default so a transient observation failure cannot suppress later verification", async () => {
  const f = await fixture();
  let explorations = 0;
  const model: CheckerModel = { async run(request) {
    if (request.role === "exploration" && ++explorations === 1) {
      const payload = JSON.parse(request.prompt);
      await request.tools.find(tool => tool.name === "finish")!.execute({ programs: [], unsupported: payload.sourceClauses.map((source: SourceClause) => ({
        clauseId: source.id, reason: "The application connection stopped before evidence could be collected", attempts: ["Opened the page and attempted to inspect the result; the connection was interrupted"],
      })) });
      return { totalTokens: 100 };
    }
    return f.model.run(request);
  } };
  try {
    const checker = createCheckerAgent({ artifacts: f.store, adapter: f.adapter, model });
    assert((await checker.check(f.job, new AbortController().signal)).outcomes.every(outcome => outcome.status === "inconclusive"));
    const second = await checker.check({ ...f.job, jobId: "retry-transient-gap" }, new AbortController().signal);
    assert.equal(explorations, 2);
    assert(second.outcomes.every(outcome => outcome.status === "pass"));
    assert.equal((await f.store.getJson<CheckerManifest>(second.manifest)).unsupported, undefined);
  } finally { await f.cleanup(); }
});

async function groupJob(f: Awaited<ReturnType<typeof fixture>>): Promise<CheckJob> {
  const input = await f.store.getJson<CheckerRequirements>(f.job.requirements);
  const second = { ...input.requirements[0]!, id: "r2", name: "Second cancellation", declarationIndex: 1 };
  return { ...f.job, requirementIds: ["r1", "r2"], requirements: await f.store.putJson({ ...input, requirements: [...input.requirements, second] }) };
}

test("one group exploration produces independent scenario programs and scoped replay reuses its context", async () => {
  const f = await fixture();
  try {
    const job = await groupJob(f);
    const checker = createCheckerAgent({ artifacts: f.store, adapter: f.adapter, model: { async run(request) {
      if (request.role === "exploration") {
        const sources = (JSON.parse(request.prompt) as { sourceClauses: SourceClause[] }).sourceClauses;
        const mixed = { checkpoints: sources.map((source, i) => ({ id: `mixed-${i}`, kind: "assertion", requirementId: source.requirementId,
          scenarioId: source.scenarioId, clauseId: source.id, dependsOn: [], basis: source.basis })),
          clauses: sources.map((source, i) => ({ ...source, checkpointId: `mixed-${i}`, expected: { operator: "equal", value: 5 } })) };
        await assert.rejects(request.tools.find(tool => tool.name === "save_artifact")!.execute({ kind: "contract", contract: mixed }), /one requirement scenario/);
      }
      return f.model.run(request);
    } } });
    const report = await checker.check(job, new AbortController().signal);
    assert.deepEqual(f.roles, ["exploration", "semantic_review", "semantic_review"]);
    assert.equal(JSON.parse(f.explorationPrompts[0]!).sourceClauses.length, 4);
    assert.equal(report.programs.length, 2);
    assert.equal(f.environments, 3, "one shared discovery and one independent replay per scenario");
    assert(report.outcomes.every(outcome => outcome.status === "pass"));
    const first = report.programs[0]!;
    const scoped = await checker.check({ ...job, jobId: "scope-r1", requirementIds: ["r1"], programs: [first] }, new AbortController().signal);
    assert(scoped.outcomes.every(outcome => outcome.requirementId === "r1" && outcome.status === "pass"));
    assert.equal(f.roles.length, 3, "scope-only replay retains the group context and cached review");
    assert.equal(f.replays, 3);
  } finally { await f.cleanup(); }
});

test("merged history prefers an approved program over a newer unreviewed candidate", async () => {
  const f = await fixture();
  try {
    const job = await groupJob(f);
    const original = await f.checker.check(job, new AbortController().signal);
    const approved = original.programs[0]!;
    const descriptor = await f.store.readTypedJson<Record<string, unknown>>(approved.descriptor);
    const pending = { ...approved, descriptor: await f.store.putTypedJson({ ...descriptor,
      source: await f.store.putBytes("// unfinished newer candidate") }, approved.descriptor.schema) };
    const report = await f.checker.check({ ...job, jobId: "merged-candidates", programs: [pending, ...original.programs] }, new AbortController().signal);
    assert(report.outcomes.every(outcome => outcome.status === "pass"));
    assert.deepEqual(f.roles, ["exploration", "semantic_review", "semantic_review"]);
    assert.equal(report.programs.length, 2);
    assert(report.programs.some(program => program.descriptor.id === approved.descriptor.id));
    assert(!report.programs.some(program => program.descriptor.id === pending.descriptor.id));
  } finally { await f.cleanup(); }
});

test("a failed scenario closes its environment and leaves sibling programs verifiable", async () => {
  const f = await fixture();
  try {
    const job = await groupJob(f);
    const original = await f.checker.check(job, new AbortController().signal);
    const checker = createCheckerAgent({ artifacts: f.store, model: f.model, adapter: { binding: f.adapter.binding, async prepare(job, signal) {
      assert.equal(f.closed, f.environments, "a previous scenario must release its environment before the next starts");
      const session = await f.adapter.prepare(job, signal);
      return { ...session, async replay(program, signal) {
        const contract = await f.store.getJson<AcceptanceContract>(program.contract);
        if (contract.clauses[0]!.requirementId === "r1") throw new Error("Scenario r1 preparation failed");
        return session.replay(program, signal);
      } };
    } } });
    const report = await checker.check({ ...job, jobId: "isolated-failure", programs: original.programs }, new AbortController().signal);
    assert.deepEqual(report.outcomes.map(outcome => outcome.status), ["inconclusive", "inconclusive", "pass", "pass"]);
    assert(report.outcomes.slice(0, 2).every(outcome => /Scenario r1 preparation failed/.test(outcome.reason!)));
    assert.equal(f.roles.length, 3, "an infrastructure error does not trigger another exploration or review");
    assert.equal(f.closed, f.environments);
  } finally { await f.cleanup(); }
});

test("discovery exhaustion preserves verified siblings and saved candidates for later independent review", { timeout: 15_000 }, async () => {
  const config = { source: "// original" };
  const f = await fixture(config);
  try {
    const job = await groupJob(f);
    const original = await f.checker.check(job, new AbortController().signal);
    config.source = "// saved before discovery exhaustion";
    const checker = createCheckerAgent({ artifacts: f.store, adapter: f.adapter, model: { async run(request) {
      return f.model.run({ ...request, tools: request.tools.map(tool => request.role === "exploration" && tool.name === "finish" ? { ...tool, async execute() {
        request.signal.throwIfAborted();
        await new Promise<never>((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }));
      } } : tool) });
    } } });
    const report = await checker.check({ ...job, jobId: "partial-discovery", programs: [original.programs[0]!],
      budget: { deadlineAt: Date.now() + 30_000, timeoutMs: 2_000 } }, new AbortController().signal);
    assert.deepEqual(report.outcomes.map(outcome => outcome.status), ["pass", "pass", "inconclusive", "inconclusive"]);
    assert.equal(report.programs.length, 2, "saved candidates survive without granting unreviewed results");
    assert(report.outcomes.slice(2).every(outcome => /timeout|aborted/i.test(outcome.reason!)));
    const explorations = f.roles.filter(role => role === "exploration").length;
    const resumed = await f.checker.check({ ...job, jobId: "resume-candidate", programs: report.programs }, new AbortController().signal);
    assert(resumed.outcomes.every(outcome => outcome.status === "pass"));
    assert.equal(f.roles.filter(role => role === "exploration").length, explorations);
    assert.equal(f.roles.at(-1), "semantic_review");
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

test("production Pi Checker retries a transient connection failure before using the model", { timeout: 20_000 }, async () => {
  const f = await fixture();
  let requests = 0;
  const server = createServer(async (req, res) => {
    requests += 1;
    if (requests === 1) { req.socket.destroy(); return; }
    const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "checker", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "checker", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert(address && typeof address !== "string");
    const usage: CheckerModelUsage[] = [];
    const model = createPiCheckerModel({ gateway: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-test", model: "test-checker" }, sessionDir: join(f.directory, "sessions"), onUsage: item => usage.push(item) });
    const result = await model.run({ role: "exploration", job: f.job, systemPrompt: "Reply.", prompt: "Hello.", tools: [], signal: new AbortController().signal });
    assert.equal(requests, 2, "the first transient connection failure must be retried");
    assert.equal(result.totalTokens, 13);
    assert.equal(usage.length, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await f.cleanup();
  }
});

test("production Pi Checker repairs a truncated terminal SSE trailer instead of discarding the turn", { timeout: 20_000 }, async () => {
  const f = await fixture();
  let requests = 0;
  const server = createServer(async (req, res) => {
    requests += 1;
    const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "checker", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "recovered" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "checker", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`);
    res.end('data: {"created":1,"usage":nu');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert(address && typeof address !== "string");
    const usage: CheckerModelUsage[] = [];
    const model = createPiCheckerModel({ gateway: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-test", model: "test-checker" }, sessionDir: join(f.directory, "sessions"), onUsage: item => usage.push(item) });
    const result = await model.run({ role: "exploration", job: f.job, systemPrompt: "Reply.", prompt: "Hello.", tools: [], signal: new AbortController().signal });
    assert.equal(requests, 1, "the completed turn must survive one damaged usage trailer");
    assert.equal(result.totalTokens, 13);
    assert.equal(usage.length, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await f.cleanup();
  }
});

test("production Pi Checker retries an observed TCP reset reported as HTTP 400", { timeout: 20_000 }, async () => {
  const f = await fixture();
  let requests = 0;
  const server = createServer(async (req, res) => {
    requests += 1;
    const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
    if (requests === 1) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: '400 Post "https://api.example/v1/chat/completions": read tcp 127.0.0.1:60000->127.0.0.1:443: read: connection reset by peer (request id: probe)' }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "checker", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "recovered" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "checker", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert(address && typeof address !== "string");
    let now = 0;
    const recovery = new GatewayRecovery({ now: () => now, sleep: async ms => { now += ms; } });
    const model = createPiCheckerModel({ gateway: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-test", model: "test-checker" },
      sessionDir: join(f.directory, "sessions"), recovery });
    const result = await model.run({ role: "exploration", job: f.job, systemPrompt: "Reply.", prompt: "Hello.", tools: [], signal: new AbortController().signal });
    assert.equal(requests, 2, "the upstream reset hidden behind HTTP 400 must be retried");
    assert.equal(result.totalTokens, 13);
    assert.equal(now, 5_000, "the reset must use the unavailable fast schedule");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await f.cleanup();
  }
});

test("production Pi Checker compacts a long transcript before the context window overflows", { timeout: 30_000 }, async () => {
  const f = await fixture();
  const requests: Array<{ summary: boolean }> = [];
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
    const payload = JSON.parse(Buffer.concat(parts).toString()) as { messages?: Array<{ role?: string; content?: unknown }> };
    const summary = JSON.stringify(payload.messages?.[0]?.content ?? "").includes("context summarization assistant");
    requests.push({ summary });
    const first = !summary && requests.filter(item => !item.summary).length === 1;
    const content = summary ? "Summary of the earlier exploration." : first ? undefined : "y".repeat(120_000);
    const delta = first ? { role: "assistant", tool_calls: [{ index: 0, id: "probe-1", type: "function", function: { name: "probe", arguments: "{}" } }] }
      : { role: "assistant", ...(content ? { content } : {}) };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "checker", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "checker", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }], usage: { prompt_tokens: summary ? 1_000 : first ? 18_000 : 30_000, completion_tokens: 10, total_tokens: summary ? 1_010 : first ? 18_010 : 30_010 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert(address && typeof address !== "string");
    const model = createPiCheckerModel({ gateway: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-test", model: "test-checker" },
      sessionDir: join(f.directory, "sessions"), contextWindow: 40_000 });
    await model.run({ role: "exploration", job: f.job, systemPrompt: "Reply.", prompt: "x".repeat(120_000),
      tools: [{ name: "probe", description: "Probe", parameters: Type.Object({}), async execute() { return { ok: true }; } }],
      signal: new AbortController().signal });
    assert.ok(requests.some(item => item.summary), `expected a compaction summary request, got ${JSON.stringify(requests)}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await f.cleanup();
  }
});

test("production Pi Checker session exposes only declared tools, calls finish and attributes usage", async () => {
  const f = await fixture();
  const payloads: Array<Record<string, unknown>> = [];
  let finished = false;
  const usage: CheckerModelUsage[] = [];
  const progress: CheckerModelUsage[] = [];
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
    const model = createPiCheckerModel({ gateway: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-test", model: "test-checker" }, sessionDir: join(f.directory, "sessions"), onUsage: item => usage.push(item), onProgress: item => progress.push(item) });
    await model.run({ role: "semantic_review", job: f.job, systemPrompt: "Use finish.", prompt: "Review.",
      tools: [{ name: "finish", description: "Submit review", parameters: Type.Object({}), async execute() { finished = true; return {}; } }], signal: new AbortController().signal });
    assert.equal(finished, true); assert.equal(payloads.length, 2);
    for (const payload of payloads) {
      const tools = payload.tools as Array<{ function: { name: string } }>;
      assert.deepEqual(tools.map(item => item.function.name), ["finish"]);
      assert(!JSON.stringify(payload).includes("E:\\\\my-works"));
    }
    assert.equal(usage.length, 1); assert.equal(usage[0]!.role, "semantic_review"); assert.equal(usage[0]!.jobId, f.job.jobId);
    assert.equal(usage[0]!.input, 20); assert.equal(usage[0]!.output, 6);
    assert.equal(progress.length, 2, "each assistant turn publishes an in-flight usage snapshot");
    assert.deepEqual(progress.map(item => [item.input, item.output, item.total]), [[10, 3, 13], [20, 6, 26]]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await f.cleanup();
  }
});

test("production Pi Checker requires a successful finish and bounds same-session submission reminders", { timeout: 30_000 }, async t => {
  const cases = [
    { name: "exploration submits after a text-only answer", role: "exploration" as const, actions: ["text", "finish", "text"], reminders: 1, rejected: false, succeeds: true },
    { name: "review submits after a JSON-only answer", role: "semantic_review" as const, actions: ["text", "finish", "text"], reminders: 1, rejected: false, succeeds: true },
    { name: "a rejected finish does not complete the session", role: "semantic_review" as const, actions: ["finish", "text", "finish", "text"], reminders: 1, rejected: true, succeeds: true },
    { name: "persistent JSON-only answers stop after two reminders", role: "semantic_review" as const, actions: ["text", "text", "text"], reminders: 2, rejected: false, succeeds: false },
  ];
  for (const config of cases) await t.test(config.name, async () => {
    const f = await fixture();
    const payloads: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    const usage: CheckerModelUsage[] = [];
    let finishCalls = 0, accepted = 0;
    const server = createServer(async (req, res) => {
      const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
      payloads.push(JSON.parse(Buffer.concat(parts).toString()));
      const tool = config.actions[payloads.length - 1] === "finish";
      const delta = tool
        ? { role: "assistant", tool_calls: [{ index: 0, id: `finish-${payloads.length}`, type: "function", function: { name: "finish", arguments: "{}" } }] }
        : { role: "assistant", content: '{"approved":true,"reasons":[],"clauseIds":["r1"]}' };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "checker", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "checker", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); assert(address && typeof address !== "string");
      const model = createPiCheckerModel({ gateway: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-test", model: "test-checker" },
        sessionDir: join(f.directory, "sessions"), onUsage: item => usage.push(item) });
      const call = model.run({ role: config.role, job: f.job, systemPrompt: "Call finish to submit.", prompt: "Check the fixed candidate.",
        tools: [{ name: "finish", description: "Submit", parameters: Type.Object({}), async execute() {
          finishCalls++;
          if (config.rejected && finishCalls === 1) throw new Error("Include every contract clause exactly once");
          accepted++; return { accepted: true };
        } }], signal: new AbortController().signal });
      if (config.succeeds) assert.equal((await call).totalTokens, config.actions.length * 13);
      else await assert.rejects(call, /did not call finish successfully after 2 submission reminders/);
      assert.equal(payloads.length, config.actions.length);
      assert.equal(accepted, config.succeeds ? 1 : 0);
      assert.equal(finishCalls, config.rejected ? 2 : accepted);
      const reminders = payloads.at(-1)!.messages.filter(message => message.role === "user" && JSON.stringify(message.content).includes("尚未提交"));
      assert.equal(reminders.length, config.reminders);
      assert.equal((await readdir(join(f.directory, "sessions"))).length, 1, "reminders retain the original session and tool results");
      assert.equal(usage.length, 1, "continuations are billed once with the cumulative session usage");
      assert.equal(usage[0]!.input, payloads.length * 10);
      assert.equal(usage[0]!.output, payloads.length * 3);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await f.cleanup();
    }
  });
});
