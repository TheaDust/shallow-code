import type { ArtifactStore } from "../artifacts.js";
import type { ExecutionAdapter, TypedRef, ContentRef, AdapterDeclaration } from "../port.js";
import type { ProjectSpec } from "../../project-spec.js";
import type { ApplicationContract } from "../../application/port.js";
import type { SnapshotStore } from "../../snapshot-store.js";

export interface CheckerAdapterOptions {
  artifacts: ArtifactStore;
  snapshots: SnapshotStore;
  spec: ProjectSpec;
  applicationContract: ApplicationContract;
  workspace: string;
  initialDataSnapshot: ContentRef;
}
export interface RegisteredExecutionAdapter extends ExecutionAdapter {
  verifyDelivery(job: Parameters<ExecutionAdapter["prepare"]>[0], signal: AbortSignal): Promise<ContentRef[]>;
}
export type CheckerAdapterFactory = (options: CheckerAdapterOptions) => Promise<{
  adapter: RegisteredExecutionAdapter; declaration: AdapterDeclaration; initialState: TypedRef;
}>;

export class CheckerAdapterRegistry {
  constructor(private readonly factories: ReadonlyMap<string, CheckerAdapterFactory>) {}
  get(id: string): CheckerAdapterFactory {
    const factory = this.factories.get(id);
    if (!factory) throw new Error(`Unknown Checker adapter ${id}; available: ${[...this.factories.keys()].join(", ")}`);
    return factory;
  }
}
