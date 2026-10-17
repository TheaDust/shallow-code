import { readFile } from "node:fs/promises";
import { atomicWrite, canonicalJson } from "./artifacts.js";
import type { ContentRef } from "./port.js";

export interface ProducedSnapshot {
  snapshot: ContentRef;
  sourceSha: string;
  ordinal: number;
  parentSnapshotId?: string;
  implementedRequirementIds: string[];
}

export interface CheckerCheckpoint {
  version: 1;
  bindingDigest: string;
  initialSha: string;
  snapshots: ProducedSnapshot[];
  producedHead?: ProducedSnapshot;
  accepted: { sha: string; snapshot?: ContentRef; ordinal: number; requirementIds: string[] };
  readySnapshots: ContentRef[];
  epoch: number;
}

/** One serialized durable pointer separates produced source from runnable source. */
export class CheckerCheckpoints {
  private writes: Promise<unknown> = Promise.resolve();
  private constructor(private readonly file: string, private state: CheckerCheckpoint) {}

  static async open(file: string, bindingDigest: string, initialSha: string): Promise<CheckerCheckpoints> {
    const existing = await readCheckerCheckpoint(file);
    if (existing && existing.bindingDigest !== bindingDigest) throw new Error("Checker execution binding changed; start a new run");
    const store = new CheckerCheckpoints(file, existing ?? { version: 1, bindingDigest, initialSha, snapshots: [],
      accepted: { sha: initialSha, ordinal: 0, requirementIds: [] }, readySnapshots: [], epoch: 0 });
    await store.update(() => {});
    return store;
  }

  get snapshot(): CheckerCheckpoint { return structuredClone(this.state); }

  async produced(value: Omit<ProducedSnapshot, "ordinal">): Promise<ProducedSnapshot> {
    let result!: ProducedSnapshot;
    await this.update(next => {
      if (value.parentSnapshotId !== next.producedHead?.snapshot.id) throw new Error("Produced snapshot parent changed");
      result = { ...value, ordinal: (next.snapshots.at(-1)?.ordinal ?? 0) + 1 };
      next.snapshots.push(result);
      next.producedHead = result;
    });
    return result;
  }

  async ready(snapshot: ContentRef): Promise<boolean> {
    let advanced = false;
    await this.update(next => {
      const candidate = next.snapshots.find(item => item.snapshot.id === snapshot.id && item.snapshot.digest === snapshot.digest);
      if (!candidate) return;
      if (!next.readySnapshots.some(item => item.digest === snapshot.digest)) next.readySnapshots.push(snapshot);
      if (candidate.ordinal <= next.accepted.ordinal) return;
      let cursor = next.producedHead;
      while (cursor && cursor.snapshot.id !== candidate.snapshot.id) {
        cursor = next.snapshots.find(item => item.snapshot.id === cursor!.parentSnapshotId);
      }
      if (!cursor) return;
      next.accepted = { sha: candidate.sourceSha, snapshot: candidate.snapshot, ordinal: candidate.ordinal,
        requirementIds: candidate.implementedRequirementIds };
      advanced = true;
    });
    return advanced;
  }

  /** Restore a complete repair baseline after the sole writer has stopped. */
  async restore(head: ProducedSnapshot): Promise<void> {
    await this.update(next => {
      if (!next.snapshots.some(item => item.snapshot.digest === head.snapshot.digest)) throw new Error("Unknown repair baseline");
      next.producedHead = head;
      // A rejected descendant is no longer a runnable delivery checkpoint on this branch.
      if (next.accepted.ordinal > head.ordinal) {
        let cursor: ProducedSnapshot | undefined = head;
        while (cursor && !next.readySnapshots.some(item => item.digest === cursor!.snapshot.digest)) {
          cursor = next.snapshots.find(item => item.snapshot.id === cursor!.parentSnapshotId);
        }
        next.accepted = cursor ? { sha: cursor.sourceSha, snapshot: cursor.snapshot, ordinal: cursor.ordinal,
          requirementIds: cursor.implementedRequirementIds } : { sha: next.initialSha, ordinal: 0, requirementIds: [] };
      }
      next.epoch++;
    });
  }

  async nextEpoch(): Promise<number> {
    let epoch = 0;
    await this.update(next => { epoch = ++next.epoch; });
    return epoch;
  }

  private async update(mutate: (next: CheckerCheckpoint) => void): Promise<void> {
    const operation = this.writes.then(async () => {
      const next = structuredClone(this.state);
      mutate(next);
      await atomicWrite(this.file, canonicalJson(next));
      this.state = next;
    });
    this.writes = operation.catch(() => {});
    await operation;
  }
}

export async function readCheckerCheckpoint(file: string): Promise<CheckerCheckpoint | undefined> {
  let text: string;
  try { text = await readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const value = JSON.parse(text) as CheckerCheckpoint;
  if (value.version !== 1 || typeof value.bindingDigest !== "string" || !Array.isArray(value.snapshots) ||
    !value.accepted || typeof value.accepted.sha !== "string" || typeof value.initialSha !== "string" ||
    !Array.isArray(value.readySnapshots) || !Number.isInteger(value.epoch)) {
    throw new Error("Invalid Checker checkpoint index");
  }
  const seen = new Map<string, ProducedSnapshot>();
  for (const item of value.snapshots) {
    if (!item.snapshot || typeof item.snapshot.id !== "string" || typeof item.snapshot.digest !== "string" ||
      typeof item.sourceSha !== "string" || !Array.isArray(item.implementedRequirementIds) ||
      !item.implementedRequirementIds.every(id => typeof id === "string") || item.ordinal !== seen.size + 1 ||
      seen.has(item.snapshot.id) || (item.parentSnapshotId && !seen.has(item.parentSnapshotId))) throw new Error("Corrupt Checker snapshot lineage");
    seen.set(item.snapshot.id, item);
  }
  if (value.producedHead && canonicalJson(seen.get(value.producedHead.snapshot.id) ?? null) !== canonicalJson(value.producedHead)) throw new Error("Unknown produced snapshot");
  if (value.readySnapshots.some(ref => seen.get(ref.id)?.snapshot.digest !== ref.digest)) throw new Error("Unknown readiness snapshot");
  const accepted = value.accepted.snapshot ? seen.get(value.accepted.snapshot.id) : undefined;
  if ((value.accepted.snapshot && (!accepted || accepted.sourceSha !== value.accepted.sha || accepted.ordinal !== value.accepted.ordinal ||
    !value.readySnapshots.some(ref => ref.digest === value.accepted.snapshot!.digest))) ||
    (!value.accepted.snapshot && (value.accepted.sha !== value.initialSha || value.accepted.ordinal !== 0))) throw new Error("Unproven accepted checkpoint");
  return value;
}
