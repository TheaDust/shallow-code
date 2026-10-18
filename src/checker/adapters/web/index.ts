import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { chromium, type Browser } from "@playwright/test";
import { CandidateRuntime } from "../../../application/candidate-runtime.js";
import { CandidatePreparationError, type ApplicationLifecycle } from "../../../application/port.js";
import { WebAppLifecycle, verifyDeclaredPorts } from "../../../adapters/web/runtime.js";
import { loadProjectSpec, parseProjectSpec, resolveRuntimeContract, webRuntimeConfig, webSettings, type ProjectSpec } from "../../../adapters/web/project-spec.js";
import { pickFreePort } from "../../../adapters/web/ports.js";
import type { SnapshotStore } from "../../../snapshot-store.js";
import { ArtifactStore, canonicalJson, contentDigest, hashBytes, sameRef } from "../../artifacts.js";
import type { AdapterDeclaration, CheckJob, ContentRef, EvidenceReceipt, ExecutionAdapter, ExecutionBinding, ExecutionBindingRef, ExecutionSession, ProgramRef, TypedRef } from "../../port.js";
import { WebProgramRuntime, type WebCheckpoint, type WebExpectation } from "./program-runtime.js";

export const WEB_PROGRAM_FORMAT = "shallow.web.javascript@1";
export interface WebAdapterOptions {
  artifacts: ArtifactStore;
  snapshots: SnapshotStore;
  spec: ProjectSpec;
  workspace: string;
  initialDataSnapshot?: ContentRef;
  reservedPorts?: number[];
  promptFragments?: ContentRef[];
  lifecycle?: ApplicationLifecycle;
  launchBrowser?: () => Promise<Browser>;
}
interface ProgramDescriptor { source: ContentRef; initialState: TypedRef; clauses: Array<{ clauseId: string; checkpointId: string }> }
interface Contract { clauses: Array<WebExpectation & { id?: string }>; checkpoints: WebCheckpoint[] }
interface WebSchemas { payload: ContentRef; environment: ContentRef; output: ContentRef; initialState: ContentRef }
const REF = { type: "object", required: ["id", "digest"], properties: { id: { type: "string" }, digest: { type: "string" } } };
const OBJECT = { type: "object", additionalProperties: true };
const PROGRAM_REF = { type: "object", required: ["descriptor", "format", "contract", "binding"], properties: { descriptor: REF, format: { type: "string" }, contract: REF, binding: REF }, additionalProperties: false };
const RUN_SCHEMA = { type: "object", required: ["source"], properties: { source: { type: "string", minLength: 1, maxLength: 256_000 }, program: PROGRAM_REF }, additionalProperties: false };
let preparationQueue: Promise<void> = Promise.resolve();
const leasedPorts = new Set<number>();
async function prepareOneAtATime<T>(operation: () => Promise<T>): Promise<T> {
  const previous = preparationQueue;
  let release!: () => void;
  preparationQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { return await operation(); } finally { release(); }
}

export class WebExecutionError extends Error {
  constructor(message: string, readonly readinessEvidence: ContentRef[]) { super(message); }
  get diagnosticRefs(): ContentRef[] { return this.readinessEvidence; }
}

/** Derives the published declaration and binding from actual code, schemas and installed dependencies. */
export async function createWebExecutionAdapter(options: WebAdapterOptions): Promise<{ adapter: WebExecutionAdapter; declaration: AdapterDeclaration; initialState: TypedRef }> {
  const spec = parseProjectSpec(options.spec);
  const store = options.artifacts;
  const require = createRequire(import.meta.url);
  const releaseFiles = ["./index.ts", "./program-runtime.ts", "./sandbox-worker.mjs", "../../../application/candidate-runtime.ts", "../../../project-spec.ts", "../../../application/commands.ts", "../../../application/port.ts", "../../../adapters/web/runtime.ts", "../../../adapters/web/project-spec.ts", "../../../inherited-data.ts", "../../../process-lifecycle.ts", "../../../process-spawn.ts", "../../../adapters/web/ports.ts", "../../../snapshot-store.ts", "../../artifacts.ts", "../../agent.ts", "../../evidence.ts", "../../model.ts"];
  const release = hashBytes(Buffer.concat(await Promise.all(releaseFiles.map((path) => readFile(new URL(path, import.meta.url))))));
  const executor = { id: "shallow.web.quickjs", version: "1", digest: release };
  const objectSchema = await store.putJson(OBJECT);
  if (options.initialDataSnapshot) await options.snapshots.open(options.initialDataSnapshot);
  const stateSchema = await store.putJson({ type: "object", required: ["mode"], properties: { mode: { enum: ["empty", "inherited"] }, baseline: REF }, additionalProperties: false });
  const initialStates = await Promise.all(["inherited", "empty"].map((mode) => store.putTypedJson({ mode, ...(mode === "inherited" && options.initialDataSnapshot ? { baseline: options.initialDataSnapshot } : {}) }, stateSchema)));
  const programSchema = await store.putJson({ type: "object", required: ["source", "initialState", "clauses"], properties: { source: REF, initialState: REF, clauses: { type: "array", minItems: 1, items: { type: "object", required: ["clauseId", "checkpointId"], properties: { clauseId: { type: "string" }, checkpointId: { type: "string" } }, additionalProperties: false } } }, additionalProperties: false });
  const inspectSchema = await store.putJson({ type: "object", properties: { actor: { type: "string" } }, additionalProperties: false });
  const resetSchema = await store.putJson({ type: "object", additionalProperties: false });
  const runSchema = await store.putJson(RUN_SCHEMA);
  const promptFragments = [await store.putBytes(`Web public entry: ${webSettings(spec).browserPath}`), await store.putBytes(await readFile(new URL("../../../../prompts/checker/web/browser.md", import.meta.url))), ...(options.promptFragments ?? [])];
  const genericPrompts = await Promise.all(["exploration", "review", "tools"].map((name) => readFile(new URL(`../../../../prompts/checker/${name}.md`, import.meta.url), "utf8")));
  const execution = await store.putTypedJson({ spec, normalizationVersion: 1, port: "allocated-per-case", dataDirectory: "allocated-per-case" }, objectSchema);
  const declaration: AdapterDeclaration = {
    schemaVersion: 1, id: "shallow.web", version: "1", implementation: executor, execution, initialStates,
    resourceKeys: [...new Set(webSettings(spec).extraPorts)].sort((a, b) => a - b).map((port) => `local-port:${port}`),
    capabilities: [
      { id: "inspect", version: "1", description: "Read the current actor page as untrusted observation data.", inputSchema: inspectSchema, outputSchema: objectSchema },
      { id: "run", version: "1", description: "Run bounded JavaScript using controlled browser and contract assertions.", inputSchema: runSchema, outputSchema: objectSchema },
      { id: "reset_case", version: "1", description: "Rebuild an independent case from declared initial state; expire all browser handles.", inputSchema: resetSchema, outputSchema: objectSchema },
    ],
    programFormat: { id: "shallow.web.javascript", version: "1", mediaType: "text/javascript", schema: programSchema },
    observations: [{ schema: objectSchema, mediaType: "application/json", maxBytes: 8_388_608, visibility: "checker" }],
    attachments: [{ schema: objectSchema, mediaType: "application/zip", maxBytes: 16_777_216, visibility: "checker" }, { schema: objectSchema, mediaType: "image/png", maxBytes: 4_194_304, visibility: "checker" }],
    prompts: promptFragments,
  };
  const bindingRecord: ExecutionBinding = { schemaVersion: 1, declaration: await store.putJson(declaration), executor,
    schemas: [objectSchema, stateSchema, programSchema, inspectSchema, runSchema, resetSchema],
    dependencies: { node: process.version, tsx: require("tsx/package.json").version as string, playwright: require("@playwright/test/package.json").version as string, quickjs: require("quickjs-emscripten/package.json").version as string, browser: chromium.executablePath().split(/[\\/]/).slice(-3).join("/") },
    promptDigest: contentDigest({ generic: genericPrompts, fragments: promptFragments, capabilities: declaration.capabilities, assembler: 1 }),
  };
  const binding: ExecutionBindingRef = { ...await store.putJson(bindingRecord), executor };
  await store.validateBinding(binding);
  const adapter = new WebExecutionAdapter({ ...options, spec }, binding, declaration, { payload: objectSchema, environment: objectSchema, output: objectSchema, initialState: stateSchema });
  return { adapter, declaration, initialState: initialStates[0]! };
}

/** One session owns each application, data directory, browser and execution realm it creates. */
export class WebExecutionAdapter implements ExecutionAdapter {
  constructor(private readonly options: WebAdapterOptions, readonly binding: ExecutionBindingRef, readonly declaration: AdapterDeclaration, private readonly schemas: WebSchemas) {}
  async prepare(job: Readonly<CheckJob>, signal: AbortSignal): Promise<ExecutionSession> {
    signal.throwIfAborted();
    if (canonicalJson(job.binding) !== canonicalJson(this.binding)) throw new Error("Web executor binding mismatch");
    await this.options.artifacts.validateBinding(job.binding);
    const initial = await this.options.artifacts.readTypedJson<{ mode: "empty" | "inherited" }>(job.initialState);
    if (!this.declaration.initialStates.some((state) => sameRef(state, job.initialState))) throw new Error("Undeclared Web initial state");
    const snapshot = await this.options.snapshots.open(job.snapshot);
    const actualSpec = await loadProjectSpec(snapshot.sourceDirectory);
    if (canonicalJson(resolveRuntimeContract(actualSpec, { port: 1 })) !== canonicalJson(resolveRuntimeContract(this.options.spec, { port: 1 }))) throw new Error("Project run configuration differs from the Web execution binding");
    const session = new WebSession(this.options, this.schemas, this.declaration, job, snapshot.sourceDirectory, initial.mode);
    try { await session.initialize(signal); return session; }
    catch (error) { await session.close(); throw new WebExecutionError(error instanceof Error ? error.message : String(error), session.readinessEvidence); }
  }
  /** Delivery consumes the same immutable snapshot and readiness implementation as Checker cases. */
  async verifyDelivery(job: Readonly<CheckJob>, signal: AbortSignal): Promise<ContentRef[]> {
    const session = await this.prepare(job, signal);
    try { await (session as WebSession).verifyDelivery(signal); return session.readinessEvidence; } finally { await session.close(); }
  }
}

class WebSession implements ExecutionSession {
  execution!: TypedRef;
  readinessEvidence: ContentRef[] = [];
  private candidate?: CandidateRuntime;
  private browser?: Browser;
  private runtime?: WebProgramRuntime;
  private caseDirectory?: string;
  private sequence = 0;
  private closed = false;
  private program?: ProgramRef;
  private contract?: Contract;
  private receipts: ContentRef[] = [];
  private readonly receiptIds = new Map<string, ContentRef>();
  private baseUrl = "";
  private runtimeContract?: ReturnType<typeof resolveRuntimeContract>;
  private app?: Awaited<ReturnType<CandidateRuntime["start"]>>;
  private failed = false;
  private leasedPort?: number;
  constructor(private readonly options: WebAdapterOptions, private readonly schemas: WebSchemas, private readonly declaration: AdapterDeclaration,
    private readonly job: Readonly<CheckJob>, private readonly source: string, private readonly initialMode: "empty" | "inherited") {}
  async initialize(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.closed) throw new Error("Web execution session is closed");
    if (Date.now() >= this.job.budget.deadlineAt) throw new Error("Web execution job deadline expired");
    const root = join(this.options.workspace, "web-" + randomUUID());
    await mkdir(root, { recursive: true, mode: 0o700 });
    this.caseDirectory = root;
    let source = this.source;
    if (this.initialMode === "empty" || this.options.initialDataSnapshot) {
      source = join(root, "initial");
      await cp(this.source, source, { recursive: true });
      for (const path of this.options.spec.dataPaths ?? []) await rm(join(source, path), { recursive: true, force: true });
      if (this.initialMode === "inherited" && this.options.initialDataSnapshot) {
        const baseline = await this.options.snapshots.open(this.options.initialDataSnapshot);
        for (const path of this.options.spec.dataPaths ?? []) {
          const from = join(baseline.sourceDirectory, path);
          const exists = await lstat(from).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
          if (exists) { await mkdir(dirname(join(source, path)), { recursive: true }); await cp(from, join(source, path), { recursive: true }); }
        }
      }
    }
    const port = await prepareOneAtATime(async () => {
      signal.throwIfAborted();
      const allocated = await pickFreePort([...leasedPorts, ...(webSettings(this.options.spec).extraPorts), ...(this.options.reservedPorts ?? [])]);
      leasedPorts.add(allocated);
      return allocated;
    });
    this.leasedPort = port;
    const contract = resolveRuntimeContract(this.options.spec, { port });
    const config = webRuntimeConfig(contract);
    this.runtimeContract = contract;
    this.execution = await this.options.artifacts.putTypedJson({ caseId: randomUUID(), port, baseUrl: config.baseUrl, initialState: this.job.initialState }, this.schemas.environment);
    this.candidate = new CandidateRuntime(source, join(root, "candidate"), contract, this.options.lifecycle ?? new WebAppLifecycle(), undefined, source);
    const onAbort = () => { void this.candidate?.close().catch(() => {}); void this.browser?.close().catch(() => {}); };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const app = await prepareOneAtATime(async () => { signal.throwIfAborted(); return this.candidate!.start(source, contract); });
      this.app = app;
      signal.throwIfAborted();
      const baseUrl = (app.metadata as { baseUrl: string }).baseUrl;
      this.baseUrl = baseUrl;
      this.browser = await (this.options.launchBrowser?.() ?? chromium.launch({ headless: true }));
      const context = await this.browser.newContext({ serviceWorkers: "block" });
      try {
        const page = await context.newPage();
        const response = await page.goto(new URL(config.browserPath ?? "/", baseUrl).href, { waitUntil: "domcontentloaded", timeout: Math.min(10_000, this.remaining()) });
        if (!response?.ok() || !response.headers()["content-type"]?.toLowerCase().includes("text/html")) throw new Error("Web browser readiness must return successful HTML");
      } finally { await context.close(); }
      await app.assertUnchanged?.();
      signal.throwIfAborted();
      this.execution = await this.options.artifacts.putTypedJson({ caseId: randomUUID(), port, baseUrl: baseUrl, initialState: this.job.initialState, candidate: app.candidate ?? null }, this.schemas.environment);
      const readiness = await this.record("readiness", { result: "ready", http: true, browser: true }, { readiness: { result: "ready" } });
      this.readinessEvidence.push(readiness);
      this.runtime = this.newRuntime();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.readinessEvidence.push(await this.record("readiness", { category: "preparation", message }, { readiness: { result: "inconclusive" } }));
      throw error;
    } finally { signal.removeEventListener("abort", onAbort); }
  }
  private remaining(): number { return Math.max(1, Math.min(30_000, this.job.budget.deadlineAt - Date.now())); }
  private newRuntime(): WebProgramRuntime {
    return new WebProgramRuntime(this.browser!, this.baseUrl, async (event) => {
      if (event.assertion?.result === "violated" || event.kind === "precondition" && event.payload.result === "violated") this.failed = true;
      const formal = !!this.program && (event.kind !== "action" || !!event.checkpointId);
      const kind = (event.kind === "action" || event.kind === "assertion" || event.kind === "precondition") && !formal ? "diagnostic" : event.kind;
      const receipt = await this.record(kind, event.payload, { ...(formal && event.checkpointId ? { checkpointId: event.checkpointId } : {}), ...(formal && event.assertion ? { assertion: event.assertion } : {}), inputs: event.inputs.map((id) => {
        const ref = this.receiptIds.get(id); if (!ref) throw new Error("Unknown host observation receipt"); return ref;
      }) });
      this.receiptIds.set(receipt.id, receipt);
      return receipt.id;
    }, (this.contract?.clauses ?? []).map((clause) => ({ ...clause, clauseId: clause.clauseId ?? clause.id! })), Math.min(5_000, this.remaining()), this.contract?.checkpoints ?? []);
  }
  private async record(kind: EvidenceReceipt["kind"], payload: unknown, extra: Partial<EvidenceReceipt> = {}): Promise<ContentRef> {
    const clean = JSON.parse(JSON.stringify(payload)) as unknown;
    if (Buffer.byteLength(canonicalJson(clean)) > this.declaration.observations[0]!.maxBytes) throw new Error("Web observation payload exceeds its declared evidence limit");
    const receipt: EvidenceReceipt = { id: randomUUID(), job: await this.options.artifacts.putJson(this.job), snapshot: this.job.snapshot, binding: this.job.binding,
      environment: this.execution, ...(this.program ? { program: this.program } : {}), sequence: this.sequence++, recordedAt: new Date().toISOString(), kind,
      inputs: [], payload: await this.options.artifacts.putTypedJson(clean, this.schemas.payload), attachments: [], ...extra };
    const ref = await this.options.artifacts.putReceipt(this.job, receipt);
    this.receipts.push(ref);
    return ref;
  }
  async invoke(capabilityId: string, input: unknown, signal: AbortSignal): Promise<{ output: TypedRef; receipts: ContentRef[] }> {
    signal.throwIfAborted();
    if (this.closed) throw new Error("Web execution session is closed");
    const capability = this.declaration.capabilities.find((item) => item.id === capabilityId);
    if (!capability) throw new Error("Unknown Web capability: " + capabilityId);
    await this.options.artifacts.validateSchema(capability.inputSchema, input);
    const start = this.receipts.length;
    const data = input as Record<string, unknown>;
    let value: unknown;
    if (capabilityId === "reset_case") { await this.reset(signal); value = { reset: true }; }
    else if (capabilityId === "inspect") {
      const actor = typeof data.actor === "string" ? data.actor : "default";
      await this.runtime!.invoke("actor", { actor }, signal);
      value = await this.runtime!.invoke("inspect", { actor }, signal);
    } else {
      if (data.program) {
        const descriptor = await this.loadProgram(data.program as ProgramRef);
        const savedSource = (await this.options.artifacts.getBytes(descriptor.source)).toString("utf8");
        if (data.source !== savedSource) throw new Error("Execution source differs from the bound program artifact");
      }
      try { value = await this.run(String(data.source), signal); }
      catch (error) { const message = error instanceof Error ? error.message : String(error); await this.record("diagnostic", { category: error instanceof CandidatePreparationError ? "candidate" : "execution", message }); if (error instanceof CandidatePreparationError) throw error; value = { error: message }; }
    }
    return { output: await this.options.artifacts.putTypedJson({ result: value ?? null }, this.schemas.output), receipts: this.receipts.slice(start) };
  }
  private async run(source: string, signal: AbortSignal): Promise<unknown> {
    const onAbort = () => { void this.runtime?.close().catch(() => {}); };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await this.runtime!.run(source, { signal, timeoutMs: this.remaining() });
      await this.app?.assertUnchanged?.();
      return result;
    } catch (error) { this.failed = true; throw error; }
    finally {
      signal.removeEventListener("abort", onAbort);
      if (this.failed && !signal.aborted) await this.captureFailureEvidence();
    }
  }
  private async captureFailureEvidence(): Promise<void> {
    const attachments: TypedRef[] = [];
    for (const attachment of await this.runtime!.captureEvidence(this.caseDirectory!)) {
      const declaration = this.declaration.attachments.find((item) => item.mediaType === attachment.mediaType)!;
      if (attachment.bytes.length > declaration.maxBytes) {
        await this.record("diagnostic", { category: "attachment-limit", mediaType: attachment.mediaType });
        continue;
      }
      attachments.push({ ...await this.options.artifacts.putBytes(attachment.bytes), schema: declaration.schema, mediaType: attachment.mediaType });
    }
    if (attachments.length) await this.record("diagnostic", { category: "failure-evidence" }, { attachments });
  }
  private async loadProgram(program: ProgramRef): Promise<ProgramDescriptor> {
    if (program.format !== WEB_PROGRAM_FORMAT || canonicalJson(program.binding) !== canonicalJson(this.job.binding)) throw new Error("Unsupported or incompatible Web program");
    const descriptor = await this.options.artifacts.readTypedJson<ProgramDescriptor>(program.descriptor);
    if (!sameRef(descriptor.initialState, this.job.initialState)) throw new Error("Program initial state differs from the job declaration");
    const contract = await this.options.artifacts.getJson<Contract>(program.contract);
    if (!Array.isArray(contract.clauses) || !Array.isArray(contract.checkpoints)) throw new Error("Web contract must declare clauses and checkpoints");
    for (const mapping of descriptor.clauses) if (!contract.clauses.some((clause) => (clause.clauseId ?? clause.id) === mapping.clauseId && clause.checkpointId === mapping.checkpointId)) throw new Error("Web program clause mapping does not match its contract");
    this.program = program;
    this.contract = contract;
    await this.runtime?.close();
    this.runtime = this.newRuntime();
    return descriptor;
  }
  async replay(program: ProgramRef, signal: AbortSignal): Promise<ContentRef[]> {
    const start = this.receipts.length;
    await this.reset(signal);
    const descriptor = await this.loadProgram(program);
    const source = (await this.options.artifacts.getBytes(descriptor.source)).toString("utf8");
    if (!source.trim() || source.length > 256_000) throw new Error("Web program must contain bounded JavaScript source");
    try { await this.run(source, signal); }
    catch (error) { await this.record("diagnostic", { category: error instanceof CandidatePreparationError ? "candidate" : "execution", message: error instanceof Error ? error.message : String(error) }); if (error instanceof CandidatePreparationError) throw error; signal.throwIfAborted(); }
    return this.receipts.slice(start);
  }
  private async reset(signal: AbortSignal): Promise<void> {
    await this.cleanup();
    this.program = undefined;
    this.contract = undefined;
    this.failed = false;
    this.receiptIds.clear();
    await this.initialize(signal);
  }
  private async cleanup(): Promise<void> {
    const failures: unknown[] = [];
    const attempt = async (operation: () => Promise<unknown>) => { try { await operation(); } catch (error) { failures.push(error); } };
    await attempt(async () => { await this.runtime?.close(); }); this.runtime = undefined;
    await attempt(async () => { await this.browser?.close(); }); this.browser = undefined;
    await attempt(async () => { await this.app?.assertUnchanged?.(); });
    await attempt(async () => { await this.app?.stop(); });
    await attempt(async () => { await this.app?.assertUnchanged?.(); });
    let disposed = false;
    await attempt(async () => { await this.candidate?.dispose(); disposed = true; });
    if (disposed) {
      this.candidate = undefined; this.app = undefined;
      if (this.caseDirectory) { await attempt(async () => { await rm(this.caseDirectory!, { recursive: true, force: true }); }); this.caseDirectory = undefined; }
      if (this.leasedPort !== undefined) { leasedPorts.delete(this.leasedPort); this.leasedPort = undefined; }
    }
    if (failures.length) throw failures[0];
  }
  async verifyDelivery(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await this.runtime?.close(); this.runtime = undefined;
    await this.candidate!.stop();
    const report = await verifyDeclaredPorts(this.candidate!.directory, this.runtimeContract!);
    signal.throwIfAborted();
    if (!report.ok) throw new Error(report.message);
    this.readinessEvidence.push(await this.record("readiness", { result: "ready", delivery: report.message }, { readiness: { result: "ready" } }));
  }
  async close(): Promise<void> { if (!this.closed) { this.closed = true; await this.cleanup(); } }
}
