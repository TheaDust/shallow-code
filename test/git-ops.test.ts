import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { GitCliOps, runGit } from "../src/git-ops.js";
import { withTempDir } from "./helpers/temp-dir.js";

const execFileAsync = promisify(execFile);

test("GitOps captures an empty baseline and returns HEAD when nothing changed", async () => {
  await withTempDir("shallow-git-", async (directory) => {
    const git = await GitCliOps.open(directory);

    const baseline = await git.captureAccepted("shallow: baseline");
    const unchanged = await git.captureAccepted("shallow: unchanged");

    assert.match(baseline, /^[0-9a-f]{40}$/);
    assert.equal(unchanged, baseline);
  });
});

test("GitOps writes and tracks ignore rules when initializing", async () => {
  await withTempDir("shallow-git-", async (directory) => {
    await GitCliOps.open(directory);

    const content = await readFile(join(directory, ".gitignore"), "utf8");
    assert.match(content, /node_modules\//);
    assert.match(content, /\.env/);

    const tracked = await execFileAsync("git", ["ls-files", ".gitignore"], {
      cwd: directory,
    });
    assert.equal(tracked.stdout.trim(), ".gitignore");
  });
});

test("Application change detection ignores run metadata and build files but sees untracked, committed and deleted source", async () => {
  await withTempDir("shallow-git-change-", async directory => {
    const git = await GitCliOps.open(directory);
    const baseline = await git.captureAccepted("baseline");
    for (const folder of [".arc", "shallow-progress", "dist", "node_modules"]) {
      await mkdir(join(directory, folder), { recursive: true });
      await writeFile(join(directory, folder, "record.txt"), "diagnostic/build output");
    }
    assert.equal(await git.hasApplicationChanges(baseline), false);
    await writeFile(join(directory, "app.ts"), "export const value = 1;");
    assert.equal(await git.hasApplicationChanges(baseline), true);
    const written = await git.captureAccepted("builder wrote source");
    assert.equal(await git.hasApplicationChanges(baseline), true);
    assert.equal(await git.hasApplicationChanges(written), false);
    await execFileAsync("git", ["rm", "app.ts"], { cwd: directory });
    assert.equal(await git.hasApplicationChanges(written), true);
    assert.equal(await git.hasApplicationChanges(baseline), false);
  });
});

test("GitOps keeps an existing .gitignore untouched", async () => {
  await withTempDir("shallow-git-", async (directory) => {
    await writeFile(join(directory, ".gitignore"), "custom/\n", "utf8");

    await GitCliOps.open(directory);

    assert.equal(await readFile(join(directory, ".gitignore"), "utf8"), "custom/\n");
  });
});

test("runGit kills the child and rejects when the command exceeds its timeout", async () => {
  await withTempDir("shallow-git-", async (directory) => {
    await assert.rejects(
      runGit(directory, ["rev-parse", "--show-toplevel"], true, 1),
      /timed out after 1ms/,
    );
  });
});

test("GitOps restores the accepted state via a recovery commit that keeps the attempt reachable", async () => {
  await withTempDir("shallow-git-", async (directory) => {
    const git = await GitCliOps.open(directory);
    const tracked = join(directory, "app.txt");
    await writeFile(tracked, "accepted");
    const accepted = await git.captureAccepted("shallow: accepted");
    await writeFile(tracked, "broken");
    const attempt = await git.captureAccepted("shallow: broken attempt");
    const untracked = join(directory, "candidate.tmp");
    await writeFile(untracked, "candidate");

    await git.restoreAccepted(accepted);

    assert.equal(await readFile(tracked, "utf8"), "accepted");
    await assert.rejects(access(untracked));
    const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: directory })).stdout.trim();
    assert.notEqual(head, accepted);
    assert.notEqual(head, attempt);
    // The attempt stays reachable in history; HEAD moved forward, not back.
    await execFileAsync("git", ["merge-base", "--is-ancestor", attempt, "HEAD"], { cwd: directory });
    assert.equal(
      (await execFileAsync("git", ["log", "-1", "--format=%s", "HEAD"], { cwd: directory })).stdout.trim(),
      "shallow: restore accepted state",
    );
  });
});

test("GitOps restore truly deletes source files introduced by a rejected attempt", async () => {
  await withTempDir("shallow-git-", async (directory) => {
    const git = await GitCliOps.open(directory);
    await writeFile(join(directory, "app.txt"), "accepted");
    const accepted = await git.captureAccepted("shallow: accepted");
    await writeFile(join(directory, "app.txt"), "broken");
    await writeFile(join(directory, "extra.txt"), "from failed attempt");
    await git.captureAccepted("shallow: failed attempt");

    await git.restoreAccepted(accepted);

    assert.equal(await readFile(join(directory, "app.txt"), "utf8"), "accepted");
    await assert.rejects(access(join(directory, "extra.txt")));
  });
});

test("GitOps supports restoring the same accepted state across repeated failed attempts", async () => {
  await withTempDir("shallow-git-", async (directory) => {
    const git = await GitCliOps.open(directory);
    await writeFile(join(directory, "app.txt"), "accepted");
    const accepted = await git.captureAccepted("shallow: accepted");
    await writeFile(join(directory, "app.txt"), "first attempt");
    await git.captureAccepted("shallow: first");
    await git.restoreAccepted(accepted);
    await writeFile(join(directory, "app.txt"), "second attempt");
    await git.captureAccepted("shallow: second");

    await git.restoreAccepted(accepted);

    assert.equal(await readFile(join(directory, "app.txt"), "utf8"), "accepted");
    const subjects = (await execFileAsync("git", ["log", "--format=%s"], { cwd: directory })).stdout;
    assert.match(subjects, /first/);
    assert.match(subjects, /second/);
  });
});

test("GitOps rejects a value that is not a commit in the output repository", async () => {
  await withTempDir("shallow-git-", async (directory) => {
    const git = await GitCliOps.open(directory);
    await git.captureAccepted("shallow: baseline");

    await assert.rejects(
      git.restoreAccepted("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
      /not a commit in the output repository/,
    );
  });
});

test("GitOps rollback retains tracked and untracked ARC audit records while restoring application state", async () => {
  await withTempDir("shallow-git-", async (directory) => {
    const git = await GitCliOps.open(directory);
    const arc = join(directory, ".arc");
    await mkdir(arc);
    const events = join(arc, "runner-events.jsonl");
    await writeFile(events, "accepted event\n");
    await writeFile(join(directory, "app.txt"), "accepted");
    const accepted = await git.captureAccepted("accept");
    await writeFile(events, "accepted event\nfailed candidate event\n");
    await writeFile(join(arc, "latest.json"), "{}");
    await writeFile(join(directory, "app.txt"), "broken");
    await writeFile(join(directory, "candidate.txt"), "new");
    const attempt = await git.captureAccepted("simulated builder commit");
    await git.restoreAccepted(accepted);
    // History moves forward: HEAD is a recovery commit, not the accepted sha,
    // and the rejected attempt remains reachable.
    assert.notEqual((await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: directory })).stdout.trim(), accepted);
    await execFileAsync("git", ["merge-base", "--is-ancestor", attempt, "HEAD"], { cwd: directory });
    assert.equal(await readFile(join(directory, "app.txt"), "utf8"), "accepted");
    assert.equal(await readFile(events, "utf8"), "accepted event\nfailed candidate event\n");
    await access(join(arc, "latest.json"));
    await assert.rejects(access(join(directory, "candidate.txt")));
  });
});

test("GitOps keeps an existing empty ignore file unchanged", async () => {
  await withTempDir("shallow-git-", async (directory) => {
    await writeFile(join(directory, ".gitignore"), "");
    await GitCliOps.open(directory);
    assert.equal(await readFile(join(directory, ".gitignore"), "utf8"), "");
  });
});

async function initRepoWithRootCommit(
  directory: string,
  rootMessage: string,
): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: directory });
  await writeFile(join(directory, ".gitignore"), "node_modules/\n", "utf8");
  await writeFile(join(directory, "app.txt"), "committed", "utf8");
  await execFileAsync("git", ["add", "-A"], { cwd: directory });
  await execFileAsync(
    "git",
    ["-c", "user.name=setup", "-c", "user.email=setup@local.invalid", "commit", "-m", rootMessage],
    { cwd: directory },
  );
}

test("GitOps open cleans crash residue left by an interrupted ShallowCode run", async () => {
  await withTempDir("shallow-git-", async (directory) => {
    await initRepoWithRootCommit(directory, "shallow: initial state");
    await writeFile(join(directory, "app.txt"), "half-written orphan", "utf8");
    await mkdir(join(directory, "backend"));
    await writeFile(join(directory, "backend", "leftover.js"), "orphan", "utf8");
    await mkdir(join(directory, ".arc"));
    const events = join(directory, ".arc", "runner-events.jsonl");
    await writeFile(events, "stale event\n", "utf8");

    await GitCliOps.open(directory);

    assert.equal(await readFile(join(directory, "app.txt"), "utf8"), "committed");
    await assert.rejects(access(join(directory, "backend", "leftover.js")));
    await assert.rejects(access(events));
  });
});

test("GitOps open removes the stale runner event stream from a clean ShallowCode repository", async () => {
  await withTempDir("shallow-git-", async (directory) => {
    await initRepoWithRootCommit(directory, "shallow: initial state");
    await mkdir(join(directory, ".arc"));
    const events = join(directory, ".arc", "runner-events.jsonl");
    await writeFile(events, "stale event\n", "utf8");

    await GitCliOps.open(directory);

    assert.equal(await readFile(join(directory, "app.txt"), "utf8"), "committed");
    await assert.rejects(access(events));
  });
});

test("GitOps open refuses to clean a dirty repository it did not create", async () => {
  await withTempDir("shallow-git-", async (directory) => {
    await initRepoWithRootCommit(directory, "user's own baseline");
    const scratch = join(directory, "scratch.txt");
    await writeFile(scratch, "user scratch", "utf8");

    await assert.rejects(
      GitCliOps.open(directory),
      /uncommitted changes from outside ShallowCode/,
    );
    assert.equal(await readFile(scratch, "utf8"), "user scratch");
  });
});

test("GitOps open initializes over pre-seeded platform scaffold entries", async () => {
  await withTempDir("shallow-git-", async (directory) => {
    await mkdir(join(directory, ".arc", "traceability"), { recursive: true });
    await writeFile(join(directory, ".arc", "traceability", "node_states.json"), "{}", "utf8");
    await mkdir(join(directory, "requirements"));
    await writeFile(join(directory, "requirements", "requirements.yaml"), "root: {}\n", "utf8");

    const git = await GitCliOps.open(directory);
    const baseline = await git.captureAccepted("shallow: initial state");

    assert.match(baseline, /^[0-9a-f]{40}$/);
    const tracked = await execFileAsync("git", ["ls-files"], { cwd: directory });
    assert.match(tracked.stdout, /\.arc\/traceability\/node_states\.json/);
    assert.match(tracked.stdout, /requirements\/requirements\.yaml/);
  });
});

test("GitOps keeps the progress journal untracked and preserves it across rollback", async () => {
  await withTempDir("shallow-git-", async (directory) => {
    const git = await GitCliOps.open(directory);
    const accepted = await git.captureAccepted("shallow: baseline");

    const journal = join(directory, "shallow-progress");
    await mkdir(join(journal, "plans"), { recursive: true });
    await writeFile(join(journal, "progress.log"), "step 1\n", "utf8");
    const after = await git.captureAccepted("shallow: journal only");

    // Untracked and excluded: a journal-only change must not create a commit.
    assert.equal(after, accepted);
    const tracked = await execFileAsync("git", ["ls-files"], { cwd: directory });
    assert.doesNotMatch(tracked.stdout, /shallow-progress/);

    // Application changes still commit.
    await writeFile(join(directory, "app.txt"), "implemented");
    const changed = await git.captureAccepted("shallow: app change");
    assert.notEqual(changed, accepted);

    // Rolling back a rejected attempt must not erase the journal.
    await writeFile(join(directory, "app.txt"), "broken");
    await git.captureAccepted("shallow: broken attempt");
    await git.restoreAccepted(changed);
    assert.equal(await readFile(join(directory, "app.txt"), "utf8"), "implemented");
    assert.equal(await readFile(join(journal, "progress.log"), "utf8"), "step 1\n");
  });
});

test("GitOps open initializes an independent repository nested inside another repository", async () => {
  await withTempDir("shallow-git-", async (parent) => {
    await initRepoWithRootCommit(parent, "parent baseline");
    const parentHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: parent })).stdout.trim();
    const nested = join(parent, "output");
    await mkdir(nested);

    const git = await GitCliOps.open(nested);
    await git.captureAccepted("shallow: initial state");

    const nestedRoot = (await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: nested })).stdout.trim();
    assert.equal(nestedRoot.replaceAll("\\", "/").toLowerCase(), nested.replaceAll("\\", "/").toLowerCase());
    assert.equal(
      (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: parent })).stdout.trim(),
      parentHead,
    );
    assert.equal(await readFile(join(parent, "app.txt"), "utf8"), "committed");
    assert.equal(await readFile(join(parent, ".gitignore"), "utf8"), "node_modules/\n");
  });
});

test("GitOps open still refuses a non-empty directory nested inside another repository", async () => {
  await withTempDir("shallow-git-", async (parent) => {
    await initRepoWithRootCommit(parent, "parent baseline");
    const nested = join(parent, "output");
    await mkdir(nested);
    await writeFile(join(nested, "stray.txt"), "stray", "utf8");

    await assert.rejects(
      GitCliOps.open(nested),
      /must be empty before the first run/,
    );
    assert.equal(await readFile(join(nested, "stray.txt"), "utf8"), "stray");
  });
});

test("GitOps open refuses a fresh directory that is not empty", async () => {
  await withTempDir("shallow-git-", async (directory) => {
    const stray = join(directory, "stray.txt");
    await writeFile(stray, "stray", "utf8");

    await assert.rejects(
      GitCliOps.open(directory),
      /must be empty before the first run/,
    );
    assert.equal(await readFile(stray, "utf8"), "stray");
  });
});

async function writeDeliveredApp(directory: string): Promise<void> {
  await mkdir(join(directory, "frontend"), { recursive: true });
  await writeFile(join(directory, "frontend", "package.json"), '{"scripts":{"build":"true"}}\n', "utf8");
  await mkdir(join(directory, "backend"), { recursive: true });
  await writeFile(join(directory, "backend", "package.json"), '{"scripts":{"start":"true"}}\n', "utf8");
}

test("GitOps open accepts an evolution template that already holds frontend/ and backend/", async () => {
  await withTempDir("shallow-git-", async (directory) => {
    await writeDeliveredApp(directory);
    await writeFile(join(directory, "README.md"), "template\n", "utf8");

    const git = await GitCliOps.open(directory);
    const baseline = await git.captureAccepted("shallow: initial state");

    assert.match(baseline, /^[0-9a-f]{40}$/);
    const tracked = await execFileAsync("git", ["ls-files"], { cwd: directory });
    assert.match(tracked.stdout, /frontend\/package\.json/);
    assert.match(tracked.stdout, /backend\/package\.json/);
    assert.match(tracked.stdout, /README\.md/);
  });
});

test("GitOps open keeps dependency and build output out of an evolution baseline", async () => {
  await withTempDir("shallow-git-", async (directory) => {
    await writeDeliveredApp(directory);
    await mkdir(join(directory, "frontend", "node_modules", "left-pad"), { recursive: true });
    await writeFile(join(directory, "frontend", "node_modules", "left-pad", "index.js"), "module\n", "utf8");
    await mkdir(join(directory, "frontend", "dist"), { recursive: true });
    await writeFile(join(directory, "frontend", "dist", "index.html"), "<main></main>\n", "utf8");

    const git = await GitCliOps.open(directory);
    await git.captureAccepted("shallow: initial state");

    const tracked = await execFileAsync("git", ["ls-files"], { cwd: directory });
    assert.doesNotMatch(tracked.stdout, /node_modules/);
    assert.doesNotMatch(tracked.stdout, /frontend\/dist\//);
    assert.match(tracked.stdout, /backend\/package\.json/);
  });
});

test("GitOps open adopts a dirty foreign repository that holds a delivered app", async () => {
  await withTempDir("shallow-git-", async (directory) => {
    await initRepoWithRootCommit(directory, "template baseline");
    await writeDeliveredApp(directory);
    const scratch = join(directory, "scratch.txt");
    await writeFile(scratch, "template scratch", "utf8");

    const git = await GitCliOps.open(directory);
    const baseline = await git.captureAccepted("shallow: initial state");

    assert.match(baseline, /^[0-9a-f]{40}$/);
    assert.equal(await readFile(scratch, "utf8"), "template scratch");
    const tracked = await execFileAsync("git", ["ls-files"], { cwd: directory });
    assert.match(tracked.stdout, /scratch\.txt/);
    assert.match(tracked.stdout, /frontend\/package\.json/);
  });
});

test("GitOps adopts injected files from old Shallow history and rollback preserves that baseline", async () => {
  for (const rootMessage of ["shallow: initial state", "chore: add ShallowCode ignore rules"]) {
    await withTempDir("shallow-git-inherited-", async directory => {
      await initRepoWithRootCommit(directory, rootMessage);
      await execFileAsync("git", ["config", "core.autocrlf", "false"], { cwd: directory });
      await writeDeliveredApp(directory);
      const frontendFile = join(directory, "frontend", "app.ts");
      const backendFile = join(directory, "backend", "new.ts");
      await writeFile(frontendFile, "original application\n");
      await execFileAsync("git", ["add", "-A"], { cwd: directory });
      await execFileAsync("git", ["-c", "user.name=setup", "-c", "user.email=setup@local.invalid",
        "commit", "-m", "preliminary application"], { cwd: directory });
      const previousHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: directory })).stdout.trim();

      await writeFile(frontendFile, "staged injection\n");
      await execFileAsync("git", ["add", "frontend/app.ts"], { cwd: directory });
      await writeFile(frontendFile, "injected baseline\n");
      await writeFile(backendFile, "injected untracked source\n");
      await rm(join(directory, "app.txt"));

      const git = await GitCliOps.open(directory);
      assert.equal((await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: directory })).stdout.trim(), previousHead);
      assert.equal(await readFile(frontendFile, "utf8"), "injected baseline\n");
      assert.equal(await readFile(backendFile, "utf8"), "injected untracked source\n");
      await assert.rejects(access(join(directory, "app.txt")));
      const baseline = await git.captureAccepted("shallow: initial state");

      await writeFile(frontendFile, "rejected modification\n");
      const attemptedFile = join(directory, "backend", "attempt.ts");
      await writeFile(attemptedFile, "new rejected source\n");
      await git.captureAccepted("shallow: rejected attempt");
      await git.restoreAccepted(baseline);
      assert.equal(await readFile(frontendFile, "utf8"), "injected baseline\n");
      assert.equal(await readFile(backendFile, "utf8"), "injected untracked source\n");
      await assert.rejects(access(join(directory, "app.txt")));
      await assert.rejects(access(attemptedFile));
    });
  }
});
