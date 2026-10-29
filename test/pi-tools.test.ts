import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

test("Shell guards use the actual private run directory while allowing absolute application paths", async () => {
  await withTempDir("shallow-private-run-", async run => {
    const workspace = join(run, "workspace");
    assert.throws(() => assertToolCommand(`type "${join(run, "run.json")}"`, run, workspace), /private/);
    assert.throws(() => assertToolCommand(`type "${join(run, "plans/case.json")}"`, run, workspace), /private/);
    assert.throws(() => assertToolCommand(`type "${workspace}/../run.json"`, run, workspace), /private/);
    assert.throws(() => assertToolCommand('type "E:/private-root/.verifier-programs/project/objects/program"', run, workspace), /private/);
    assert.doesNotThrow(() => assertToolCommand(`node "${join(workspace, "server.mjs")}"`, run, workspace));
    assert.doesNotThrow(() => assertToolCommand("npm run build", run, workspace));
  });
});

import { assertNotTestCommand, assertToolCommand, assertToolPath, assertToolReadPath } from "../src/builder/pi-tools.js";
import { withTempDir } from "./helpers/temp-dir.js";

test("Loaded skill files remain read-only even when located inside the target workspace", async () => {
  await withTempDir("shallow-skill-guard-", async root => {
    const skillFile = join(root, "SKILL.md");
    await writeFile(skillFile, "approved guidance");
    await assert.doesNotReject(assertToolReadPath(root, skillFile, [skillFile]));
    await assert.rejects(assertToolPath(root, skillFile, [skillFile]), /read-only/);
    await assert.doesNotReject(assertToolPath(root, "app.ts", [skillFile]));
    assert.equal(await readFile(skillFile, "utf8"), "approved guidance");
  });
});

test("Builder tools cannot reach the product-visible progress journal", async () => {
  await withTempDir("shallow-pi-tools-", async (root) => {
    await mkdir(join(root, "shallow-progress", "plans"), { recursive: true });
    await writeFile(join(root, "shallow-progress", "plans", "a.json"), "{}", "utf8");
    await mkdir(join(root, ".arc", "traceability"), { recursive: true });
    await writeFile(join(root, ".arc", "traceability", "requirements.json"), "{}", "utf8");
    await mkdir(join(root, "frontend"), { recursive: true });
    await writeFile(join(root, "frontend", "main.js"), "", "utf8");

    await assert.rejects(assertToolPath(root, "shallow-progress/plans/a.json"), /private controller evidence/);
    await assert.rejects(assertToolPath(root, ".arc/traceability/requirements.json"), /private controller evidence/);
    await assert.doesNotReject(assertToolPath(root, "frontend/main.js"));

    assert.throws(() => assertToolCommand("cat shallow-progress/progress.log"));
    assert.throws(() => assertToolCommand("type .arc\\runner-events.jsonl"));
    assert.doesNotThrow(() => assertToolCommand("npm test"));
  });
});

test("Builder shell rejects ad-hoc test commands and points at run_tests", () => {
  for (const command of [
    "npm test",
    "npm run test",
    "npm run test:unit",
    "npm --prefix frontend run test",
    "npm.cmd --prefix backend test",
    "npm exec vitest",
    "NODE_ENV=test npm test",
    "pnpm test",
    "yarn run test",
    "pnpm --filter app test",
    "npx vitest run",
    "bunx vitest",
    "npx tsx --test test/app.test.ts",
    "vitest --watch",
    ".\\node_modules\\.bin\\vitest run",
    "node_modules/.bin/vitest",
    "node --test test/",
    "node --experimental-strip-types --test test/app.test.js",
    "cd frontend && npm test",
  ]) {
    assert.throws(() => assertNotTestCommand(command), /run_tests/, command);
  }
  for (const command of [
    "npm run build",
    "npm install",
    "npm ci",
    "npm install --save-dev vitest",
    "npm run build -- --mode test",
    "npm --prefix frontend run build",
    "npx tsc --noEmit",
    "node server.js",
    "node scripts/seed.js",
    "node --check server.js",
    "grep -r vitest package.json",
    "cat vitest.config.ts",
    "npm ls vitest",
    "NODE_ENV=test npm run build",
  ]) {
    assert.doesNotThrow(() => assertNotTestCommand(command), command);
  }
});
