import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
  DEFAULT_READY_PATH,
  PROJECT_SPEC_FILENAME,
  loadProjectSpec,
  minimalWebProjectSpec,
  npmExecutable,
  parseProjectSpec,
  resolveRuntimeContract,
} from "../src/project-spec.js";
import { withTempDir } from "./helpers/temp-dir.js";

const FULL_SPEC = {
  install: [{ executable: "pnpm", args: ["install", "--frozen-lockfile"], cwd: "web" }],
  build: [{ executable: "pnpm", args: ["build"], cwd: "web", timeoutMs: 120_000 }],
  tests: [
    { id: "unit", executable: "pnpm", args: ["test"], cwd: "web" },
    { id: "e2e", executable: "pnpm", args: ["test:e2e"], cwd: "tests/e2e" },
  ],
  start: { executable: "node", args: ["server.js"], cwd: "." },
  env: { NODE_ENV: "test" },
  readyPath: "/__ready",
  extraPorts: [3301, 8081],
  dependencyPaths: ["web"],
  generatedPaths: ["web/dist"],
  dataPaths: ["web/storage", "./server/data"],
};

test("The shipped template spec resolves to the previous fixed frontend/backend contract", () => {
  const spec = minimalWebProjectSpec(npmExecutable());
  const contract = resolveRuntimeContract(spec, { port: 3000, evaluationPort: 3000, extraPorts: [3301] });
  assert.deepEqual(contract.installCommands, [
    { executable: spec.install![0].executable, args: ["install", "--no-audit", "--no-fund"], cwd: "frontend" },
    { executable: spec.install![1].executable, args: ["install", "--no-audit", "--no-fund"], cwd: "backend" },
  ]);
  assert.deepEqual(contract.buildCommands, [
    { executable: spec.build![0].executable, args: ["run", "build"], cwd: "frontend" },
  ]);
  assert.deepEqual(contract.startCommand, {
    executable: spec.start.executable, args: ["run", "start"], cwd: "backend",
  });
  assert.equal(contract.healthPath, DEFAULT_READY_PATH);
  assert.equal(contract.baseUrl, "http://127.0.0.1:3000");
  assert.deepEqual(contract.extraPorts, [3301]);
});

test("A project with any directory layout resolves its own commands and ports", () => {
  const spec = parseProjectSpec(FULL_SPEC);
  const contract = resolveRuntimeContract(spec, { port: 45123, evaluationPort: 3000 });
  assert.deepEqual(contract.startCommand, { executable: "node", args: ["server.js"], cwd: "output" });
  assert.deepEqual(contract.installCommands, [
    { executable: "pnpm", args: ["install", "--frozen-lockfile"], cwd: "web" },
  ]);
  assert.equal(contract.healthPath, "/__ready");
  assert.equal(contract.baseUrl, "http://127.0.0.1:45123");
  assert.deepEqual(contract.extraPorts, [3301, 8081]);
  assert.equal(contract.evaluationPort, 3000);
});

test("Declared and run-time extra ports merge, and never include the probe or evaluation port", () => {
  const spec = parseProjectSpec({ start: { executable: "node" }, extraPorts: [3301, 4000] });
  const contract = resolveRuntimeContract(spec, { port: 45123, evaluationPort: 3000, extraPorts: [3301, 8081, 3000, 45123] });
  assert.deepEqual(contract.extraPorts, [3301, 4000, 8081]);
  const withoutExtras = resolveRuntimeContract(parseProjectSpec({ start: { executable: "node" } }), {
    port: 45123, evaluationPort: 3000,
  });
  assert.equal("extraPorts" in withoutExtras, false);
});

test("Declared test targets keep their ids and project-relative directories", () => {
  const spec = parseProjectSpec(FULL_SPEC);
  assert.deepEqual(spec.tests!.map((target) => target.id), ["unit", "e2e"]);
  assert.equal(spec.tests![1].cwd, "tests/e2e");
  assert.deepEqual(spec.dataPaths, ["web/storage", "server/data"]);
});

test("Relative paths are normalized and escaping or absolute paths are rejected", () => {
  assert.deepEqual(parseProjectSpec(FULL_SPEC).generatedPaths, ["web/dist"]);
  assert.throws(() => parseProjectSpec({ start: { executable: "node", cwd: "/etc" } }), /project-relative/);
  assert.throws(() => parseProjectSpec({ start: { executable: "node", cwd: "../elsewhere" } }), /stay inside the project/);
  assert.throws(() => parseProjectSpec({ start: { executable: "node", cwd: "a/../../b" } }), /stay inside the project/);
  assert.throws(() => parseProjectSpec({ start: { executable: "node", cwd: "C:/Windows" } }), /project-relative/);
  assert.throws(() => parseProjectSpec({ start: { executable: "node" }, dataPaths: ["../../secret"] }), /stay inside the project/);
});

test("Malformed run descriptions fail before any command runs", () => {
  assert.throws(() => parseProjectSpec(null), /must be a JSON object/);
  assert.throws(() => parseProjectSpec({}), /start is required/);
  assert.throws(() => parseProjectSpec({ start: { executable: "node", args: [1] } }), /args\[0\] must be a string/);
  assert.throws(() => parseProjectSpec({ start: { executable: "node", timeoutMs: 0 } }), /positive integer/);
  assert.throws(() => parseProjectSpec({ start: { executable: "node" }, readyPath: "health" }), /beginning with/);
  assert.throws(() => parseProjectSpec({ start: { executable: "node" }, extraPorts: [70000] }), /between 1 and 65535/);
  assert.throws(() => parseProjectSpec({ start: { executable: "node" }, extraPorts: [80, 80] }), /repeats an earlier port/);
  assert.throws(() => parseProjectSpec({ start: { executable: "node" }, env: { A: 1 } }), /env\.A must be a string/);
});

test("Duplicate test target ids are rejected instead of silently shadowing", () => {
  assert.throws(
    () => parseProjectSpec({
      start: { executable: "node" },
      tests: [{ id: "unit", executable: "npm" }, { id: "unit", executable: "npm" }],
    }),
    /duplicates an earlier test target: unit/,
  );
});

test("A project run configuration is loaded and validated from disk", async () => {
  await withTempDir("shallowcode-spec-", async (root) => {
    await writeFile(join(root, PROJECT_SPEC_FILENAME), JSON.stringify(FULL_SPEC), "utf8");
    const spec = await loadProjectSpec(root);
    assert.equal(spec.readyPath, "/__ready");
    assert.deepEqual(spec.env, { NODE_ENV: "test" });
    assert.deepEqual(spec.extraPorts, [3301, 8081]);
  });
});

test("Missing or unreadable run configuration is reported as a pending item", async () => {
  await withTempDir("shallowcode-spec-", async (root) => {
    await assert.rejects(loadProjectSpec(root), /Missing project run configuration/);
    await writeFile(join(root, PROJECT_SPEC_FILENAME), "{ not json", "utf8");
    await assert.rejects(loadProjectSpec(root), /is not valid JSON/);
  });
});