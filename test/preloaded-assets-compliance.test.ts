import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { test } from "node:test";

import { APPROVED_CAPABILITIES } from "../src/builder/capability-catalog.js";

const root = process.cwd();
const preloadedRoots = [
  join(root, "scaffold", "minimal-web", "frontend", "src"),
  join(root, "scaffold", "minimal-web", "backend", "src"),
];

const competitionDomainTerms = /github|spreadsheet|workbook|worksheet|repository|pull request|branch protection|pivot|formula|电子表格|工作簿|工作表|代码仓库|拉取请求|分支保护|数据透视|公式/iu;

test("preloaded scaffold source remains task-neutral", async () => {
  const files = (await Promise.all(preloadedRoots.map(walkFiles))).flat();
  assert.ok(files.length > 0);

  for (const file of files) {
    const inspected = `${relative(root, file)}\n${await readFile(file, "utf8")}`;
    assert.doesNotMatch(inspected, competitionDomainTerms, `competition-specific content found in ${relative(root, file)}`);
  }
});

test("scaffold and installable capabilities contain the same generic UI source", async () => {
  assert.deepEqual(APPROVED_CAPABILITIES.map(item => item.id), ["accessible-ui"]);
  for (const capability of APPROVED_CAPABILITIES) {
    assert.equal(capability.targetDirectory, "frontend/src/ui");
    assert.ok(capability.files.every(file => !file.includes("/") && /\.(?:tsx|ts|css)$/u.test(file)));
    assert.deepEqual((await readdir(join(root, "scaffold", "minimal-web", capability.targetDirectory))).sort(), [...capability.files].sort());
  }
});

async function walkFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(path) : Promise.resolve([path]);
  }));
  return nested.flat();
}
