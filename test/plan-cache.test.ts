import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { PlanCache, shouldWritePlanCache, spawnPlanGeneration } from "../src/judge/plan-cache.js";
import { ProbePlannerError } from "../src/judge/llm-probe-planner.js";
import type { ProbePlan } from "../src/judge/probe-schema.js";
import type { WorkPacket } from "../src/types.js";
import { withTempDir } from "./helpers/temp-dir.js";

function plan(packetId: string, covered: string[]): ProbePlan {
  return {
    packetId,
    cases: [{ id: "case-1", requirementIds: covered, purpose: "happy_path",
      expectationBasis: ["fixture"],
      steps: [{ op: "goto", path: "/" }, { op: "expectVisible", locator: { by: "role", role: "main" } }] }],
  };
}

test("A cached plan is reused only when it still validates against its packet", async () => {
  await withTempDir("shallow-plan-cache-", async directory => {
    const cache = new PlanCache(directory);
    await cache.write("packet-a", plan("packet-a", ["A", "B"]));
    assert.equal((await cache.read({ id: "packet-a", requirementIds: ["A", "B"] }))?.packetId, "packet-a");
    // The same entry must not be reused for a packet whose coverage it fails.
    assert.equal(await cache.read({ id: "packet-a", requirementIds: ["A", "C"] }), undefined);
    assert.equal(await cache.read({ id: "packet-b", requirementIds: ["A", "B"] }), undefined);
  });
});

test("A pending completeness review survives the plan cache", async () => {
  await withTempDir("shallow-plan-cache-", async directory => {
    const cache = new PlanCache(directory);
    await cache.write("packet-a", { ...plan("packet-a", ["A"]), coverageReview: "pending" });
    assert.equal((await cache.read({ id: "packet-a", requirementIds: ["A"] }))?.coverageReview, "pending");
  });
});

test("Cache persistence notices completeness-review state changes separately from behavior", () => {
  const pending = { ...plan("packet-a", ["A"]), coverageReview: "pending" as const };
  const verified = { ...pending, coverageReview: "verified" as const };
  assert.equal(shouldWritePlanCache(pending, verified), true);
  assert.equal(shouldWritePlanCache(verified, { ...verified }), false);
});

test("Cache files stay separate for packet ids that sanitise identically", async () => {
  await withTempDir("shallow-plan-cache-", async directory => {
    const cache = new PlanCache(directory);
    await cache.write("packet-a:1", plan("packet-a:1", ["A"]));
    await cache.write("packet-a/1", plan("packet-a/1", ["B"]));
    assert.equal((await cache.read({ id: "packet-a:1", requirementIds: ["A"] }))?.packetId, "packet-a:1");
    assert.equal((await cache.read({ id: "packet-a/1", requirementIds: ["B"] }))?.packetId, "packet-a/1");
    assert.equal((await readdir(`${directory}/plans`)).length, 2);
  });
});

test("Plan cache mirrors writes into the product-visible directory", async () => {
  await withTempDir("shallow-plan-cache-", async (directory) => {
    const mirror = join(directory, "shallow-progress", "plans");
    const cache = new PlanCache(directory, mirror);
    await cache.write("packet-a", plan("packet-a", ["A"]));

    const files = await readdir(mirror);
    assert.equal(files.length, 1);
    assert.equal(JSON.parse(await readFile(join(mirror, files[0]), "utf8")).packetId, "packet-a");
  });
});

test("An inherited plan mirror cannot bootstrap a new run even for the same packet ID", async () => {
  await withTempDir("shallow-plan-inherited-", async directory => {
    const mirror = join(directory, "shallow-progress", "plans");
    const previous = new PlanCache(join(directory, "previous-run"), mirror);
    await previous.write("packet-a", { ...plan("packet-a", ["A"]), coverageReview: "verified" });
    const current = new PlanCache(join(directory, "current-run"), mirror);
    assert.equal(await current.read({ id: "packet-a", requirementIds: ["A"] }), undefined);
    assert.equal((await readdir(mirror)).length, 1, "historical diagnostic plans remain intact");
  });
});

test("Background planning retries a model-length cutoff and caches the complete plan", async () => {
  await withTempDir("shallow-plan-cache-", async directory => {
    const packet = { id: "packet-a", requirementIds: ["A"] } as WorkPacket;
    const cache = new PlanCache(directory);
    let calls = 0;
    let failures = 0;
    const generated = await spawnPlanGeneration(packet, packet.id, {
      plan: async (_packet, feedback) => {
        calls++;
        if (calls === 1) throw new ProbePlannerError("response", "Probe planner response body failed",
          { cause: new SyntaxError("Probe planner stream was cut off by the model") });
        assert.equal(feedback?.validationError, "Probe planner stream was cut off by the model");
        return plan(packet.id, packet.requirementIds);
      },
    }, cache, 60_000, async () => { failures++; });
    assert.equal(calls, 2);
    assert.equal(failures, 0);
    assert.equal(generated?.packetId, packet.id);
    assert.equal((await cache.read(packet))?.packetId, packet.id);
  });
});

test("Background planning repairs a schema error before the module audit", async () => {
  await withTempDir("shallow-plan-cache-", async directory => {
    const packet = { id: "packet-a", requirementIds: ["A"] } as WorkPacket;
    const cache = new PlanCache(directory);
    let calls = 0;
    let failures = 0;
    const generated = await spawnPlanGeneration(packet, packet.id, {
      plan: async (_packet, feedback) => {
        calls++;
        if (calls === 1) throw new ProbePlannerError("schema", "Probe planner content violates ProbePlan",
          { cause: new Error("unanchored text locator"), content: "invalid plan" });
        assert.equal(feedback?.validationError, "unanchored text locator");
        assert.equal(feedback?.contentPreview, "invalid plan");
        return plan(packet.id, packet.requirementIds);
      },
    }, cache, 60_000, async () => { failures++; });
    assert.equal(calls, 2);
    assert.equal(failures, 0);
    assert.equal(generated?.packetId, packet.id);
    assert.equal((await cache.read(packet))?.packetId, packet.id);
  });
});

test("Background planning leaves other response failures unretried", async () => {
  await withTempDir("shallow-plan-cache-", async directory => {
    const packet = { id: "packet-a", requirementIds: ["A"] } as WorkPacket;
    let calls = 0;
    let failures = 0;
    const generated = await spawnPlanGeneration(packet, packet.id, {
      plan: async () => {
        calls++;
        throw new ProbePlannerError("response", "Probe planner response has no message content");
      },
    }, new PlanCache(directory), 60_000, async () => { failures++; });
    assert.equal(generated, undefined);
    assert.equal(calls, 1);
    assert.equal(failures, 1);
  });
});
