import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { PROGRESS_DIR_NAME, ProgressJournal, isProgressPath } from "../src/progress-journal.js";
import { withTempDir } from "./helpers/temp-dir.js";

test("isProgressPath recognises the journal directory and its children", () => {
  assert.equal(isProgressPath("shallow-progress"), true);
  assert.equal(isProgressPath("shallow-progress/plans/a.json"), true);
  assert.equal(isProgressPath("shallow-progress\\progress.log"), true);
  assert.equal(isProgressPath("shallow-progress-extra/x"), false);
  assert.equal(isProgressPath("frontend/src/main.js"), false);
});

test("ProgressJournal appends UTF-8 lines under the product directory", async () => {
  await withTempDir("shallow-progress-", async (output) => {
    const journal = new ProgressJournal(output);
    journal.appendLine("开始");
    journal.appendLine("第二步");
    const content = await readFile(join(output, PROGRESS_DIR_NAME, "progress.log"), "utf8");
    assert.equal(content, "开始\n第二步\n");
  });
});
