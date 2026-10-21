/** Content references resolve only within the owning run's private artifact store. */
export interface ContentRef { id: string; digest: string }
export interface TypedRef extends ContentRef { schema: ContentRef; mediaType: string }
export interface ExecutorIdentity { id: string; version: string; digest: string }
export interface ExecutionBindingRef extends ContentRef { executor: ExecutorIdentity }
export interface ProgramRef {
  descriptor: TypedRef;
  format: string;
  contract: ContentRef;
  binding: ExecutionBindingRef;
}
export interface CheckJob {
  jobId: string;
  runId: string;
  moduleId: string;
  packetId: string;
  attempt: number;
  moduleEpoch: number;
  snapshot: ContentRef;
  requirements: ContentRef;
  binding: ExecutionBindingRef;
  initialState: TypedRef;
  requirementIds: string[];
  /** Only discover may explore or request semantic reviews; replay/confirm require cached approval. */
  mode: "prepare" | "discover" | "replay" | "confirm";
  programs: ProgramRef[];
  budget: {
    /** Absolute run limit, including queue admission. */
    deadlineAt: number;
    /** Execution allowance starting when the queue grants a slot. */
    timeoutMs?: number;
  };
}
export interface EvidenceReceipt {
  id: string;
  job: ContentRef;
  snapshot: ContentRef;
  binding: ExecutionBindingRef;
  environment: TypedRef;
  program?: ProgramRef;
  sequence: number;
  recordedAt: string;
  kind: "readiness" | "precondition" | "action" | "observation" | "assertion" | "diagnostic";
  checkpointId?: string;
  readiness?: { result: "ready" | "failed" | "inconclusive" };
  assertion?: { clauseId: string; result: "satisfied" | "violated" };
  inputs: ContentRef[];
  payload: TypedRef;
  attachments: TypedRef[];
}
export interface CheckOutcome {
  requirementId: string;
  scenarioId: string;
  clauseId: string;
  status: "pass" | "fail" | "blocked" | "inconclusive";
  evidence: ContentRef[];
  reason?: string;
}
export interface CheckReport {
  job: ContentRef;
  snapshot: ContentRef;
  binding: ExecutionBindingRef;
  manifest: ContentRef;
  programs: ProgramRef[];
  outcomes: CheckOutcome[];
}
export interface ExecutionSession {
  execution: TypedRef;
  readinessEvidence: ContentRef[];
  invoke(capabilityId: string, input: unknown, signal: AbortSignal): Promise<{ output: TypedRef; receipts: ContentRef[] }>;
  replay(program: ProgramRef, signal: AbortSignal): Promise<ContentRef[]>;
  /** Resolves after all owned execution resources have been released. */
  close(): Promise<void>;
}
export interface ExecutionAdapter {
  binding: ExecutionBindingRef;
  prepare(job: Readonly<CheckJob>, signal: AbortSignal): Promise<ExecutionSession>;
  /** Project opaque adapter data for model review; original receipts remain immutable. */
  reviewEvidence?(evidence: ReviewEvidence[]): ReviewEvidence[];
}
export interface ReviewEvidence { receipt: EvidenceReceipt; payload: unknown; environment: unknown }
export interface CheckerPort {
  /** Every exit, including cancellation, awaits execution cleanup. */
  check(job: Readonly<CheckJob>, signal: AbortSignal, onProgress?: (progress: CheckerProgress) => Promise<void>): Promise<CheckReport>;
}

/** Presentation facts only; progress never grants a requirement outcome. */
export type CheckerProgress = {
  stage: "prepare" | "exploration" | "rediscovery" | "replay" | "semantic_review" | "review_approved" |
    "review_rejected" | "review_cached" | "confirmation" | "diagnostic" | "cleanup";
  programId?: string;
  clauseIds?: string[];
  reason?: string;
  cached?: boolean;
};

export interface CapabilityDeclaration {
  id: string;
  version: string;
  description: string;
  inputSchema: ContentRef;
  outputSchema: ContentRef;
}
export interface AdapterDeclaration {
  schemaVersion: 1;
  id: string;
  version: string;
  implementation: ExecutorIdentity;
  execution: TypedRef;
  initialStates: TypedRef[];
  resourceKeys: string[];
  capabilities: CapabilityDeclaration[];
  programFormat: { id: string; version: string; mediaType: string; schema: ContentRef };
  observations: Array<{ schema: ContentRef; mediaType: string; maxBytes: number; visibility: "checker" | "builder" }>;
  attachments: Array<{ schema: ContentRef; mediaType: string; maxBytes: number; visibility: "checker" | "builder" }>;
  prompts: ContentRef[];
}
export interface ExecutionBinding {
  schemaVersion: 1;
  declaration: ContentRef;
  executor: ExecutorIdentity;
  schemas: ContentRef[];
  dependencies: Record<string, string>;
  promptDigest: string;
}
