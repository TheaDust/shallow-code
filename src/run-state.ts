import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { sanitizeDiagnosticText } from "./diagnostics.js";
import { locatorCandidates, probePlanSha256, type ProbeLocator, type ProbePlan } from "./judge/probe-schema.js";
export { sanitizeDiagnosticText } from "./diagnostics.js";

import type {
  RequirementStatus,
  RunEvent,
  ShadowReport,
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
  private evidenceCount = 0;
  private readonly semanticCorrections = new Map<string, number>();

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

  /** Per-run quota fence: each case may receive at most one semantic correction. */
  semanticCorrectionCount(packetId: string, caseId: string): number {
    return this.semanticCorrections.get(`${packetId}\u0000${caseId}`) ?? 0;
  }

  noteSemanticCorrection(packetId: string, caseId: string): void {
    const key = `${packetId}\u0000${caseId}`;
    this.semanticCorrections.set(key, (this.semanticCorrections.get(key) ?? 0) + 1);
  }

  /** Bounded, source-free failure evidence; neither full plans nor raw browser traces. */
  async saveEvidence(report: ShadowReport, plan?: ProbePlan): Promise<string | undefined> {
    if (!this.ledgerFile || report.failures.length === 0 || this.evidenceCount >= 128) return undefined;
    const id = `${this.runId}-${++this.evidenceCount}`;
    const evidence = {
      id, packetId: sanitizeDiagnosticText(report.packetId, this.secrets), verdict: report.verdict,
      acceptedSha: this.state.acceptedSha, attempt: this.state.attemptsByPacketId[report.packetId],
      ...(report.candidate ? { candidate: report.candidate } : {}),
      ...(plan ? { planSha256: probePlanSha256(plan) } : {}),
      failureCount: report.failures.length,
      failures: report.failures.slice(0, 8).map((failure) => {
        const step = plan?.cases.find((item) => item.id === failure.caseId)?.steps[failure.stepIndex];
        return {
          caseId: sanitizeDiagnosticText(failure.caseId, this.secrets), stepIndex: failure.stepIndex,
          category: failure.category, message: sanitizeDiagnosticText(failure.message, this.secrets),
          ...(failure.pageUrl ? { pageUrl: sanitizeDiagnosticText(failure.pageUrl, this.secrets, 1_000) } : {}),
          ...(failure.inputSummary ? { inputSummary: sanitizeDiagnosticText(failure.inputSummary, this.secrets) } : {}),
          ...(failure.locatorSnapshot ? { accessibilityExcerpt: sanitizeDiagnosticText(failure.locatorSnapshot, this.secrets) } : {}),
          ...(step && "locator" in step ? {
            locators: locatorCandidates(step.locator).map((locator) => sanitizeEvidenceLocator(locator, this.secrets)),
          } : {}),
          ...(failure.locatorAttempts ? {
            locatorAttempts: failure.locatorAttempts.slice(0, 4).map((attempt) => ({
              locator: sanitizeEvidenceLocator(attempt.locator, this.secrets),
              message: sanitizeDiagnosticText(attempt.message, this.secrets),
              ...(attempt.matchCount === undefined ? {} : { matchCount: attempt.matchCount }),
            })),
          } : {}),
        };
      }),
    };
    try {
      const payload = `${JSON.stringify(evidence)}\n`;
      if (Buffer.byteLength(payload) > 128 * 1024) return undefined;
      const directory = join(dirname(this.ledgerFile), "evidence");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(join(directory, `${id}.json`), payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
      return id;
    } catch {
      await this.record({ at: new Date().toISOString(), type: "evidence_write_failed", packetId: report.packetId });
      return undefined;
    }
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
    try {
      await mkdir(dirname(this.ledgerFile), { recursive: true });
      await appendFile(this.ledgerFile, `${JSON.stringify(safeEvent)}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {
      // Ledger file failures must never change the decision path.
    }
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

function sanitizeEvidenceLocator(locator: ProbeLocator, secrets: readonly string[]): ProbeLocator {
  const exact = locator.exact === undefined ? {} : { exact: locator.exact };
  const scope = locator.scope ? { scope: { ...sanitizeEvidenceLocator(locator.scope as ProbeLocator, secrets),
    ...(locator.scope.hasText === undefined ? {} : { hasText: sanitizeDiagnosticText(locator.scope.hasText, secrets) }) } } : {};
  return locator.by === "role"
    ? { by: "role", role: sanitizeDiagnosticText(locator.role, secrets), ...exact, ...scope,
      ...(locator.name === undefined ? {} : { name: sanitizeDiagnosticText(locator.name, secrets) }) }
    : { by: locator.by, text: sanitizeDiagnosticText(locator.text, secrets), ...exact, ...scope };
}

function eventPhase(event: RunEvent): RunEvent["phase"] {
  if (event.type.startsWith("arc_")) return "projection";
  if (event.type.startsWith("evidence_")) return "evidence";
  if (event.type.startsWith("builder_")) return "builder";
  if (event.type.startsWith("application_")) return "application";
  if (event.type.startsWith("candidate_")) return "application";
  if (event.type.startsWith("delivery_") || event.type.startsWith("verification_")) return "delivery";
  if (event.type.startsWith("probe_plan") || event.type === "probe_preplan_failed" || event.type.startsWith("probe_refin")) return "planner";
  if (event.type.startsWith("probe_")) return "probe";
  if (event.type.startsWith("packet_")) return "decision";
  return "pipeline";
}
