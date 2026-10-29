import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { PROGRESS_DIR_NAME, ProgressJournal } from "../src/progress-journal.js";
import { withTempDir } from "./helpers/temp-dir.js";

test("ProgressJournal appends UTF-8 lines under the product directory", async () => {
  await withTempDir("shallow-progress-", async (output) => {
    const journal = new ProgressJournal(output);
    journal.appendLine("开始");
    journal.appendLine("第二步");
    const content = await readFile(join(output, PROGRESS_DIR_NAME, "progress.log"), "utf8");
    assert.equal(content, "开始\n第二步\n");
  });
});
