import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { ArtifactStore, atomicWrite, canonicalJson, contentDigest, hashBytes } from "./artifacts.js";
import type { AdapterDeclaration, CheckOutcome, CheckReport, CheckerPort, CheckerProgress, ContentRef, EvidenceReceipt, ExecutionAdapter, ExecutionSession, ProgramRef, ReviewEvidence } from "./port.js";
import { checkerSourceClauses, evaluateProgramEvidence, sameRef, validateAcceptanceContract,
  type AcceptanceContract, type CheckerManifest, type CheckerProgramDescriptor, type CheckerRequirements, type SemanticReview, type UnsupportedClause } from "./evidence.js";
import type { CheckerModel, CheckerTool } from "./model.js";
import type { AtomicRequirement } from "../types.js";
import { SOURCE_TREE_MAX_DEPTH, SOURCE_TREE_MAX_LIMIT, type CheckerSourceIndex, type CheckerSourceView } from "./source-index.js";
import { compactExecutionFeedback, feedbackSlice, type ExecutionFeedback } from "./feedback.js";

export { createPiCheckerModel } from "./model.js";
export type { CheckerModel, CheckerModelUsage } from "./model.js";
export type { CheckerRequirements } from "./evidence.js";

async function promptAsset(name: string): Promise<string> {
  return (await readFile(fileURLToPath(new URL(`../../prompts/checker/${name}.md`, import.meta.url)), "utf8")).trimEnd();
}
const refSchema = Type.Object({ id: Type.String(), digest: Type.String() });
const programSchema = Type.Object({ descriptor: Type.Object({ id: Type.String(), digest: Type.String(), schema: refSchema, mediaType: Type.String() }),
  format: Type.String(), contract: refSchema, binding: Type.Object({ id: Type.String(), digest: Type.String(), executor: Type.Object({ id: Type.String(), version: Type.String(), digest: Type.String() }) }) });
/** Values with an application-defined shape still advertise an object root to the model and gateway. */
const toolObjectSchema = Type.Object({}, { additionalProperties: true });
const PROGRAM_REPAIR_MS = 10 * 60_000;
const REVIEW_BATCH_PROGRAMS = 4;
const REVIEW_BATCH_BYTES = 256_000;
type RejectedProgram = { program: ProgramRef; source: string; contract: AcceptanceContract; clauseIds: string[]; reasons: string[]; observations?: unknown[] };

export class CheckerCleanupError extends Error {
  readonly code = "CHECKER_CLEANUP_FAILED";
  constructor(cause: unknown) { super(`Checker execution cleanup failed: ${String(cause)}`, { cause }); this.name = "CheckerCleanupError"; }
}

function compareId(left: { id: string }, right: { id: string }): number { return left.id < right.id ? -1 : left.id > right.id ? 1 : 0; }
function compareClauseId(left: { clauseId: string }, right: { clauseId: string }): number { return left.clauseId < right.clauseId ? -1 : left.clauseId > right.clauseId ? 1 : 0; }

/** Keep the review prompt scoped to the program while preserving source-grounded context. */
function semanticReviewRequirements(input: CheckerRequirements, contract: Pick<AcceptanceContract, "clauses">): Array<Partial<AtomicRequirement> & Pick<AtomicRequirement, "id" | "name" | "text">> {
  const ids = new Set(contract.clauses.map(clause => clause.requirementId));
  return input.requirements.filter(requirement => ids.has(requirement.id)).sort(compareId).map(requirement => ({
    id: requirement.id,
    name: requirement.name,
    text: requirement.text,
    scenarios: requirement.scenarios,
    ...(requirement.scenarioContracts ? { scenarioContracts: requirement.scenarioContracts } : {}),
    references: requirement.references,
    exactUiStrings: requirement.exactUiStrings,
    seedDeclarations: requirement.seedDeclarations,
    product: {
      kind: requirement.product.kind,
      rootId: requirement.product.rootId,
      rootName: requirement.product.rootName,
      description: requirement.product.description,
      seedData: requirement.product.seedData,
      ...(requirement.product.evolution ? { evolution: true as const } : {}),
      ...(requirement.product.stage ? { stage: requirement.product.stage } : {}),
    },
    ancestors: requirement.ancestors.map(ancestor => ({ id: ancestor.id, name: ancestor.name, description: ancestor.description })),
  }));
}

function reviewProgramPayload(program: ProgramRef, contract: AcceptanceContract,
  descriptor: CheckerProgramDescriptor, source: string, evidence: ReviewEvidence[]): Record<string, unknown> {
  const environments = [...new Map(evidence.map(item => [item.receipt.environment.id, item.environment])).entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return {
    programId: contentDigest(program),
    contract: {
      requirements: contract.requirements,
      checkpoints: [...contract.checkpoints].sort(compareId),
      clauses: [...contract.clauses].sort(compareId),
    },
    descriptor: { ...descriptor, clauses: [...descriptor.clauses].sort(compareClauseId) },
    source,
    environments: Object.fromEntries(environments),
    // Receipts are execution-specific and intentionally remain the final prompt field.
    receipts: evidence.map(item => reviewReceipt(item.receipt, item.payload)),
  };
}

function reviewReceipt(receipt: EvidenceReceipt, payload: unknown): Record<string, unknown> {
  return {
    receipt: {
      id: receipt.id,
      kind: receipt.kind,
      sequence: receipt.sequence,
      checkpointId: receipt.checkpointId,
      readiness: receipt.readiness,
      assertion: receipt.assertion,
      inputs: receipt.inputs,
      environmentId: receipt.environment.id,
    },
    payload,
  };
}

/** Exploration, semantic review and replay share one immutable task, with separate model sessions. */
export function createCheckerAgent(options: { artifacts: ArtifactStore; adapter: ExecutionAdapter; model: CheckerModel; sourceIndex?: CheckerSourceIndex;
  semanticReview?: boolean }): CheckerPort {
  const { artifacts: store, adapter, model } = options;
  const semanticReview = options.semanticReview === true;
  const invocationInput = async (capabilityId: string, schema: ContentRef, input: unknown): Promise<unknown> => {
    try { await store.validateSchema(schema, input); return input; }
    catch (error) {
      if (typeof input !== "string") throw new Error(`Capability ${capabilityId} input does not satisfy its declared schema: ${errorMessage(error)}`);
      let decoded: unknown;
      try { decoded = JSON.parse(input); }
      catch { throw new Error(`Capability ${capabilityId} input must satisfy its declared schema; received a string that is not valid JSON`); }
      try { await store.validateSchema(schema, decoded); return decoded; }
      catch { throw new Error(`Capability ${capabilityId} input must satisfy its declared schema; the JSON-encoded value also does not match`); }
    }
  };
  return { async check(job, parentSignal, onProgress) {
    const limit = Math.min(job.budget.deadlineAt, Date.now() + (job.budget.timeoutMs ?? Infinity));
    // Finish work before queue expiry so cleanup and a partial report can still commit.
    const deadlineAt = limit - Math.min(5_000, Math.max(0, Math.floor((limit - Date.now()) / 10)));
    const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(Math.max(1,
      Math.min(2_147_483_647, deadlineAt - Date.now())))]);
    const manifest: CheckerManifest = { schemaVersion: 1, contracts: [], reviews: [], receipts: [], diagnostics: [] };
    const programs = new Map<string, ProgramRef>();
    const input = await store.getJson<CheckerRequirements>(job.requirements);
    const sources = checkerSourceClauses(input, job.requirementIds);
    const missingProgramReason = semanticReview ? "No reviewed program covered this source result" : "No executed program covered this source result";
    const outcomeMap = new Map<string, CheckOutcome>(sources.map(source => [source.id, { requirementId: source.requirementId,
      scenarioId: source.scenarioId, clauseId: source.id, status: "inconclusive", evidence: [], reason: missingProgramReason }]));
    for (const id of job.requirementIds) if (!sources.some(source => source.requirementId === id)) outcomeMap.set(`${id}:missing-source`, {
      requirementId: id, scenarioId: "unknown", clauseId: `${id}:missing-source`, status: "inconclusive", evidence: [], reason: "Requirement has no source result clause" });
    let cleanupFailure: CheckerCleanupError | undefined;
    const sessions = new Set<ExecutionSession>();
    let sourceView: CheckerSourceView | undefined;
    const progress = async (detail: CheckerProgress): Promise<void> => {
      try { await onProgress?.(detail); } catch { /* Presentation failures must not change evidence or prevent cleanup. */ }
    };
    const prepare = async (executionSignal = signal): Promise<ExecutionSession> => {
      executionSignal.throwIfAborted();
      await progress({ stage: "prepare" });
      let session: ExecutionSession;
      try { session = await adapter.prepare(job, executionSignal); }
      catch (error) {
        const failure = error as { readinessEvidence?: ContentRef[]; code?: string };
        if (failure?.readinessEvidence) manifest.receipts.push(...failure.readinessEvidence);
        if (failure?.code === "CHECKER_CLEANUP_FAILED") cleanupFailure = new CheckerCleanupError(error);
        throw error;
      }
      sessions.add(session);
      manifest.receipts.push(...session.readinessEvidence);
      return session;
    };
    const close = async (session: ExecutionSession): Promise<void> => {
      await progress({ stage: "cleanup" });
      try { await session.close(); sessions.delete(session); }
      catch (error) { cleanupFailure = new CheckerCleanupError(error); throw cleanupFailure; }
    };
    const ready = async (session: ExecutionSession): Promise<boolean> => {
      const receipts = await Promise.all(session.readinessEvidence.map(ref => store.getJson<EvidenceReceipt>(ref)));
      for (const receipt of receipts) await store.validateReceipt(job, receipt);
      return receipts.length > 0 && receipts.every(receipt => receipt.kind === "readiness" && receipt.readiness?.result === "ready"
        && sameRef(receipt.environment, session.execution));
    };
    const runModel = async (role: "exploration" | "semantic_review", systemPrompt: string, prompt: string, tools: CheckerTool[], modelSignal = signal): Promise<void> => {
      modelSignal.throwIfAborted();
      await model.run({ role, job, systemPrompt, prompt, tools, signal: modelSignal });
    };
    try {
      if (!sameRef(adapter.binding, job.binding)) throw new Error("Checker adapter binding mismatch");
      const binding = await store.validateBinding(job.binding);
      const declaration = await store.getJson<AdapterDeclaration>(binding.declaration);
      const genericPrompts = await Promise.all(["exploration", "review", "tools", "submission"].map(promptAsset));
      const adapterPrompts = await Promise.all(declaration.prompts.map(ref => store.getBytes(ref).then(bytes => bytes.toString("utf8"))));
      const promptDigest = hashBytes(genericPrompts.join("\n\n"));
      // Review uses only review/tools/adapter prompts. Keep its cache key independent
      // from exploration and submission edits so unrelated prompt changes do not
      // invalidate already approved review decisions.
      const reviewPromptDigest = hashBytes([genericPrompts[1], genericPrompts[2], ...adapterPrompts].join("\n\n"));
      // The content-addressed binding also covers exploration/submission prompt
      // edits. Use a review-specific binding identity so only execution semantics
      // and prompts visible to review invalidate its decisions.
      const reviewBindingDigest = contentDigest({ schemaVersion: binding.schemaVersion, declaration: binding.declaration,
        executor: binding.executor, schemas: binding.schemas, dependencies: binding.dependencies, promptDigest: reviewPromptDigest });
      const cachedReview = async (program: ProgramRef) => {
        const key = store.reviewKey({ requirements: job.requirements, contract: program.contract, program: program.descriptor,
          binding: reviewBindingDigest, promptDigest: reviewPromptDigest });
        const path = join(store.directory, "reviews", key + ".json");
        if (!semanticReview) return { key, path, ref: undefined, review: undefined };
        try {
          const ref = JSON.parse(await readFile(path, "utf8")) as ContentRef;
          const review = await store.getJson<SemanticReview>(ref);
          if (review.key !== key || canonicalJson(review.program) !== canonicalJson(program)) throw new Error("Semantic review cache changed");
          return { key, path, ref, review };
        } catch { return { key, path, ref: undefined, review: undefined }; }
      };
      const capabilities = await Promise.all(declaration.capabilities.map(async capability => ({ ...capability,
        inputSchema: await store.getJson(capability.inputSchema), outputSchema: await store.getJson(capability.outputSchema) })));
      // Capabilities are invariant across exploration sessions and review batches.
      // Put them first so each request shares the longest possible prompt prefix.
      const orderedCapabilities = [...capabilities].sort(compareId);
      const executionCapability = (id: string) => {
        const capability = declaration.capabilities.find(item => item.id === id);
        if (!capability) throw new Error(`Undeclared execution capability "${id}". invoke only accepts: ${declaration.capabilities.map(item => item.id).join(", ")}. Call the separate Checker tools check_program and finish directly by their tool names; source_tree/source_search/source_read are also separate tools when provided.`);
        return capability;
      };
      if (job.mode === "prepare") { const session = await prepare(); await close(session); }
      else {
        const implemented = input.implementedRequirementIds ? new Set(input.implementedRequirementIds) : undefined;
        for (const requirement of input.requirements.filter(item => job.requirementIds.includes(item.id))) {
          const missing = requirement.dependencyIds.filter(id => implemented && !implemented.has(id) && !job.requirementIds.includes(id)
            && !requirement.externalDependencyIds?.includes(id));
          if (missing.length) for (const source of sources.filter(item => item.requirementId === requirement.id)) outcomeMap.set(source.id, {
            requirementId: source.requirementId, scenarioId: source.scenarioId, clauseId: source.id, status: "blocked", evidence: [], reason: `Dependencies not implemented: ${missing.join(", ")}` });
        }
        const eligibleSources = sources.filter(source => outcomeMap.get(source.id)?.status !== "blocked");
        const submitted: ProgramRef[] = [];
        const executions = new Map<string, ContentRef[]>();
        const coveredSources = new Set<string>();
        const rejectedPrograms: RejectedProgram[] = [];
        const candidates: Array<{ program: ProgramRef; descriptor: CheckerProgramDescriptor; approved: boolean }> = [];
        for (const program of job.programs) {
          try {
            if (!sameRef(program.binding, job.binding) || program.format !== `${declaration.programFormat.id}@${declaration.programFormat.version}`) continue;
            const descriptor = await store.readTypedJson<CheckerProgramDescriptor>(program.descriptor);
            if (!sameRef(descriptor.initialState, job.initialState)) continue;
            const contract = await store.getJson<AcceptanceContract>(program.contract);
            validateAcceptanceContract(contract, job, eligibleSources, input);
            const cached = await cachedReview(program);
            if (cached.review && !cached.review.approved) {
              manifest.reviews.push(cached.ref!);
              // Retain the rejected attempt for history and feedback, without claiming coverage.
              programs.set(canonicalJson(program), program);
              rejectedPrograms.push({ program, contract, source: (await store.getBytes(descriptor.source)).toString("utf8"),
                clauseIds: cached.review.clauseIds, reasons: cached.review.reasons });
              await progress({ stage: "review_rejected", programId: program.descriptor.id, clauseIds: cached.review.clauseIds,
                cached: true, reason: cached.review.reasons.join("; ") });
              for (const clause of contract.clauses) outcomeMap.set(clause.id, { requirementId: clause.requirementId, scenarioId: clause.scenarioId,
                clauseId: clause.id, status: "inconclusive", evidence: [], reason: `Semantic review rejected: ${cached.review.reasons.join("; ")}` });
              continue;
            }
            candidates.push({ program, descriptor, approved: cached.review?.approved === true });
          } catch (error) {
            const reason = `Reusable program is incompatible: ${String(error)}`;
            manifest.diagnostics.push(reason);
            await progress({ stage: "diagnostic", reason });
          }
        }
        for (const { program, descriptor } of candidates.sort((left, right) => Number(right.approved) - Number(left.approved))) {
          if (descriptor.clauses.some(mapping => coveredSources.has(mapping.clauseId))) continue;
          descriptor.clauses.forEach(mapping => coveredSources.add(mapping.clauseId));
          submitted.push(program);
        }
        const unsupported = new Set<string>();
        const validGap = (gap: UnsupportedClause): boolean => !!gap && typeof gap.reason === "string" && !!gap.reason.trim() && gap.reason.length <= 2000
          && Array.isArray(gap.attempts) && gap.attempts.length > 0 && gap.attempts.length <= 8 && gap.attempts.every(attempt => typeof attempt === "string" && !!attempt.trim() && attempt.length <= 1000)
          && (gap.retryable === undefined || typeof gap.retryable === "boolean");
        const gapCache = (clauseId: string) => {
          const key = contentDigest({ snapshot: job.snapshot, requirements: job.requirements, initialState: job.initialState, binding: job.binding, promptDigest, clauseId });
          return { key, path: join(store.directory, "unsupported", key + ".json") };
        };
        const recordGap = async (gap: UnsupportedClause, cached: boolean): Promise<void> => {
          const source = eligibleSources.find(source => source.id === gap.clauseId)!;
          const reason = `Unable to verify: ${gap.reason} Attempts: ${gap.attempts.join("; ")}`;
          unsupported.add(source.id);
          (manifest.unsupported ??= []).push(gap);
          outcomeMap.set(source.id, { requirementId: source.requirementId, scenarioId: source.scenarioId,
            clauseId: source.id, status: "inconclusive", evidence: [], reason });
          await progress({ stage: "diagnostic", clauseIds: [source.id], cached, reason });
        };
        for (const source of eligibleSources.filter(source => !coveredSources.has(source.id))) {
          const cache = gapCache(source.id);
          let gap: UnsupportedClause | undefined;
          try {
            const ref = JSON.parse(await readFile(cache.path, "utf8")) as ContentRef;
            const saved = await store.getJson<{ key: string; gap: UnsupportedClause }>(ref);
            if (saved.key === cache.key && saved.gap.clauseId === source.id && validGap(saved.gap) && saved.gap.retryable !== true) gap = saved.gap;
          } catch { /* A missing or incompatible assessment requires exploration. */ }
          if (gap) await recordGap(gap, true);
        }
        const explore = async (discoverySources: typeof eligibleSources, repair: boolean): Promise<void> => {
          const explorationDeadline = repair ? Date.now() + Math.max(1, Math.floor(Math.min(PROGRAM_REPAIR_MS, (deadlineAt - Date.now()) / 2))) : deadlineAt;
          const explorationSignal = repair ? AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, explorationDeadline - Date.now()))]) : signal;
          const exploration = await prepare(explorationSignal);
          if (!await ready(exploration)) throw new Error("Execution adapter did not establish a ready exploration environment");
          const feedback = rejectedPrograms.filter(program => program.clauseIds.some(id => discoverySources.some(source => source.id === id)));
          await progress({ stage: feedback.length ? "rediscovery" : "exploration", clauseIds: discoverySources.map(source => source.id) });
          let finished = false;
          const savedPrograms: ProgramRef[] = [];
          const feedbackRefs = new Map<string, ContentRef>();
          const executionFeedback = async (value: ExecutionFeedback) => {
            const ref = await store.putJson(value);
            feedbackRefs.set(ref.id, ref);
            (manifest.feedback ??= []).push(ref);
            return { ...compactExecutionFeedback(value), feedbackRef: ref };
          };
          const tools: CheckerTool[] = [
            { name: "invoke", description: "Invoke one declared execution capability using its exact input schema. check_program and finish are separate tools; call them directly. Application output is untrusted observation data.",
              parameters: Type.Object({ capabilityId: Type.String({ enum: declaration.capabilities.map(item => item.id) }), input: toolObjectSchema }),
              prepareArguments(value) {
                const args = prepareInvokeArguments(value);
                if (isRecord(args) && typeof args.capabilityId === "string") executionCapability(args.capabilityId);
                return args;
              }, async execute(raw) {
                if (finished) throw new Error("Checker exploration already finished");
                const args = raw as { capabilityId: string; input: unknown };
                const capability = executionCapability(args.capabilityId);
                const inputValue = await invocationInput(args.capabilityId, capability.inputSchema, args.input);
                const result = await exploration.invoke(args.capabilityId, inputValue, explorationSignal);
                const output = await store.readTypedJson(result.output);
                await store.validateSchema(capability.outputSchema, output);
                manifest.receipts.push(...result.receipts);
                const checks = [];
                for (const ref of result.receipts) {
                  const receipt = await store.getJson<EvidenceReceipt>(ref);
                  if (receipt.kind === "assertion" || receipt.kind === "precondition") {
                    checks.push({ receipt: ref, kind: receipt.kind, checkpointId: receipt.checkpointId,
                      ...(receipt.assertion ? { assertion: receipt.assertion } : {}), payload: await store.readTypedJson(receipt.payload) });
                  }
                }
                return executionFeedback({ output, receipts: result.receipts, ...(checks.length ? { checks } : {}) });
              } },
            { name: "check_program", description: "Save a complete contract and program, derive clause mappings, and execute the saved program in an independent clean environment. Once entry, initial state and object identity are located, use this tool directly instead of separately probing the same path. Inspect compact checks and diagnostics; use read_feedback only for missing diagnostic detail. Revise through this same tool if needed. This execution supplies formal evidence; finish does not run it again. Business violations remain valid test results, subject to failure confirmation and independent semantic review when enabled.",
              parameters: Type.Object({ contract: toolObjectSchema, source: Type.String({ minLength: 1 }) }),
              prepareArguments: prepareCheckArguments,
              async execute(raw) {
                if (finished) throw new Error("Checker exploration already finished");
                const args = raw as { contract: unknown; source: string };
                const contract = { ...toolObject(args.contract, "contract"), requirements: job.requirements } as unknown as AcceptanceContract;
                validateAcceptanceContract(contract, job, discoverySources, input);
                if (!args.source?.trim()) throw new Error("Program must contain nonempty source");
                const contractRef = await store.putJson(contract);
                manifest.contracts.push(contractRef);
                const descriptor: CheckerProgramDescriptor = { source: await store.putBytes(args.source), initialState: job.initialState,
                  clauses: contract.clauses.map(clause => ({ clauseId: clause.id, checkpointId: clause.checkpointId })) };
                const program: ProgramRef = { descriptor: await store.putTypedJson(descriptor, declaration.programFormat.schema),
                  format: `${declaration.programFormat.id}@${declaration.programFormat.version}`, contract: contractRef, binding: job.binding };
                const cached = await cachedReview(program);
                if (cached.review && !cached.review.approved) {
                  await progress({ stage: "review_rejected", programId: program.descriptor.id, clauseIds: cached.review.clauseIds,
                    cached: true, reason: cached.review.reasons.join("; ") });
                  throw new Error(`Program was rejected by semantic review; revise its source or contract: ${cached.review.reasons.join("; ")}`);
                }
                programs.set(canonicalJson(program), program);
                const execution = await prepare(explorationSignal);
                let refs = [...execution.readinessEvidence];
                try {
                  await progress({ stage: "replay", programId: program.descriptor.id, clauseIds: contract.clauses.map(clause => clause.id) });
                  if (await ready(execution)) refs.push(...await execution.replay(program, explorationSignal));
                  manifest.receipts.push(...refs);
                  await evaluateProgramEvidence(store, job, program, contract, deduplicate(refs));
                } finally { await close(execution); }
                executions.set(canonicalJson(program), refs);
                savedPrograms.push(program);
                const checks = [], diagnostics = [];
                for (const ref of refs) {
                  const receipt = await store.getJson<EvidenceReceipt>(ref);
                  const payload = await store.readTypedJson(receipt.payload);
                  if (receipt.kind === "assertion" || receipt.kind === "precondition") checks.push({ receipt: ref, kind: receipt.kind,
                    checkpointId: receipt.checkpointId, ...(receipt.assertion ? { assertion: receipt.assertion } : {}), payload });
                  else if (receipt.kind === "diagnostic" || receipt.kind === "readiness" && receipt.readiness?.result !== "ready") diagnostics.push(payload);
                }
                return executionFeedback({ program, checks, diagnostics });
              } },
            { name: "finish", description: "Submit exact program references returned by check_program after inspecting its checks and diagnostics, or explain unverifiable clauses. When enabled, independent review uses those executions without another replay; faithful business failures are independently confirmed.",
              parameters: Type.Object({ programs: Type.Array(programSchema), unsupported: Type.Optional(Type.Array(Type.Object({
                clauseId: Type.String({ enum: discoverySources.map(source => source.id) }), reason: Type.String({ minLength: 1, maxLength: 2000 }),
                attempts: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { minItems: 1, maxItems: 8 }),
                retryable: Type.Optional(Type.Boolean({ description: "Defaults to false. Set true only when the reason explains a transient problem and why another attempt may obtain evidence." })),
              }))) }), prepareArguments: prepareFinishArguments, async execute(raw) {
                if (finished) throw new Error("Checker exploration already finished");
                const args = raw as { programs: unknown; unsupported?: unknown };
                const submittedPrograms = toolArray(args.programs, "programs") as ProgramRef[];
                const gaps = args.unsupported === undefined ? [] : toolArray(args.unsupported, "unsupported") as UnsupportedClause[];
                if ((!submittedPrograms.length && !gaps.length) || submittedPrograms.some(program => !savedPrograms.some(saved => canonicalJson(saved) === canonicalJson(program)))) throw new Error("Finish must reference saved programs or explain unverifiable source clauses");
                const claimed = new Set<string>();
                for (const program of submittedPrograms) {
                  const descriptor = await store.readTypedJson<CheckerProgramDescriptor>(program.descriptor);
                  for (const mapping of descriptor.clauses) {
                    if (claimed.has(mapping.clauseId)) throw new Error("Submitted programs overlap source clauses");
                    claimed.add(mapping.clauseId);
                  }
                }
                for (const gap of gaps) {
                  if (!validGap(gap) || !discoverySources.some(source => source.id === gap.clauseId) || claimed.has(gap.clauseId)) throw new Error("Unverifiable clauses must uniquely cite a source clause and explain the reason and attempts");
                  claimed.add(gap.clauseId);
                }
                for (const gap of gaps) {
                  if (gap.retryable !== true) {
                    const cache = gapCache(gap.clauseId);
                    const ref = await store.putJson({ key: cache.key, gap });
                    await atomicWrite(cache.path, canonicalJson(ref));
                  }
                  await recordGap(gap, false);
                }
                submitted.push(...submittedPrograms); finished = true; return { accepted: true };
              } },
          ];
          tools.push({ name: "read_feedback", description: "Read a specific field or bounded text window from a feedbackRef returned in this exploration session. Use only when compact execution feedback omits detail needed to diagnose a problem; previews are not complete evidence values.",
            parameters: Type.Object({ feedbackRef: refSchema, path: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Integer({ minimum: 0 })]), { maxItems: 16 })),
              offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 4000 })) }),
            async execute(raw) {
              if (finished) throw new Error("Checker exploration already finished");
              explorationSignal.throwIfAborted();
              const args = raw as { feedbackRef: ContentRef; path?: Array<string | number>; offset?: number; limit?: number };
              const known = feedbackRefs.get(args.feedbackRef?.id);
              if (!known || !sameRef(known, args.feedbackRef)) throw new Error("Feedback reference was not returned in this exploration session");
              return feedbackSlice(await store.getJson(args.feedbackRef), args.path, args.offset, args.limit);
            } });
          try {
            let sourceIndexInfo: { available: boolean; fileCount?: number } | undefined;
            if (options.sourceIndex) {
              sourceIndexInfo = { available: false };
              try {
                sourceView ??= await options.sourceIndex.open(job.snapshot, explorationSignal);
                const fileCount = sourceView.list().length;
                sourceIndexInfo = { available: fileCount > 0, fileCount };
                if (!fileCount) {
                  const reason = "Checker source index is empty; continuing exploration with declared execution capabilities";
                  manifest.diagnostics.push(reason);
                  await progress({ stage: "diagnostic", reason });
                }
              } catch (error) {
                explorationSignal.throwIfAborted();
                const reason = `Checker source index could not be opened; continuing exploration with declared execution capabilities: ${errorMessage(error)}`;
                manifest.diagnostics.push(reason);
                await progress({ stage: "diagnostic", reason });
              }
            }
            const source = sourceIndexInfo?.available ? sourceView : undefined;
            if (source) {
              tools.push({ name: "source_tree", description: "List indexed implementation directories and files under an optional path prefix. Results are navigation context, not behavior evidence. Narrow pathPrefix or reduce depth when truncated.",
                parameters: Type.Object({ pathPrefix: Type.Optional(Type.String()), depth: Type.Optional(Type.Integer({ minimum: 1, maximum: SOURCE_TREE_MAX_DEPTH })),
                  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: SOURCE_TREE_MAX_LIMIT })) }),
                async execute(raw) {
                  if (finished) throw new Error("Checker exploration already finished");
                  explorationSignal.throwIfAborted();
                  const args = raw as { pathPrefix?: string; depth?: number; limit?: number };
                  return source.tree(args.pathPrefix, args.depth, args.limit);
                } }, { name: "source_search", description: "Find implementation files and literal text in this job's sealed source index. Results are navigation context, not behavior evidence.",
                parameters: Type.Object({ terms: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }), pathPrefix: Type.Optional(Type.String()) }),
                async execute(raw) {
                  if (finished) throw new Error("Checker exploration already finished");
                  explorationSignal.throwIfAborted();
                  const args = raw as { terms: string[]; pathPrefix?: string };
                  return source.search(args.terms, args.pathPrefix);
                } }, { name: "source_read", description: "Read a line range from a fileId in the current sealed source index. Prefer the relevant function or control, then verify behavior with declared execution capabilities.",
                parameters: Type.Object({ fileId: Type.String({ minLength: 1 }), startLine: Type.Integer({ minimum: 1 }), lineCount: Type.Optional(Type.Integer({ minimum: 1 })) }),
                async execute(raw) {
                  if (finished) throw new Error("Checker exploration already finished");
                  explorationSignal.throwIfAborted();
                  const args = raw as { fileId: string; startLine: number; lineCount?: number };
                  return source.read(args.fileId, args.startLine, args.lineCount);
                } });
            }
            const context = repair ? { requirements: input.requirements.filter(requirement => discoverySources.some(source => source.requirementId === requirement.id)),
              prerequisites: input.prerequisites ?? [] } : input;
            await runModel("exploration", [genericPrompts[0], genericPrompts[2], ...adapterPrompts].join("\n\n"), JSON.stringify({
              // Keep session-invariant fields first; discovery scope and feedback
              // are the parts that change between initial and repair sessions.
              capabilities: orderedCapabilities,
              programFormat: declaration.programFormat,
              initialState: await store.readTypedJson(job.initialState),
              semanticReview,
              requirements: context,
              sourceClauses: discoverySources,
              ...(sourceIndexInfo ? { sourceIndex: sourceIndexInfo } : {}),
              repair,
              remainingMs: Math.max(0, explorationDeadline - Date.now()),
              ...(feedback.length ? { rejectedPrograms: feedback } : {}),
            }), tools, explorationSignal);
            if (!finished) throw new Error("Checker exploration did not finish with saved programs");
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            manifest.diagnostics.push(reason);
            for (const source of discoverySources) {
              const outcome = outcomeMap.get(source.id)!;
              if (outcome.status === "inconclusive" && !unsupported.has(source.id)) outcome.reason = outcome.reason === missingProgramReason
                ? reason : `${outcome.reason}; Program correction failed: ${reason}`;
            }
            await progress({ stage: "diagnostic", reason });
          }
          finally { await close(exploration); }
        };
        const replaySubmitted = async (): Promise<Set<string>> => {
          type Executed = { program: ProgramRef; contract: AcceptanceContract; descriptor: CheckerProgramDescriptor; source: string;
            refs: ContentRef[]; outcomes: CheckOutcome[]; cached: Awaited<ReturnType<typeof cachedReview>>;
            review?: SemanticReview; reviewRef?: ContentRef; projected?: ReviewEvidence[] };
          const executed: Executed[] = [];
          const rejectedClauses = new Set<string>();
          for (const program of submitted.splice(0)) {
            signal.throwIfAborted();
            let failedContract: AcceptanceContract | undefined;
            try {
              if (!sameRef(program.binding, job.binding)) throw new Error("Reusable program execution binding changed");
              if (program.format !== `${declaration.programFormat.id}@${declaration.programFormat.version}`) throw new Error("Reusable program format changed");
              const contract = await store.getJson<AcceptanceContract>(program.contract);
              failedContract = contract;
              validateAcceptanceContract(contract, job, eligibleSources, input);
              const descriptor = await store.readTypedJson<CheckerProgramDescriptor>(program.descriptor);
              if (!sameRef(descriptor.initialState, job.initialState) || descriptor.clauses.length !== contract.clauses.length
                || new Set(descriptor.clauses.map(mapping => mapping.clauseId)).size !== descriptor.clauses.length
                || descriptor.clauses.some(mapping => !contract.clauses.some(clause => clause.id === mapping.clauseId && clause.checkpointId === mapping.checkpointId))) throw new Error("Reusable program contract or initial state mismatch");
              const source = (await store.getBytes(descriptor.source)).toString("utf8");
              if (!source.trim()) throw new Error("Cannot replay an empty program");
              programs.set(canonicalJson(program), program); manifest.contracts.push(program.contract);
              const cached = await cachedReview(program);
              if (semanticReview && job.mode !== "discover" && !cached.review?.approved) {
                for (const clause of contract.clauses) outcomeMap.get(clause.id)!.reason = "Replay requires an approved program; no model sessions are started";
                continue;
              }
              let refs = executions.get(canonicalJson(program));
              if (!refs) {
                const replay = await prepare();
                try {
                  await progress({ stage: "replay", programId: program.descriptor.id, clauseIds: contract.clauses.map(clause => clause.id) });
                  refs = [...replay.readinessEvidence];
                  if (await ready(replay)) refs.push(...await replay.replay(program, signal));
                  manifest.receipts.push(...refs);
                } finally { await close(replay); }
              }
              const outcomes = await evaluateProgramEvidence(store, job, program, contract, deduplicate(refs));
              executed.push({ program, contract, descriptor, source, refs, outcomes, cached, review: cached.review, reviewRef: cached.ref });
            } catch (error) {
              if (cleanupFailure) throw cleanupFailure;
              signal.throwIfAborted();
              const reason = `Program execution failed: ${errorMessage(error)}`;
              manifest.diagnostics.push(reason);
              for (const clause of failedContract?.clauses ?? []) {
                const outcome = outcomeMap.get(clause.id);
                if (outcome && outcome.status !== "pass" && outcome.status !== "fail") outcome.reason = reason;
              }
              await progress({ stage: "diagnostic", programId: program.descriptor.id, clauseIds: failedContract?.clauses.map(clause => clause.id), reason });
            }
          }
          const applyReview = async (item: Executed): Promise<void> => {
            try {
              const { program, contract, source, outcomes, review, reviewRef } = item;
              if (semanticReview && (!review || !reviewRef)) return;
              if (reviewRef) manifest.reviews.push(reviewRef);
              if (review && item.cached.review) await progress({ stage: "review_cached", programId: program.descriptor.id, clauseIds: review.clauseIds, cached: true });
              if (review && !review.approved) {
                rejectedPrograms.push({ program, contract, source, clauseIds: review.clauseIds, reasons: review.reasons,
                  observations: item.projected?.filter(value => value.receipt.kind === "observation").map(value => reviewReceipt(value.receipt, value.payload)) });
                review.clauseIds.forEach(id => rejectedClauses.add(id));
                for (const clause of contract.clauses) outcomeMap.set(clause.id, { requirementId: clause.requirementId, scenarioId: clause.scenarioId,
                  clauseId: clause.id, status: "inconclusive", evidence: [], reason: `Semantic review rejected: ${review.reasons.join("; ")}` });
                return;
              }
              if (outcomes.some(outcome => outcome.status === "fail")) {
                const confirmation = await prepare();
                const refs = [...confirmation.readinessEvidence];
                try {
                  await progress({ stage: "confirmation", programId: program.descriptor.id, clauseIds: outcomes.filter(value => value.status === "fail").map(value => value.clauseId) });
                  if (await ready(confirmation)) refs.push(...await confirmation.replay(program, signal));
                  manifest.receipts.push(...refs);
                } finally { await close(confirmation); }
                const repeated = await evaluateProgramEvidence(store, job, program, contract, deduplicate(refs));
                for (const outcome of outcomes.filter(value => value.status === "fail")) {
                  const reproduced = repeated.find(value => value.clauseId === outcome.clauseId && value.status === "fail");
                  const firstEnvironment = await environmentOf(store, outcome.evidence);
                  const secondEnvironment = reproduced ? await environmentOf(store, reproduced.evidence) : undefined;
                  if (reproduced && firstEnvironment && secondEnvironment && !sameRef(firstEnvironment, secondEnvironment)) {
                    outcome.evidence.push(...reproduced.evidence); outcome.reason = "Requirement violation reproduced in an independent fresh environment";
                  } else { outcome.status = "inconclusive"; outcome.reason = "Violation did not reproduce independently"; }
                }
              }
              for (const outcome of outcomes) {
                if (outcomeMap.get(outcome.clauseId)?.status === "pass" || outcomeMap.get(outcome.clauseId)?.status === "fail") throw new Error("Multiple programs claimed the same source clause");
                outcomeMap.set(outcome.clauseId, outcome);
              }
            } catch (error) {
              if (cleanupFailure) throw cleanupFailure;
              signal.throwIfAborted();
              const reason = `Program confirmation failed: ${errorMessage(error)}`;
              manifest.diagnostics.push(reason);
              for (const clause of item.contract.clauses) outcomeMap.get(clause.id)!.reason = reason;
              await progress({ stage: "diagnostic", programId: item.program.descriptor.id, clauseIds: item.contract.clauses.map(clause => clause.id), reason });
            }
          };
          for (const item of executed.filter(value => !semanticReview || value.review)) await applyReview(item);
          if (!semanticReview) return rejectedClauses;
          const pending = executed.filter(item => !item.review);
          for (const item of pending) {
            const evidence = await Promise.all(item.refs.map(async ref => {
              const receipt = await store.getJson<EvidenceReceipt>(ref);
              return { receipt, payload: await store.readTypedJson(receipt.payload), environment: await store.readTypedJson(receipt.environment) };
            }));
            item.projected = adapter.reviewEvidence?.(evidence) ?? evidence;
          }
          const batchPayload = (batch: Executed[]): string => {
            const clauses = batch.flatMap(item => item.contract.clauses);
            const ids = new Set(clauses.map(clause => clause.id));
            return JSON.stringify({
              // Keep job-invariant capabilities first. Requirements and source
              // clauses are scoped to this batch and therefore follow them.
              capabilities: orderedCapabilities,
              requirements: semanticReviewRequirements(input, { clauses }),
              sourceClauses: eligibleSources.filter(clause => ids.has(clause.id)).sort(compareId),
              programs: batch.map(item => reviewProgramPayload(item.program, item.contract, item.descriptor, item.source, item.projected!)),
            });
          };
          while (pending.length) {
            const batch = [pending.shift()!];
            while (pending.length && batch.length < REVIEW_BATCH_PROGRAMS
              && Buffer.byteLength(batchPayload([...batch, pending[0]!])) <= REVIEW_BATCH_BYTES) batch.push(pending.shift()!);
            type Decision = { programId: string; approved: boolean; reasons: string[]; clauseIds: string[] };
            let proposal: Decision[] | undefined;
            try {
              for (const item of batch) await progress({ stage: "semantic_review", programId: item.program.descriptor.id, clauseIds: item.contract.clauses.map(clause => clause.id) });
              await runModel("semantic_review", [genericPrompts[1], genericPrompts[2], ...adapterPrompts].join("\n\n"), batchPayload(batch), [{
                name: "finish", description: "Submit one whole-program decision per programId in this batch. Enumerate every clause of each program exactly once. JSON text is not a submission.",
                parameters: Type.Object({ reviews: Type.Array(Type.Object({ programId: Type.String({ enum: batch.map(item => contentDigest(item.program)) }),
                  approved: Type.Boolean(), reasons: Type.Array(Type.String()), clauseIds: Type.Array(Type.String(), { uniqueItems: true }) }),
                  { minItems: batch.length, maxItems: batch.length }) }),
                prepareArguments(value) { return isRecord(value) ? { ...value, reviews: toolArray(value.reviews, "reviews") } : value; },
                async execute(raw) {
                  if (proposal) throw new Error("Semantic review already finished");
                  const decisions = (raw as { reviews: Decision[] }).reviews;
                  if (!Array.isArray(decisions) || decisions.length !== batch.length || new Set(decisions.map(item => item.programId)).size !== batch.length
                    || decisions.some(decision => !batch.some(item => contentDigest(item.program) === decision.programId))) throw new Error("Independent review must enumerate each program exactly once");
                  for (const item of batch) {
                    const decision = decisions.find(value => value.programId === contentDigest(item.program))!;
                    if (typeof decision.approved !== "boolean" || !Array.isArray(decision.reasons) || decision.reasons.some(reason => typeof reason !== "string")
                      || !Array.isArray(decision.clauseIds) || decision.clauseIds.length !== item.contract.clauses.length
                      || new Set(decision.clauseIds).size !== decision.clauseIds.length
                      || item.contract.clauses.some(clause => !decision.clauseIds.includes(clause.id))) throw new Error("Independent review must enumerate each contract clause exactly once for its program");
                  }
                  proposal = decisions; return { accepted: true };
                },
              }]);
              const decisions = proposal as Decision[] | undefined;
              if (!decisions) throw new Error("Independent semantic review did not call finish");
              for (const item of batch) {
                const decision = decisions.find(value => value.programId === contentDigest(item.program))!;
                item.review = { key: item.cached.key, requirements: job.requirements, contract: item.program.contract, program: item.program,
                  binding: job.binding, approved: decision.approved, reasons: decision.reasons, clauseIds: decision.clauseIds };
                item.reviewRef = await store.putJson(item.review);
                await atomicWrite(item.cached.path, canonicalJson(item.reviewRef));
                await progress({ stage: item.review.approved ? "review_approved" : "review_rejected", programId: item.program.descriptor.id,
                  clauseIds: item.review.clauseIds, reason: item.review.reasons.join("; ") });
              }
            } catch (error) {
              signal.throwIfAborted();
              const reason = `Independent review failed: ${errorMessage(error)}`;
              manifest.diagnostics.push(reason);
              for (const item of batch) {
                for (const clause of item.contract.clauses) outcomeMap.get(clause.id)!.reason = reason;
                await progress({ stage: "diagnostic", programId: item.program.descriptor.id, clauseIds: item.contract.clauses.map(clause => clause.id), reason });
              }
            }
            for (const item of batch) await applyReview(item);
          }
          return rejectedClauses;
        };
        // Verify reusable programs first; one difficult discovery cannot erase their results.
        const corrections = await replaySubmitted();
        const missing = eligibleSources.filter(source => !coveredSources.has(source.id) && !unsupported.has(source.id));
        for (let round = 0; job.mode === "discover" && round < 2; round++) {
          const repair = round > 0 || !missing.length;
          const targets = repair ? eligibleSources.filter(source => corrections.has(source.id) && !unsupported.has(source.id)) : missing;
          if (!targets.length) break;
          await explore(targets, repair);
          const rejected = await replaySubmitted();
          if (repair) break;
          rejected.forEach(id => corrections.add(id));
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      manifest.diagnostics.push(reason);
      await progress({ stage: "diagnostic", reason });
    } finally {
      for (const session of sessions) {
        try { await close(session); } catch (error) { manifest.diagnostics.push(`Execution cleanup failed: ${String(error)}`); }
      }
    }
    if (cleanupFailure) throw cleanupFailure;
    if (manifest.diagnostics.length) for (const outcome of outcomeMap.values()) {
      if (outcome.status === "inconclusive" && outcome.reason === missingProgramReason) outcome.reason = manifest.diagnostics.join("; ");
    }
    for (const ref of deduplicate(manifest.receipts)) await store.validateReceipt(job, await store.getJson<EvidenceReceipt>(ref));
    const report: CheckReport = { job: await store.putJson(job), snapshot: job.snapshot, binding: job.binding,
      manifest: await store.putJson({ ...manifest, contracts: deduplicate(manifest.contracts), receipts: deduplicate(manifest.receipts) }),
      programs: [...programs.values()], outcomes: job.mode === "prepare" ? [] : [...outcomeMap.values()] };
    await store.validateReport(job, report);
    return report;
  } };
}

function deduplicate(refs: ContentRef[]): ContentRef[] { return [...new Map(refs.map(ref => [ref.digest, ref])).values()]; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Normalize model-rendered tool arguments before the SDK validates them against the declared schema. */
function prepareInvokeArguments(value: unknown): unknown {
  if (!isRecord(value) || typeof value.input !== "string") return value;
  const text = value.input.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return value;
  try { return { ...value, input: JSON.parse(text) }; }
  catch { throw new Error("input must be a JSON value; received a string that is not valid JSON"); }
}
function prepareCheckArguments(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return { ...value, contract: toolObject(value.contract, "contract") };
}
function prepareFinishArguments(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return { ...value, programs: toolArray(value.programs, "programs"), ...(value.unsupported === undefined ? {} : { unsupported: toolArray(value.unsupported, "unsupported") }) };
}
/** Accept both the declared object argument and a gateway/model-rendered JSON string. */
function toolObject(value: unknown, name: string): Record<string, unknown> {
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); }
    catch { throw new Error(`${name} must be a JSON object; received a string that is not valid JSON`); }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${name} must be a JSON object`);
  return parsed as Record<string, unknown>;
}
function toolArray(value: unknown, name: string): unknown[] {
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); }
    catch { throw new Error(`${name} must be a JSON array; received a string that is not valid JSON`); }
  }
  if (!Array.isArray(parsed)) throw new Error(`${name} must be a JSON array`);
  return parsed;
}
async function environmentOf(store: ArtifactStore, refs: ContentRef[]): Promise<ContentRef | undefined> {
  for (const ref of refs) { const receipt = await store.getJson<EvidenceReceipt>(ref); if (receipt.kind === "assertion") return receipt.environment; }
  return undefined;
}
