import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { ApplicationRegistry } from "../src/application/registry.js";
import { CandidateRuntime } from "../src/application/candidate-runtime.js";
import type { RuntimeAdapter } from "../src/application/port.js";
import { parseProjectSpec, resolveApplicationContract } from "../src/project-spec.js";
import { CheckerAdapterRegistry } from "../src/checker/adapters/registry.js";
import { withTempDir } from "./helpers/temp-dir.js";

test("A non-Web adapter prepares isolated candidates and invalidates changed input without a network endpoint", async () => {
  await withTempDir("application-adapter-", async root => {
    const output = join(root, "source");
    await mkdir(output);
    await writeFile(join(output, "input.txt"), "original");
    let starts = 0, stops = 0;
    const adapter: RuntimeAdapter = {
      id: "fixture", parseSpec: parseProjectSpec,
      defaultSpec: () => parseProjectSpec({ adapter: "fixture", start: { executable: process.execPath } }),
      configure: async spec => resolveApplicationContract(spec),
      lifecycle: { async start(directory) {
        starts++;
        assert.equal(await readFile(join(directory, "input.txt"), "utf8"), "original");
        return { metadata: { execution: starts }, async stop() { stops++; } };
      } },
      async installScaffold() { return { status: "skipped_existing_application", reason: "fixture", files: [] }; },
      builderCapabilities: () => ({ tools: [], skillDirectories: [], async close() {} }),
      async verifyDelivery() { return { ok: true, stage: "complete", message: "fixture" }; },
    };
    const registry = new ApplicationRegistry([adapter]);
    assert.equal(registry.get("fixture"), adapter);
    assert.throws(() => registry.get("missing"), /missing.*available: fixture/);
    assert.throws(() => new ApplicationRegistry([adapter, adapter]), /Duplicate/);
    const contract = await adapter.configure(adapter.defaultSpec(), {});
    const runtime = new CandidateRuntime(output, join(root, "runtime"), contract, adapter.lifecycle);
    try {
      const first = await runtime.start(output, contract);
      assert.deepEqual(first.metadata, { execution: 1 });
      runtime.recordAccepted(first.candidate!);
      await first.assertUnchanged?.();
      await first.stop();
      const second = await runtime.start(output, contract);
      assert.equal(second.candidate!.buildId, first.candidate!.buildId);
      assert.notEqual(second.candidate!.runtimeId, first.candidate!.runtimeId);
      await writeFile(join(output, "input.txt"), "changed");
      await assert.rejects(runtime.assertAcceptedInput(), /evidence is invalid/);
      await assert.rejects(() => second.assertUnchanged!(), /evidence is invalid/);
    } finally { await runtime.dispose(); }
    assert.equal(starts, 2);
    assert.equal(stops, 2);
  });
});

test("Checker adapter selection fails before execution for an unknown application platform", () => {
  const registry = new CheckerAdapterRegistry(new Map());
  assert.throws(() => registry.get("missing"), /Unknown Checker adapter missing/);
});

test("Shared project parsing leaves platform selection and reserved variables to the adapter", () => {
  const spec = parseProjectSpec({ start: { executable: "fixture" }, dataEnvVar: "PORT" });
  assert.equal(spec.adapter, undefined);
  assert.throws(() => resolveApplicationContract(spec), /Select an application adapter/);
  const contract = resolveApplicationContract({ ...spec, adapter: "fixture" });
  assert.equal(contract.adapterId, "fixture");
  assert.equal(contract.dataEnvVar, "PORT");
});
