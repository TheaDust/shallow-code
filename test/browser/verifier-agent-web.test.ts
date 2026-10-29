import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createVerifierAgent } from "../../src/verifier/agent.js";
import { ArtifactStore } from "../../src/verifier/artifacts.js";
import { createWebExecutionAdapter } from "../../src/verifier/adapters/web/index.js";
import { verifierSourceClauses, type AcceptanceContract, type VerifierManifest, type VerifierRequirements } from "../../src/verifier/evidence.js";
import type { VerifierModel } from "../../src/verifier/model.js";
import type { CheckJob, EvidenceReceipt, ExecutionBindingRef } from "../../src/verifier/port.js";
import type { ProjectSpec } from "../../src/project-spec.js";
import { SnapshotStore } from "../../src/snapshot-store.js";
import { VerifierSourceIndex } from "../../src/verifier/source-index.js";
import { VerifierProgramCache } from "../../src/verifier/program-cache.js";
import { requirementDigest } from "../../src/requirement-progress.js";
import type { AtomicRequirement } from "../../src/types.js";
import { withTempDir } from "../helpers/temp-dir.js";

// A scripted model fixes the intended interpretation; actual adapter/browser execution supplies every receipt.
for (const semanticReview of [false, true]) for (const mutant of [false, true]) test(`Verifier Agent Web review=${semanticReview} ${mutant ? "reproduces seat defect" : "passes correct cross-actor persistence"}`, async () => {
  await withTempDir("verifier-agent-web-", async root => {
    const source = join(root, "source"), workspace = join(root, "workers");
    await mkdir(join(source, "data"), { recursive: true });
    const spec: ProjectSpec = { start: { executable: process.execPath, args: ["server.cjs"] }, dataPaths: ["data"], dataEnvVar: "APP_DATA_DIR" };
    await writeFile(join(source, "shallowcode.config.json"), JSON.stringify(spec));
    await writeFile(join(source, "data/state.json"), JSON.stringify({ order: "unpaid", seats: 4 }));
    await writeFile(join(source, "server.cjs"), `const fs=require('node:fs'),path=require('node:path');const file=path.join(process.env.APP_DATA_DIR,'state.json');
      if(!fs.existsSync(file))fs.writeFileSync(file,JSON.stringify({order:'unpaid',seats:4}));
      require('node:http').createServer((req,res)=>{if(req.url.startsWith('/cancel')){fs.writeFileSync(file,JSON.stringify({order:'cancelled',seats:${mutant ? 4 : 5}}));res.writeHead(302,{location:'/'});res.end();return;}
      const state=JSON.parse(fs.readFileSync(file,'utf8'));res.setHeader('content-type',req.url==='/health'?'text/plain':'text/html');res.end(req.url==='/health'?'ok':
      '<main><output role="status" aria-label="Order O-17">'+state.order+'</output><output role="status" aria-label="Train T-6 seats">'+state.seats+'</output><form action="/cancel"><button>Cancel O-17</button></form></main>');}).listen(Number(process.env.PORT),'127.0.0.1');`);
    const artifacts = new ArtifactStore(join(root, "artifacts"), "run");
    const snapshots = new SnapshotStore(join(root, "snapshots"));
    const snapshot = await snapshots.seal({ sourceDirectory: source, sourceSha: mutant ? "mutant" : "correct", packetId: "packet", dataPaths: ["data"] });
    const { adapter, initialState } = await createWebExecutionAdapter({ artifacts, snapshots, workspace, spec, initialDataSnapshot: snapshot.ref });
    const requirement: AtomicRequirement = { id: "r1", folderPath: [], declarationIndex: 0, name: "Cancel order", text: "Cancel order and release seats persistently.",
      dependencyIds: [], scenarios: [], scenarioContracts: [{ id: "cancel", name: "Cancel shared order", steps: [{ keyword: "GIVEN", content: "Order O-17 is unpaid" },
        { keyword: "WHEN", content: "Alice clicks button Cancel O-17" }, { keyword: "THEN", content: "Bob sees order O-17 cancelled and Train T-6 has 5 seats" },
        { keyword: "AND", content: "Refreshing Alice's view preserves the cancelled order" }] }], references: [], exactUiStrings: [], seedDeclarations: [], ancestors: [],
      product: { kind: "generic_web", rootId: "root", rootName: "root", description: "", seedData: [] } };
    const input: VerifierRequirements = { requirements: [requirement], implementedRequirementIds: ["r1"] };
    const job: CheckJob = { jobId: "job", runId: "run", moduleId: "module", packetId: "packet", attempt: 1, moduleEpoch: 1,
      snapshot: snapshot.ref, requirements: await artifacts.putJson(input), binding: adapter.binding, initialState,
      requirementIds: ["r1"], mode: "discover", programs: [], budget: { deadlineAt: Date.now() + 180_000 } };
    const clauses = verifierSourceClauses(input, job.requirementIds);
    const programCache = (store: ArtifactStore, binding: ExecutionBindingRef, baseline: typeof snapshot) => VerifierProgramCache.open({
      directory: join(root, "program-cache"), artifacts: store, binding,
      initialData: baseline.manifest.files.filter(file => file.path.startsWith("data/")),
      requirements: [requirement], requirementDigests: { r1: requirementDigest(requirement) },
    });
    assert.equal(clauses.length, 3);
    const roles: string[] = [];
    const model: VerifierModel = { async run(request) {
      roles.push(request.role);
      assert.match(request.systemPrompt, /通用 Web 应用/);
      assert.match(request.systemPrompt, /Authorized Playwright interface/);
      assert.match(request.systemPrompt, /Web 的二进制下载/);
      assert.match(request.systemPrompt, /Web rendered-content/);
      const invoke = (name: string, args: unknown) => request.tools.find(tool => tool.name === name)!.execute(args);
      if (request.role === "semantic_review") {
        assert.deepEqual(request.tools.map(tool => tool.name), ["finish"]);
        assert(!request.prompt.includes("require('node:http')"));
        const evidence = JSON.parse(request.prompt).programs[0] as { programId: string; receipts: Array<{ receipt: EvidenceReceipt; payload: unknown }> };
        assert(evidence.receipts.some(item => item.receipt.kind === "observation" && JSON.stringify(item.payload).includes("cancelled")));
        await invoke("finish", { reviews: [{ programId: evidence.programId, approved: true, reasons: [], clauseIds: clauses.map(clause => clause.id) }] });
      } else {
        assert.match(request.systemPrompt, /最终场景使用 check_program/);
        assert.match(request.systemPrompt, /独立干净 case 中运行/);
        const tree = await invoke("source_tree", { depth: 1 }) as { entries: Array<{ path: string; kind: string }> };
        assert(tree.entries.some(entry => entry.path === "server.cjs" && entry.kind === "file"));
        assert(!tree.entries.some(entry => entry.path === "data"));
        const matches = await invoke("source_search", { terms: ["/cancel"] }) as { matches: Array<{ fileId: string; path: string }> };
        const implementation = matches.matches.find(file => file.path === "server.cjs")!;
        assert(implementation);
        const excerpt = await invoke("source_read", { fileId: implementation.fileId, startLine: 1, lineCount: 10 }) as { content: string };
        assert.match(excerpt.content, /createServer/);
        const observed = await invoke("invoke", { capabilityId: "inspect", input: { actor: "alice" } });
        assert.match(JSON.stringify(observed), /unpaid/);
        await invoke("invoke", { capabilityId: "run", input: { source: "const p=await browser.actor('bob');const o=await p.getByRole('status',{name:'Train T-6 seats',exact:true}).innerText();return o.value;" } });
        // Dirty exploration state must never become the initial state of a submitted program.
        await invoke("invoke", { capabilityId: "run", input: { source: "const p=await browser.actor('alice');await p.getByRole('button',{name:'Cancel O-17',exact:true}).click();" } });
        const contract: AcceptanceContract = { requirements: job.requirements,
          checkpoints: [{ id: "given", kind: "precondition", requirementId: "r1", scenarioId: "cancel", dependsOn: [], basis: "Order O-17 is unpaid", expected: { operator: "equal", value: "unpaid" } },
            { id: "when", kind: "action", requirementId: "r1", scenarioId: "cancel", dependsOn: ["given"], basis: "Alice clicks button Cancel O-17" },
            ...clauses.map((clause, index) => ({ id: `result-${index}`, kind: "assertion" as const, requirementId: "r1", scenarioId: "cancel", clauseId: clause.id, basis: clause.basis, dependsOn: ["when"] }))],
          clauses: clauses.map((clause, index) => ({ ...clause, checkpointId: `result-${index}`, expected: { operator: "equal", value: index === 1 ? "5" : "cancelled" } })) };
        const programSource = `const alice=await browser.actor('alice');const bob=await browser.actor('bob');
          const before=await alice.getByRole('status',{name:'Order O-17',exact:true}).innerText();await check.precondition('given',[before.id]);
          await check.action('when',()=>alice.getByRole('button',{name:'Cancel O-17',exact:true}).click());await bob.reload();
          const order=await bob.getByRole('status',{name:'Order O-17',exact:true}).innerText();await check.expect('${clauses[0]!.id}',[order.id]);
          const seats=await bob.getByRole('status',{name:'Train T-6 seats',exact:true}).innerText();await check.expect('${clauses[1]!.id}',[seats.id]);
          await alice.reload();const persisted=await alice.getByRole('status',{name:'Order O-17',exact:true}).innerText();await check.expect('${clauses[2]!.id}',[persisted.id]);`;
        const preview = await invoke("check_program", { contract, source: programSource }) as {
          program: unknown;
          checks: Array<{ receipt: { digest: string }; kind: string; checkpointId: string; payload: { result: string; actual: unknown } }>;
        };
        const program = preview.program;
        assert.equal(preview.checks.length, 4, "exploration sees each GIVEN and result check before submission");
        assert.equal(preview.checks[0]!.payload.result, "satisfied");
        assert.deepEqual(preview.checks.slice(1).map(check => check.payload.result), mutant ? ["satisfied", "violated", "satisfied"] : ["satisfied", "satisfied", "satisfied"]);
        assert(preview.checks.every(check => check.receipt.digest.length === 64));
        assert.equal(preview.checks[0]!.payload.actual, undefined, "passed precondition values are not repeated to the model");
        assert.equal(preview.checks[1]!.payload.actual, undefined);
        if (mutant) assert.equal(preview.checks[2]!.payload.actual, "4", "small failure values remain exact");
        await invoke("finish", { programs: [program] });
      }
      return { totalTokens: 100 };
    } };
    const sourceIndex = new VerifierSourceIndex(snapshots, spec.dataPaths);
    const report = await createVerifierAgent({ semanticReview, artifacts, adapter, model, sourceIndex,
      programCache: await programCache(artifacts, adapter.binding, snapshot) }).check(job, new AbortController().signal);
    const manifest = await artifacts.getJson<VerifierManifest>(report.manifest);
    assert.deepEqual(manifest.diagnostics, []);
    assert.deepEqual(report.outcomes.map(outcome => outcome.status), mutant ? ["pass", "fail", "pass"] : ["pass", "pass", "pass"]);
    if (mutant) assert.match(report.outcomes[1]!.reason!, /independent fresh environment/);
    assert.deepEqual(roles, semanticReview ? ["exploration", "semantic_review"] : ["exploration"]);
    assert.equal(manifest.reviews.length, semanticReview ? 1 : 0);
    const receipts = await Promise.all(manifest.receipts.map(ref => artifacts.getJson<EvidenceReceipt>(ref)));
    const assertions = receipts.filter(receipt => receipt.kind === "assertion");
    assert.equal(assertions.length, clauses.length * (mutant ? 2 : 1), "the submitted clean execution is reused; only business failures get a second execution");
    assert.equal(new Set(assertions.map(receipt => receipt.environment.id)).size, mutant ? 2 : 1);

    assert.deepEqual(await readdir(workspace), []);
    if (!semanticReview && !mutant) for (const regression of [false, true]) {
      if (regression) {
        const server = join(source, "server.cjs");
        await writeFile(server, (await readFile(server, "utf8")).replace("seats:5", "seats:4"));
      }
      const runId = regression ? "regression-build" : "continued-build";
      const currentArtifacts = new ArtifactStore(join(root, runId), runId);
      const currentSnapshot = await snapshots.seal({ sourceDirectory: source, sourceSha: runId, packetId: "packet", dataPaths: ["data"] });
      const current = await createWebExecutionAdapter({ artifacts: currentArtifacts, snapshots, workspace: join(root, runId + "-workers"), spec,
        initialDataSnapshot: currentSnapshot.ref });
      let modelCalls = 0;
      const currentJob: CheckJob = { ...job, jobId: runId, runId, snapshot: currentSnapshot.ref, binding: current.adapter.binding,
        requirements: await currentArtifacts.putJson(input), initialState: current.initialState, programs: [], budget: { deadlineAt: Date.now() + 180_000 } };
      const repeated = await createVerifierAgent({ artifacts: currentArtifacts, adapter: current.adapter,
        model: { async run() { modelCalls++; throw new Error("Compatible cross-build programs must not start a model"); } },
        programCache: await programCache(currentArtifacts, current.adapter.binding, currentSnapshot) }).check(currentJob, new AbortController().signal);
      assert.equal(modelCalls, 0, runId);
      assert.deepEqual(repeated.outcomes.map(outcome => outcome.status), regression ? ["pass", "fail", "pass"] : ["pass", "pass", "pass"], runId);
      const currentManifest = await currentArtifacts.getJson<VerifierManifest>(repeated.manifest);
      for (const ref of currentManifest.receipts) await currentArtifacts.validateReceipt(currentJob, await currentArtifacts.getJson<EvidenceReceipt>(ref));
    }
  });
});
