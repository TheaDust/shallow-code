import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { sanitizeDiagnosticText } from "./run-state.js";
import type { RequirementNode } from "./types.js";

type ProjectionRecord = {
  id: string;
  event: Record<string, unknown>;
  tree?: { requirementRows: Record<string, ArcRequirementRow>; scenarioRows: Record<string, ArcScenarioRow> };
};

export interface ArcProjectionOptions {
  /** Controller-owned path outside the candidate. Contains only public projection data. */
  journalFile: string;
}

const ARC_TABLES = [
  "requirements",
  "scenarios",
  "interfaces",
  "tests",
  "call_edges",
  "node_states",
  "node_contracts",
] as const;

const NODE_STATE_BY_PHASE_STATUS: Record<string, string> = {
  "design:running": "DESIGNING",
  "design:completed": "DESIGNED",
  "design:failed": "FAILED",
  "implement:running": "IMPLEMENTING",
  "implement:completed": "IMPLEMENTED",
  "implement:failed": "FAILED",
  "test:passed": "PASSED",
  "test:failed": "FAILED",
};

export interface ArcRequirementRow {
  req_id: string;
  id: string;
  name: string;
  description: string;
  visual_reference: string[];
  scenarios: Array<{ id: string; name: string; steps: ArcScenarioStep[] }>;
  parent_id: string | null;
  children_ids: string[];
  dependencies: string[];
}

export interface ArcScenarioRow {
  scenario_id: string;
  id: string;
  name: string;
  req_id: string;
  steps: ArcScenarioStep[];
}

export interface ArcScenarioStep {
  keyword: string;
  content: string;
}

export class ArcEventSink {
  private readonly eventsFile: string;
  private readonly traceDir: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(outputDir: string, private readonly projection?: ArcProjectionOptions) {
    const arcDir = join(outputDir, ".arc");
    this.eventsFile = join(arcDir, "runner-events.jsonl");
    this.traceDir = join(arcDir, "traceability");
  }

  async init(): Promise<void> {
    await mkdir(this.traceDir, { recursive: true });
    for (const table of ARC_TABLES) {
      const path = this.tablePath(table);
      try {
        await readFile(path, "utf8");
      } catch {
        await writeJsonAtomic(path, {});
      }
    }
  }

  async runnerState(
    state: "running" | "completed" | "failed",
    message?: string,
  ): Promise<void> {
    await this.appendEvent({
      type: "runner_state",
      state,
      timestamp: arcTimestamp(),
      message: message === undefined ? null : sanitizeDiagnosticText(message),
    });
  }

  async requirementState(
    reqId: string,
    phase: "design" | "implement" | "test",
    status: "running" | "completed" | "failed" | "passed",
  ): Promise<void> {
    await this.appendEvent({
      type: "requirement_state",
      node_id: reqId,
      phase,
      status,
      timestamp: arcTimestamp(),
      message: null,
    });
    // Reference parity: EventClient.set_requirement_state_writer updates node_states
    // and emits a traceability refresh signal after every requirement state event.
    await this.appendTraceabilitySignal("node_state_updated");
  }

  private appendTraceabilitySignal(reason: string): Promise<void> {
    return this.appendEvent({
      type: "signal",
      reason,
      timestamp: arcTimestamp(),
      refresh: {
        submission: true,
        logs: false,
        commit_history: false,
        traceability_selected: true,
        traceability_all: true,
        preview: false,
      },
    });
  }

  async commitHistorySignal(reason: string): Promise<void> {
    await this.appendEvent({
      type: "signal",
      reason,
      timestamp: arcTimestamp(),
      refresh: {
        submission: false,
        logs: false,
        commit_history: true,
        traceability_selected: false,
        traceability_all: false,
        preview: false,
      },
    });
  }

  async storeRequirementTree(
    requirementRows: Record<string, ArcRequirementRow>,
    scenarioRows: Record<string, ArcScenarioRow>,
  ): Promise<void> {
    await this.appendEvent({
      type: "signal",
      reason: "requirement_tree_stored",
      timestamp: arcTimestamp(),
      refresh: {
        submission: true,
        logs: false,
        commit_history: false,
        traceability_selected: true,
        traceability_all: true,
        preview: false,
      },
    }, { requirementRows, scenarioRows });
  }

  private async upsertNodeState(
    reqId: string,
    state: string,
    phase: string,
    timestamp: string,
  ): Promise<void> {
    const path = this.tablePath("node_states");
    const rows = await readJsonObject(path);
    rows[reqId] = {
      req_id: reqId,
      state,
      phase,
      updated_at: timestamp,
    };
    await writeJsonAtomic(path, rows);
  }

  private appendEvent(event: Record<string, unknown>, tree?: ProjectionRecord["tree"]): Promise<void> {
    const record: ProjectionRecord = structuredClone({ id: randomUUID(), event, ...(tree ? { tree } : {}) });
    return this.serial(async () => {
      if (this.projection) {
        await mkdir(join(this.projection.journalFile, ".."), { recursive: true });
        await appendFile(this.projection.journalFile, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
      }
      await this.apply(record);
    });
  }

  private async apply(record: ProjectionRecord): Promise<void> {
    if (record.tree) {
      await writeJsonAtomic(this.tablePath("requirements"), record.tree.requirementRows);
      await writeJsonAtomic(this.tablePath("scenarios"), record.tree.scenarioRows);
    }
    await mkdir(join(this.eventsFile, ".."), { recursive: true });
    await appendFile(this.eventsFile, `${JSON.stringify(record.event)}\n`, "utf8");
    const { node_id, phase, status, timestamp } = record.event;
    const nodeState = NODE_STATE_BY_PHASE_STATUS[`${phase}:${status}`];
    if (record.event.type === "requirement_state" && nodeState) {
      await this.upsertNodeState(String(node_id), nodeState, String(phase), String(timestamp));
    }
  }

  /** Rebuild this run's owned projection. Repeated replay preserves history exactly once. */
  rebuild(): Promise<void> {
    return this.serial(async () => {
      if (!this.projection) throw new Error("ARC rebuild requires a projection journal");
      const source = await readFile(this.projection.journalFile, "utf8");
      const records = source.split("\n").filter(Boolean).map((line) => JSON.parse(line) as ProjectionRecord);
      const unique = new Map<string, ProjectionRecord>();
      for (const record of records) {
        if (!record.id || !record.event) throw new Error("Invalid ARC projection record");
        const previous = unique.get(record.id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(record)) throw new Error("Conflicting ARC projection ID");
        unique.set(record.id, record);
      }
      const tables = Object.fromEntries(ARC_TABLES.map((table) => [table, {}])) as Record<(typeof ARC_TABLES)[number], Record<string, unknown>>;
      for (const record of unique.values()) {
        if (record.tree) {
          tables.requirements = record.tree.requirementRows;
          tables.scenarios = record.tree.scenarioRows;
        }
        const { node_id, phase, status, timestamp } = record.event;
        const state = NODE_STATE_BY_PHASE_STATUS[`${phase}:${status}`];
        if (record.event.type === "requirement_state" && state) {
          tables.node_states[String(node_id)] = { req_id: node_id, state, phase, updated_at: timestamp };
        }
      }
      await this.init();
      for (const table of ARC_TABLES) await writeJsonAtomic(this.tablePath(table), tables[table]);
      const tmp = `${this.eventsFile}.tmp`;
      await writeFile(tmp, [...unique.values()].map((record) => `${JSON.stringify(record.event)}\n`).join(""), "utf8");
      await rename(tmp, this.eventsFile);
    });
  }

  private serial(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }

  private tablePath(table: (typeof ARC_TABLES)[number]): string {
    return join(this.traceDir, `${table}.json`);
  }
}

export function buildArcRequirementRows(root: RequirementNode): {
  requirementRows: Record<string, ArcRequirementRow>;
  scenarioRows: Record<string, ArcScenarioRow>;
} {
  const requirementRows: Record<string, ArcRequirementRow> = {};
  const scenarioRows: Record<string, ArcScenarioRow> = {};
  const walk = (requirement: RequirementNode, parentId: string | null): void => {
    const scenarios: ArcRequirementRow["scenarios"] = [];
    for (const scenario of requirement.scenarios) {
      const row: ArcScenarioRow = { scenario_id: scenario.id, id: scenario.id,
        name: scenario.name, req_id: requirement.id, steps: scenario.steps };
      scenarios.push({
        id: row.scenario_id,
        name: row.name,
        steps: row.steps,
      });
      scenarioRows[row.scenario_id] = row;
    }
    requirementRows[requirement.id] = {
      req_id: requirement.id,
      id: requirement.id,
      name: requirement.name,
      description: requirement.description,
      visual_reference: [...requirement.visual_reference],
      scenarios,
      parent_id: parentId,
      children_ids: requirement.children.map((child) => child.id),
      dependencies: [...requirement.dependencies],
    };
    for (const child of requirement.children) walk(child, requirement.id);
  };
  walk(root, null);
  return { requirementRows, scenarioRows };
}

export function arcTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

async function writeJsonAtomic(
  path: string,
  value: unknown,
): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}
