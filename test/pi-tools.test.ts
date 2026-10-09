import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { assertNotTestCommand, assertToolCommand, assertToolPath, createPiTools } from "../src/builder/pi-tools.js";
import { withTempDir } from "./helpers/temp-dir.js";

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

test("Builder read stays within the application", async () => {
  await withTempDir("shallow-pi-read-roots-", async root => {
    const app = join(root, "app");
    const privateDirectory = join(root, "private");
    await mkdir(app);
    await mkdir(privateDirectory);
    const appFile = join(app, "main.ts");
    const privateFile = join(privateDirectory, "secret.txt");
    await writeFile(appFile, "export const value = 1;\n", "utf8");
    await writeFile(privateFile, "hidden", "utf8");

    const read = createPiTools(app).find(tool => tool.name === "read")!;
    const execute = (path: string) => read.execute("read-boundary", { path }, undefined, undefined, {} as never);
    await assert.doesNotReject(execute(appFile));
    await assert.rejects(execute(privateFile), /outside the application/);
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
