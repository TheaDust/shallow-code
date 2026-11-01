import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { GitCliOps } from "../src/git-ops.js";
import { loadRunRecord, lockWorkspace, saveRunRecord, snapshotFiles, writeRunReport, type RunRecord } from "../src/run-record.js";
import { withTempDir } from "./helpers/temp-dir.js";
import { ModelUsageTotals } from "../src/model-usage.js";
import { ArtifactStore } from "../src/verifier/artifacts.js";
import { loadRequirementCatalog } from "../src/catalog.js";
import { verifierSourceClauses } from "../src/verifier/evidence.js";
import type { CheckJob, CheckReport, EvidenceReceipt, ProgramRef } from "../src/verifier/port.js";

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

test("Verifier reports link source requirements and artifacts even when a clause has no assertion receipt", async () => {
  await withTempDir("shallow-trace-report-", async run => {
    const file = join(run, "requirements.yaml");
    await writeFile(file, JSON.stringify({ id: "ROOT", name: "Demo", type: "ROOT", children: [
      { id: "R", name: "Save", type: "ATOMIC", description: "Save an item.", scenarios: [
        { id: "save", name: "Save", steps: [
          { keyword: "WHEN", content: "The user saves the item" },
          { keyword: "THEN", content: "The saved item is visible" },
          { keyword: "AND", content: "The item count is updated" },
        ] },
      ] },
    ] }));
    const input = await loadRequirementCatalog(file);
    const clauses = verifierSourceClauses(input, ["R"]);
    assert.equal(clauses.length, 2);
    const store = new ArtifactStore(join(run, "verifier"), "trace-run");
    const schema = await store.putJson({});
    const typed = await store.putTypedJson({}, schema);
    const executor = { id: "test", version: "1", digest: "test" };
    const binding = { ...await store.putJson({ executor }), executor };
    const job: CheckJob = { jobId: "save-check", runId: store.runId, moduleId: "ROOT", packetId: "save", attempt: 1,
      moduleEpoch: 2, snapshot: await store.putJson({ source: "sealed" }), requirements: await store.putJson(input),
      binding, initialState: typed, requirementIds: ["R"], mode: "discover", programs: [], timeoutMs: 1000 };
    const jobRef = await store.putJson(job);
    const program: ProgramRef = { format: "test@1", binding,
      contract: await store.putJson({ requirements: job.requirements, clauses }),
      descriptor: await store.putTypedJson({ source: await store.putBytes("check.expect('saved item');"),
        initialState: typed, clauses: [{ clauseId: clauses[0].id, checkpointId: "saved" }] }, schema) };
    const observation: EvidenceReceipt = { id: "observed", job: jobRef, snapshot: job.snapshot, binding,
      environment: typed, sequence: 1, recordedAt: new Date().toISOString(), kind: "observation", inputs: [],
      payload: await store.putTypedJson({ visible: true }, schema), attachments: [] };
    const observed = await store.putReceipt(job, observation);
    const assertion = await store.putReceipt(job, { ...observation, id: "asserted", sequence: 2,
      kind: "assertion", checkpointId: "saved", assertion: { clauseId: clauses[0].id, result: "satisfied" },
      program, inputs: [observed], attachments: [await store.putTypedJson({ screenshot: "attachment" }, schema)] });
    const outcomes = clauses.map((clause, index) => ({ requirementId: "R", scenarioId: "save", clauseId: clause.id,
      status: index ? "inconclusive" as const : "pass" as const, evidence: index ? [] : [assertion, observed],
      ...(index ? { reason: "Result assertion was not executed" } : {}) }));
    const report: CheckReport = { job: jobRef, snapshot: job.snapshot, binding,
      manifest: await store.putJson({ receipts: [assertion, observed] }), programs: [program], outcomes };
    const reportRef = await store.putJson(report);
    await writeRunReport(run, { status: "partial", acceptedSha: "runnable", verifiedRequirementIds: [],
      blockedRequirementIds: [], inconclusiveRequirementIds: ["R"], verifier: { mode: "active", replay: false,
        outcomes: outcomes.map(outcome => ({ ...outcome, snapshotId: job.snapshot.id, jobId: job.jobId, job: jobRef, report: reportRef })) } });
    const markdown = await readFile(join(run, "verifier-report.md"), "utf8");
    const uncovered = markdown.slice(markdown.indexOf(`## R / save / ${clauses[1].id}`));
    assert.match(uncovered, /原文依据：The item count is updated/);
    assert.match(uncovered, /验收任务：save-check/);
    assert.match(markdown, /检查程序源码/);
    assert.match(markdown, /验收合同/);
    assert.match(markdown, /附件 1/);
    const links = [...markdown.matchAll(/\]\((verifier\/objects\/[a-f0-9]+)\)/g)];
    assert.ok(links.length >= 10);
    for (const match of links) await access(join(run, match[1]));
    const summary = await readFile(join(run, "report.md"), "utf8");
    assert.doesNotMatch(summary, /evidence\//);
    assert.match(summary, /\[运行账本\]\(run-ledger.jsonl\)/);
    assert.match(markdown, /按功能组原检查快照汇总/);
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
