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

test("Patch export preserves ignored requirements drafts and filters run metadata without changing the application index", async () => {
  await withTempDir("shallow-patch-metadata-", async root => {
    const project = join(root, "project"), run = join(root, "run");
    await mkdir(project);
    await mkdir(run);
    await writeFile(join(project, ".gitignore"), "custom/\n");
    await mkdir(join(project, ".requirements-agent"));
    const draft = join(project, ".requirements-agent", "draft.json");
    await writeFile(draft, "{}\n");
    const git = await GitCliOps.open(project);
    const baseline = await git.captureAccepted("input baseline");
    const index = (await runGit(project, ["ls-files", "--stage"], false)).stdout;
    await writeFile(join(project, "app.txt"), "implemented\n");
    for (const name of [".arc", "shallow-progress"]) {
      await mkdir(join(project, name));
      await writeFile(join(project, name, "events.txt"), "run metadata\n");
    }

    const patch = await writeProjectPatch(project, baseline, run);

    const content = await readFile(patch, "utf8");
    assert.match(content, /app\.txt/);
    assert.match(content, /\+implemented/);
    assert.doesNotMatch(content, /\.requirements-agent|\.arc|shallow-progress/);
    assert.equal(await readFile(draft, "utf8"), "{}\n");
    assert.equal((await runGit(project, ["ls-files", "--stage"], false)).stdout, index);
    assert.equal((await runGit(project, ["rev-parse", "HEAD"], false)).stdout.trim(), baseline);
  });
});

test("Workspace preparation rejects source overlap and distinguishes configuration from application files", async () => {
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
