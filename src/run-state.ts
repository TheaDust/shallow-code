import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { sanitizeDiagnosticText } from "./diagnostics.js";
export { sanitizeDiagnosticText } from "./diagnostics.js";

import type {
  RequirementStatus,
  RunEvent,
} from "./types.js";

export interface RunStateSnapshot {
  statusByRequirementId: Record<string, RequirementStatus>;
  attemptsByPacketId: Record<string, number>;
  acceptedSha: string;
  startedAtMs: number;
  totalBudgetMs: number;
  ledger: RunEvent[];
}

export interface InitialRunState {
  statusByRequirementId: Record<string, RequirementStatus>;
  acceptedSha: string;
  startedAtMs: number;
  totalBudgetMs: number;
}

export interface LogSink {
  write(chunk: string): void;
}

export class RunStateStore {
  private readonly state: RunStateSnapshot;
  private readonly runId = randomUUID();
  private firstEventAtMs?: number;
  private ledgerWrites: Promise<void> = Promise.resolve();

  constructor(
    initial: InitialRunState,
    private readonly ledgerFile?: string,
    private readonly logSink?: LogSink | null,
    private readonly secrets: readonly string[] = [],
  ) {
    this.state = {
      ...initial,
      statusByRequirementId: { ...initial.statusByRequirementId },
      attemptsByPacketId: {},
      ledger: [],
    };
  }

  get snapshot(): RunStateSnapshot {
    return {
      ...this.state,
      statusByRequirementId: { ...this.state.statusByRequirementId },
      attemptsByPacketId: { ...this.state.attemptsByPacketId },
      ledger: [...this.state.ledger],
    };
  }

  markRequirements(ids: string[], status: RequirementStatus): void {
    for (const id of ids) {
      if (!(id in this.state.statusByRequirementId)) {
        throw new Error(`Unknown requirement status key: ${id}`);
      }
      this.state.statusByRequirementId[id] = status;
    }
  }

  setAcceptedSha(sha: string): void {
    this.state.acceptedSha = sha;
  }

  setPacketAttempt(packetId: string, attempt: number): void {
    this.state.attemptsByPacketId[packetId] = attempt;
  }

  async record(event: RunEvent): Promise<void> {
    const sequence = this.state.ledger.length + 1;
    const atMs = Date.parse(event.at);
    this.firstEventAtMs ??= atMs;
    const safeEvent = redactEvent({ ...event, runId: this.runId,
      eventId: `${this.runId}:${sequence}`, sequence, phase: eventPhase(event),
      elapsedMs: Math.max(0, atMs - this.firstEventAtMs),
      acceptedSha: this.state.acceptedSha,
      ...(event.packetId ? { attempt: this.state.attemptsByPacketId[event.packetId] } : {}),
    }, this.secrets);
    this.state.ledger.push(safeEvent);
    try {
      // Planner response previews are private controller diagnostics, not public stderr.
      this.logSink?.write(`${JSON.stringify(safeEvent, (key, value: unknown) => key === "contentPreview" ? undefined : value)}\n`);
    } catch {
      // Diagnostic sink failures must never change the decision path.
    }
    if (!this.ledgerFile) return;
    // Reserve ordering before yielding: concurrent workers keep sequence and disk order aligned.
    this.ledgerWrites = this.ledgerWrites.then(async () => {
      try {
        await mkdir(dirname(this.ledgerFile!), { recursive: true });
        await appendFile(this.ledgerFile!, `${JSON.stringify(safeEvent)}\n`, { encoding: "utf8", mode: 0o600 });
      } catch {
        // Durable Checker transitions use their own store; this ledger is diagnostic.
      }
    });
    await this.ledgerWrites;
  }
}

function redactEvent(event: RunEvent, secrets: readonly string[]): RunEvent {
  return JSON.parse(JSON.stringify(event, (key, value: unknown) => {
    if (/^(?:api[_-]?key|authorization|password|secret|cookie|token|access[_-]?token|refresh[_-]?token)$/i.test(key)) return "[redacted]";
    if (/^(?:plan|probePlan|locatorSnapshot|trace|screenshot)$/i.test(key)) return undefined;
    if (typeof value === "string") return sanitizeDiagnosticText(value, secrets);
    return value;
  })) as RunEvent;
}

function eventPhase(event: RunEvent): RunEvent["phase"] {
  if (event.type.startsWith("check_") || event.type.startsWith("module_check") || event.type === "checker_usage") return "checker";
  if (event.type.startsWith("evidence_")) return "evidence";
  if (event.type.startsWith("builder_")) return "builder";
  if (event.type.startsWith("application_")) return "application";
  if (event.type.startsWith("candidate_")) return "application";
  if (event.type.startsWith("delivery_") || event.type.startsWith("verification_")) return "delivery";
  if (event.type.startsWith("packet_")) return "decision";
  return "pipeline";
}
