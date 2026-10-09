import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { copyInheritedData } from "../src/inherited-data.js";
import { withTempDir } from "./helpers/temp-dir.js";

for (const relative of ["backend/data", "backend/.data"]) {
  test(`Inherited storage copies ${relative} into an isolated execution directory`, async () => {
    await withTempDir("shallow-inherited-data-", async root => {
      const app = join(root, "app");
      const target = join(root, "execution");
      await mkdir(join(app, relative, "nested"), { recursive: true });
      await writeFile(join(app, relative, "records.json"), '{"legacy":true}\n');
      await writeFile(join(app, relative, "nested", "state.txt"), "kept");
      const copied = await copyInheritedData(app, target);
      assert.deepEqual(copied, { source: relative, files: 2 });
      assert.equal(await readFile(join(target, "records.json"), "utf8"), '{"legacy":true}\n');
      assert.equal(await readFile(join(target, "nested", "state.txt"), "utf8"), "kept");
      await writeFile(join(target, "records.json"), "mutated copy");
      assert.equal(await readFile(join(app, relative, "records.json"), "utf8"), '{"legacy":true}\n');
    });
  });
}

test("Inherited storage rejects ambiguous roots and directory links", async () => {
  await withTempDir("shallow-inherited-data-", async root => {
    const app = join(root, "app");
    const target = join(root, "execution");
    await mkdir(join(app, "backend/data"), { recursive: true });
    await mkdir(join(app, "backend/.data"), { recursive: true });
    await assert.rejects(copyInheritedData(app, target), /Multiple default data directories/);
  });
  await withTempDir("shallow-inherited-data-", async root => {
    const app = join(root, "app");
    const target = join(root, "execution");
    await mkdir(join(app, "backend/data"), { recursive: true });
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "state.json"), "{}");
    await symlink(outside, join(app, "backend/data/linked"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(copyInheritedData(app, target), /Inherited data links are not supported/);
  });
});
