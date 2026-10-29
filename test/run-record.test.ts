import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { GitCliOps } from "../src/git-ops.js";
import { loadRunRecord, lockWorkspace, saveRunRecord, snapshotFiles, writeRunReport, type RunRecord } from "../src/run-record.js";
import { withTempDir } from "./helpers/temp-dir.js";
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

test("A live workspace owner prevents concurrent builds", async () => {
  await withTempDir("shallow-workspace-lock-", async project => {
    const release = await lockWorkspace(project);
    try { await assert.rejects(lockWorkspace(project), /in use/); }
    finally { await release(); }
    await (await lockWorkspace(project))();
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

test("Version 3 records are rejected even when their workspace and current fields are valid", async () => {
  await withTempDir("shallow-run-record-", async root => {
    const project = join(root, "project"), run = join(root, "run");
    await mkdir(project);
    await writeFile(join(project, "app.txt"), "current source\n");
    const checkpointGitDirectory = join(run, "checkpoints.git");
    const git = await GitCliOps.open(project, { checkpointDirectory: checkpointGitDirectory });
    const inputBaseline = await git.captureAccepted("input");
    const record: RunRecord = { version: 4, requirementsDir: project, requirementsDigest: "requirements",
      contractDigest: "contract", projectSpec: { start: { executable: "node", args: ["app.js"] } },
      outputDir: project, checkpointGitDirectory, inputBaseline, inputFiles: await snapshotFiles(project),
      verifier: { mode: "active", concurrency: 2 }, verifierRunId: "fixture" };
    await saveRunRecord(run, record);
    assert.equal((await loadRunRecord(run)).outputDir, project);
    const content = JSON.stringify({ ...record, version: 3 });
    await writeFile(join(run, "run.json"), content);
    await assert.rejects(loadRunRecord(run), /unsupported; start a new Verifier run/);
    assert.equal(await readFile(join(run, "run.json"), "utf8"), content);
    assert.equal(await readFile(join(project, "app.txt"), "utf8"), "current source\n");
  });
});
