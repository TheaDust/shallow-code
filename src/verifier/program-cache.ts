import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { AtomicRequirement } from "../types.js";
import { ArtifactStore, atomicWrite, canonicalJson, contentDigest, sameRef } from "./artifacts.js";
import { validateAcceptanceContract, verifierSourceClauses, type AcceptanceContract, type VerifierProgramDescriptor, type VerifierRequirements } from "./evidence.js";
import type { AdapterDeclaration, CheckJob, ContentRef, ExecutionBindingRef, ProgramRef } from "./port.js";

interface CachedProgram {
  version: 1;
  key: string;
  source: string;
  contract: Omit<AcceptanceContract, "requirements">;
}

/** Private, cross-build program storage. Verdicts, receipts and review approvals stay run-local. */
export class VerifierProgramCache {
  private readonly cached: ArtifactStore;
  private readonly entries = new Map<string, { ref: ContentRef; value: CachedProgram }>();

  private constructor(readonly directory: string, private readonly artifacts: ArtifactStore,
    private readonly declaration: AdapterDeclaration, private readonly keys: Map<string, string>) {
    this.cached = new ArtifactStore(directory, "program-cache");
  }

  static async open(options: {
    directory: string;
    artifacts: ArtifactStore;
    binding: ExecutionBindingRef;
    initialData: unknown;
    requirements: AtomicRequirement[];
    requirementDigests: Readonly<Record<string, string>>;
  }): Promise<VerifierProgramCache> {
    const binding = await options.artifacts.validateBinding(options.binding);
    const declaration = await options.artifacts.getJson<AdapterDeclaration>(binding.declaration);
    // Rebind run-local state references only after checking the actual initial data.
    const execution = contentDigest({ ...binding, declaration: { ...declaration,
      initialStates: declaration.initialStates.map(state => ({ schema: state.schema, mediaType: state.mediaType })) },
      initialData: options.initialData });
    const byId = new Map(options.requirements.map(requirement => [requirement.id, requirement]));
    const keys = new Map<string, string>();
    for (const requirement of options.requirements) {
      if (!options.requirementDigests[requirement.id]) continue;
      const dependencies = new Set<string>();
      const visit = (id: string): void => {
        if (dependencies.has(id)) return;
        dependencies.add(id);
        byId.get(id)?.dependencyIds.forEach(visit);
      };
      visit(requirement.id);
      keys.set(requirement.id, contentDigest({ execution,
        requirements: [...dependencies].sort().map(id => [id, options.requirementDigests[id] ?? null]) }));
    }
    return new VerifierProgramCache(options.directory, options.artifacts, declaration, keys);
  }

  async load(job: CheckJob, input: VerifierRequirements): Promise<ProgramRef[]> {
    const sources = verifierSourceClauses(input, job.requirementIds);
    const seen = new Set<string>();
    const programs: ProgramRef[] = [];
    for (const clause of sources) {
      const key = this.keys.get(clause.requirementId);
      if (!key) continue;
      try {
        const ref = JSON.parse(await readFile(this.pointer(key, clause.id), "utf8")) as ContentRef;
        if (seen.has(ref.digest)) continue;
        seen.add(ref.digest);
        const value = await this.cached.getJson<CachedProgram>(ref);
        if (value.version !== 1 || value.key !== key || typeof value.source !== "string" || !value.source.trim()) continue;
        const contract: AcceptanceContract = { ...value.contract, requirements: job.requirements };
        validateAcceptanceContract(contract, job, sources, input);
        if (!contract.clauses.some(item => item.id === clause.id) || contract.clauses.some(item => item.requirementId !== clause.requirementId)) continue;
        const descriptor: VerifierProgramDescriptor = { source: await this.artifacts.putBytes(value.source), initialState: job.initialState,
          clauses: contract.clauses.map(item => ({ clauseId: item.id, checkpointId: item.checkpointId })) };
        const program: ProgramRef = { descriptor: await this.artifacts.putTypedJson(descriptor, this.declaration.programFormat.schema),
          format: `${this.declaration.programFormat.id}@${this.declaration.programFormat.version}`,
          contract: await this.artifacts.putJson(contract), binding: job.binding };
        this.entries.set(canonicalJson(program), { ref, value });
        programs.push(program);
      } catch {
        // Missing or invalid cache entries have no authority; discovery supplies current programs.
      }
    }
    return programs;
  }

  async save(job: CheckJob, input: VerifierRequirements, program: ProgramRef): Promise<void> {
    const contract = await this.artifacts.getJson<AcceptanceContract>(program.contract);
    validateAcceptanceContract(contract, job, verifierSourceClauses(input, job.requirementIds), input);
    const key = this.keys.get(contract.clauses[0]!.requirementId);
    if (!key) return;
    const descriptor = await this.artifacts.readTypedJson<VerifierProgramDescriptor>(program.descriptor);
    const value: CachedProgram = { version: 1, key, source: (await this.artifacts.getBytes(descriptor.source)).toString("utf8"),
      contract: { checkpoints: contract.checkpoints, clauses: contract.clauses } };
    const ref = await this.cached.putJson(value);
    for (const clause of contract.clauses) await atomicWrite(this.pointer(key, clause.id), canonicalJson(ref));
    this.entries.set(canonicalJson(program), { ref, value });
  }

  async invalidate(program: ProgramRef): Promise<void> {
    const entry = this.entries.get(canonicalJson(program));
    if (!entry) return;
    for (const clause of entry.value.contract.clauses) {
      const path = this.pointer(entry.value.key, clause.id);
      try {
        const current = JSON.parse(await readFile(path, "utf8")) as ContentRef;
        if (sameRef(current, entry.ref)) await unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  private pointer(key: string, clauseId: string): string {
    return join(this.directory, "clauses", key, contentDigest(clauseId) + ".json");
  }
}
