import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser } from "@playwright/test";
import { test } from "node:test";
import { ArtifactStore } from "../../src/verifier/artifacts.js";
import { createWebExecutionAdapter, WEB_PROGRAM_FORMAT } from "../../src/verifier/adapters/web/index.js";
import type { CheckJob, EvidenceReceipt, ExecutionSession, ProgramRef } from "../../src/verifier/port.js";
import type { ProjectSpec } from "../../src/project-spec.js";
import { SnapshotStore } from "../../src/snapshot-store.js";
import { fileFixture } from "../../src/verifier/adapters/web/fixtures.js";
import { withTempDir } from "../helpers/temp-dir.js";

test("Job slots reuse builds and one browser while cases keep independent processes, storage and contexts", async () => {
  await withTempDir("verifier-web-reuse-", async root => {
    const source = join(root, "source"), workspace = join(root, "workers");
    const commands = join(root, "commands.log"), starts = join(root, "starts.log");
    await mkdir(join(source, "data"), { recursive: true });
    const spec: ProjectSpec = {
      install: [{ executable: process.execPath, args: ["install.cjs"] }],
      build: [{ executable: process.execPath, args: ["build.cjs"] }],
      start: { executable: process.execPath, args: ["server.cjs"] },
      dataPaths: ["data"], generatedPaths: ["data", "built.txt"], dataEnvVar: "APP_DATA_DIR",
    };
    await writeFile(join(source, "shallowcode.config.json"), JSON.stringify(spec));
    await writeFile(join(source, "data/state.txt"), "original");
    await writeFile(join(source, "install.cjs"), `require('node:fs').appendFileSync(${JSON.stringify(commands)},'install\\n');`);
    await writeFile(join(source, "build.cjs"), `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(commands)},'build\\n');fs.writeFileSync('built.txt','ready');`);
    await writeFile(join(source, "server.cjs"), `const fs=require('node:fs'),path=require('node:path');
      const file=path.join(process.env.APP_DATA_DIR,'state.txt');let memory='clean';
      fs.appendFileSync(${JSON.stringify(starts)},JSON.stringify({pid:process.pid,data:process.env.APP_DATA_DIR})+'\\n');
      require('node:http').createServer((req,res)=>{if(req.url==='/mutate'){fs.writeFileSync(file,'changed');memory='dirty';}
      res.setHeader('content-type','text/html');res.end('<output role="status">'+fs.readFileSync(file,'utf8')+'|'+memory+'</output>');}).listen(Number(process.env.PORT),'127.0.0.1');`);
    const artifacts = new ArtifactStore(join(root, "artifacts"), "run"), snapshots = new SnapshotStore(join(root, "snapshots"));
    const snapshot = await snapshots.seal({ sourceDirectory: source, sourceSha: "sha", packetId: "packet", dataPaths: ["data"] });
    let launches = 0, browser: Browser | undefined, abortOnLaunch: AbortController | undefined;
    const { adapter, initialState } = await createWebExecutionAdapter({ artifacts, snapshots, workspace, spec, initialDataSnapshot: snapshot.ref,
      launchBrowser: async () => {
        launches++;
        browser = await chromium.launch({ headless: true });
        abortOnLaunch?.abort(new Error("cancel browser preparation"));
        return browser;
      } });
    const job: CheckJob = { jobId: "job", runId: "run", moduleId: "module", packetId: "packet", attempt: 1, moduleEpoch: 1,
      snapshot: snapshot.ref, requirements: await artifacts.putJson({ requirements: [] }), binding: adapter.binding, initialState,
      requirementIds: ["r"], mode: "discover", programs: [], timeoutMs: 90_000 };
    const signal = new AbortController().signal;
    const identity = (session: ExecutionSession) => artifacts.readTypedJson<{ candidate: { buildId: string; runtimeId: string }; baseUrl: string }>(session.execution);
    let originalBuild: string;
    try {
      const first = await adapter.prepare(job, signal), firstIdentity = await identity(first);
      originalBuild = firstIdentity.candidate.buildId;
      await first.invoke("run", { source: "const p=await browser.actor('alice');await p.goto('/mutate');" }, signal);
      const oldContext = browser!.contexts()[0]!;
      await oldContext.pages()[0]!.evaluate(() => localStorage.setItem("case", "dirty"));
      const second = await adapter.prepare(job, signal), secondIdentity = await identity(second);
      assert.notEqual(secondIdentity.candidate.buildId, firstIdentity.candidate.buildId, "live cases have exclusive build slots");
      const secondState = await second.invoke("inspect", { actor: "alice" }, signal);
      assert.match(JSON.stringify(await artifacts.readTypedJson(secondState.output)), /original\|clean/);
      await first.close();
      assert.equal(oldContext.pages().length, 0, "case close releases browser contexts");
      await assert.rejects(fetch(firstIdentity.baseUrl));
      const third = await adapter.prepare(job, signal), thirdIdentity = await identity(third);
      assert.equal(thirdIdentity.candidate.buildId, firstIdentity.candidate.buildId);
      assert.notEqual(thirdIdentity.candidate.runtimeId, firstIdentity.candidate.runtimeId);
      const thirdState = await third.invoke("inspect", { actor: "alice" }, signal);
      assert.match(JSON.stringify(await artifacts.readTypedJson(thirdState.output)), /original\|clean/);
      const thirdPage = browser!.contexts().at(-1)!.pages()[0]!;
      assert.equal(await thirdPage.evaluate(() => localStorage.getItem("case")), null);
      assert.equal(launches, 1);
      assert.equal(await readFile(commands, "utf8"), "install\nbuild\ninstall\nbuild\n");
      const runs = (await readFile(starts, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { pid: number; data: string });
      assert.equal(new Set(runs.map(run => run.pid)).size, 3);
      assert.equal(new Set(runs.map(run => run.data)).size, 3);
      await third.close(); await second.close();
      assert.equal(browser!.contexts().length, 0);
      assert.equal(browser!.isConnected(), true, "the job retains its browser until release");
      await assert.rejects(adapter.prepare({ ...job, moduleEpoch: 2 }, signal), /job identity changed/);
    } finally { await adapter.releaseJob(job); }
    assert.equal(browser!.isConnected(), false);
    assert.deepEqual(await readdir(workspace), []);
    const nextJob = { ...job, jobId: "next-job" };
    try {
      const next = await adapter.prepare(nextJob, signal);
      const nextBuild = (await identity(next)).candidate.buildId;
      assert.notEqual(nextBuild, originalBuild!);
      assert.equal(launches, 2, "jobs do not share retained resources");
      await next.close();
      const [directory] = await readdir(workspace);
      assert.match(directory!, /^w[0-9a-f]{12}$/, "worker names stay short for Windows path budgets");
      await writeFile(join(workspace, directory!, "candidate", "app", "built.txt"), "tampered");
      const rebuilt = await adapter.prepare(nextJob, signal);
      assert.notEqual((await identity(rebuilt)).candidate.buildId, nextBuild, "a modified artifact cannot reuse its build identity");
      assert.equal(await readFile(commands, "utf8"), "install\nbuild\ninstall\nbuild\ninstall\nbuild\nbuild\n");
      await rebuilt.close();
    } finally { await adapter.releaseJob(nextJob); }
    assert.deepEqual(await readdir(workspace), []);
    const cancelledJob = { ...job, jobId: "cancelled-job" };
    abortOnLaunch = new AbortController();
    try { await assert.rejects(adapter.prepare(cancelledJob, abortOnLaunch.signal)); }
    finally { await adapter.releaseJob(cancelledJob); }
    assert.equal(browser!.isConnected(), false);
    assert.deepEqual(await readdir(workspace), []);
  });
});

test("Web adapter binds schemas, fixed inputs, independent case data and full assertion receipts", async () => {
  await withTempDir("verifier-web-adapter-", async (root) => {
    const source = join(root, "source"), workspace = join(root, "workers");
    await mkdir(join(source, "data"), { recursive: true });
    const spec: ProjectSpec = { start: { executable: process.execPath, args: ["server.cjs"] }, dataPaths: ["data"], generatedPaths: ["data"], dataEnvVar: "APP_DATA_DIR" };
    await writeFile(join(source, "shallowcode.config.json"), JSON.stringify(spec));
    await writeFile(join(source, "data/state.txt"), "original");
    await writeFile(join(source, "server.cjs"), `const fs=require('node:fs'),path=require('node:path');const file=path.join(process.env.APP_DATA_DIR,'state.txt');
      if(!fs.existsSync(file))fs.writeFileSync(file,'empty');
      require('node:http').createServer((req,res)=>{if(req.url==='/image'){res.writeHead(200,{'content-type':'image/png','content-disposition':'attachment; filename="image.png"'});res.end(Buffer.from('${fileFixture({ kind: "png", bytes: 128 }).buffer.toString("base64")}','base64'));return;}
      if(req.url.startsWith('/change')){fs.writeFileSync(file,'changed');res.writeHead(302,{location:'/'});res.end();return;}
      res.setHeader('content-type',req.url==='/health'?'text/plain':'text/html');res.end(req.url==='/health'?'ok':'<main><output role="status">'+fs.readFileSync(file,'utf8')+'</output><form action="/change"><button>Change</button></form><a href="/image" download>Download image</a></main>');}).listen(Number(process.env.PORT),'127.0.0.1');`);
    const artifacts = new ArtifactStore(join(root, "artifacts"), "run");
    const snapshots = new SnapshotStore(join(root, "snapshots"));
    const baseline = await snapshots.seal({ sourceDirectory: source, sourceSha: "sha-baseline", packetId: "baseline", dataPaths: ["data"] });
    await writeFile(join(source, "data/state.txt"), "snapshot-later");
    const snapshot = await snapshots.seal({ sourceDirectory: source, sourceSha: "sha-original", packetId: "packet", dataPaths: ["data"] });
    let launches = 0;
    const { adapter, declaration, initialState } = await createWebExecutionAdapter({ artifacts, snapshots, workspace, spec, initialDataSnapshot: baseline.ref,
      launchBrowser: async () => { launches++; return chromium.launch({ headless: true }); } });
    const declarationPrompts = await Promise.all(declaration.prompts.map(ref => artifacts.getBytes(ref).then(bytes => bytes.toString("utf8"))));
    assert.match(declarationPrompts[0]!, /^你在隔离解释器中执行普通 JavaScript 异步函数体/);
    assert.match(declarationPrompts[1]!, /^Authorized Playwright interface/);
    assert.match(declarationPrompts[1]!, /"filechooser"/);
    assert.match(declarationPrompts[1]!, /"touchscreen"/);
    assert.match(declarationPrompts[1]!, /"emulateMedia"/);
    assert.match(declarationPrompts[1]!, /"selectText"/);
    assert.match(declarationPrompts[1]!, /"domcontentloaded"/);
    assert.match(declarationPrompts[1]!, /"hasTouch"/);
    assert.match(declarationPrompts[2]!, /^Web public entry: \/$/);
    assert.deepEqual(declaration.initialStates, [initialState]);
    assert.deepEqual(await artifacts.readTypedJson(initialState), { baseline: baseline.ref });
    const job: CheckJob = { jobId: "job", runId: "run", moduleId: "module", packetId: "packet", attempt: 1, moduleEpoch: 1,
      snapshot: snapshot.ref, requirements: await artifacts.putJson({ requirements: [] }), binding: adapter.binding, initialState,
      requirementIds: ["r"], mode: "replay", programs: [], timeoutMs: 90_000 };
    const contract = await artifacts.putJson({ clauses: [{ id: "r:result", requirementId: "r", scenarioId: "s", checkpointId: "result", expected: { operator: "equal", value: "changed" } }], checkpoints: [
      { id: "initial", kind: "precondition", expected: { operator: "equal", value: "original" } }, { id: "change", kind: "action" }, { id: "result", kind: "assertion" },
    ] });
    const programSource = `const p=await browser.actor('alice');const before=await p.getByRole('status').innerText();await check.precondition('initial',[before.id]);await check.action('change',()=>p.getByRole('button',{name:'Change',exact:true}).click());const after=await p.getByRole('status').innerText();await check.expect('r:result',[after.id]);`;
    const descriptor = await artifacts.putTypedJson({ source: await artifacts.putBytes(programSource), initialState, clauses: [{ clauseId: "r:result", checkpointId: "result" }] }, declaration.programFormat.schema);
    const program: ProgramRef = { descriptor, format: WEB_PROGRAM_FORMAT, contract, binding: adapter.binding };
    // Builder changes after sealing do not affect execution or its input baseline.
    await writeFile(join(source, "data/state.txt"), "builder-later");
    const session = await adapter.prepare(job, new AbortController().signal);
    const firstEnvironment = session.execution;
    try {
      assert.equal(launches, 1);
      const receiptRefs = await session.replay(program, new AbortController().signal);
      const receipts = await Promise.all(receiptRefs.map((ref) => artifacts.getJson<EvidenceReceipt>(ref)));
      assert.equal(receipts.find((receipt) => receipt.kind === "assertion")?.assertion?.result, "satisfied");
      assert.ok(receipts.some((receipt) => receipt.kind === "precondition"));
      assert.ok(receipts.some((receipt) => receipt.kind === "action" && receipt.checkpointId === "change"));
      assert.ok(receipts.filter((receipt) => receipt.kind === "observation").length >= 2);
      assert.equal(session.execution.digest, firstEnvironment.digest, "first replay uses the freshly prepared case");
      assert.equal(launches, 1, "first replay does not rebuild its prepared environment");
      const repeatedRefs = await session.replay(program, new AbortController().signal);
      assert.notEqual(session.execution.digest, firstEnvironment.digest, "a used case must reset before another replay");
      assert.equal(launches, 1, "reset retains the job browser and creates new contexts");
      const repeatedReceipts = await Promise.all(repeatedRefs.map(ref => artifacts.getJson<EvidenceReceipt>(ref)));
      assert.equal((await artifacts.readTypedJson<{ result: string }>(repeatedReceipts.find(receipt => receipt.kind === "precondition")!.payload)).result, "satisfied");
      assert.equal(repeatedReceipts
        .find(receipt => receipt.kind === "assertion")?.assertion?.result, "satisfied", "repeated replay restores the original data");
      const observed = await session.invoke("inspect", { actor: "alice" }, new AbortController().signal);
      assert.match(JSON.stringify(await artifacts.readTypedJson(observed.output)), /changed/);
      await session.invoke("reset_case", {}, new AbortController().signal);
      const reset = await session.invoke("inspect", { actor: "alice" }, new AbortController().signal);
      assert.match(JSON.stringify(await artifacts.readTypedJson(reset.output)), /original/);
      const formal = await session.invoke("run", { program }, new AbortController().signal);
      const formalReceipts = await Promise.all(formal.receipts.map((ref) => artifacts.getJson<EvidenceReceipt>(ref)));
      assert.equal(formalReceipts.find((receipt) => receipt.kind === "assertion")?.assertion?.result, "satisfied");
      await assert.rejects(session.invoke("run", {}, new AbortController().signal), /schema/);
      await assert.rejects(session.invoke("run", { source: "return true", program }, new AbortController().signal), /differs from the bound program/);
      await assert.rejects(session.invoke("evaluate", {}, new AbortController().signal), /Unknown Web capability/);
      const failedContract = await artifacts.putJson({ clauses: [{ id: "r:result", checkpointId: "result", expected: { operator: "equal", value: "deliberately absent expected result" } }], checkpoints: [
        { id: "initial", kind: "precondition", expected: { operator: "equal", value: "original" } }, { id: "change", kind: "action" }, { id: "result", kind: "assertion" },
      ] });
      const failedRefs = await session.replay({ ...program, contract: failedContract }, new AbortController().signal);
      assert.equal(launches, 1, "explicit reset and replay retain the job browser");
      const failedReceipts = await Promise.all(failedRefs.map((ref) => artifacts.getJson<EvidenceReceipt>(ref)));
      assert.equal(failedReceipts.find((receipt) => receipt.kind === "assertion")?.assertion?.result, "violated");
      const attachments = failedReceipts.flatMap((receipt) => receipt.attachments);
      assert.ok(attachments.some((attachment) => attachment.mediaType === "image/png"));
      assert.ok(attachments.some((attachment) => attachment.mediaType === "application/zip"));
      for (const attachment of attachments) assert.ok((await artifacts.getBytes(attachment)).length > 0);
      assert.equal(await readFile(join(snapshot.sourceDirectory, "data/state.txt"), "utf8"), "snapshot-later");
      assert.equal(await readFile(join(baseline.sourceDirectory, "data/state.txt"), "utf8"), "original");
      assert.equal(await readFile(join(source, "data/state.txt"), "utf8"), "builder-later");
    } finally { try { await session.close(); } finally { await adapter.releaseJob(job); } }
    await assert.rejects(session.replay(program, new AbortController().signal), /closed/);
    const beforeDelivery = launches;
    const deliveryReceipts = await adapter.verifyDelivery({ ...job, jobId: "delivery", mode: "prepare" }, new AbortController().signal);
    assert.equal(launches, beforeDelivery + 1, "delivery uses one prepared browser environment");
    for (const ref of deliveryReceipts) await artifacts.validateReceipt({ ...job, jobId: "delivery", mode: "prepare" }, await artifacts.getJson<EvidenceReceipt>(ref));
    const mediaJob = { ...job, jobId: "media" };
    const media = await adapter.prepare(mediaJob, new AbortController().signal);
    try {
      const result = await media.invoke("run", { source: `const p=await browser.actor('alice');const filePending=p.waitForEvent('download');await p.getByRole('link',{name:'Download image',exact:true}).click();const file=await (await filePending).read('base64');return await p.render(file.id,{samples:[{x:0,y:0}]});` }, new AbortController().signal);
      const receipts = await Promise.all(result.receipts.map(ref => artifacts.getJson<EvidenceReceipt>(ref)));
      for (const receipt of receipts) await artifacts.validateReceipt(mediaJob, receipt);
      const rendered = receipts.find(receipt => receipt.kind === "observation" && receipt.attachments.length)!;
      const payload = await artifacts.readTypedJson<{ value: { samples: Array<{ rgba: number[] }> } }>(rendered.payload);
      assert.deepEqual(payload.value.samples[0]!.rgba, [51, 102, 153, 255]);
      assert.equal(rendered.attachments[0]!.mediaType, "image/png");
      assert((await artifacts.getBytes(rendered.attachments[0]!)).length > 20);
      const input = await artifacts.getJson<EvidenceReceipt>(rendered.inputs[0]!);
      assert.equal((await artifacts.readTypedJson<{ kind: string }>(input.payload)).kind, "download", "rendered evidence links to the actual download receipt");
    } finally { try { await media.close(); } finally { await adapter.releaseJob(mediaJob); } }
    assert.deepEqual(await readdir(workspace), []);
    const emptyInput = join(root, "empty-input");
    await mkdir(emptyInput);
    const emptyBaseline = await snapshots.seal({ sourceDirectory: emptyInput, sourceSha: "sha-empty-input", packetId: "empty-input", dataPaths: ["data"] });
    const fresh = await createWebExecutionAdapter({ artifacts, snapshots, workspace, spec, initialDataSnapshot: emptyBaseline.ref });
    assert.deepEqual(await artifacts.readTypedJson(fresh.initialState), { baseline: emptyBaseline.ref });
    const freshJob = { ...job, jobId: "fresh-job", binding: fresh.adapter.binding, initialState: fresh.initialState };
    const freshSession = await fresh.adapter.prepare(freshJob, new AbortController().signal);
    try {
      const initial = await freshSession.invoke("inspect", { actor: "alice" }, new AbortController().signal);
      assert.match(JSON.stringify(await artifacts.readTypedJson(initial.output)), /empty/);
      await freshSession.invoke("run", { source: "const p=await browser.actor('alice');await p.getByRole('button',{name:'Change',exact:true}).click();" }, new AbortController().signal);
      const changed = await freshSession.invoke("inspect", { actor: "alice" }, new AbortController().signal);
      assert.match(JSON.stringify(await artifacts.readTypedJson(changed.output)), /changed/);
      await freshSession.invoke("reset_case", {}, new AbortController().signal);
      const reset = await freshSession.invoke("inspect", { actor: "alice" }, new AbortController().signal);
      assert.match(JSON.stringify(await artifacts.readTypedJson(reset.output)), /empty/);
      await assert.rejects(readFile(join(emptyBaseline.sourceDirectory, "data/state.txt")), { code: "ENOENT" });
      assert.equal(await readFile(join(snapshot.sourceDirectory, "data/state.txt"), "utf8"), "snapshot-later");
    } finally { try { await freshSession.close(); } finally { await fresh.adapter.releaseJob(freshJob); } }
    assert.deepEqual(await readdir(workspace), []);
    const broken = await createWebExecutionAdapter({ artifacts, snapshots, workspace, spec, initialDataSnapshot: emptyBaseline.ref,
      lifecycle: { start: async () => { throw new Error("actual-startup-diagnostic"); } } });
    assert.deepEqual(broken.declaration.initialStates, [broken.initialState]);
    assert.deepEqual(await artifacts.readTypedJson(broken.initialState), { baseline: emptyBaseline.ref });
    try { await broken.adapter.prepare({ ...job, binding: broken.adapter.binding, initialState: broken.initialState }, new AbortController().signal); assert.fail("prepare should fail"); }
    catch (error) {
      assert.match(String(error), /actual-startup-diagnostic/);
      const refs = (error as { diagnosticRefs: Array<{ id: string; digest: string }> }).diagnosticRefs;
      assert.ok(refs.length > 0);
      assert.equal((await artifacts.getJson<EvidenceReceipt>(refs[0]!)).readiness?.result, "inconclusive");
    }
    await broken.adapter.releaseJob(job);
    assert.deepEqual(await readdir(workspace), []);
    await assert.rejects(adapter.prepare({ ...job, binding: { ...job.binding, executor: { ...job.binding.executor, version: "forged" } } }, new AbortController().signal), /binding mismatch/);
    const { declaration: fixed } = await createWebExecutionAdapter({ artifacts, snapshots, workspace, initialDataSnapshot: baseline.ref,
      spec: { ...spec, adapterConfig: { extraPorts: [3001] } } });
    assert.deepEqual(fixed.resourceKeys, []);
  });
});
