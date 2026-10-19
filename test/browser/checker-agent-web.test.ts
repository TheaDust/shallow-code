import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createCheckerAgent } from "../../src/checker/agent.js";
import { ArtifactStore } from "../../src/checker/artifacts.js";
import { createWebExecutionAdapter } from "../../src/checker/adapters/web/index.js";
import { checkerSourceClauses, type AcceptanceContract, type CheckerManifest, type CheckerRequirements } from "../../src/checker/evidence.js";
import type { CheckerModel } from "../../src/checker/model.js";
import type { CheckJob, EvidenceReceipt } from "../../src/checker/port.js";
import type { ProjectSpec } from "../../src/project-spec.js";
import { SnapshotStore } from "../../src/snapshot-store.js";
import type { AtomicRequirement } from "../../src/types.js";
import { withTempDir } from "../helpers/temp-dir.js";

// A scripted model fixes the intended interpretation; actual adapter/browser execution supplies every receipt.
for (const mutant of [false, true]) test(`Checker Agent full Web exploration/review/replay ${mutant ? "reproduces seat defect" : "passes correct cross-actor persistence"}`, async () => {
  await withTempDir("checker-agent-web-", async root => {
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
    const input: CheckerRequirements = { requirements: [requirement], implementedRequirementIds: ["r1"] };
    const job: CheckJob = { jobId: "job", runId: "run", moduleId: "module", packetId: "packet", attempt: 1, moduleEpoch: 1,
      snapshot: snapshot.ref, requirements: await artifacts.putJson(input), binding: adapter.binding, initialState,
      requirementIds: ["r1"], mode: "discover", programs: [], budget: { deadlineAt: Date.now() + 180_000 } };
    const clauses = checkerSourceClauses(input, job.requirementIds);
    assert.equal(clauses.length, 3);
    const roles: string[] = [];
    const model: CheckerModel = { async run(request) {
      roles.push(request.role);
      const invoke = (name: string, args: unknown) => request.tools.find(tool => tool.name === name)!.execute(args);
      if (request.role === "semantic_review") {
        const evidence = JSON.parse(request.prompt) as { receipts: Array<{ receipt: EvidenceReceipt; payload: unknown }> };
        assert(evidence.receipts.some(item => item.receipt.kind === "observation" && JSON.stringify(item.payload).includes("cancelled")));
        await invoke("finish", { approved: true, reasons: [], clauseIds: clauses.map(clause => clause.id) });
      } else {
        const observed = await invoke("invoke", { capabilityId: "inspect", input: { actor: "alice" } });
        assert.match(JSON.stringify(observed), /unpaid/);
        await invoke("invoke", { capabilityId: "run", input: { source: "const p=await browser.actor('bob');const o=await p.read({role:'status',name:'Train T-6 seats'});return o.value;" } });
        const contract: AcceptanceContract = { requirements: job.requirements,
          checkpoints: [{ id: "given", kind: "precondition", requirementId: "r1", scenarioId: "cancel", dependsOn: [], basis: "Order O-17 is unpaid", expected: { operator: "equal", value: "unpaid" } },
            { id: "when", kind: "action", requirementId: "r1", scenarioId: "cancel", dependsOn: ["given"], basis: "Alice clicks button Cancel O-17" },
            ...clauses.map((clause, index) => ({ id: `result-${index}`, kind: "assertion" as const, requirementId: "r1", scenarioId: "cancel", clauseId: clause.id, basis: clause.basis, dependsOn: ["when"] }))],
          clauses: clauses.map((clause, index) => ({ ...clause, checkpointId: `result-${index}`, expected: { operator: "equal", value: index === 1 ? "5" : "cancelled" } })) };
        const contractRef = await invoke("save_artifact", { kind: "contract", contract });
        const programSource = `const alice=await browser.actor('alice');const bob=await browser.actor('bob');
          const before=await alice.read({role:'status',name:'Order O-17'});await check.precondition('given',[before.id]);
          await alice.click({role:'button',name:'Cancel O-17'},'when');await bob.reload();
          const order=await bob.read({role:'status',name:'Order O-17'});await check.expect('${clauses[0]!.id}',[order.id]);
          const seats=await bob.read({role:'status',name:'Train T-6 seats'});await check.expect('${clauses[1]!.id}',[seats.id]);
          await alice.reload();const persisted=await alice.read({role:'status',name:'Order O-17'});await check.expect('${clauses[2]!.id}',[persisted.id]);`;
        const program = await invoke("save_artifact", { kind: "program", contract: contractRef, source: programSource,
          clauses: contract.clauses.map(clause => ({ clauseId: clause.id, checkpointId: clause.checkpointId })) });
        await invoke("finish", { programs: [program] });
      }
      return { totalTokens: 100 };
    } };
    const report = await createCheckerAgent({ artifacts, adapter, model }).check(job, new AbortController().signal);
    const manifest = await artifacts.getJson<CheckerManifest>(report.manifest);
    assert.deepEqual(manifest.diagnostics, []);
    assert.deepEqual(report.outcomes.map(outcome => outcome.status), mutant ? ["pass", "fail", "pass"] : ["pass", "pass", "pass"]);
    if (mutant) assert.match(report.outcomes[1]!.reason!, /independent fresh environment/);
    assert.deepEqual(roles, ["exploration", "semantic_review"]);
    assert.equal(manifest.reviews.length, 1);
    assert.deepEqual(await readdir(workspace), []);
  });
});
