import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
  ArcEventSink,
  arcTimestamp,
  buildArcRequirementRows,
} from "../src/arc-protocol.js";
import type { RequirementNode } from "../src/types.js";
import { withTempDir } from "./helpers/temp-dir.js";

test("ARC event sink initializes the .arc protocol tables", async () => {
  await withTempDir("shallow-arc-", async (directory) => {
    const outputDir = join(directory, "output");
    const sink = new ArcEventSink(outputDir);

    await sink.init();

    const traceDir = join(outputDir, ".arc", "traceability");
    const tables = await readdir(traceDir);
    assert.deepEqual(tables.sort(), [
      "call_edges.json",
      "interfaces.json",
      "node_contracts.json",
      "node_states.json",
      "requirements.json",
      "scenarios.json",
      "tests.json",
    ]);
    assert.equal(await readFile(join(traceDir, "tests.json"), "utf8"), "{}\n");
  });
});

test("ARC event sink appends runner state events with UTC timestamps", async () => {
  await withTempDir("shallow-arc-", async (directory) => {
    const sink = new ArcEventSink(join(directory, "output"));
    await sink.init();

    await sink.runnerState("running", "pipeline started");
    await sink.runnerState("completed");

    const lines = await readEvents(directory);
    assert.equal(lines.length, 2);
    assert.deepEqual(Object.keys(lines[0]).sort(), [
      "message",
      "state",
      "timestamp",
      "type",
    ]);
    assert.equal(lines[0].type, "runner_state");
    assert.equal(lines[0].state, "running");
    assert.equal(lines[0].message, "pipeline started");
    assert.equal(lines[1].message, null);
    assert.match(lines[0].timestamp as string, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

test("ARC event sink records requirement states and node_states table", async () => {
  await withTempDir("shallow-arc-", async (directory) => {
    const sink = new ArcEventSink(join(directory, "output"));
    await sink.init();

    await sink.requirementState("REQ-PROFILE", "implement", "running");
    await sink.requirementState("REQ-PROFILE", "implement", "completed");
    await sink.requirementState("REQ-PROFILE", "test", "passed");

    const lines = await readEvents(directory);
    const states = lines.filter((line) => line.type === "requirement_state");
    assert.deepEqual(
      states.map((line) => [line.phase, line.status]),
      [
        ["implement", "running"],
        ["implement", "completed"],
        ["test", "passed"],
      ],
    );
    const signals = lines.filter((line) => line.type === "signal") as Array<{
      reason: string;
      refresh: Record<string, boolean>;
    }>;
    assert.equal(signals.length, 3);
    assert.ok(signals.every((signal) => signal.reason === "node_state_updated"));
    assert.equal(signals[0].refresh.submission, true);
    assert.equal(signals[0].refresh.traceability_selected, true);
    assert.equal(signals[0].refresh.traceability_all, true);
    assert.equal(signals[0].refresh.commit_history, false);
    const nodeStates = JSON.parse(
      await readFile(
        join(directory, "output", ".arc", "traceability", "node_states.json"),
        "utf8",
      ),
    ) as Record<string, { req_id: string; state: string; phase: string }>;
    assert.deepEqual(Object.keys(nodeStates), ["REQ-PROFILE"]);
    assert.equal(nodeStates["REQ-PROFILE"].state, "PASSED");
    assert.equal(nodeStates["REQ-PROFILE"].phase, "test");
  });
});

test("ARC event sink stores requirement and scenario rows atomically", async () => {
  await withTempDir("shallow-arc-", async (directory) => {
    const sink = new ArcEventSink(join(directory, "output"));
    await sink.init();

    const rows = buildArcRequirementRows(requirementTree());
    await sink.storeRequirementTree(rows.requirementRows, rows.scenarioRows);

    const requirements = JSON.parse(
      await readFile(
        join(directory, "output", ".arc", "traceability", "requirements.json"),
        "utf8",
      ),
    ) as Record<string, { req_id: string; name: string; parent_id: string | null }>;
    assert.deepEqual(Object.keys(requirements), ["ROOT", "PROFILE", "REQ-PROFILE"]);
    assert.equal(requirements["REQ-PROFILE"].name, "Save a profile");
    assert.equal(requirements["REQ-PROFILE"].parent_id, "PROFILE");

    const scenarios = JSON.parse(
      await readFile(
        join(directory, "output", ".arc", "traceability", "scenarios.json"),
        "utf8",
      ),
    ) as Record<string, { scenario_id: string; req_id: string; steps: unknown[] }>;
    assert.deepEqual(Object.keys(scenarios), ["REQ-PROFILE::0"]);
    assert.equal(scenarios["REQ-PROFILE::0"].req_id, "REQ-PROFILE");
    assert.equal(scenarios["REQ-PROFILE::0"].steps.length, 2);

    const lines = await readEvents(directory);
    assert.equal(
      lines.some((line) => line.type === "signal" && line.reason === "requirement_tree_stored"),
      true,
    );
  });
});

test("ARC event sink emits commit history refresh signals", async () => {
  await withTempDir("shallow-arc-", async (directory) => {
    const sink = new ArcEventSink(join(directory, "output"));
    await sink.init();

    await sink.commitHistorySignal("git_commit");

    const lines = await readEvents(directory);
    const signal = lines.find((line) => line.type === "signal") as {
      reason: string;
      refresh: Record<string, boolean>;
    };
    assert.equal(signal.reason, "git_commit");
    assert.equal(signal.refresh.commit_history, true);
    assert.equal(signal.refresh.submission, false);
  });
});

test("ARC timestamp renders UTC in platform format", () => {
  const timestamp = arcTimestamp(new Date(Date.UTC(2026, 8, 4, 12, 34, 56)));
  assert.equal(timestamp, "2026-09-04 12:34:56");
});

test("ARC replay repairs a failed projection, deduplicates IDs, and keeps official wire fields", async () => {
  await withTempDir("shallow-arc-replay-", async (directory) => {
    const output = join(directory, "output");
    const journalFile = join(directory, "private", "arc-projection.jsonl");
    const sink = new ArcEventSink(output, { journalFile });
    await sink.init();
    const rows = buildArcRequirementRows(requirementTree());
    await sink.storeRequirementTree(rows.requirementRows, rows.scenarioRows);
    await sink.requirementState("REQ-PROFILE", "implement", "failed");
    const eventsPath = join(output, ".arc", "runner-events.jsonl");
    // Replace only this test's generated file with an unwritable projection target.
    await rm(eventsPath);
    await mkdir(eventsPath);
    await assert.rejects(sink.requirementState("REQ-PROFILE", "test", "passed"));
    const journal = await readFile(journalFile, "utf8");
    await appendFile(journalFile, journal.trim().split("\n").at(-1)! + "\n");
    await rm(eventsPath, { recursive: true });
    await sink.rebuild();
    const first = await readFile(eventsPath, "utf8");
    await sink.rebuild();
    assert.equal(await readFile(eventsPath, "utf8"), first);
    const events = first.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.length, 4);
    const stateEvents = events.filter((event) => event.type === "requirement_state");
    assert.deepEqual(stateEvents.map((event) => event.status), ["failed", "passed"]);
    const signals = events.filter((event) => event.type === "signal");
    assert.deepEqual(signals.map((event) => event.reason), [
      "requirement_tree_stored",
      "node_state_updated",
    ]);
    assert.deepEqual(Object.keys(events[0]).sort(), ["reason", "refresh", "timestamp", "type"]);
    assert.deepEqual(Object.keys(stateEvents[0]).sort(), ["message", "node_id", "phase", "status", "timestamp", "type"]);
    assert.doesNotMatch(first, /packet_id|outcome|eventId|probePlan|builder_receipt/);
    const state = JSON.parse(await readFile(join(output, ".arc", "traceability", "node_states.json"), "utf8"));
    assert.equal(state["REQ-PROFILE"].state, "PASSED");
    assert.equal(state["REQ-PROFILE"].updated_at, stateEvents[1].timestamp);
    const tree = JSON.parse(await readFile(join(output, ".arc", "traceability", "requirements.json"), "utf8"));
    assert.equal(tree.ROOT.parent_id, null);
    assert.deepEqual(tree.ROOT.children_ids, ["PROFILE"]);
    assert.deepEqual(tree.PROFILE.children_ids, ["REQ-PROFILE"]);
  });
});

test("ARC serializes simultaneous state updates without dropping rows", async () => {
  await withTempDir("shallow-arc-serial-", async (directory) => {
    const sink = new ArcEventSink(directory);
    await sink.init();
    await Promise.all(["A", "B", "C"].map((id) => sink.requirementState(id, "implement", "running")));
    const state = JSON.parse(await readFile(join(directory, ".arc", "traceability", "node_states.json"), "utf8"));
    assert.deepEqual(Object.keys(state).sort(), ["A", "B", "C"]);
  });
});

test("ARC requirement rows preserve the complete source tree and structured scenarios", () => {
  const rows = buildArcRequirementRows(requirementTree());

  assert.deepEqual(Object.keys(rows.requirementRows), ["ROOT", "PROFILE", "REQ-PROFILE"]);
  const row = rows.requirementRows["REQ-PROFILE"];
  assert.equal(row.description, "Keep a profile name after refresh.");
  assert.deepEqual(row.dependencies, []);
  assert.deepEqual(row.visual_reference, []);
  assert.deepEqual(row.children_ids, []);
  const scenario = rows.scenarioRows["REQ-PROFILE::0"];
  assert.deepEqual(scenario.steps, [
    { keyword: "WHEN", content: "The user enters a profile name and saves." },
    { keyword: "THEN", content: "The same name remains after refresh." },
  ]);
});

async function readEvents(
  directory: string,
): Promise<Array<Record<string, unknown>>> {
  const content = await readFile(
    join(directory, "output", ".arc", "runner-events.jsonl"),
    "utf8",
  );
  return content
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function requirementTree(): RequirementNode {
  return {
    id: "ROOT", name: "Demo Product", type: "ROOT", description: "Root description.",
    dependencies: [], visual_reference: [], scenarios: [], children: [{
      id: "PROFILE", name: "Profile", type: "FOLDER", description: "Profile area",
      dependencies: [], visual_reference: [], scenarios: [], children: [{
        id: "REQ-PROFILE", name: "Save a profile", type: "ATOMIC",
        description: "Keep a profile name after refresh.",
        dependencies: [], visual_reference: [], children: [], scenarios: [{
          id: "REQ-PROFILE::0", name: "Save and refresh", steps: [
            { keyword: "WHEN", content: "The user enters a profile name and saves." },
            { keyword: "THEN", content: "The same name remains after refresh." },
          ],
        }],
      }],
    }],
  };
}
