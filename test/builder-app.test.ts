import assert from "node:assert/strict";
import { test } from "node:test";
import { BuilderApp } from "../src/builder/builder-app.js";
import { createArcPlatformContract } from "../src/runtime-config.js";

test("Managed app serializes starts, keeps data/port contract and stops only its owned app", async () => {
  const contract = { ...createArcPlatformContract("linux", 43210), dataDirectory: "isolated" };
  let starts = 0, stops = 0;
  const app = new BuilderApp("output", contract, { start: async (output, actual) => {
    assert.equal(output, "output"); assert.deepEqual(actual, contract); starts++;
    return { baseUrl: contract.baseUrl, stop: async () => { stops++; } };
  } });
  assert.equal((await app.run("status")).running, false);
  await Promise.all([app.run("start"), app.run("start")]);
  assert.equal(starts, 1);
  assert.equal((await app.run("status")).running, true);
  await app.run("stop"); await app.run("stop");
  assert.equal(stops, 1);
  await app.run("start"); await app.close(); await app.close();
  assert.equal(stops, 2);
  await assert.rejects(app.run("start"), /closed/);
});

test("Closing during startup waits for it and cleans the resulting process", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let stopped = false;
  const contract = createArcPlatformContract("linux", 43210);
  const app = new BuilderApp("output", contract, { start: async () => {
    await gate;
    return { baseUrl: contract.baseUrl, stop: async () => { stopped = true; } };
  } });
  const starting = app.run("start");
  const closing = app.close();
  release();
  await starting; await closing;
  assert.equal(stopped, true);
});

test("Failed startup is reported and can be retried without pretending the app is running", async () => {
  let starts = 0;
  const contract = createArcPlatformContract("linux", 43210);
  const app = new BuilderApp("output", contract, { start: async () => {
    if (++starts === 1) throw new Error("occupied");
    return { baseUrl: contract.baseUrl, stop: async () => {} };
  } });
  await assert.rejects(app.run("start"), /occupied/);
  assert.equal((await app.run("status")).running, false);
  assert.equal((await app.run("start")).running, true);
  await app.close();
});
