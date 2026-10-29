import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { hasProjectFiles } from "../src/project-workspace.js";
import { GitCliOps, runGit } from "../src/git-ops.js";
import { withTempDir } from "./helpers/temp-dir.js";

test("Workspace preparation distinguishes configuration from application files", async () => {
  await withTempDir("shallow-workspace-", async root => {
    await writeFile(join(root, "shallowcode.config.json"), "{}");
    await mkdir(join(root, "requirements"));
    await writeFile(join(root, "requirements", "requirements.yaml"), "id: app\n");
    // req 的草稿目录是启动目录元数据：空目录或残留草稿都不算应用文件。
    await mkdir(join(root, ".requirements-agent"));
    assert.equal(await hasProjectFiles(root), false, "空白模板目录只能携带配置与需求元数据");
    await writeFile(join(root, ".requirements-agent", "draft.json"), "{}");
    assert.equal(await hasProjectFiles(root), false, "残留需求草稿不算应用文件");
    await writeFile(join(root, "server.js"), "source");
    assert.equal(await hasProjectFiles(root), true);
  });
});

test("Explicitly owned application inputs can have any layout and their rejected work rolls back to the input baseline", async () => {
  await withTempDir("shallow-owned-", async root => {
    await mkdir(join(root, "web"));
    await writeFile(join(root, "web/index.js"), "existing");
    const git = await GitCliOps.open(root, { allowExisting: true });
    const baseline = await git.captureAccepted("input");
    await writeFile(join(root, "web/index.js"), "attempt");
    await git.captureAccepted("attempt");
    await git.restoreAccepted(baseline);
    assert.equal(await readFile(join(root, "web/index.js"), "utf8"), "existing");
  });
});

test("An owned project keeps source directories named build unless declared as generated", async () => {
  await withTempDir("shallow-source-build-", async root => {
    await mkdir(join(root, "build"));
    await writeFile(join(root, "build/source.js"), "source");
    const git = await GitCliOps.open(root, { allowExisting: true, generatedPaths: ["out"] });
    const baseline = await git.captureAccepted("input");
    assert.equal((await runGit(root, ["show", `${baseline}:build/source.js`], false)).stdout, "source");
    await writeFile(join(root, "build/source.js"), "attempt");
    await git.restoreAccepted(baseline);
    assert.equal(await readFile(join(root, "build/source.js"), "utf8"), "source");
  });
});
