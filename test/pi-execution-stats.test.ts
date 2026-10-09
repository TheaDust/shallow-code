import assert from "node:assert/strict";
import { test } from "node:test";

import { PiExecutionCollector } from "../src/builder/pi-execution-stats.js";

test("Pi execution stats separate model and tool time and bound the slowest tools", () => {
  const collector = new PiExecutionCollector();
  collector.modelStarted(0);
  collector.modelEnded(1_000);
  collector.toolStarted("t1", "read", 1_000);
  collector.toolEnded("t1", 1_400);
  collector.toolStarted("t2", "shell", 2_000);
  collector.toolEnded("t2", 5_000);
  collector.modelStarted(5_000);
  collector.modelEnded(6_500);
  collector.turnEnded();
  collector.turnEnded();

  const summary = collector.summarize(
    { input: 100, output: 20, cacheRead: 30, cacheWrite: 0, total: 150 },
    1,
  );

  assert.deepEqual(summary.usage, {
    status: "available",
    input: 100,
    output: 20,
    cacheRead: 30,
    cacheWrite: 0,
    total: 150,
  });
  assert.deepEqual(summary.timing, {
    turns: 2,
    modelMsTotal: 2_500,
    toolMsTotal: 3_400,
    longestTools: [{ name: "shell", durationMs: 3_000 }],
    toolCounts: [{ name: "read", count: 1 }, { name: "shell", count: 1 }],
    outputBytes: 0,
  });
});

test("Pi execution stats ignore unmatched spans and duplicate starts", () => {
  const collector = new PiExecutionCollector();
  collector.toolEnded("missing", 10);
  collector.modelEnded(10);
  collector.toolStarted("t1", "read", 0);
  collector.toolStarted("t1", "write", 100);
  collector.toolEnded("t1", 300);
  collector.modelStarted(500);
  collector.modelEnded(500);

  const summary = collector.summarize();

  assert.deepEqual(summary.usage, { status: "unavailable" });
  assert.deepEqual(summary.timing, {
    turns: 0,
    modelMsTotal: 0,
    toolMsTotal: 300,
    longestTools: [{ name: "read", durationMs: 300 }],
    // A duplicate start for the same call must not inflate the per-tool count.
    toolCounts: [{ name: "read", count: 1 }],
    outputBytes: 0,
  });
});

test("Pi execution stats clamp negative spans and cap the slowest list", () => {
  const collector = new PiExecutionCollector();
  collector.toolStarted("a", "read", 500);
  collector.toolEnded("a", 100);
  for (const [id, name] of [["b", "shell"], ["c", "write"], ["d", "browser"]] as const) {
    collector.toolStarted(id, name, 0);
    collector.toolEnded(id, 50);
  }

  const summary = collector.summarize(undefined, 2);

  assert.deepEqual(summary.timing, {
    turns: 0,
    modelMsTotal: 0,
    toolMsTotal: 150,
    longestTools: [{ name: "shell", durationMs: 50 }, { name: "write", durationMs: 50 }],
    toolCounts: [{ name: "browser", count: 1 }, { name: "read", count: 1 },
      { name: "shell", count: 1 }, { name: "write", count: 1 }],
    outputBytes: 0,
  });
});

test("Pi execution stats count per-tool calls and assistant output size without keeping text", () => {
  const collector = new PiExecutionCollector();
  for (const [id, name] of [["a", "shell"], ["b", "shell"], ["c", "read"]] as const) {
    collector.toolStarted(id, name, 0);
    collector.toolEnded(id, 10);
  }
  collector.outputProduced(1_500);
  collector.outputProduced(2_500);
  collector.outputProduced(-5);
  collector.outputProduced(Number.NaN);

  const summary = collector.summarize();

  assert.deepEqual(summary.timing.toolCounts, [{ name: "shell", count: 2 }, { name: "read", count: 1 }]);
  assert.equal(summary.timing.outputBytes, 4_000);
  assert.equal("text" in summary, false);
});
