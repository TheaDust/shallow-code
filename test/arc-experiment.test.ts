import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import type { JSONReport } from "@playwright/test/reporter";
import { createPlan, parseExperimentArgs, runExperiment, writeSummary } from "../src/experiments/arc-experiment.js";
import { csv, planCells, reportEntries, scoreReport, summarize, type CellResult, type ExperimentPlan } from "../src/experiments/protocol.js";
import { normalizeArcRequirements } from "../src/experiments/requirements.js";
import type { ProcessRequest } from "../src/experiments/process.js";
import type { WorkerRequest } from "../src/experiments/worker.js";
import { withTempDir } from "./helpers/temp-dir.js";

const env = { MODEL: "fixture", OPENAI_BASE_URL: "https://fixture.invalid", OPENAI_API_KEY: "private-credential" };
const source = JSON.stringify({ id: "ROOT", name: "Fixture", description: { text: "Original root wording." }, scenarios: [], children: [
  { id: "REQ-1", name: "First", description: { text: "Original {{literal}} wording.", image: [{ id: "IMG-1", reference: "reference/a.png", page: "home" }] },
    scenarios: [{ id: "SCN-1", name: "First scenario", steps: [{ id: "STEP-1", Given: "Initial state.", When: "Click A.", Then: "A and B are visible.",
      references: ["\\ref[requirement](REQ-2)", "\\ref[image](IMG-1)"] }] }], children: [] },
  { id: "REQ-2", name: "Second", description: { text: "Second behavior." }, scenarios: [], children: [] },
] });

function report(statuses: string[]): JSONReport {
  return { suites: [{ title: "suite", file: "fixture.spec.ts", specs: statuses.map((status, index) => ({
    title: `case-${index}`, file: "fixture.spec.ts", line: index + 1, column: 1, tests: [{ projectName: "chromium",
      results: status === "not_run" ? [] : [{ status }], expectedStatus: "passed", status: "expected" }],
  })) }], errors: [] } as unknown as JSONReport;
}

async function fixture(root: string): Promise<ExperimentPlan> {
  const bench = join(root, "bench"), task = join(bench, "arc-bench", "fixture");
  await mkdir(join(task, "requirements", "reference"), { recursive: true }); await mkdir(join(task, "tests"));
  await writeFile(join(task, "requirements", "requirements.yaml"), source);
  await writeFile(join(task, "requirements", "reference", "a.png"), "reference bytes");
  await writeFile(join(task, "tests", "fixture.spec.ts"), "// private evaluator tests\n");
  await writeFile(join(bench, "setup-playwright.cjs"), "// fixture setup\n");
  return createPlan(parseExperimentArgs(["run", "--bench-root", bench, "--repeats", "1", "--output-dir", join(root, "out")]), env);
}

function fakeProcess(calls: WorkerRequest[]) {
  return async (request: ProcessRequest) => {
    const input = request.message as WorkerRequest;
    assert.equal(request.timeoutMs, input.timeoutMs, "the worker and its subprocess share the optional wall limit");
    calls.push(input);
    if (input.action === "catalog") {
      assert.equal(request.env.OPENAI_API_KEY, undefined);
      await mkdir(input.directory, { recursive: true });
      await writeFile(join(input.directory, "catalog.json"), JSON.stringify(reportEntries(report(["not_run", "not_run"]))));
    } else if (input.action === "generate") {
      assert.equal("task" in input, false); assert.equal("testsDir" in input, false);
      assert.equal(request.env.OPENAI_API_KEY, "private-credential");
      const normalized = parse(await readFile(join(input.requirementsDir, "requirements.yaml"), "utf8"));
      assert.equal(normalized.children[0].type, "ATOMIC");
      assert.equal(normalized.children[0].scenarios[0].steps[2].content, "A and B are visible.");
      await writeFile(join(input.projectDir, "app.txt"), "generated application");
      const runs = join(input.privateDir, "runs", "fixture"); await mkdir(runs, { recursive: true });
      await writeFile(join(runs, "result.json"), JSON.stringify({ status: input.method === "shallow" ? "delivered" : "completed",
        modelUsage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, cost: 0.01 } }));
    } else {
      await assert.rejects(readFile(join(input.projectDir!, "tests", "fixture.spec.ts")), /ENOENT/);
      await mkdir(input.directory, { recursive: true });
      await writeFile(join(input.directory, "evaluation.json"), JSON.stringify({ status: "completed", durationMs: 5,
        directory: input.directory, score: scoreReport(input.catalog!, report(["passed", "failed"])) }));
    }
    return { exitCode: 0, timedOut: false, durationMs: 12 };
  };
}

test("ARC conversion preserves source outcomes, identities, image links and step references", () => {
  const normalized = normalizeArcRequirements(source), tree = parse(normalized.yaml);
  assert.equal(normalized.requirements, 2); assert.equal(normalized.scenarios, 1);
  assert.equal(tree.type, "ROOT"); assert.equal(tree.children[0].type, "ATOMIC");
  assert.match(tree.children[0].description, /Original \{\{literal\}\} wording/);
  assert.match(tree.children[0].description, /IMG-1; page=home/);
  assert.match(tree.children[0].description, /Source step references/);
  assert.deepEqual(tree.children[0].visual_reference, ["reference/a.png"]);
  assert.deepEqual(tree.children[0].dependencies, []);
  assert.deepEqual(tree.children[0].scenarios[0].steps, [
    { keyword: "GIVEN", content: "Initial state." }, { keyword: "WHEN", content: "Click A." },
    { keyword: "THEN", content: "A and B are visible." },
  ]);
  assert.equal(normalizeArcRequirements(normalized.yaml).yaml, normalized.yaml);
  const invalid = parse(source); invalid.children[0].scenarios[0].steps[0].Unknown = "unhandled";
  assert.throws(() => normalizeArcRequirements(JSON.stringify(invalid)), /Unsupported ARC step field/);
});

test("experimental scoring includes failed, skipped, interrupted and unexecuted tests in its denominator", () => {
  const catalog = reportEntries(report(["not_run", "not_run", "not_run", "not_run", "not_run"]));
  const score = scoreReport(catalog, report(["passed", "failed", "skipped", "interrupted"]));
  assert.deepEqual(score, { total: 5, passed: 1, failed: 1, skipped: 1, notRun: 2, passRate: 0.2, errors: [] });
  assert.equal(scoreReport(catalog).passRate, 0);
  assert.throws(() => scoreReport(catalog, report(["passed", "passed", "passed", "passed", "passed", "passed"])), /identities differ/);
  assert.throws(() => scoreReport([]), /empty test catalog/);
});

test("experiment CLI validates tasks and limits and alternates paired method order", () => {
  const defaults = parseExperimentArgs(["run"]);
  assert.equal(defaults.generationTimeoutMs, null);
  assert.equal(defaults.evaluationTimeoutMs, null);
  const explicit = parseExperimentArgs(["run", "--generation-timeout-ms", "60000", "--evaluation-timeout-ms", "30000"]);
  assert.equal(explicit.generationTimeoutMs, 60000);
  assert.equal(explicit.evaluationTimeoutMs, 30000);
  assert.deepEqual(planCells(["a", "b"], 2).map(cell => cell.method), ["baseline", "shallow", "shallow", "baseline", "shallow", "baseline", "baseline", "shallow"]);
  for (const args of [["run", "--tasks", "../keep"], ["run", "--tasks", "keep,keep"], ["run", "--repeats", "0"],
    ["run", "--generation-timeout-ms", "NaN"], ["run", "--generation-timeout-ms", "0"],
    ["run", "--evaluation-timeout-ms", "-1"], ["run", "--repeats", "1", "--repeats", "2"]]) {
    assert.throws(() => parseExperimentArgs(args));
  }
});

test("experiment runs two independent workspaces, preserves inputs and resumes without rerunning finalized cells", async () => {
  await withTempDir("shallow-arc-experiment-", async root => {
    const plan = await fixture(root), output = join(root, "out"), calls: WorkerRequest[] = [];
    assert.doesNotMatch(JSON.stringify(plan), /private-credential/);
    assert.equal(plan.generationTimeoutMs, null); assert.equal(plan.evaluationTimeoutMs, null);
    const result = await runExperiment(plan, output, env, false, { runProcess: fakeProcess(calls) });
    assert.equal(calls.length, 5);
    assert(calls.every(call => call.timeoutMs === null));
    const manifest = JSON.parse(await readFile(join(output, "experiment.json"), "utf8"));
    assert.equal(manifest.generationTimeoutMs, null); assert.equal(manifest.evaluationTimeoutMs, null);
    assert.deepEqual(result.byMethod.map(row => row.macroPassRate), [0.5, 0.5]);
    assert.equal(await readFile(join(plan.tasks[0].requirementsDir, "requirements.yaml"), "utf8"), source);
    assert.equal(await readFile(join(plan.tasks[0].testsDir, "fixture.spec.ts"), "utf8"), "// private evaluator tests\n");
    assert.equal(result.cells[0].generation.modelUsage?.total, 15);
    await runExperiment(plan, output, env, true, { runProcess: fakeProcess(calls) });
    assert.equal(calls.length, 5);
    await assert.rejects(runExperiment({ ...plan, generationTimeoutMs: 1 }, output, env, true), /settings changed/);
    await assert.rejects(runExperiment(plan, output, env, false), /already exists/);
    assert.match(await readFile(join(output, "runs.csv"), "utf8"), /baseline/);
    assert.equal((await writeSummary(output, plan)).cells.length, 2);
  });
});

test("prepare enumerates tests without running a generator; resume retains an interrupted attempt", async () => {
  await withTempDir("shallow-arc-resume-", async root => {
    const plan = await fixture(root), output = join(root, "out"), calls: WorkerRequest[] = [];
    const prepared = await runExperiment(plan, output, env, false, { runProcess: fakeProcess(calls), prepareOnly: true });
    assert.deepEqual(calls.map(call => call.action), ["catalog"]);
    assert.equal(prepared.byMethod[0].macroPassRate, null);
    const baseline = join(output, "fixture", "repeat-1", "baseline");
    await mkdir(baseline, { recursive: true }); await writeFile(join(baseline, "started.json"), "{}");
    const result = await runExperiment(plan, output, env, true, { runProcess: fakeProcess(calls) });
    assert.equal(calls.filter(call => call.action === "generate").length, 1);
    const interrupted = result.cells.find(cell => cell.method === "baseline")!;
    assert.equal(interrupted.generation.status, "interrupted");
    assert.equal(interrupted.generation.modelUsage, null); assert.equal(interrupted.generation.durationMs, null);
    assert.equal(result.byMethod[0].generationFailures, 1);
    assert.equal(result.byMethod[0].missingOrPartialUsage, 1);
  });
});

test("a generation wall timeout still evaluates the retained final program and is included in summaries", async () => {
  await withTempDir("shallow-arc-timeout-", async root => {
    const plan = { ...await fixture(root), generationTimeoutMs: 1000 }, output = join(root, "out"), calls: WorkerRequest[] = [];
    const run = fakeProcess(calls);
    const result = await runExperiment(plan, output, env, false, { runProcess: async request => {
      const response = await run(request);
      return (request.message as WorkerRequest).action === "generate" ? { ...response, exitCode: null, timedOut: true } : response;
    } });
    assert.equal(result.cells.length, 2);
    assert.ok(result.cells.every(cell => cell.generation.status === "timed_out" && !cell.generation.usageComplete));
    assert.equal(result.byMethod[0].generationFailures, 1);
  });
});

test("macro summaries weight applications equally and do not publish an incomplete headline", () => {
  const plan = { tasks: [{ id: "a" }, { id: "b" }], repeats: 1 } as ExperimentPlan;
  const row = (task: string, total: number, passed: number) => ({ task, repeat: 1, method: "baseline", generation: {
    status: "completed", durationMs: 1, modelUsage: null, usageComplete: false }, evaluation: {
    status: "completed", score: { total, passed, passRate: passed / total } } }) as CellResult;
  assert.equal(summarize(plan, [row("a", 1, 1)]).byMethod[0].macroPassRate, null);
  assert.equal(summarize(plan, [row("a", 1, 1), row("b", 100, 0)]).byMethod[0].macroPassRate, 0.5);
  assert.match(csv([{ name: 'a,"b', score: null }]), /"a,""b"/);
});
