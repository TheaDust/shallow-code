import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { VerifierCleanupError, createVerifierAgent, createPiVerifierModel } from "../src/verifier/agent.js";
import { GatewayRecovery } from "../src/gateway-recovery.js";
import { ArtifactStore, contentDigest } from "../src/verifier/artifacts.js";
import { type AcceptanceContract, type VerifierManifest, type VerifierRequirements, type SourceClause } from "../src/verifier/evidence.js";
import type { VerifierModel, VerifierModelRequest, VerifierModelUsage } from "../src/verifier/model.js";
import type { AdapterDeclaration, VerifierProgress, CheckJob, ContentRef, EvidenceReceipt, ExecutionAdapter, ExecutionBinding, ExecutionBindingRef, ProgramRef } from "../src/verifier/port.js";
import type { AtomicRequirement } from "../src/types.js";
import { VerifierSourceIndex } from "../src/verifier/source-index.js";
import { SnapshotStore } from "../src/snapshot-store.js";

async function fixture(config: { failures?: number[]; omitSecond?: boolean; rejectReview?: boolean; source?: string; forgeInput?: boolean; dependencies?: string[]; omitSetup?: boolean; omitDependency?: boolean; failPrecondition?: boolean; conditionWhen?: boolean; omitActionReceipt?: boolean; stringifyToolArguments?: boolean; sourceTools?: boolean; emptySource?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "verifier-agent-"));
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
  const input: VerifierRequirements = { requirements: [requirement], implementedRequirementIds: [] };
  const job: CheckJob = { jobId: "job-1", runId: store.runId, moduleId: "module", packetId: "packet", attempt: 1, moduleEpoch: 1,
    snapshot: await store.putJson({ sha: "source-1" }), requirements: await store.putJson(input), binding, initialState,
    requirementIds: ["r1"], mode: "discover", programs: [], budget: { deadlineAt: Date.now() + 30_000 } };
  let sourceIndex: VerifierSourceIndex | undefined;
  if (config.sourceTools) {
    const source = join(directory, "application"); await mkdir(source);
    if (!config.emptySource) await writeFile(join(source, "cancel.ts"), "export const SOURCE_ONLY_SENTINEL = 'private implementation';\nexport function cancelOrder() {}\n");
    else await writeFile(join(source, "README.md"), "no indexed implementation\n");
    await writeFile(join(source, "cancel.test.ts"), "builder-test-only");
    const snapshots = new SnapshotStore(join(directory, "snapshots"));
    job.snapshot = (await snapshots.seal({ sourceDirectory: source, sourceSha: "source-1", packetId: "packet" })).ref;
    sourceIndex = new VerifierSourceIndex(snapshots);
  }
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
  const model: VerifierModel = { async run(request) {
    assert.doesNotMatch(request.systemPrompt, /Playwright|JavaScript|DOM|ARIA|PDF|PNG|OCR|browser|viewport|page\.|role\/label/,
      "an adapter without Web prompt fragments receives only generic Verifier instructions");
    roles.push(request.role);
    for (const tool of request.tools) toolSchemas.push({ role: request.role, name: tool.name, parameters: tool.parameters });
    if (request.role === "semantic_review") reviewPrompts.push(request.prompt);
    else explorationPrompts.push(request.prompt);
    const tool = async (name: string, args: unknown) => {
      const definition = request.tools.find(item => item.name === name)!;
      return definition.execute(definition.prepareArguments?.(args) ?? args);
    };
    const argument = (value: unknown) => config.stringifyToolArguments ? JSON.stringify(value) : value;
    const promptInput = JSON.parse(request.prompt);
    const clauses = (promptInput.sourceClauses as SourceClause[]).slice(0, config.omitSecond ? 1 : undefined);
    if (request.role === "semantic_review") {
      assert.deepEqual(request.tools.map(item => item.name), ["finish"]);
      await tool("finish", { reviews: promptInput.programs.map((item: { programId: string; contract: AcceptanceContract }) => ({ programId: item.programId, approved: !config.rejectReview, reasons: config.rejectReview ? ["Constant predicate does not test source result"] : [], clauseIds: item.contract.clauses.map(clause => clause.id) })) });
    } else {
      assert.deepEqual(request.tools.map(item => item.name), ["invoke", "check_program", "finish", "read_feedback", ...config.sourceTools && !config.emptySource ? ["source_tree", "source_search", "source_read"] : []]);
      if (config.sourceTools && !config.emptySource) {
        const tree = await tool("source_tree", { depth: 1 }) as { entries: Array<{ path: string; kind: string }> };
        assert.deepEqual(tree.entries.map(entry => [entry.path, entry.kind]), [["cancel.ts", "file"]]);
        const result = await tool("source_search", { terms: ["cancelOrder"] }) as { matches: Array<{ fileId: string }> };
        const read = await tool("source_read", { fileId: result.matches[0]!.fileId, startLine: 1, lineCount: 2 }) as { content: string };
        assert.match(read.content, /SOURCE_ONLY_SENTINEL/);
      }
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
        const { program } = await tool("check_program", { contract: argument(contract), source: config.source ?? "await check.expect('source-result', [observation.id]);" }) as { program: ProgramRef };
        programs.push(program);
      }
      await tool("finish", { programs: argument(programs) });
    }
    return { totalTokens: 100 };
  } };
  return { directory, store, job, adapter, model, roles, reviewPrompts, explorationPrompts, toolSchemas, get environments() { return environments; }, get closed() { return closed; }, get replays() { return replays; },
    verifier: createVerifierAgent({ semanticReview: true, artifacts: store, adapter, model, sourceIndex }), sourceIndex,
    cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("semantic review defaults off, leaves no approval cache and remains independently switchable", async () => {
  const f = await fixture({ rejectReview: true });
  try {
    const verifier = createVerifierAgent({ artifacts: f.store, adapter: f.adapter, model: f.model });
    const report = await verifier.check(f.job, new AbortController().signal);
    assert.deepEqual(f.roles, ["exploration"]);
    assert.deepEqual(report.outcomes.map(item => item.status), ["pass", "pass"]);
    assert.equal(f.replays, 1, "check_program execution supplies evidence without another execution");
    assert.deepEqual((await f.store.getJson<VerifierManifest>(report.manifest)).reviews, []);
    assert.deepEqual(await readdir(join(f.directory, "reviews")).catch(() => []), []);
    const replay = { ...f.job, jobId: "replay-without-review", mode: "replay" as const, programs: report.programs };
    const repeated = await verifier.check(replay, new AbortController().signal);
    assert.deepEqual(repeated.outcomes.map(item => item.status), ["pass", "pass"]);
    assert.deepEqual(f.roles, ["exploration"], "replay independently works with semantic review off");
    const reviewed = await f.verifier.check({ ...replay, jobId: "review-enabled" }, new AbortController().signal);
    assert(reviewed.outcomes.every(item => item.status === "inconclusive"), "an unreviewed run never grants cached approval");
    assert.deepEqual(f.roles, ["exploration"]);
    await f.verifier.check({ ...f.job, jobId: "discover-with-review", programs: report.programs }, new AbortController().signal);
    assert(f.roles.includes("semantic_review"), "enabling review still invokes the independent reviewer");
  } finally { await f.cleanup(); }
});

test("semantic review off retains evidence validation and independent business failure confirmation", async () => {
  const f = await fixture({ failures: [0, 1] });
  try {
    const report = await createVerifierAgent({ artifacts: f.store, adapter: f.adapter, model: f.model })
      .check(f.job, new AbortController().signal);
    assert.deepEqual(report.outcomes.map(item => item.status), ["pass", "fail"]);
    assert.equal(f.replays, 2);
    assert.deepEqual(f.roles, ["exploration"]);
    assert.match(report.outcomes[1]!.reason!, /independent fresh environment/);
  } finally { await f.cleanup(); }
});

test("compact model feedback keeps full artifacts, targeted reads and original review/failure evidence", async () => {
  const f = await fixture({ failures: [0, 1] });
  const long = "INPUT-CONTENT-".repeat(10_000) + "EXACT-END";
  const prepare = f.adapter.prepare.bind(f.adapter);
  let previews = 0;
  try {
    f.adapter.prepare = async (...args) => {
      const session = await prepare(...args);
      const replay = session.replay.bind(session);
      session.replay = async (...args) => Promise.all((await replay(...args)).map(async ref => {
        const receipt = await f.store.getJson<EvidenceReceipt>(ref);
        if (receipt.kind !== "assertion") return ref;
        const result = receipt.assertion!.result;
        const payload = { result, passed: result === "satisfied", expected: 5, actual: result === "satisfied" ? 5 : 4,
          context: long };
        return f.store.putReceipt(f.job, { ...receipt, payload: await f.store.putTypedJson(payload, receipt.payload.schema) });
      }));
      return session;
    };
    const verifier = createVerifierAgent({ semanticReview: true, artifacts: f.store, adapter: f.adapter, model: { async run(request) {
      if (request.role === "semantic_review") {
        assert(request.tools.every(tool => tool.name !== "read_feedback"));
        assert.match(request.prompt, /EXACT-END/, "independent review retains unabridged receipt payloads");
        return f.model.run(request);
      }
      const read = request.tools.find(tool => tool.name === "read_feedback")!;
      await assert.rejects(read.execute({ feedbackRef: f.job.requirements }), /not returned/);
      return f.model.run({ ...request, tools: request.tools.map(tool => tool.name !== "check_program" ? tool : {
        ...tool, async execute(args) {
          const preview = await tool.execute(args) as { feedbackRef: ContentRef; checks: Array<{ payload: Record<string, unknown> }> };
          previews++;
          assert(JSON.stringify(preview).length < 5000);
          assert.deepEqual(preview.checks[1]!.payload, { result: "satisfied", passed: true });
          assert.equal(preview.checks[2]!.payload.result, "violated");
          const full = await f.store.getJson<{ checks: Array<{ payload: { context?: string } }> }>(preview.feedbackRef);
          assert.equal(full.checks[2]!.payload.context, long);
          const slice = await read.execute({ feedbackRef: preview.feedbackRef, path: ["checks", 2, "payload", "context"], offset: long.length - 9 }) as { text: string };
          assert.equal(slice.text, "EXACT-END");
          await assert.rejects(read.execute({ feedbackRef: { ...preview.feedbackRef, digest: "wrong" } }), /not returned/);
          await assert.rejects(read.execute({ feedbackRef: preview.feedbackRef, path: ["__proto__"] }), /does not exist/);
          return preview;
        },
      }) });
    } } });
    const report = await verifier.check(f.job, new AbortController().signal);
    assert.equal(previews, 1);
    assert.deepEqual(report.outcomes.map(item => item.status), ["pass", "fail"]);
    assert.equal(f.replays, 2, "compaction does not remove independent failure confirmation");
    const manifest = await f.store.getJson<VerifierManifest>(report.manifest);
    assert.equal(manifest.feedback!.length, 2, "both invoke and check_program retain their full feedback");
    const receipts = await Promise.all(manifest.receipts.map(ref => f.store.getJson<EvidenceReceipt>(ref)));
    for (const receipt of receipts.filter(item => item.kind === "assertion")) {
      assert.equal((await f.store.readTypedJson<{ context: string }>(receipt.payload)).context, long);
    }
  } finally { await f.cleanup(); }
});

test("source lookups aid discovery without reaching semantic review, behavior evidence or replay", async () => {
  const f = await fixture({ sourceTools: true, failures: [0, 1] });
  try {
    const report = await f.verifier.check(f.job, new AbortController().signal);
    assert.deepEqual(report.outcomes.map(item => item.status), ["pass", "fail"]);
    assert.deepEqual(JSON.parse(f.explorationPrompts[0]!).sourceIndex, { available: true, fileCount: 1 });
    for (const prompt of [...f.reviewPrompts, ...f.explorationPrompts]) {
      assert.doesNotMatch(prompt, /SOURCE_ONLY_SENTINEL|private implementation/);
    }
    assert(f.toolSchemas.some(tool => tool.role === "exploration" && tool.name === "source_tree"));
    assert(f.toolSchemas.some(tool => tool.role === "exploration" && tool.name === "source_read"));
    assert(!f.toolSchemas.some(tool => tool.role === "semantic_review" && (tool.name === "source_tree" || tool.name === "source_search" || tool.name === "source_read")));
    const roles = f.roles.length;
    const open = f.sourceIndex!.open;
    f.sourceIndex!.open = async () => { throw new Error("Replay must not open source"); };
    await f.verifier.check({ ...f.job, jobId: "replay", mode: "replay", programs: report.programs }, new AbortController().signal);
    assert.equal(f.roles.length, roles);
    const ready = await f.verifier.check({ ...f.job, jobId: "prepare", mode: "prepare", programs: [] }, new AbortController().signal);
    assert.deepEqual(ready.outcomes, []); assert.equal(f.roles.length, roles);
    f.sourceIndex!.open = open;
  } finally { await f.cleanup(); }
});

test("empty source indexes are surfaced before exploration and do not expose empty lookup tools", async () => {
  const f = await fixture({ sourceTools: true, emptySource: true });
  try {
    const report = await f.verifier.check(f.job, new AbortController().signal);
    assert.deepEqual(report.outcomes.map(item => item.status), ["pass", "pass"]);
    assert.deepEqual(JSON.parse(f.explorationPrompts[0]!).sourceIndex, { available: false, fileCount: 0 });
    assert(!f.toolSchemas.some(tool => tool.name === "source_tree" || tool.name === "source_search" || tool.name === "source_read"));
    const manifest = await f.store.getJson<VerifierManifest>(report.manifest);
    assert(manifest.diagnostics.some(item => /source index is empty/.test(item)));
  } finally { await f.cleanup(); }
});

test("source index open failures preserve page discovery, review and independent failure confirmation", async () => {
  const config = { sourceTools: true, failures: [0, 1] };
  const f = await fixture(config);
  const events: VerifierProgress[] = [];
  try {
    f.sourceIndex!.open = async () => { throw new Error("Source snapshot cannot be indexed"); };
    config.sourceTools = false; // The fake model now expects only execution and submission tools.
    const verifier = createVerifierAgent({ semanticReview: true, artifacts: f.store, adapter: f.adapter, sourceIndex: f.sourceIndex,
      model: { async run(request) {
        if (request.role === "exploration") {
          assert.deepEqual(JSON.parse(request.prompt).sourceIndex, { available: false });
          assert.match(request.systemPrompt, /源码索引为空或不可用不是验收缺口，不能仅据此提交 unsupported/);
        }
        return f.model.run(request);
      } } });
    const report = await verifier.check(f.job, new AbortController().signal, async event => { events.push(event); });
    assert.deepEqual(report.outcomes.map(item => item.status), ["pass", "fail"]);
    assert.deepEqual(f.roles, ["exploration", "semantic_review"]);
    assert.equal(f.replays, 2);
    assert.equal(f.closed, f.environments);
    const manifest = await f.store.getJson<VerifierManifest>(report.manifest);
    assert(manifest.diagnostics.some(item => /source index could not be opened.*Source snapshot cannot be indexed/.test(item)));
    assert(events.some(item => item.stage === "diagnostic" && /source index could not be opened/.test(item.reason ?? "")));
    assert(!manifest.unsupported?.length);
  } finally { await f.cleanup(); }
});

test("cancellation while opening a source index still stops discovery and closes its environment", async () => {
  const f = await fixture({ sourceTools: true });
  const abort = new AbortController();
  try {
    f.sourceIndex!.open = async () => { abort.abort(new Error("Cancelled during source indexing")); abort.signal.throwIfAborted(); throw new Error("unreachable"); };
    const report = await f.verifier.check(f.job, abort.signal);
    assert.deepEqual(f.roles, []);
    assert(report.outcomes.every(item => item.status === "inconclusive"));
    assert.equal(f.closed, f.environments);
  } finally { await f.cleanup(); }
});

test("Verifier discovers, replays, independently reviews and reproduces one failed AND clause", async () => {
  const f = await fixture({ failures: [0, 1] });
  try {
    const report = await f.verifier.check(f.job, new AbortController().signal);
    assert.deepEqual(report.outcomes.map(item => item.status), ["pass", "fail"]);
    assert.match(report.outcomes[1]!.reason!, /independent fresh environment/);
    assert.deepEqual(f.roles, ["exploration", "semantic_review"]);
    assert.equal(f.environments, 3); assert.equal(f.closed, 3);
    const manifest = await f.store.getJson<VerifierManifest>(report.manifest);
    assert.equal(manifest.reviews.length, 1); assert.equal(manifest.diagnostics.length, 0);
  } finally { await f.cleanup(); }
});

test("Verifier keeps an unreproduced violation inconclusive", async () => {
  const f = await fixture({ failures: [0] });
  try {
    const report = await f.verifier.check(f.job, new AbortController().signal);
    assert.deepEqual(report.outcomes.map(item => item.status), ["pass", "inconclusive"]);
    assert.match(report.outcomes[1]!.reason!, /did not reproduce/);
  } finally { await f.cleanup(); }
});

test("Verifier tool schemas keep an object root because the gateway rejects a root union", async () => {
  const f = await fixture({ failures: [0] });
  try {
    await f.verifier.check(f.job, new AbortController().signal);
    assert.deepEqual([...new Set(f.toolSchemas.map(item => item.role))].sort(), ["exploration", "semantic_review"]);
    for (const tool of f.toolSchemas) {
      const schema = tool.parameters as Record<string, unknown>;
      assert.equal(schema.type, "object", `${tool.role}/${tool.name} must declare an object root`);
      for (const keyword of ["anyOf", "oneOf", "allOf"]) assert.equal(schema[keyword], undefined, `${tool.role}/${tool.name} must not use a root ${keyword}`);
    }
    const save = f.toolSchemas.find(item => item.name === "check_program")!;
    assert.deepEqual(Object.keys((save.parameters as { properties: Record<string, unknown> }).properties).sort(),
      ["contract", "source"]);
    assert.deepEqual((save.parameters as { required: string[] }).required, ["contract", "source"]);
    const invoke = f.toolSchemas.find(item => item.name === "invoke")!;
    assert.equal(((invoke.parameters as { properties: Record<string, { type?: string }> }).properties.input.type), "object");
    assert.deepEqual((invoke.parameters as { properties: { capabilityId: { enum: string[] } } }).properties.capabilityId.enum, ["inspect"]);
    assert.equal(((save.parameters as { properties: Record<string, { type?: string }> }).properties.contract.type), "object");
  } finally { await f.cleanup(); }
});

test("Verifier assembles final-program self-check guidance with its exploration submission tools", async () => {
  const f = await fixture();
  let explored = false;
  try {
    const verifier = createVerifierAgent({ semanticReview: true, artifacts: f.store, adapter: f.adapter, model: { async run(request) {
      if (request.role === "exploration") {
        explored = true;
        assert.match(request.systemPrompt, /优先源码定位/);
        assert.match(request.systemPrompt, /直接调用 check_program/);
        assert.match(request.systemPrompt, /没有源码索引或源码无法确定.*才用 invoke/);
        assert.match(request.systemPrompt, /提交前自检/);
        assert.doesNotMatch(request.systemPrompt, /先检查应用并建立规定的初始状态。用 invoke/);
        assert.match(request.systemPrompt, /check_program.*独立干净环境/);
        assert.match(request.systemPrompt, /源码或合同修改后，重新调用 check_program/);
        assert.match(request.systemPrompt, /业务断言失败不要求把正确程序改到通过/);
        assert.match(request.systemPrompt, /verifier-tools@6/);
        assert.match(request.systemPrompt, /不等待全组源码读完/);
        assert.match(request.systemPrompt, /避免先用 invoke 逐步跑通同一路径/);
        assert.match(request.systemPrompt, /摘要缺失排错所需信息时才用 read_feedback/);
        assert.match(request.tools.find(tool => tool.name === "check_program")!.description, /execute the saved program in an independent clean environment/);
        assert.match(request.tools.find(tool => tool.name === "finish")!.description, /returned by check_program/);
      }
      return f.model.run(request);
    } } });
    const report = await verifier.check(f.job, new AbortController().signal);
    assert(explored);
    assert(report.outcomes.every(outcome => outcome.status === "pass"));
  } finally { await f.cleanup(); }
});

test("Verifier corrects a nested finish call and permits a corrected independent review", async () => {
  const f = await fixture();
  try {
    const model: VerifierModel = { async run(request) {
      if (request.role === "exploration") {
        const invoke = request.tools.find(tool => tool.name === "invoke")!;
        const args = { capabilityId: "finish", input: { programs: [] } };
        assert.throws(() => invoke.prepareArguments!(args), /Call the separate Verifier tools.*finish directly/);
        await assert.rejects(invoke.execute(args), /Call the separate Verifier tools.*finish directly/);
      } else {
        const finish = request.tools[0]!;
        const entry = JSON.parse(request.prompt).programs[0];
        const ids = (entry.contract as AcceptanceContract).clauses.map(clause => clause.id);
        for (const clauseIds of [[ids[0]], [ids[0], ids[0]], [ids[0], "unknown-clause"]]) {
          await assert.rejects(finish.execute({ reviews: [{ programId: entry.programId, approved: true, reasons: [], clauseIds }] }), /each contract clause exactly once/);
        }
      }
      return f.model.run(request);
    } };
    const report = await createVerifierAgent({ semanticReview: true, artifacts: f.store, adapter: f.adapter, model }).check(f.job, new AbortController().signal);
    assert(report.outcomes.every(outcome => outcome.status === "pass"));
    const manifest = await f.store.getJson<VerifierManifest>(report.manifest);
    assert.equal(manifest.reviews.length, 1);
    assert.deepEqual(manifest.diagnostics, []);
  } finally { await f.cleanup(); }
});

test("Verifier accepts JSON-encoded tool arguments from a stringifying gateway", async () => {
  const f = await fixture({ stringifyToolArguments: true });
  try {
    const report = await f.verifier.check(f.job, new AbortController().signal);
    assert(report.outcomes.every(item => item.status === "pass"));
    assert.equal(f.roles.filter(role => role === "exploration").length, 1);
  } finally { await f.cleanup(); }
});

test("Verifier reports replay, independent review, confirmation and cached approval at their actual stages", async () => {
  const f = await fixture({ failures: [0, 1] });
  const events: VerifierProgress[] = [];
  try {
    const first = await f.verifier.check(f.job, new AbortController().signal, async progress => { events.push(progress); });
    const stages = events.map(item => item.stage);
    assert(stages.indexOf("exploration") < stages.indexOf("replay"));
    assert(stages.indexOf("replay") < stages.indexOf("semantic_review"));
    assert(stages.indexOf("review_approved") < stages.indexOf("confirmation"));
    assert.equal(stages.at(-1), "cleanup");
    assert.deepEqual(events.find(item => item.stage === "confirmation")!.clauseIds, [first.outcomes[1]!.clauseId]);
    events.length = 0;
    await f.verifier.check({ ...f.job, jobId: "cached", mode: "replay", programs: first.programs }, new AbortController().signal,
      async progress => { events.push(progress); });
    assert(events.some(item => item.stage === "replay"));
    assert(events.some(item => item.stage === "review_cached" && item.cached && item.programId === first.programs[0]!.descriptor.id));
    assert(!events.some(item => item.stage === "semantic_review" || item.stage === "exploration"));
  } finally { await f.cleanup(); }
});

test("progress sink failures cannot change evidence or prevent environment cleanup", async () => {
  const f = await fixture();
  try {
    const report = await f.verifier.check(f.job, new AbortController().signal, async () => { throw new Error("Presentation unavailable"); });
    assert(report.outcomes.every(item => item.status === "pass"));
    assert.equal(f.closed, f.environments);
  } finally { await f.cleanup(); }
});

test("Verifier never grants missing source AND clause through submitted coverage", async () => {
  const f = await fixture({ omitSecond: true });
  try {
    const report = await f.verifier.check(f.job, new AbortController().signal);
    assert.deepEqual(report.outcomes.map(item => item.status), ["pass", "inconclusive"]);
    assert.match(report.outcomes[1]!.reason!, /No reviewed program/);
  } finally { await f.cleanup(); }
});

test("Verifier rejects fabricated observations and independent semantic rejection", async t => {
  for (const config of [{ forgeInput: true }, { rejectReview: true }]) await t.test(JSON.stringify(config), async () => {
    const f = await fixture(config);
    try {
      const report = await f.verifier.check(f.job, new AbortController().signal);
      assert(report.outcomes.every(item => item.status === "inconclusive"));
      assert(report.outcomes.some(item => /outside the replay|Semantic review rejected/.test(item.reason!)));
    } finally { await f.cleanup(); }
  });
});

test("Verifier rejects an incomplete dependency closure before replay and review", async () => {
  const f = await fixture({ omitDependency: true });
  try {
    const report = await f.verifier.check(f.job, new AbortController().signal);
    const manifest = await f.store.getJson<VerifierManifest>(report.manifest);
    assert.equal(f.environments, 1, "exploration readiness is the only environment needed to reject the contract");
    assert.deepEqual(f.roles, ["exploration"]);
    assert.equal(f.reviewPrompts.length, 0);
    assert(report.outcomes.every(item => item.status === "inconclusive"));
    assert.match(manifest.diagnostics.join(" "), /dependency closure/);
  } finally { await f.cleanup(); }
});

test("Verifier semantic review payload is scoped and stably ordered", async () => {
  const f = await fixture();
  try {
    const report = await f.verifier.check(f.job, new AbortController().signal);
    const batch = JSON.parse(f.reviewPrompts[0]!);
    const payload = batch.programs[0];
    assert.deepEqual(Object.keys(batch), ["capabilities", "requirements", "sourceClauses", "programs"]);
    assert.deepEqual(Object.keys(payload), ["programId", "contract", "descriptor", "source", "environments", "receipts"]);
    assert.equal(batch.requirements.length, 1);
    assert.equal(batch.requirements[0].guidance, undefined);
    assert.equal(batch.requirements[0].product.guidance, undefined);
    assert.equal(payload.receipts[0].receipt.job, undefined);
    assert.equal(payload.receipts[0].receipt.attachments, undefined);
    assert.equal(payload.receipts[0].receipt.recordedAt, undefined);
    assert.equal(Object.keys(payload.environments).length, 1);
    const manifest = await f.store.getJson<VerifierManifest>(report.manifest);
    const originals = await Promise.all(manifest.receipts.map(ref => f.store.getJson<EvidenceReceipt>(ref)));
    for (const item of payload.receipts) {
      const original = originals.find(receipt => receipt.id === item.receipt.id)!;
      assert.equal(item.environment, undefined);
      assert.equal(item.receipt.program, undefined);
      assert.equal(item.receipt.environmentId, original.environment.id);
      assert.deepEqual(payload.environments[item.receipt.environmentId], await f.store.readTypedJson(original.environment));
      assert.deepEqual(item.payload, await f.store.readTypedJson(original.payload));
      for (const field of ["id", "kind", "sequence", "checkpointId", "assertion", "inputs"]) assert.deepEqual(item.receipt[field], original[field as keyof EvidenceReceipt]);
      if (original.kind !== "readiness") assert(original.program, "original receipts retain their complete program identity");
    }
  } finally { await f.cleanup(); }
});

test("explicit discovery fills missing clauses and replaces incompatible requirement contracts", async () => {
  const f = await fixture({ omitSecond: true });
  try {
    const first = await f.verifier.check(f.job, new AbortController().signal);
    const second = await f.verifier.check({ ...f.job, jobId: "partial-discovery", mode: "discover", programs: first.programs }, new AbortController().signal);
    assert(second.outcomes.every(outcome => outcome.status === "pass"));
    assert.equal(second.programs.length, 2);
    assert.deepEqual(f.roles, ["exploration", "semantic_review", "exploration", "semantic_review"]);
    const original = await f.store.getJson<VerifierRequirements>(f.job.requirements);
    const changedInput = await f.store.putJson({ ...original, browserEntry: "/new-entry" });
    const third = await f.verifier.check({ ...f.job, jobId: "changed-input", requirements: changedInput, mode: "discover", programs: second.programs }, new AbortController().signal);
    assert.equal(third.programs.length, 1);
    const manifest = await f.store.getJson<VerifierManifest>(third.manifest);
    assert(manifest.diagnostics.some(message => /is incompatible/.test(message)));
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
    const verifier = createVerifierAgent({ semanticReview: true, artifacts: f.store, model: f.model, adapter: { binding: f.job.binding, async prepare() {
      const error = new Error("Application startup failed") as Error & { readinessEvidence: ContentRef[] };
      error.readinessEvidence = [failed]; throw error;
    } } });
    const report = await verifier.check(f.job, new AbortController().signal);
    const manifest = await f.store.getJson<VerifierManifest>(report.manifest);
    assert.deepEqual(manifest.receipts, [failed]);
    assert.match(manifest.diagnostics.join(" "), /Application startup failed/);
    assert(report.outcomes.every(outcome => outcome.status === "inconclusive"));
  } finally { await f.cleanup(); }
});

test("Verifier replays reusable programs without another model session and invalidates changed source", async () => {
  const f = await fixture();
  try {
    const first = await f.verifier.check(f.job, new AbortController().signal);
    assert(first.outcomes.every(item => item.status === "pass"));
    const second = await f.verifier.check({ ...f.job, jobId: "job-2", mode: "replay", programs: first.programs }, new AbortController().signal);
    assert(second.outcomes.every(item => item.status === "pass"));
    assert.deepEqual(f.roles, ["exploration", "semantic_review"]);
    const descriptor = await f.store.readTypedJson<{ source: ContentRef }>(first.programs[0]!.descriptor);
    const modified = { ...await f.store.readTypedJson<Record<string, unknown>>(first.programs[0]!.descriptor), source: await f.store.putBytes("// changed\n" + (await f.store.getBytes(descriptor.source)).toString()) };
    const changed: ProgramRef = { ...first.programs[0]!, descriptor: await f.store.putTypedJson(modified, first.programs[0]!.descriptor.schema) };
    const unapproved = await f.verifier.check({ ...f.job, jobId: "job-3", mode: "replay", programs: [changed] }, new AbortController().signal);
    assert(unapproved.outcomes.every(item => item.status === "inconclusive" && /requires an approved program/.test(item.reason!)));
    assert.deepEqual(f.roles, ["exploration", "semantic_review"]);
  } finally { await f.cleanup(); }
});

test("Verifier keeps unavailable dependencies blocked and prepares without model calls", async () => {
  const f = await fixture({ dependencies: ["future-feature"] });
  try {
    const blocked = await f.verifier.check(f.job, new AbortController().signal);
    assert(blocked.outcomes.every(item => item.status === "blocked")); assert.equal(f.environments, 0);
    const readiness = await f.verifier.check({ ...f.job, mode: "prepare" }, new AbortController().signal);
    assert.equal(readiness.outcomes.length, 0); assert.equal(f.environments, 1); assert.equal(f.closed, 1); assert.deepEqual(f.roles, []);
  } finally { await f.cleanup(); }
});

test("source GIVEN/WHEN omissions cannot claim an initial state and failed setup blocks results", async t => {
  for (const config of [{ omitSetup: true }, { failPrecondition: true }]) await t.test(JSON.stringify(config), async () => {
    const f = await fixture(config);
    try {
      const report = await f.verifier.check(f.job, new AbortController().signal);
      assert(report.outcomes.every(item => item.status === (config.omitSetup ? "inconclusive" : "blocked")));
      if (config.omitSetup) {
        assert.match(report.outcomes[0]!.reason!, /omitted a source initial condition/);
        assert.match(report.outcomes[0]!.reason!, /requirementId=r1, scenarioId=cancel, phase=given/);
        assert.match(report.outcomes[0]!.reason!, /Order is unpaid/);
      }
    } finally { await f.cleanup(); }
  });
});

test("Verifier accepts a state WHEN without an action receipt", async () => {
  const f = await fixture({ conditionWhen: true });
  try {
    const report = await f.verifier.check(f.job, new AbortController().signal);
    assert(report.outcomes.every(item => item.status === "pass"));
  } finally { await f.cleanup(); }
});

test("Verifier reports a missing action WHEN receipt as inconclusive, not blocked", async () => {
  const f = await fixture({ omitActionReceipt: true });
  try {
    const report = await f.verifier.check(f.job, new AbortController().signal);
    assert(report.outcomes.every(item => item.status === "inconclusive"));
    assert.match(report.outcomes[0]!.reason!, /did not record required checkpoint receipt: when/);
  } finally { await f.cleanup(); }
});

test("rejected programs survive restart as feedback and cannot be replayed or resubmitted unchanged", async () => {
  const f = await fixture({ rejectReview: true });
  try {
    const first = await f.verifier.check(f.job, new AbortController().signal);
    const verifier = createVerifierAgent({ semanticReview: true, artifacts: new ArtifactStore(f.directory, f.store.runId), adapter: f.adapter, model: f.model });
    const progress: VerifierProgress[] = [];
    const second = await verifier.check({ ...f.job, jobId: "job-retry", mode: "discover", programs: first.programs }, new AbortController().signal,
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
    const firstManifest = await f.store.getJson<VerifierManifest>(first.manifest);
    const secondManifest = await f.store.getJson<VerifierManifest>(second.manifest);
    assert.deepEqual(secondManifest.reviews, firstManifest.reviews);
  } finally { await f.cleanup(); }
});

test("rejected coverage is rediscovered, revised programs are reviewed, and approved replacements are reused", async () => {
  const config = { rejectReview: true, omitSecond: true, source: "// rejected test" };
  const f = await fixture(config);
  try {
    const first = await f.verifier.check(f.job, new AbortController().signal);
    config.rejectReview = false; config.omitSecond = false; config.source = "// revised test";
    const second = await f.verifier.check({ ...f.job, jobId: "explicit-retry", mode: "discover", programs: first.programs,
      snapshot: await f.store.putJson({ sha: "source-2" }) }, new AbortController().signal);
    assert(second.outcomes.every(item => item.status === "pass"));
    assert.deepEqual(JSON.parse(f.explorationPrompts.at(-1)!).sourceClauses.map((item: SourceClause) => item.id), first.outcomes.map(item => item.clauseId));
    assert.equal(second.programs.length, 2, "history retains the rejected attempt alongside its replacement");
    assert.deepEqual(f.roles, ["exploration", "semantic_review", "exploration", "exploration", "semantic_review"]);
    assert.equal(f.replays, 2, "only the replacement is replayed during rediscovery");
    const third = await f.verifier.check({ ...f.job, jobId: "final", mode: "replay", programs: second.programs }, new AbortController().signal);
    assert(third.outcomes.every(item => item.status === "pass"));
    assert.equal(f.roles.length, 5, "final replay reuses the replacement review");
    assert.equal(f.replays, 3);
  } finally { await f.cleanup(); }
});

test("changed requirement context invalidates a cached rejection", async () => {
  const config = { rejectReview: true };
  const f = await fixture(config);
  try {
    const first = await f.verifier.check(f.job, new AbortController().signal);
    config.rejectReview = false;
    const input = await f.store.getJson<VerifierRequirements>(f.job.requirements);
    const second = await f.verifier.check({ ...f.job, jobId: "changed-context", mode: "discover", programs: first.programs,
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
    const first = await f.verifier.check(f.job, new AbortController().signal);
    config.rejectReview = true;
    const second = await f.verifier.check({ ...f.job, jobId: "partial", mode: "discover", programs: first.programs }, new AbortController().signal);
    assert.deepEqual(second.outcomes.map(item => item.status), ["pass", "inconclusive"]);
    const third = await f.verifier.check({ ...f.job, jobId: "retry", mode: "discover", programs: second.programs }, new AbortController().signal);
    assert.deepEqual(third.outcomes.map(item => item.status), ["pass", "inconclusive"]);
    assert.match(third.outcomes[1]!.reason!, /Program was rejected/);
    assert.equal(f.replays, 4, "approved sibling still replays while the rejected program is skipped");
    assert.equal(f.reviewPrompts.length, 2, "neither program needs another semantic review");
    assert.equal(f.closed, f.environments);
  } finally { await f.cleanup(); }
});

test("an unsubmitted batch is not cached and explicit discovery retries without rediscovery", async () => {
  const f = await fixture();
  try {
    const original = (await f.verifier.check(f.job, new AbortController().signal)).programs[0]!;
    const contract = await f.store.getJson<AcceptanceContract>(original.contract);
    const descriptor = await f.store.readTypedJson<Record<string, unknown>>(original.descriptor);
    const programs = await Promise.all(contract.clauses.map(async clause => ({ ...original,
      contract: await f.store.putJson({ ...contract, clauses: [clause],
        checkpoints: contract.checkpoints.filter(checkpoint => checkpoint.kind !== "assertion" || checkpoint.clauseId === clause.id) }),
      descriptor: await f.store.putTypedJson({ ...descriptor, clauses: [{ clauseId: clause.id, checkpointId: clause.checkpointId }] }, original.descriptor.schema),
    })));
    let reviews = 0;
    const verifier = createVerifierAgent({ semanticReview: true, artifacts: f.store, adapter: f.adapter, model: { async run(request) {
      if (request.role === "semantic_review" && reviews++ === 0) return { totalTokens: 100 };
      return f.model.run(request);
    } } });
    const partial = await verifier.check({ ...f.job, jobId: "partial-review", mode: "discover", programs }, new AbortController().signal);
    assert.deepEqual(partial.outcomes.map(outcome => outcome.status), ["inconclusive", "inconclusive"]);
    assert.match(partial.outcomes[0]!.reason!, /Independent semantic review did not call finish/);
    assert.equal(partial.programs.length, 2, "both programs remain available for retry");
    const manifest = await f.store.getJson<VerifierManifest>(partial.manifest);
    assert.equal(manifest.reviews.length, 0, "an unsubmitted batch is not cached");
    const retried = await f.verifier.check({ ...f.job, jobId: "review-retry", mode: "discover", programs: partial.programs }, new AbortController().signal);
    assert(retried.outcomes.every(outcome => outcome.status === "pass"));
    assert.equal(f.roles.filter(role => role === "exploration").length, 1);
    assert.equal(f.closed, f.environments);
  } finally { await f.cleanup(); }
});

test("one local correction repairs only rejected coverage and retains approved sibling replay", async () => {
  const config = { source: "// original" };
  const f = await fixture(config);
  try {
    const original = (await f.verifier.check(f.job, new AbortController().signal)).programs[0]!;
    const contract = await f.store.getJson<AcceptanceContract>(original.contract);
    const descriptor = await f.store.readTypedJson<Record<string, unknown>>(original.descriptor);
    const split = await Promise.all(contract.clauses.map(async (clause, index) => ({ ...original,
      contract: await f.store.putJson({ ...contract, clauses: [clause],
        checkpoints: contract.checkpoints.filter(point => point.kind !== "assertion" || point.clauseId === clause.id) }),
      descriptor: await f.store.putTypedJson({ ...descriptor, source: await f.store.putBytes(index ? "// sibling" : "// invalid"),
        clauses: [{ clauseId: clause.id, checkpointId: clause.checkpointId }] }, original.descriptor.schema),
    })));
    const requests: VerifierModelRequest[] = [];
    const verifier = createVerifierAgent({ semanticReview: true, artifacts: f.store, adapter: f.adapter, model: { async run(request) {
      requests.push(request);
      const payload = JSON.parse(request.prompt);
      if (request.role === "semantic_review") {
        await request.tools[0]!.execute({ reviews: payload.programs.map((entry: { programId: string; source: string; contract: AcceptanceContract }) => ({
          programId: entry.programId, approved: entry.source !== "// invalid", reasons: entry.source === "// invalid" ? ["Incorrect source expectation"] : [],
          clauseIds: entry.contract.clauses.map(clause => clause.id),
        })) });
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
    const report = await verifier.check({ ...f.job, mode: "discover", programs: split }, new AbortController().signal);
    assert(report.outcomes.every(outcome => outcome.status === "pass"));
    assert.deepEqual(requests.map(request => request.role), ["semantic_review", "exploration", "semantic_review"]);
    assert.equal(report.programs.length, 3, "rejected history is retained with the sibling and replacement");
    assert.equal(f.replays, 4, "one initial fixture replay, then each sibling and the replacement exactly once");
    const final = await verifier.check({ ...f.job, jobId: "final-local-repair", mode: "replay", programs: report.programs }, new AbortController().signal);
    assert(final.outcomes.every(outcome => outcome.status === "pass"));
    assert.equal(requests.length, 3, "the approved replacement is reused without rediscovery or review");
    assert.equal(f.replays, 6);
    assert.equal(f.closed, f.environments);
  } finally { await f.cleanup(); }
});

test("fresh rejection gets at most one local correction and remains inconclusive if rejected again", async () => {
  const config = { rejectReview: true, source: "" };
  const f = await fixture(config);
  let attempts = 0;
  try {
    const verifier = createVerifierAgent({ semanticReview: true, artifacts: f.store, adapter: f.adapter, model: { async run(request) {
      if (request.role === "exploration") config.source = `// attempt ${++attempts}`;
      return f.model.run(request);
    } } });
    const report = await verifier.check(f.job, new AbortController().signal);
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
  const model: VerifierModel = { async run(request) {
    assert.equal(request.role, "exploration"); explorations++;
    const payload = JSON.parse(request.prompt);
    assert.equal("limitations" in payload, false);
    const unsupported = payload.sourceClauses.map((clause: SourceClause) => ({ clauseId: clause.id, reason: "The cross-window animation cannot be observed with sufficient timing evidence",
      attempts: ["Inspected both windows and tried the available state observations; intermediate frames remain unobservable"] }));
    const finish = request.tools.find(tool => tool.name === "finish")!;
    await assert.rejects(finish.execute({ programs: [], unsupported: [{ ...unsupported[0], attempts: [] }] }), /reason and attempts/);
    await assert.rejects(finish.execute({ programs: [], unsupported: [{ ...unsupported[0], clauseId: "invented" }] }), /source clause/);
    await finish.execute({ programs: [], unsupported });
    return { totalTokens: 100 };
  } };
  try {
    const verifier = createVerifierAgent({ semanticReview: true, artifacts: f.store, adapter: f.adapter, model });
    const first = await verifier.check(f.job, new AbortController().signal);
    assert(first.outcomes.every(outcome => outcome.status === "inconclusive" && /Unable to verify:.*cross-window animation/.test(outcome.reason!)));
    const progress: VerifierProgress[] = [];
    const restarted = createVerifierAgent({ semanticReview: true, artifacts: new ArtifactStore(f.directory, f.store.runId), adapter: f.adapter, model });
    const second = await restarted.check({ ...f.job, jobId: "gap-replay" }, new AbortController().signal,
      async event => { progress.push(event); });
    assert.equal(explorations, 1);
    assert.equal(f.environments, 1, "a gap on the same snapshot defaults to reuse without another exploration environment");
    assert(second.outcomes.every(outcome => outcome.status === "inconclusive"));
    assert.equal(progress.filter(event => event.cached && event.stage === "diagnostic").length, 2);
    const manifest = await f.store.getJson<VerifierManifest>(second.manifest);
    assert.equal(manifest.unsupported!.length, 2);
    await verifier.check({ ...f.job, jobId: "new-gap-snapshot", snapshot: await f.store.putJson({ sha: "new-source" }) }, new AbortController().signal);
    assert.equal(explorations, 2, "a new application snapshot requires another attempt");
    const input = await f.store.getJson<VerifierRequirements>(f.job.requirements);
    await verifier.check({ ...f.job, jobId: "changed-gap-context", requirements: await f.store.putJson({ ...input, contextVersion: 2 }) }, new AbortController().signal);
    assert.equal(explorations, 3, "requirement changes require a fresh assessment");
    assert.equal(f.closed, f.environments);
  } finally { await f.cleanup(); }
});

test("unverifiable-gap reuse preserves a verifiable sibling and expires when adapter capabilities change", async () => {
  const f = await fixture();
  const model: VerifierModel = { async run(request) {
    if (request.role !== "exploration") return f.model.run(request);
    const payload = JSON.parse(request.prompt);
    const gap = { clauseId: payload.sourceClauses[0].id, reason: "Required evidence cannot be obtained in this execution context", attempts: ["Inspected the application and tried the applicable observation tools"], retryable: false };
    const finish = request.tools.find(tool => tool.name === "finish")!;
    return f.model.run({ ...request, prompt: JSON.stringify({ ...payload, sourceClauses: payload.sourceClauses.slice(1) }),
      tools: request.tools.map(tool => tool.name === "finish" ? { ...tool, execute: args => finish.execute({ ...(args as object), unsupported: [gap] }) } : tool) });
  } };
  try {
    const verifier = createVerifierAgent({ semanticReview: true, artifacts: f.store, adapter: f.adapter, model });
    const first = await verifier.check(f.job, new AbortController().signal);
    assert.deepEqual(first.outcomes.map(outcome => outcome.status), ["inconclusive", "pass"]);
    const second = await verifier.check({ ...f.job, jobId: "gap-with-sibling", programs: first.programs }, new AbortController().signal);
    assert.deepEqual(second.outcomes.map(outcome => outcome.status), ["inconclusive", "pass"]);
    assert.deepEqual(f.roles, ["exploration", "semantic_review"]);
    assert.equal(f.replays, 2, "the verifiable sibling replays against the current job");
    const oldBinding = await f.store.getJson<ExecutionBinding>(f.job.binding);
    const declaration = await f.store.getJson<AdapterDeclaration>(oldBinding.declaration);
    const binding = { ...await f.store.putJson({ ...oldBinding, declaration: await f.store.putJson({ ...declaration, version: "2" }) }), executor: f.job.binding.executor };
    let prepares = 0;
    const changed = createVerifierAgent({ semanticReview: true, artifacts: f.store, model, adapter: { binding, async prepare() {
      prepares++; throw new Error("Fresh exploration with changed adapter");
    } } });
    const report = await changed.check({ ...f.job, jobId: "changed-capabilities", binding }, new AbortController().signal);
    assert.equal(prepares, 1);
    assert.equal((await f.store.getJson<VerifierManifest>(report.manifest)).unsupported, undefined);
    assert(report.outcomes.every(outcome => /changed adapter/.test(outcome.reason!)));
  } finally { await f.cleanup(); }
});

test("unverifiable gaps retry only when explicitly marked as a transient problem", async () => {
  const f = await fixture();
  let explorations = 0;
  const model: VerifierModel = { async run(request) {
    if (request.role === "exploration" && ++explorations === 1) {
      const payload = JSON.parse(request.prompt);
      await request.tools.find(tool => tool.name === "finish")!.execute({ programs: [], unsupported: payload.sourceClauses.map((source: SourceClause) => ({
        clauseId: source.id, reason: "The application connection was interrupted; reconnecting can restore observations", attempts: ["Opened the page and attempted to inspect the result; the connection was interrupted"], retryable: true,
      })) });
      return { totalTokens: 100 };
    }
    return f.model.run(request);
  } };
  try {
    const verifier = createVerifierAgent({ semanticReview: true, artifacts: f.store, adapter: f.adapter, model });
    assert((await verifier.check(f.job, new AbortController().signal)).outcomes.every(outcome => outcome.status === "inconclusive"));
    const second = await verifier.check({ ...f.job, jobId: "retry-transient-gap" }, new AbortController().signal);
    assert.equal(explorations, 2);
    assert(second.outcomes.every(outcome => outcome.status === "pass"));
    assert.equal((await f.store.getJson<VerifierManifest>(second.manifest)).unsupported, undefined);
  } finally { await f.cleanup(); }
});

async function groupJob(f: Awaited<ReturnType<typeof fixture>>, count = 2): Promise<CheckJob> {
  const input = await f.store.getJson<VerifierRequirements>(f.job.requirements);
  const requirements = Array.from({ length: count }, (_, i) => ({ ...input.requirements[0]!, id: `r${i + 1}`, declarationIndex: i }));
  return { ...f.job, requirementIds: requirements.map(item => item.id), requirements: await f.store.putJson({ ...input, requirements }) };
}

test("replay never starts a model for missing, unapproved, incompatible or rejected programs", async () => {
  const config = { rejectReview: false, failures: [] as number[] };
  const f = await fixture(config);
  try {
    const first = await f.verifier.check(f.job, new AbortController().signal);
    const original = first.programs[0]!;
    const descriptor = await f.store.readTypedJson<Record<string, unknown>>(original.descriptor);
    const pending = { ...original, descriptor: await f.store.putTypedJson({ ...descriptor, source: await f.store.putBytes("// unreviewed") }, original.descriptor.schema) };
    let modelCalls = 0;
    const verifier = createVerifierAgent({ semanticReview: true, artifacts: f.store, adapter: f.adapter, model: { async run() { modelCalls++; assert.fail("pure replay called the model"); } } });
    for (const programs of [[], [pending]]) {
      const report = await verifier.check({ ...f.job, jobId: `missing-${programs.length}`, mode: "replay", programs }, new AbortController().signal);
      assert(report.outcomes.every(item => item.status === "inconclusive"));
    }
    const input = await f.store.getJson<VerifierRequirements>(f.job.requirements);
    const incompatible = await verifier.check({ ...f.job, jobId: "changed-contract", mode: "replay", programs: [original],
      requirements: await f.store.putJson({ ...input, version: 2 }) }, new AbortController().signal);
    assert(incompatible.outcomes.every(item => item.status === "inconclusive"));
    config.failures = [1, 2];
    const snapshot = await f.store.putJson({ sha: "changed-business-behavior" });
    const failed = await verifier.check({ ...f.job, jobId: "current-failure", mode: "replay", programs: [original], snapshot }, new AbortController().signal);
    assert.deepEqual(failed.outcomes.map(item => item.status), ["pass", "fail"]);
    assert.equal(f.replays, 3, "current behavior is executed and its failure independently confirmed");
    config.rejectReview = true;
    const rejected = await f.verifier.check({ ...f.job, jobId: "reject-new", programs: [pending] }, new AbortController().signal);
    const before = f.replays;
    assert(rejected.programs.some(program => program.descriptor.id === pending.descriptor.id));
    const repeated = await verifier.check({ ...f.job, jobId: "rejected-replay", mode: "replay", programs: [pending] }, new AbortController().signal);
    assert(repeated.outcomes.every(item => item.status === "inconclusive" && /Semantic review rejected/.test(item.reason!)));
    assert.equal(f.replays, before);
    assert.equal(modelCalls, 0);
    assert.equal(f.closed, f.environments);
  } finally { await f.cleanup(); }
});

test("group reviews validate each whole-program decision before accepting the batch", async () => {
  const f = await fixture();
  try {
    const job = await groupJob(f);
    const verifier = createVerifierAgent({ semanticReview: true, artifacts: f.store, adapter: f.adapter, model: { async run(request) {
      if (request.role === "semantic_review") {
        const entries = JSON.parse(request.prompt).programs as Array<{ programId: string; contract: AcceptanceContract }>;
        assert.equal(entries.length, 2);
        const decisions = entries.map(item => ({ programId: item.programId, approved: true, reasons: [], clauseIds: item.contract.clauses.map(clause => clause.id) }));
        const finish = request.tools[0]!;
        for (const reviews of [[decisions[0]], [decisions[0], decisions[0]], [{ ...decisions[0], programId: "invented" }, decisions[1]]]) {
          await assert.rejects(finish.execute({ reviews }), /each program exactly once/);
        }
        await assert.rejects(finish.execute({ reviews: [{ ...decisions[0], clauseIds: decisions[1]!.clauseIds }, decisions[1]] }), /each contract clause exactly once/);
      }
      return f.model.run(request);
    } } });
    const report = await verifier.check(job, new AbortController().signal);
    assert(report.outcomes.every(item => item.status === "pass"));
    assert.deepEqual(JSON.parse(f.reviewPrompts[0]!).programs.map((item: { programId: string }) => item.programId), report.programs.map(contentDigest));
    assert.equal(f.reviewPrompts.length, 1);
  } finally { await f.cleanup(); }
});

test("review batches bound program count and input bytes and cache decisions individually", async () => {
  for (const config of [{ count: 5, source: "// ordinary" }, { count: 2, source: "//" + "x".repeat(150_000) }]) {
    const f = await fixture({ source: config.source });
    try {
      const job = await groupJob(f, config.count);
      const report = await f.verifier.check(job, new AbortController().signal);
      assert(report.outcomes.every(item => item.status === "pass"));
      assert.equal(f.reviewPrompts.length, 2);
      const [firstReview, secondReview] = f.reviewPrompts;
      assert(firstReview!.startsWith('{"capabilities":'));
      const requirementsBoundary = ',"requirements":';
      assert.equal(firstReview!.slice(0, firstReview!.indexOf(requirementsBoundary)),
        secondReview!.slice(0, secondReview!.indexOf(requirementsBoundary)),
        "review batches share the job-invariant capabilities prefix");
      const replay = await f.verifier.check({ ...job, jobId: "batch-replay", mode: "replay", programs: report.programs }, new AbortController().signal);
      assert(replay.outcomes.every(item => item.status === "pass"));
      assert.equal(f.reviewPrompts.length, 2, "batch membership is not part of per-program review identity");
      assert.equal(f.closed, f.environments);
    } finally { await f.cleanup(); }
  }
});

test("a later review batch failure retains earlier approved programs and leaves its own programs pending", async () => {
  const f = await fixture();
  try {
    const job = await groupJob(f, 5);
    let reviews = 0;
    const verifier = createVerifierAgent({ semanticReview: true, artifacts: f.store, adapter: f.adapter, model: { async run(request) {
      if (request.role === "semantic_review" && ++reviews === 2) throw new Error("Review connection failed");
      return f.model.run(request);
    } } });
    const report = await verifier.check(job, new AbortController().signal);
    assert.deepEqual(report.outcomes.map(item => item.status), [...Array(8).fill("pass"), "inconclusive", "inconclusive"]);
    assert(report.outcomes.slice(8).every(item => /Review connection failed/.test(item.reason!)));
    const manifest = await f.store.getJson<VerifierManifest>(report.manifest);
    assert.equal(manifest.reviews.length, 4);
    const replay = await verifier.check({ ...job, jobId: "pending-batch-replay", mode: "replay", programs: report.programs }, new AbortController().signal);
    assert.deepEqual(replay.outcomes.map(item => item.status), report.outcomes.map(item => item.status));
    assert.equal(reviews, 2, "pure replay does not retry the unfinished review");
  } finally { await f.cleanup(); }
});

test("one group exploration produces independent scenario programs and scoped replay reuses its context", async () => {
  const f = await fixture();
  try {
    const job = await groupJob(f);
    const verifier = createVerifierAgent({ semanticReview: true, artifacts: f.store, adapter: f.adapter, model: { async run(request) {
      if (request.role === "exploration") {
        const sources = (JSON.parse(request.prompt) as { sourceClauses: SourceClause[] }).sourceClauses;
        const mixed = { checkpoints: sources.map((source, i) => ({ id: `mixed-${i}`, kind: "assertion", requirementId: source.requirementId,
          scenarioId: source.scenarioId, clauseId: source.id, dependsOn: [], basis: source.basis })),
          clauses: sources.map((source, i) => ({ ...source, checkpointId: `mixed-${i}`, expected: { operator: "equal", value: 5 } })) };
        await assert.rejects(request.tools.find(tool => tool.name === "check_program")!.execute({ contract: mixed, source: "// invalid mixed contract" }), /one requirement scenario/);
      }
      return f.model.run(request);
    } } });
    const report = await verifier.check(job, new AbortController().signal);
    assert.deepEqual(f.roles, ["exploration", "semantic_review"]);
    assert.equal(JSON.parse(f.explorationPrompts[0]!).sourceClauses.length, 4);
    assert.equal(report.programs.length, 2);
    assert.equal(f.environments, 3, "one shared discovery and one independent replay per scenario");
    assert(report.outcomes.every(outcome => outcome.status === "pass"));
    const first = report.programs[0]!;
    const scoped = await verifier.check({ ...job, jobId: "scope-r1", requirementIds: ["r1"], programs: [first] }, new AbortController().signal);
    assert(scoped.outcomes.every(outcome => outcome.requirementId === "r1" && outcome.status === "pass"));
    assert.equal(f.roles.length, 2, "scope-only replay retains the group context and cached review");
    assert.equal(f.replays, 3);
  } finally { await f.cleanup(); }
});

test("merged history prefers an approved program over a newer unreviewed candidate", async () => {
  const f = await fixture();
  try {
    const job = await groupJob(f);
    const original = await f.verifier.check(job, new AbortController().signal);
    const approved = original.programs[0]!;
    const descriptor = await f.store.readTypedJson<Record<string, unknown>>(approved.descriptor);
    const pending = { ...approved, descriptor: await f.store.putTypedJson({ ...descriptor,
      source: await f.store.putBytes("// unfinished newer candidate") }, approved.descriptor.schema) };
    const report = await f.verifier.check({ ...job, jobId: "merged-candidates", programs: [pending, ...original.programs] }, new AbortController().signal);
    assert(report.outcomes.every(outcome => outcome.status === "pass"));
    assert.deepEqual(f.roles, ["exploration", "semantic_review"]);
    assert.equal(report.programs.length, 2);
    assert(report.programs.some(program => program.descriptor.id === approved.descriptor.id));
    assert(!report.programs.some(program => program.descriptor.id === pending.descriptor.id));
  } finally { await f.cleanup(); }
});

test("a failed scenario closes its environment and leaves sibling programs verifiable", async () => {
  const f = await fixture();
  try {
    const job = await groupJob(f);
    const original = await f.verifier.check(job, new AbortController().signal);
    const verifier = createVerifierAgent({ semanticReview: true, artifacts: f.store, model: f.model, adapter: { binding: f.adapter.binding, async prepare(job, signal) {
      assert.equal(f.closed, f.environments, "a previous scenario must release its environment before the next starts");
      const session = await f.adapter.prepare(job, signal);
      return { ...session, async replay(program, signal) {
        const contract = await f.store.getJson<AcceptanceContract>(program.contract);
        if (contract.clauses[0]!.requirementId === "r1") throw new Error("Scenario r1 preparation failed");
        return session.replay(program, signal);
      } };
    } } });
    const report = await verifier.check({ ...job, jobId: "isolated-failure", programs: original.programs }, new AbortController().signal);
    assert.deepEqual(report.outcomes.map(outcome => outcome.status), ["inconclusive", "inconclusive", "pass", "pass"]);
    assert(report.outcomes.slice(0, 2).every(outcome => /Scenario r1 preparation failed/.test(outcome.reason!)));
    assert.equal(f.roles.length, 2, "an infrastructure error does not trigger another exploration or review");
    assert.equal(f.closed, f.environments);
  } finally { await f.cleanup(); }
});

test("discovery exhaustion preserves verified siblings and saved candidates for later independent review", { timeout: 15_000 }, async () => {
  const config = { source: "// original" };
  const f = await fixture(config);
  try {
    const job = await groupJob(f);
    const original = await f.verifier.check(job, new AbortController().signal);
    config.source = "// saved before discovery exhaustion";
    const verifier = createVerifierAgent({ semanticReview: true, artifacts: f.store, adapter: f.adapter, model: { async run(request) {
      return f.model.run({ ...request, tools: request.tools.map(tool => request.role === "exploration" && tool.name === "finish" ? { ...tool, async execute() {
        request.signal.throwIfAborted();
        await new Promise<never>((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }));
      } } : tool) });
    } } });
    const report = await verifier.check({ ...job, jobId: "partial-discovery", programs: [original.programs[0]!],
      budget: { deadlineAt: Date.now() + 30_000, timeoutMs: 2_000 } }, new AbortController().signal);
    assert.deepEqual(report.outcomes.map(outcome => outcome.status), ["pass", "pass", "inconclusive", "inconclusive"]);
    assert.equal(report.programs.length, 2, "saved candidates survive without granting unreviewed results");
    assert(report.outcomes.slice(2).every(outcome => /timeout|aborted/i.test(outcome.reason!)));
    const explorations = f.roles.filter(role => role === "exploration").length;
    const resumed = await f.verifier.check({ ...job, jobId: "resume-candidate", programs: report.programs }, new AbortController().signal);
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
    await assert.rejects(createVerifierAgent({ semanticReview: true, artifacts: f.store, adapter, model: f.model }).check({ ...f.job, mode: "prepare" }, new AbortController().signal), VerifierCleanupError);
  } finally { await f.cleanup(); }
});

test("Verifier cancellation awaits cleanup and returns unconfirmed results", async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    const verifier = createVerifierAgent({ semanticReview: true, artifacts: f.store, adapter: f.adapter, model: { async run(request: VerifierModelRequest) {
      controller.abort(new Error("Cancelled test job")); request.signal.throwIfAborted(); return { totalTokens: 0 };
    } } });
    const report = await verifier.check(f.job, controller.signal);
    assert(report.outcomes.every(item => item.status === "inconclusive"));
    assert.equal(f.environments, 1); assert.equal(f.closed, 1);
  } finally { await f.cleanup(); }
});

test("production Pi Verifier retries a transient connection failure before using the model", { timeout: 20_000 }, async () => {
  const f = await fixture();
  let requests = 0;
  const server = createServer(async (req, res) => {
    requests += 1;
    if (requests === 1) { req.socket.destroy(); return; }
    const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "verifier", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "verifier", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert(address && typeof address !== "string");
    const usage: VerifierModelUsage[] = [];
    const model = createPiVerifierModel({ gateway: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-test", model: "test-verifier" }, sessionDir: join(f.directory, "sessions"), onUsage: item => usage.push(item) });
    const result = await model.run({ role: "exploration", job: f.job, systemPrompt: "Reply.", prompt: "Hello.", tools: [], signal: new AbortController().signal });
    assert.equal(requests, 2, "the first transient connection failure must be retried");
    assert.equal(result.totalTokens, 13);
    assert.equal(usage.length, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await f.cleanup();
  }
});

test("production Pi Verifier repairs a truncated terminal SSE trailer instead of discarding the turn", { timeout: 20_000 }, async () => {
  const f = await fixture();
  let requests = 0;
  const server = createServer(async (req, res) => {
    requests += 1;
    const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "verifier", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "recovered" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "verifier", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`);
    res.end('data: {"created":1,"usage":nu');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert(address && typeof address !== "string");
    const usage: VerifierModelUsage[] = [];
    const model = createPiVerifierModel({ gateway: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-test", model: "test-verifier" }, sessionDir: join(f.directory, "sessions"), onUsage: item => usage.push(item) });
    const result = await model.run({ role: "exploration", job: f.job, systemPrompt: "Reply.", prompt: "Hello.", tools: [], signal: new AbortController().signal });
    assert.equal(requests, 1, "the completed turn must survive one damaged usage trailer");
    assert.equal(result.totalTokens, 13);
    assert.equal(usage.length, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await f.cleanup();
  }
});

test("production Pi Verifier retries an observed TCP reset reported as HTTP 400", { timeout: 20_000 }, async () => {
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
    res.write(`data: ${JSON.stringify({ id: "verifier", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "recovered" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "verifier", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert(address && typeof address !== "string");
    let now = 0;
    const recovery = new GatewayRecovery({ now: () => now, sleep: async ms => { now += ms; } });
    const model = createPiVerifierModel({ gateway: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-test", model: "test-verifier" },
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

test("production Pi Verifier compacts a long transcript before the context window overflows", { timeout: 30_000 }, async () => {
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
    res.write(`data: ${JSON.stringify({ id: "verifier", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "verifier", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }], usage: { prompt_tokens: summary ? 1_000 : first ? 18_000 : 30_000, completion_tokens: 10, total_tokens: summary ? 1_010 : first ? 18_010 : 30_010 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert(address && typeof address !== "string");
    const model = createPiVerifierModel({ gateway: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-test", model: "test-verifier" },
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

test("production Pi Verifier session exposes only declared tools, calls finish and attributes usage", async () => {
  const f = await fixture();
  const payloads: Array<Record<string, unknown>> = [];
  let finished = false;
  const usage: VerifierModelUsage[] = [];
  const progress: VerifierModelUsage[] = [];
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
    const payload = JSON.parse(Buffer.concat(parts).toString()) as Record<string, unknown>;
    payloads.push(payload);
    const tool = payloads.length === 1;
    const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: "finish-1", type: "function", function: { name: "finish", arguments: "{}" } }] } : { role: "assistant", content: "Review submitted." };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "verifier", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "verifier", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, completion_tokens_details: { reasoning_tokens: 1 } } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert(address && typeof address !== "string");
    const model = createPiVerifierModel({ gateway: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-test", model: "test-verifier" }, sessionDir: join(f.directory, "sessions"), onUsage: item => usage.push(item), onProgress: item => progress.push(item) });
    await model.run({ role: "semantic_review", job: f.job, systemPrompt: "Use finish.", prompt: "Review.",
      tools: [{ name: "finish", description: "Submit review", parameters: Type.Object({}), async execute() { finished = true; return {}; } }], signal: new AbortController().signal });
    assert.equal(finished, true); assert.equal(payloads.length, 1);
    for (const payload of payloads) {
      const tools = payload.tools as Array<{ function: { name: string } }>;
      assert.deepEqual(tools.map(item => item.function.name), ["finish"]);
      assert(!JSON.stringify(payload).includes("E:\\\\my-works"));
    }
    assert.equal(usage.length, 1); assert.equal(usage[0]!.role, "semantic_review"); assert.equal(usage[0]!.jobId, f.job.jobId);
    assert.equal(usage[0]!.input, 10); assert.equal(usage[0]!.output, 3);
    assert.equal(progress.length, 1, "the submitted tool turn is billed without a follow-up model request");
    assert.deepEqual(progress.map(item => [item.input, item.output, item.total]), [[10, 3, 13]]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await f.cleanup();
  }
});

test("production Pi Verifier requires a successful finish and bounds same-session submission reminders", { timeout: 30_000 }, async t => {
  const cases = [
    { name: "exploration submits after a text-only answer", role: "exploration" as const, actions: ["text", "finish"], reminders: 1, rejected: false, succeeds: true },
    { name: "review submits after a JSON-only answer", role: "semantic_review" as const, actions: ["text", "finish"], reminders: 1, rejected: false, succeeds: true },
    { name: "a rejected finish does not complete the session", role: "semantic_review" as const, actions: ["finish", "text", "finish"], reminders: 1, rejected: true, succeeds: true },
    { name: "a mixed tool batch ends after its successful finish", role: "exploration" as const, actions: ["invoke_finish"], reminders: 0, rejected: false, succeeds: true },
    { name: "persistent JSON-only answers stop after two reminders", role: "semantic_review" as const, actions: ["text", "text", "text"], reminders: 2, rejected: false, succeeds: false },
  ];
  for (const config of cases) await t.test(config.name, async () => {
    const f = await fixture();
    const payloads: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    const usage: VerifierModelUsage[] = [];
    let finishCalls = 0, accepted = 0;
    const server = createServer(async (req, res) => {
      const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
      payloads.push(JSON.parse(Buffer.concat(parts).toString()));
      const action = config.actions[payloads.length - 1];
      const tool = action === "finish" || action === "invoke_finish";
      const delta = tool
        ? { role: "assistant", tool_calls: [{ index: 0, id: `finish-${payloads.length}`, type: "function", function: { name: "finish", arguments: "{}" } }] }
        : { role: "assistant", content: '{"approved":true,"reasons":[],"clauseIds":["r1"]}' };
      if (action === "invoke_finish") delta.tool_calls?.unshift({ index: 0, id: "inspect", type: "function", function: { name: "inspect", arguments: "{}" } });
      delta.tool_calls?.forEach((call, index) => { call.index = index; });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "verifier", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "verifier", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); assert(address && typeof address !== "string");
      const model = createPiVerifierModel({ gateway: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-test", model: "test-verifier" },
        sessionDir: join(f.directory, "sessions"), onUsage: item => usage.push(item) });
      const call = model.run({ role: config.role, job: f.job, systemPrompt: "Call finish to submit.", prompt: "Check the fixed candidate.",
        tools: [{ name: "inspect", description: "Observe", parameters: Type.Object({}), async execute() { return {}; } },
          { name: "finish", description: "Submit", parameters: Type.Object({}), async execute() {
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

for (const failure of ["reset", "rate_limit", "truncated"] as const) {
  test(`Pi Verifier preserves tool results through exhausted SDK retries: ${failure}`, { timeout: 20_000 }, async () => {
    const f = await fixture();
    let requests = 0, inspections = 0, submissions = 0;
    const errors: unknown[] = [], waits: number[] = [];
    const server = createServer(async (req, res) => {
      try {
        const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
        const body = JSON.parse(Buffer.concat(parts).toString());
        requests++;
        const failures = failure === "reset" ? 6 : 3;
        if (requests > 1 && requests <= failures + 1) {
          if (failure === "truncated") {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end('data: {"choices":[{"delta":{"tool_calls":');
          } else {
            res.writeHead(failure === "reset" ? 400 : 429,
              { "content-type": "application/json", ...(failure === "rate_limit" ? { "retry-after": "40" } : {}) });
            res.end(JSON.stringify({ message: failure === "reset"
              ? '400 Post "https://api.example/v1/chat/completions": read tcp 127.0.0.1:60000->127.0.0.1:443: read: connection reset by peer (request id: same-session)'
              : "rate limit" }));
          }
          return;
        }
        const tool = requests === 1 ? "inspect" : "finish";
        if (tool === "finish") {
          assert.match(JSON.stringify(body.messages), /OBSERVED_STATE_SENTINEL/);
          assert.match(JSON.stringify(body.messages), /ORIGINAL_REQUIREMENT_SENTINEL/);
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0,
          id: `call-${requests}`, type: "function", function: { name: tool, arguments: "{}" } }] }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 10, completion_tokens: 3 } })}\n\n`);
        res.end("data: [DONE]\n\n");
      } catch (error) { errors.push(error); res.writeHead(500); res.end(); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); assert(address && typeof address !== "string");
      let now = 0;
      const recovery = new GatewayRecovery({ now: () => now, sleep: async ms => { waits.push(ms); now += ms; } });
      const usage: VerifierModelUsage[] = [];
      const directory = join(f.directory, "sessions");
      const model = createPiVerifierModel({ gateway: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "fixture", model: "fixture" },
        sessionDir: directory, recovery, onUsage: item => usage.push(item) });
      await model.run({ role: "exploration", job: f.job, signal: new AbortController().signal,
        systemPrompt: "Inspect, then finish.", prompt: "ORIGINAL_REQUIREMENT_SENTINEL", tools: [
          { name: "inspect", description: "Inspect once", parameters: Type.Object({}),
            async execute() { inspections++; return { state: "OBSERVED_STATE_SENTINEL" }; } },
          { name: "finish", description: "Submit", parameters: Type.Object({}),
            async execute() { submissions++; return { accepted: true }; } },
        ] });
      assert.deepEqual(errors, []);
      assert.equal(inspections, 1); assert.equal(submissions, 1);
      assert.equal(requests, failure === "reset" ? 8 : 5);
      assert.equal((await readdir(directory)).length, 1, "recovery must retain the same private session");
      assert.equal(usage.length, 1, "the session is settled once across recovery");
      assert.equal(waits.reduce((sum, ms) => sum + ms, 0), failure === "rate_limit" ? 40_000 : failure === "reset" ? 195_000 : 5_000);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await f.cleanup();
    }
  });
}
