import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { copyInheritedData } from "../src/inherited-data.js";
import { withTempDir } from "./helpers/temp-dir.js";

test("Declared storage is copied without adopting a conventional backend directory", async () => {
  await withTempDir("shallow-declared-data-", async root => {
    const app = join(root, "app"), target = join(root, "execution");
    await mkdir(join(app, "storage"), { recursive: true });
    await mkdir(join(app, "backend/data"), { recursive: true });
    await writeFile(join(app, "storage/state.json"), '{"user":"kept"}');
    await writeFile(join(app, "backend/data/state.json"), "wrong source");
    assert.deepEqual(await copyInheritedData(app, target, ["storage"]), { source: "storage", files: 1 });
    assert.equal(await readFile(join(target, "state.json"), "utf8"), '{"user":"kept"}');
    assert.deepEqual(await copyInheritedData(app, join(root, "empty"), []), { files: 0 });
    await assert.rejects(copyInheritedData(app, target, ["../execution"]), /inside the project/);
  });
});

for (const relative of ["backend/data", "backend/.data"]) {
  test(`Inherited storage copies ${relative} into an isolated execution directory`, async () => {
    await withTempDir("shallow-inherited-data-", async root => {
      const app = join(root, "app");
      const target = join(root, "execution");
      await mkdir(join(app, relative, "nested"), { recursive: true });
      await writeFile(join(app, relative, "records.json"), '{"legacy":true}\n');
      await writeFile(join(app, relative, "nested", "state.txt"), "kept");
      const copied = await copyInheritedData(app, target, [relative]);
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
    await assert.rejects(copyInheritedData(app, target, ["backend/data", "backend/.data"]), /Multiple default data directories/);
  });
  await withTempDir("shallow-inherited-data-", async root => {
    const app = join(root, "app");
    const target = join(root, "execution");
    await mkdir(join(app, "backend/data"), { recursive: true });
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "state.json"), "{}");
    await symlink(outside, join(app, "backend/data/linked"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(copyInheritedData(app, target, ["backend/data"]), /Inherited data links are not supported/);
  });
});
