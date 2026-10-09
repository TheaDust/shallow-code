import assert from "node:assert/strict";
import fs from "node:fs";
import { access } from "node:fs/promises";
import { test } from "node:test";
import { withTempDir } from "./helpers/temp-dir.js";

test("withTempDir retries transient directory locks and removes its own directory", async (t) => {
  let target = "";
  let busyResponses = 0;
  const original = fs.rmdir;
  t.after(async () => {
    t.mock.restoreAll();
    if (target) await fs.promises.rm(target, { recursive: true, force: true });
  });
  t.mock.method(fs, "rmdir", (path: fs.PathLike, ...args: unknown[]) => {
    if (String(path) === target && busyResponses < 2) {
      busyResponses += 1;
      const callback = args.at(-1) as (error: NodeJS.ErrnoException) => void;
      queueMicrotask(() => callback(Object.assign(new Error("directory busy"), { code: "EBUSY" })));
      return;
    }
    return Reflect.apply(original, fs, [path, ...args]);
  });
  const result = await withTempDir("shallow-cleanup-test-", async (directory) => {
    target = directory;
    return "done";
  });
  assert.equal(result, "done");
  assert.equal(busyResponses, 2);
  await assert.rejects(access(target), { code: "ENOENT" });
});
