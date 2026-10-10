import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { copyProjectWorkspace, hasProjectFiles, writeProjectPatch } from "../src/project-workspace.js";
import { GitCliOps, runGit } from "../src/git-ops.js";
import { withTempDir } from "./helpers/temp-dir.js";

test("A project snapshot preserves staged and untracked inputs while keeping the original repository untouched", async () => {
  await withTempDir("shallow-workspace-", async root => {
    const source = join(root, "source"), work = join(root, "run/workspace");
    await mkdir(source);
    const origin = await GitCliOps.open(source);
    await writeFile(join(source, "app.txt"), "base\n");
    await origin.captureAccepted("user baseline");
    await writeFile(join(source, "app.txt"), "staged\n");
    await runGit(source, ["add", "app.txt"], false);
    await writeFile(join(source, "app.txt"), "working\n");
    await writeFile(join(source, "new.bin"), Buffer.from([0, 1, 2, 255]));
    const head = await runGit(source, ["rev-parse", "HEAD"], false);
    await mkdir(join(source, "node_modules"));
    await mkdir(join(source, "generated"));
    await writeFile(join(source, "generated/cache.txt"), "cache");
    const before = await runGit(source, ["status", "--porcelain"], false);
    await copyProjectWorkspace(source, work, ["generated"]);
    assert.equal(await readFile(join(work, "app.txt"), "utf8"), "working\n");
    assert.deepEqual(await readFile(join(work, "new.bin")), Buffer.from([0, 1, 2, 255]));
    await assert.rejects(access(join(work, ".git")));
    await assert.rejects(access(join(work, "generated")));
    const git = await GitCliOps.open(work, { allowExisting: true });
    const baseline = await git.captureAccepted("input baseline");
    await writeFile(join(work, "app.txt"), "implemented\n");
    await writeFile(join(work, "new-file.txt"), "new work\n");
    await writeFile(join(work, "new.bin"), Buffer.from([0, 99, 255, 1]));
    const patch = await writeProjectPatch(work, baseline, join(root, "run"));
    assert.match(await readFile(patch, "utf8"), /new-file.txt/);
    assert.match(await readFile(patch, "utf8"), /GIT binary patch/);
    assert.equal((await runGit(source, ["apply", "--check", patch], true)).code, 0);
    assert.equal((await runGit(source, ["status", "--porcelain"], false)).stdout, before.stdout);
    assert.equal((await runGit(source, ["rev-parse", "HEAD"], false)).stdout, head.stdout);
    assert.equal(await readFile(join(source, "app.txt"), "utf8"), "working\n");
    const index = await runGit(source, ["show", ":app.txt"], false);
    assert.equal(index.stdout, "staged\n");
    await git.captureAccepted("attempt");
    await git.restoreAccepted(baseline);
    assert.equal(await readFile(join(work, "app.txt"), "utf8"), "working\n");
    assert.equal(await readFile(join(source, "app.txt"), "utf8"), "working\n");
  });
});

test("Workspace preparation rejects source overlap and distinguishes configuration from application files", async () => {
  await withTempDir("shallow-workspace-", async root => {
    await writeFile(join(root, "shallowcode.config.json"), "{}");
    assert.equal(await hasProjectFiles(root), false);
    await writeFile(join(root, "server.js"), "source");
    assert.equal(await hasProjectFiles(root), true);
    await assert.rejects(copyProjectWorkspace(root, join(root, "nested")), /separate from its source/);
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
