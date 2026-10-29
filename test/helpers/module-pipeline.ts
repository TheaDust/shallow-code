import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runPipeline, type PipelineDeps, type PipelineOptions } from "../../src/pipeline.js";
import type { RunEvent } from "../../src/types.js";
import { FakeBuilder } from "../fakes/fake-builder.js";
import { FakeGitOps } from "../fakes/fake-git-ops.js";
import { withTempDir } from "./temp-dir.js";
import { GatewayRecovery } from "../../src/gateway-recovery.js";

export interface PipelineFixture {
  options: PipelineOptions; deps: PipelineDeps; builder: FakeBuilder; git: FakeGitOps;
  events(): Promise<RunEvent[]>; run(): ReturnType<typeof runPipeline>;
}
export async function withModulePipeline(callback: (fixture: PipelineFixture) => Promise<void>): Promise<void> {
  await withTempDir("shallow-module-pipeline-", async directory => {
    const atom = (id: string, dependencies: string[] = []) => ({ id, name: id, type: "ATOMIC", dependencies, description: "Display the main workspace." });
    const requirementsFile = join(directory, "requirements.yaml");
    await writeFile(requirementsFile, JSON.stringify({ id: "ROOT", name: "Product", type: "FOLDER", dependencies: [], children: [
      { id: "FIRST", name: "First", type: "FOLDER", dependencies: [], children: [atom("A"), atom("B", ["A"])] },
      { id: "SECOND", name: "Second", type: "FOLDER", dependencies: [], children: [atom("C", ["B"])] },
    ] }));
    const options: PipelineOptions = { requirementsFile, outputDir: join(directory, "output"), ledgerFile: join(directory, "logs", "ledger.jsonl"),
      totalBudgetMs: 60_000, verifier: { mode: "active", concurrency: 2 }, applicationContract: { adapterId: "fake", adapterConfig: {},
        installCommands: [], buildCommands: [], startCommand: { executable: "node", args: [], cwd: "output" }, buildTimeoutMs: 5_000, startTimeoutMs: 5_000 } };
    const builder = new FakeBuilder();
    const git = new FakeGitOps(["initial", "first", "second", "repair-one", "repair-two"]);
    let gatewayTime = 0;
    const deps: PipelineDeps = { builder, git, clock: { nowMs: () => 0 },
      gatewayRecovery: new GatewayRecovery({ now: () => gatewayTime, sleep: async ms => { gatewayTime += ms; } }),
      verifier: undefined as unknown as PipelineDeps["verifier"] };
    await callback({ options, deps, builder, git,
      events: async () => (await readFile(options.ledgerFile, "utf8")).trim().split("\n").map(line => JSON.parse(line)),
      run: () => runPipeline(options, deps) });
  });
}
