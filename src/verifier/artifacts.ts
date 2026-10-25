import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import type { AdapterDeclaration, CheckJob, CheckReport, ContentRef, EvidenceReceipt, ExecutionBinding, ExecutionBindingRef, TypedRef } from "./port.js";

export function hashBytes(value: Uint8Array | string): string { return createHash("sha256").update(value).digest("hex"); }
/** Stable JSON, rejecting values that JSON would silently change or discard. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonicalJson((value as Record<string, unknown>)[key])).join(",") + "}";
  }
  throw new Error("Artifacts must contain JSON data only");
}
export function contentDigest(value: unknown): string { return hashBytes(canonicalJson(value)); }
export function sameRef(left: ContentRef, right: ContentRef): boolean { return left.id === right.id && left.digest === right.digest; }

/** Write complete contents before atomically publishing an index or immutable object. */
export async function atomicWrite(path: string, contents: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  }
  finally { await rm(temporary, { force: true }); }
}

/** Run-local content storage. All reads revalidate bytes; callers never resolve arbitrary paths. */
export class ArtifactStore {
  readonly directory: string;
  private pending = new Map<string, Promise<ContentRef>>();
  constructor(directory: string, readonly runId: string) { this.directory = resolve(directory); }
  private path(ref: ContentRef): string {
    if (!ref || !/^[a-f0-9]{64}$/.test(ref.digest) || ref.id !== ref.digest) throw new Error("Invalid artifact reference");
    return join(this.directory, "objects", ref.digest);
  }
  async putBytes(value: Uint8Array | string): Promise<ContentRef> {
    const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
    const digest = hashBytes(bytes), ref = { id: digest, digest };
    const existing = this.pending.get(digest);
    if (existing) return existing;
    const write = this.storeBytes(ref, bytes);
    this.pending.set(digest, write);
    try { return await write; } finally { this.pending.delete(digest); }
  }
  private async storeBytes(ref: ContentRef, bytes: Buffer): Promise<ContentRef> {
    const path = this.path(ref);
    try {
      const previous = await readFile(path);
      if (hashBytes(previous) !== ref.digest) throw new Error("Corrupt existing artifact: " + ref.digest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await atomicWrite(path, bytes);
    }
    return ref;
  }
  async getBytes(ref: ContentRef): Promise<Buffer> {
    const bytes = await readFile(this.path(ref));
    if (hashBytes(bytes) !== ref.digest) throw new Error("Artifact integrity mismatch: " + ref.id);
    return bytes;
  }
  putJson(value: unknown): Promise<ContentRef> { return this.putBytes(canonicalJson(value)); }
  async getJson<T = unknown>(ref: ContentRef): Promise<T> { return JSON.parse((await this.getBytes(ref)).toString("utf8")) as T; }
  async putTypedJson(value: unknown, schema: ContentRef, mediaType = "application/json"): Promise<TypedRef> {
    await this.validateSchema(schema, value);
    return { ...await this.putJson(value), schema, mediaType };
  }
  async readTypedJson<T = unknown>(ref: TypedRef): Promise<T> {
    if (!ref.mediaType || !ref.schema) throw new Error("Missing typed artifact metadata");
    const value = await this.getJson<T>(ref);
    await this.validateSchema(ref.schema, value);
    return value;
  }
  async validateSchema(ref: ContentRef, value: unknown): Promise<void> {
    const schema = await this.getJson<TSchema>(ref);
    if (!Value.Check(schema, value)) throw new Error("Artifact does not satisfy schema " + ref.id);
  }
  async validateBinding(ref: ExecutionBindingRef): Promise<ExecutionBinding> {
    const binding = await this.getJson<ExecutionBinding>(ref);
    if (binding.schemaVersion !== 1 || canonicalJson(binding.executor) !== canonicalJson(ref.executor)) throw new Error("Execution binding mismatch");
    const declaration = await this.getJson<AdapterDeclaration>(binding.declaration);
    if (declaration.schemaVersion !== 1 || canonicalJson(declaration.implementation) !== canonicalJson(binding.executor)) throw new Error("Adapter implementation mismatch");
    const references = [declaration.execution.schema, ...declaration.initialStates.map(ref => ref.schema),
      ...declaration.capabilities.flatMap(capability => [capability.inputSchema, capability.outputSchema]),
      declaration.programFormat.schema, ...declaration.observations.map(item => item.schema), ...declaration.attachments.map(item => item.schema)];
    if (references.some(schema => !binding.schemas.some(ref => sameRef(ref, schema)))) throw new Error("Binding omits declaration schema");
    await Promise.all([...binding.schemas, ...declaration.prompts].map(ref => this.getBytes(ref)));
    await this.readTypedJson(declaration.execution);
    await Promise.all(declaration.initialStates.map(ref => this.readTypedJson(ref)));
    if (!binding.promptDigest || !declaration.capabilities.every(capability => capability.id && capability.version)) throw new Error("Incomplete execution binding");
    return binding;
  }
  async putReceipt(job: Readonly<CheckJob>, receipt: EvidenceReceipt): Promise<ContentRef> {
    await this.validateReceipt(job, receipt);
    return this.putJson(receipt);
  }
  async validateReceipt(job: Readonly<CheckJob>, receipt: EvidenceReceipt): Promise<void> {
    if (job.runId !== this.runId || !sameRef(receipt.job, await this.putJson(job)) || !sameRef(receipt.snapshot, job.snapshot) ||
      canonicalJson(receipt.binding) !== canonicalJson(job.binding)) throw new Error("Receipt belongs to a different job or execution binding");
    if (!receipt.id || !Number.isInteger(receipt.sequence) || receipt.sequence < 0 || !Number.isFinite(Date.parse(receipt.recordedAt))) throw new Error("Invalid receipt identity");
    if (receipt.kind === "readiness" && !receipt.readiness) throw new Error("Missing readiness result");
    if (receipt.kind === "assertion" && (!receipt.assertion || !receipt.program || !receipt.checkpointId || !receipt.inputs.length)) throw new Error("Missing assertion evidence");
    if ((receipt.kind === "action" || receipt.kind === "precondition") && (!receipt.program || !receipt.checkpointId)) throw new Error("Missing program checkpoint");
    await this.readTypedJson(receipt.environment);
    await this.readTypedJson(receipt.payload);
    await Promise.all(receipt.inputs.map(ref => this.getBytes(ref)));
    for (const attachment of receipt.attachments) { await this.getBytes(attachment); await this.getBytes(attachment.schema); }
  }
  /** Envelope/integrity validation only. Semantic review and clause coverage are owned by Verifier. */
  async validateReport(job: Readonly<CheckJob>, report: CheckReport): Promise<void> {
    if (job.runId !== this.runId || !sameRef(report.job, await this.putJson(job)) || !sameRef(report.snapshot, job.snapshot) ||
      canonicalJson(report.binding) !== canonicalJson(job.binding)) throw new Error("Report belongs to a different job or execution binding");
    await this.validateBinding(report.binding);
    await this.getBytes(report.manifest);
    const seen = new Set<string>();
    for (const outcome of report.outcomes) {
      const key = canonicalJson([outcome.requirementId, outcome.scenarioId, outcome.clauseId]);
      if (!job.requirementIds.includes(outcome.requirementId) || seen.has(key)) throw new Error("Report scope or duplicate clause mismatch");
      seen.add(key);
      if ((outcome.status === "pass" || outcome.status === "fail") && !outcome.evidence.length) throw new Error("Definitive outcome has no evidence");
      for (const ref of outcome.evidence) await this.validateReceipt(job, await this.getJson<EvidenceReceipt>(ref));
    }
    for (const program of report.programs) {
      if (canonicalJson(program.binding) !== canonicalJson(job.binding)) throw new Error("Program binding mismatch");
      await this.readTypedJson(program.descriptor);
      await this.getBytes(program.contract);
    }
  }
  reviewKey(value: unknown): string { return contentDigest(value); }
}
