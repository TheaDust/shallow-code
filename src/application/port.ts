import type { CandidateEvidence, RunEvent } from "../types.js";
import type { BuilderTool } from "../builder/tool-contract.js";
import type { ProjectSpec } from "../project-spec.js";

export interface ProcessCommand {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
}

/** Shared execution inputs; adapterConfig is interpreted only by its owning adapter. */
export interface ApplicationContract {
  adapterId: string;
  adapterConfig: unknown;
  installCommands: ProcessCommand[];
  buildCommands: ProcessCommand[];
  startCommand: ProcessCommand;
  testTargets?: Array<ProcessCommand & { id: string }>;
  env?: Record<string, string>;
  dataDirectory?: string;
  dataPaths?: string[];
  dataEnvVar?: string;
  dependencyPaths?: string[];
  generatedPaths?: string[];
  buildTimeoutMs: number;
  startTimeoutMs: number;
  builderInstructions?: string;
}

export interface ApplicationSession {
  metadata: unknown;
  candidate?: CandidateEvidence;
  assertUnchanged?(): Promise<void>;
  stop(): Promise<void>;
}

export interface ApplicationLifecycle {
  start(directory: string, contract: ApplicationContract): Promise<ApplicationSession>;
}

export interface ApplicationRuntimePort extends ApplicationLifecycle {
  readonly directory: string;
  prepare(): Promise<void>;
  assertCurrent(evidence: CandidateEvidence): Promise<void>;
  recordAccepted(evidence: CandidateEvidence): void;
  assertAcceptedInput(): Promise<void>;
  setRecorder(recorder: (event: RunEvent) => Promise<void>): void;
  stop(): Promise<void>;
  close(): Promise<void>;
  dispose(): Promise<void>;
}

export interface BuilderCapabilityPack {
  tools: BuilderTool[];
  skillDirectories: string[];
  close(): Promise<void>;
}

export interface ScaffoldResult {
  status: "installed" | "skipped_existing_application" | "skipped_nonempty_output";
  reason: string;
  files: string[];
}

/** Trusted, bundled implementation selected by a project declaration. */
export interface RuntimeAdapter {
  id: string;
  parseSpec(raw: unknown, origin?: string): ProjectSpec;
  defaultSpec(): ProjectSpec;
  configure(spec: ProjectSpec, env: Record<string, string | undefined>): Promise<ApplicationContract>;
  lifecycle: ApplicationLifecycle;
  installScaffold(directory: string, contract: ApplicationContract): Promise<ScaffoldResult>;
  builderCapabilities(directory: string): BuilderCapabilityPack;
  verifyDelivery(directory: string, contract: ApplicationContract): Promise<DeliveryReport>;
}

export interface DeliveryReport {
  ok: boolean;
  stage: "install" | "build" | "readiness" | "entry" | "candidate" | "complete";
  message: string;
  candidate?: CandidateEvidence;
}

export class CandidatePreparationError extends Error {
  constructor(readonly stage: "install" | "build" | "candidate", message: string) { super(message); }
}
