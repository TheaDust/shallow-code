import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "../../src/checker/artifacts.js";
import { createWebExecutionAdapter, WEB_PROGRAM_FORMAT } from "../../src/checker/adapters/web/index.js";
import type { CheckJob, EvidenceReceipt, ProgramRef } from "../../src/checker/port.js";
import type { ProjectSpec } from "../../src/project-spec.js";
import { SnapshotStore } from "../../src/snapshot-store.js";
import { withTempDir } from "../helpers/temp-dir.js";

test("Web adapter binds schemas, fixed inputs, independent case data and full assertion receipts", async () => {
  await withTempDir("checker-web-adapter-", async (root) => {
    const source = join(root, "source"), workspace = join(root, "workers");
    await mkdir(join(source, "data"), { recursive: true });
    const spec: ProjectSpec = { start: { executable: process.execPath, args: ["server.cjs"] }, dataPaths: ["data"], generatedPaths: ["data"], dataEnvVar: "APP_DATA_DIR" };
    await writeFile(join(source, "shallowcode.config.json"), JSON.stringify(spec));
    await writeFile(join(source, "data/state.txt"), "original");
    await writeFile(join(source, "server.cjs"), `const fs=require('node:fs'),path=require('node:path');const file=path.join(process.env.APP_DATA_DIR,'state.txt');
      if(!fs.existsSync(file))fs.writeFileSync(file,'empty');
      require('node:http').createServer((req,res)=>{if(req.url.startsWith('/change')){fs.writeFileSync(file,'changed');res.writeHead(302,{location:'/'});res.end();return;}
      res.setHeader('content-type',req.url==='/health'?'text/plain':'text/html');res.end(req.url==='/health'?'ok':'<main><output role="status">'+fs.readFileSync(file,'utf8')+'</output><form action="/change"><button>Change</button></form></main>');}).listen(Number(process.env.PORT),'127.0.0.1');`);
    const artifacts = new ArtifactStore(join(root, "artifacts"), "run");
    const snapshots = new SnapshotStore(join(root, "snapshots"));
    const baseline = await snapshots.seal({ sourceDirectory: source, sourceSha: "sha-baseline", packetId: "baseline", dataPaths: ["data"] });
    await writeFile(join(source, "data/state.txt"), "snapshot-later");
    const snapshot = await snapshots.seal({ sourceDirectory: source, sourceSha: "sha-original", packetId: "packet", dataPaths: ["data"] });
    const { adapter, declaration, initialState } = await createWebExecutionAdapter({ artifacts, snapshots, workspace, spec, initialDataSnapshot: baseline.ref });
    const job: CheckJob = { jobId: "job", runId: "run", moduleId: "module", packetId: "packet", attempt: 1, moduleEpoch: 1,
      snapshot: snapshot.ref, requirements: await artifacts.putJson({ requirements: [] }), binding: adapter.binding, initialState,
      requirementIds: ["r"], mode: "replay", programs: [], budget: { deadlineAt: Date.now() + 90_000, maxModelTokens: 1_000 } };
    const contract = await artifacts.putJson({ clauses: [{ id: "r:result", requirementId: "r", scenarioId: "s", checkpointId: "result", expected: { operator: "equal", value: "changed" } }], checkpoints: [
      { id: "initial", kind: "precondition", expected: { operator: "equal", value: "original" } }, { id: "change", kind: "action" }, { id: "result", kind: "assertion" },
    ] });
    const programSource = `const p=await browser.actor('alice');const before=await p.read({role:'status'});await check.precondition('initial',[before.id]);await p.click({role:'button',name:'Change'},'change');const after=await p.read({role:'status'});await check.expect('r:result',[after.id]);`;
    const descriptor = await artifacts.putTypedJson({ source: await artifacts.putBytes(programSource), initialState, clauses: [{ clauseId: "r:result", checkpointId: "result" }] }, declaration.programFormat.schema);
    const program: ProgramRef = { descriptor, format: WEB_PROGRAM_FORMAT, contract, binding: adapter.binding };
    // Builder changes after sealing do not affect execution or its inherited baseline.
    await writeFile(join(source, "data/state.txt"), "builder-later");
    const session = await adapter.prepare(job, new AbortController().signal);
    const firstEnvironment = session.execution;
    try {
      const receiptRefs = await session.replay(program, new AbortController().signal);
      const receipts = await Promise.all(receiptRefs.map((ref) => artifacts.getJson<EvidenceReceipt>(ref)));
      assert.equal(receipts.find((receipt) => receipt.kind === "assertion")?.assertion?.result, "satisfied");
      assert.ok(receipts.some((receipt) => receipt.kind === "precondition"));
      assert.ok(receipts.some((receipt) => receipt.kind === "action" && receipt.checkpointId === "change"));
      assert.ok(receipts.filter((receipt) => receipt.kind === "observation").length >= 2);
      assert.notEqual(session.execution.digest, firstEnvironment.digest);
      const observed = await session.invoke("inspect", { actor: "alice" }, new AbortController().signal);
      assert.match(JSON.stringify(await artifacts.readTypedJson(observed.output)), /changed/);
      await session.invoke("reset_case", {}, new AbortController().signal);
      const reset = await session.invoke("inspect", { actor: "alice" }, new AbortController().signal);
      assert.match(JSON.stringify(await artifacts.readTypedJson(reset.output)), /original/);
      const formal = await session.invoke("run", { source: programSource, program }, new AbortController().signal);
      const formalReceipts = await Promise.all(formal.receipts.map((ref) => artifacts.getJson<EvidenceReceipt>(ref)));
      assert.equal(formalReceipts.find((receipt) => receipt.kind === "assertion")?.assertion?.result, "satisfied");
      await assert.rejects(session.invoke("run", { source: "return true", program }, new AbortController().signal), /differs from the bound program/);
      await assert.rejects(session.invoke("evaluate", {}, new AbortController().signal), /Unknown Web capability/);
      const failedContract = await artifacts.putJson({ clauses: [{ id: "r:result", checkpointId: "result", expected: { operator: "equal", value: "deliberately absent expected result" } }], checkpoints: [
        { id: "initial", kind: "precondition", expected: { operator: "equal", value: "original" } }, { id: "change", kind: "action" }, { id: "result", kind: "assertion" },
      ] });
      const failedRefs = await session.replay({ ...program, contract: failedContract }, new AbortController().signal);
      const failedReceipts = await Promise.all(failedRefs.map((ref) => artifacts.getJson<EvidenceReceipt>(ref)));
      assert.equal(failedReceipts.find((receipt) => receipt.kind === "assertion")?.assertion?.result, "violated");
      const attachments = failedReceipts.flatMap((receipt) => receipt.attachments);
      assert.ok(attachments.some((attachment) => attachment.mediaType === "image/png"));
      assert.ok(attachments.some((attachment) => attachment.mediaType === "application/zip"));
      for (const attachment of attachments) assert.ok((await artifacts.getBytes(attachment)).length > 0);
      assert.equal(await readFile(join(snapshot.sourceDirectory, "data/state.txt"), "utf8"), "snapshot-later");
      assert.equal(await readFile(join(baseline.sourceDirectory, "data/state.txt"), "utf8"), "original");
      assert.equal(await readFile(join(source, "data/state.txt"), "utf8"), "builder-later");
    } finally { await session.close(); }
    assert.deepEqual(await readdir(workspace), []);
    const broken = await createWebExecutionAdapter({ artifacts, snapshots, workspace, spec, lifecycle: { start: async () => { throw new Error("actual-startup-diagnostic"); } } });
    try { await broken.adapter.prepare({ ...job, binding: broken.adapter.binding, initialState: broken.initialState }, new AbortController().signal); assert.fail("prepare should fail"); }
    catch (error) {
      assert.match(String(error), /actual-startup-diagnostic/);
      const refs = (error as { diagnosticRefs: Array<{ id: string; digest: string }> }).diagnosticRefs;
      assert.ok(refs.length > 0);
      assert.equal((await artifacts.getJson<EvidenceReceipt>(refs[0]!)).readiness?.result, "inconclusive");
    }
    assert.deepEqual(await readdir(workspace), []);
    await assert.rejects(adapter.prepare({ ...job, binding: { ...job.binding, executor: { ...job.binding.executor, version: "forged" } } }, new AbortController().signal), /binding mismatch/);
    const { declaration: fixed } = await createWebExecutionAdapter({ artifacts, snapshots, workspace, spec: { ...spec, adapterConfig: { extraPorts: [3001] } } });
    assert.deepEqual(fixed.resourceKeys, ["local-port:3001"]);
  });
});
