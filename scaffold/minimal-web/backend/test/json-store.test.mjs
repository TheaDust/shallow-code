import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createJsonStore } from "../src/lib/json-store.mjs";

test("serializes updates and persists the complete state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shallowcode-json-store-"));
  const path = join(directory, "state.json");
  const store = createJsonStore(path, { count: 0 });

  await Promise.all([
    store.update(state => { state.count += 1; }),
    store.update(state => { state.count += 1; }),
  ]);

  assert.deepEqual(await store.read(), { count: 2 });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { count: 2 });
});
