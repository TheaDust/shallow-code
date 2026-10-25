import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { GitCliOps, runGit } from "../src/git-ops.js";
import { copyProjectWorkspace, writeProjectPatch } from "../src/project-workspace.js";
import { applyRun, loadRunRecord, lockWorkspace, readResumeCheckpoint, saveRunRecord, snapshotFiles, writeRunReport, type RunRecord } from "../src/run-record.js";
import { withTempDir } from "./helpers/temp-dir.js";
import { readHistoricalRequirementIds } from "../src/evolution.js";
import { ModelUsageTotals } from "../src/model-usage.js";

test("Run reports persist separate Builder, Verifier and Grouper usage with partial cost clearly marked", async () => {
  await withTempDir("shallow-usage-report-", async run => {
    const usage = new ModelUsageTotals();
    usage.add("builder", { input: 100, output: 20, cacheRead: 10, cacheWrite: 0, cost: 0.001 });
    usage.add("verifier", { input: 50, output: 5, cacheRead: 0, cacheWrite: 0 });
    usage.add("verifier", { input: 60, output: 4, cacheRead: 0, cacheWrite: 0 });
    usage.add("grouper", { input: 20, output: 2, cacheRead: 0, cacheWrite: 0 });
    await writeRunReport(run, { status: "delivered", acceptedSha: "sha", verifiedRequirementIds: [], blockedRequirementIds: [], modelUsage: usage.summary() });
    const result = JSON.parse(await readFile(join(run, "result.json"), "utf8"));
    assert.deepEqual(result.modelUsage, usage.summary());
    const report = await readFile(join(run, "report.md"), "utf8");
    assert.match(report, /总计.*tokens 271.*已知费用.*部分未计价/);
    assert.match(report, /Builder.*tokens 130.*费用 \$0\.001/);
    assert.match(report, /Verifier.*tokens 119.*费用未知/);
    assert.match(report, /Grouper.*tokens 22.*费用未知/);
  });
});

async function withOwnedRun(callback: (f: { source: string; work: string; run: string; record: RunRecord; patch: string; sha: string }) => Promise<void>, repository = true): Promise<void> {
  await withTempDir("shallow-run-record-", async root => {
    const source = join(root, "source"), run = join(root, "run"), work = join(run, "workspace");
    await mkdir(source);
    const origin = repository ? await GitCliOps.open(source) : undefined;
    await writeFile(join(source, "app.txt"), "baseline\nsecond line\n");
    await writeFile(join(source, "deleted.txt"), "remove me\n");
    await writeFile(join(source, "image.bin"), Buffer.from([0, 1, 255]));
    await origin?.captureAccepted("user baseline");
    if (origin) {
      await writeFile(join(source, "app.txt"), "staged\nsecond line\n");
      await runGit(source, ["add", "app.txt"], false);
      await writeFile(join(source, "app.txt"), "working\nsecond line\n");
    }
    const inputFiles = await snapshotFiles(source);
    await copyProjectWorkspace(source, work);
    const git = await GitCliOps.open(work, { allowExisting: true });
    const baseline = await git.captureAccepted("input");
    await writeFile(join(work, "app.txt"), "delivered\nsecond line\n");
    await writeFile(join(work, "image.bin"), Buffer.from([0, 255, 2]));
    await writeFile(join(work, "new.txt"), "new\n");
    await (await import("node:fs/promises")).unlink(join(work, "deleted.txt"));
    const sha = await git.captureAccepted("checkpoint");
    const record: RunRecord = { version: 4, requirementsDir: source, requirementsDigest: "requirements",
      contractDigest: "contract", projectSpec: { start: { executable: "node", args: ["app.js"] } },
      outputDir: work, sourceProjectDir: source, inputBaseline: baseline, inputFiles,
      auditInheritedRequirements: false, verifier: { mode: "active", concurrency: 2 }, verifierRunId: "fixture" };
    await saveRunRecord(run, record);
    const patch = await writeProjectPatch(work, baseline, run);
    await writeRunReport(run, { status: "delivered", acceptedSha: sha, verifiedRequirementIds: ["A"], blockedRequirementIds: [] }, patch);
    await callback({ source, work, run, record, patch, sha });
  });
}

test("Apply writes modified, added, deleted and binary files while preserving the source index and history", async () => {
  await withOwnedRun(async f => {
    const head = (await runGit(f.source, ["rev-parse", "HEAD"], false)).stdout;
    const staged = (await runGit(f.source, ["show", ":app.txt"], false)).stdout;
    assert.equal(await applyRun(f.run), f.source);
    assert.equal(await readFile(join(f.source, "app.txt"), "utf8"), "delivered\nsecond line\n");
    assert.equal(await readFile(join(f.source, "new.txt"), "utf8"), "new\n");
    assert.deepEqual(await readFile(join(f.source, "image.bin")), Buffer.from([0, 255, 2]));
    await assert.rejects(access(join(f.source, "deleted.txt")));
    assert.equal((await runGit(f.source, ["rev-parse", "HEAD"], false)).stdout, head);
    assert.equal((await runGit(f.source, ["show", ":app.txt"], false)).stdout, staged);
  });
});

test("Apply refuses concurrent changes anywhere in a touched file before writing any delivery files", async () => {
  await withOwnedRun(async f => {
    await writeFile(join(f.source, "app.txt"), "working\nuser changed another line\n");
    await assert.rejects(applyRun(f.run), /Project changed.*app.txt/);
    await assert.rejects(access(join(f.source, "new.txt")));
    assert.equal(await readFile(join(f.source, "deleted.txt"), "utf8"), "remove me\n");
    assert.deepEqual(await readFile(join(f.source, "image.bin")), Buffer.from([0, 1, 255]));
    await access(f.patch);
  });
});

test("Apply supports a project without Git and requires explicit partial delivery consent", async () => {
  await withOwnedRun(async f => {
    await writeRunReport(f.run, { status: "partial", acceptedSha: f.sha, verifiedRequirementIds: ["A"], blockedRequirementIds: ["B"] }, f.patch);
    await assert.rejects(applyRun(f.run), /--allow-partial/);
    await applyRun(f.run, true);
    assert.equal(await readFile(join(f.source, "app.txt"), "utf8"), "delivered\nsecond line\n");
    await assert.rejects(access(join(f.source, ".git")));
  }, false);
});

test("Apply rejects a patch edited after delivery reporting", async () => {
  await withOwnedRun(async f => {
    await writeFile(f.patch, "modified artifact");
    await assert.rejects(applyRun(f.run), /patch changed/);
    assert.equal(await readFile(join(f.source, "app.txt"), "utf8"), "working\nsecond line\n");
  });
});

test("Apply transfers requirement contract provenance without transferring private plans or verification", async () => {
  await withOwnedRun(async f => {
    f.record.requirementDigests = { A: "a".repeat(64), B: "b".repeat(64) };
    await saveRunRecord(f.run, f.record);
    await mkdir(join(f.source, "shallow-progress"));
    await writeFile(join(f.source, "shallow-progress/progress.log"),
      `[12:00:00 +0s] 保存可运行检查点；implementation；需求 A、B；SHA ${f.sha}（功能验收状态单独记录） [#1]\n`);
    await writeRunReport(f.run, { status: "partial", acceptedSha: f.sha, implementedRequirementIds: ["A", "B"],
      verifiedRequirementIds: ["A"], inconclusiveRequirementIds: ["B"], blockedRequirementIds: [] }, f.patch);
    await applyRun(f.run, true);
    const history = await readHistoricalRequirementIds(join(f.source, "shallow-progress"));
    assert.deepEqual([...history.requirementIds], ["A"]);
    assert.deepEqual(history.requirementDigests, { A: "a".repeat(64) });
    await assert.rejects(access(join(f.source, "shallow-progress/plans")));
  });
});

test("Apply treats a project nested inside another Git repository as its own patch root", async () => {
  await withOwnedRun(async f => {
    const parent = dirname(f.source);
    await runGit(parent, ["init"], false);
    await applyRun(f.run);
    assert.equal(await readFile(join(f.source, "app.txt"), "utf8"), "delivered\nsecond line\n");
    assert.equal((await runGit(parent, ["ls-files", "--stage"], false)).stdout, "");
    await assert.rejects(access(join(parent, "app.txt")));
  }, false);
});

test("Resume reads the committed Verifier checkpoint rather than diagnostic ledger events", async () => {
  await withOwnedRun(async f => {
    const { VerifierCheckpoints } = await import("../src/verifier/checkpoints.js");
    const file = join(f.run, "verifier", "controller.json");
    await mkdir(dirname(file), { recursive: true });
    const checkpoints = await VerifierCheckpoints.open(file, "fixture", f.sha);
    await checkpoints.produced({ snapshot: { id: "snapshot", digest: "digest" }, sourceSha: f.sha, implementedRequirementIds: ["A"] });
    await writeFile(join(f.run, "run-ledger.jsonl"), 'broken diagnostic append');
    assert.deepEqual(await readResumeCheckpoint(f.run, f.record), { sha: f.sha, requirementIds: ["A"] });
  });
});

test("A live workspace owner prevents concurrent resume", async () => {
  await withOwnedRun(async f => {
    const release = await lockWorkspace(f.work);
    try { await assert.rejects(lockWorkspace(f.work), /in use/); }
    finally { await release(); }
    await (await lockWorkspace(f.work))();
  });
});

test("Old run formats are rejected before attempting a workspace checkout", async () => {
  await withTempDir("old-run-format-", async run => {
    for (const version of [1, 2, 3]) {
      await writeFile(join(run, "run.json"), JSON.stringify({ version }));
      await assert.rejects(loadRunRecord(run), /unsupported; start a new Verifier run/);
    }
  });
});

test("Version 3 records cannot resume or apply even when their workspace and current fields are valid", async () => {
  await withOwnedRun(async f => {
    const content = JSON.stringify({ ...f.record, version: 3 });
    await writeFile(join(f.run, "run.json"), content);
    await assert.rejects(loadRunRecord(f.run), /unsupported; start a new Verifier run/);
    await assert.rejects(applyRun(f.run), /unsupported; start a new Verifier run/);
    assert.equal(await readFile(join(f.run, "run.json"), "utf8"), content);
    assert.equal(await readFile(join(f.source, "app.txt"), "utf8"), "working\nsecond line\n");
  });
});
