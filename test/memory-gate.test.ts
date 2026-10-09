import assert from "node:assert/strict";
import { test } from "node:test";

import { createMemoryGate, type MemoryGateWaitInfo, type MemoryUsage } from "../src/memory-gate.js";

interface Fixture {
  waits: MemoryGateWaitInfo[];
  sleeps: number[];
  setUsage: (values: Array<MemoryUsage | undefined>) => void;
}

function fixture(): { options: Parameters<typeof createMemoryGate>[0]; state: Fixture } {
  const state: Fixture = { waits: [], sleeps: [], setUsage: () => {} };
  let values: Array<MemoryUsage | undefined> = [];
  let index = 0;
  const options: Parameters<typeof createMemoryGate>[0] = {
    thresholdRatio: 0.8,
    pollMs: 10,
    maxWaitMs: 50,
    readUsage: async () => values[Math.min(index++, Math.max(0, values.length - 1))],
    onWait: info => state.waits.push(info),
    now: () => Date.now(),
    sleep: async ms => { state.sleeps.push(ms); },
  };
  state.setUsage = next => { values = next; index = 0; };
  return { options, state };
}

test("memory gate proceeds immediately below the threshold", async () => {
  const { options, state } = fixture();
  state.setUsage([{ current: 1_000_000_000, max: 2_147_483_648 }]);
  await createMemoryGate(options).waitForHeadroom(400 * 1_048_576);
  assert.equal(state.sleeps.length, 0);
  assert.equal(state.waits.length, 0);
});

test("memory gate waits for pressure to subside, then proceeds", async () => {
  const { options, state } = fixture();
  // 80% of 2GiB is 1718MB; current+expected starts at 1900+400MB, then drops.
  state.setUsage([
    { current: 1_900_000_000, max: 2_147_483_648 },
    { current: 1_900_000_000, max: 2_147_483_648 },
    { current: 1_200_000_000, max: 2_147_483_648 },
  ]);
  await createMemoryGate(options).waitForHeadroom(400 * 1_048_576);
  assert.equal(state.sleeps.length, 2);
  assert.ok(state.sleeps.every(ms => ms === 10));
  assert.equal(state.waits.length, 1);
  assert.equal(state.waits[0].timedOut, false);
});

test("memory gate proceeds after maxWaitMs instead of stalling forever", async () => {
  const { options, state } = fixture();
  state.setUsage([{ current: 2_000_000_000, max: 2_147_483_648 }]);
  await createMemoryGate(options).waitForHeadroom(400 * 1_048_576);
  assert.ok(state.waits.length >= 1);
  assert.equal(state.waits.at(-1)!.timedOut, true);
  assert.ok(state.sleeps.length >= 4, `expected several polls before the timeout, got ${state.sleeps.length}`);
});

test("memory gate is a no-op without a finite cgroup limit", async () => {
  const { options, state } = fixture();
  state.setUsage([undefined, { current: 1_900_000_000 }, { current: 1_900_000_000, max: undefined }]);
  await createMemoryGate(options).waitForHeadroom(400 * 1_048_576);
  await createMemoryGate(options).waitForHeadroom(400 * 1_048_576);
  await createMemoryGate(options).waitForHeadroom(400 * 1_048_576);
  assert.equal(state.sleeps.length, 0);
  assert.equal(state.waits.length, 0);
});

test("memory gate stops waiting once the run is aborted", async () => {
  const controller = new AbortController();
  const waits: MemoryGateWaitInfo[] = [];
  const sleeps: number[] = [];
  await createMemoryGate({
    maxWaitMs: 60_000,
    pollMs: 10,
    readUsage: async () => ({ current: 2_000_000_000, max: 2_147_483_648 }),
    onWait: info => waits.push(info),
    sleep: async ms => { sleeps.push(ms); controller.abort(); },
  }).waitForHeadroom(400 * 1_048_576, controller.signal);
  assert.equal(sleeps.length, 1);
  assert.equal(waits.length, 0);
});
