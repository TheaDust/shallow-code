import assert from "node:assert/strict";
import { cp, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import type { JSONReport } from "@playwright/test/reporter";
import { createPlan, experimentMain, parseExperimentArgs, runExperiment, writeSummary } from "../src/experiments/arc-experiment.js";
import { cacheHitRate, csv, planCells, reportEntries, REPOSITORY, scoreReport, summarize, summaryMarkdown,
  type CellResult, type ExperimentPlan } from "../src/experiments/protocol.js";
import { lockWorkspace } from "../src/run-record.js";
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

async function fixture(root: string, methods?: readonly string[]): Promise<ExperimentPlan> {
  const bench = join(root, "bench"), task = join(bench, "arc-bench", "fixture");
  await mkdir(join(task, "requirements", "reference"), { recursive: true }); await mkdir(join(task, "tests"));
  await writeFile(join(task, "requirements", "requirements.yaml"), source);
  await writeFile(join(task, "requirements", "reference", "a.png"), "reference bytes");
  await writeFile(join(task, "tests", "fixture.spec.ts"), "// private evaluator tests\n");
  await writeFile(join(bench, "setup-playwright.cjs"), "// fixture setup\n");
  return createPlan(parseExperimentArgs(["run", "--bench-root", bench, "--repeats", "1", "--output-dir", join(root, "out"),
    ...(methods ? ["--methods", methods.join(",")] : [])]), env);
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
      assert.equal(await readFile(join(input.requirementsDir, "reference", "a.png"), "utf8"), "reference bytes");
      assert.equal(await readFile(join(input.privateDir, "source-requirements", "requirements.yaml"), "utf8"), source);
      const mapping = JSON.parse(await readFile(join(input.privateDir, "source-requirements", "conversion-map.json"), "utf8"));
      assert.equal(mapping.steps[0].stepId, "STEP-1");
      assert.deepEqual(mapping.steps[0].normalizedStepIndices, [0, 1, 2]);
      await assert.rejects(readFile(join(input.requirementsDir, "conversion-map.json")), /ENOENT/);
      await writeFile(join(input.projectDir, "app.txt"), "generated application");
      const runs = join(input.privateDir, "runs", "fixture"); await mkdir(runs, { recursive: true });
      await writeFile(join(runs, "result.json"), JSON.stringify({ status: input.method === "shallow" ? "delivered" : "completed",
        modelUsage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, cost: 0.01 } }));
    } else {
      await assert.rejects(readFile(join(input.projectDir!, "tests", "fixture.spec.ts")), /ENOENT/);
      await mkdir(input.directory, { recursive: true });
      await writeFile(join(input.directory, "evaluation.json"), JSON.stringify({ status: "completed", durationMs: 5,
        directory: ".", score: scoreReport(input.catalog!, report(["passed", "failed"])) }));
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
  assert.throws(() => normalizeArcRequirements(JSON.stringify(invalid)), /Unsupported ARC .*step field/);
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
  assert.equal(defaults.benchRoot, resolve(REPOSITORY, "../arc-bench-ext"));
  assert.equal(defaults.outputDir, undefined);
  assert.equal(defaults.outputRoot, resolve("outputs"));
  assert.equal(defaults.concurrency, 1);
  assert.equal(defaults.generationTimeoutMs, null);
  assert.equal(defaults.evaluationTimeoutMs, null);
  assert.deepEqual(defaults.methods, ["baseline", "shallow"]);
  const explicit = parseExperimentArgs(["run", "--generation-timeout-ms", "60000", "--evaluation-timeout-ms", "30000",
    "--concurrency", "3", "--bench-root", "custom-bench", "--methods", "baseline"], "/work");
  assert.equal(explicit.benchRoot, resolve("/work", "custom-bench"));
  assert.equal(explicit.concurrency, 3);
  assert.equal(explicit.generationTimeoutMs, 60000);
  assert.equal(explicit.evaluationTimeoutMs, 30000);
  assert.deepEqual(explicit.methods, ["baseline"]);
  assert.deepEqual(planCells(["a", "b"], 2).map(cell => cell.method), ["baseline", "shallow", "shallow", "baseline", "shallow", "baseline", "baseline", "shallow"]);
  assert.deepEqual(planCells(["a", "b"], 2, ["baseline"]).map(cell => cell.method), ["baseline", "baseline", "baseline", "baseline"]);
  assert.deepEqual(planCells(["a"], 1, ["shallow", "baseline"]).map(cell => cell.method), ["baseline", "shallow"]);
  for (const args of [["run", "--tasks", "../keep"], ["run", "--tasks", "keep,keep"], ["run", "--repeats", "0"],
    ["run", "--methods", ""], ["run", "--methods", "other"], ["run", "--methods", "baseline,baseline"],
    ["run", "--methods", "baseline", "--methods", "shallow"],
    ["run", "--generation-timeout-ms", "NaN"], ["run", "--generation-timeout-ms", "0"],
    ["run", "--evaluation-timeout-ms", "-1"], ["run", "--repeats", "1", "--repeats", "2"],
    ["run", "--concurrency", "0"], ["run", "--concurrency", "1.5"], ["run", "--concurrency", "NaN"],
    ["run", "--concurrency", "2", "--concurrency", "3"], ["run", "--resume"], ["summarize"]]) {
    assert.throws(() => parseExperimentArgs(args));
  }
});

test("default experiment directories use discovered task names and a UTC timestamp, with an explicit override", async () => {
  await withTempDir("shallow-arc-output-", async root => {
    const original = await fixture(root);
    const options = parseExperimentArgs(["plan", "--bench-root", original.benchRoot], root);
    const single = await createPlan(options, env);
    assert.equal(dirname(single.outputDir), join(root, "outputs"));
    assert.match(basename(single.outputDir), /^fixture-\d{8}T\d{9}Z$/);
    await assert.rejects(stat(single.outputDir), /ENOENT/, "planning does not create an output directory");
    await cp(join(original.benchRoot, "arc-bench", "fixture"), join(original.benchRoot, "arc-bench", "second"), { recursive: true });
    const multiple = await createPlan(options, env);
    assert.match(basename(multiple.outputDir), /^fixture\+second-\d{8}T\d{9}Z$/);
    const selected = await createPlan({ ...options, tasks: ["second"] }, env);
    assert.match(basename(selected.outputDir), /^second-\d{8}T\d{9}Z$/);
    const baselineOnly = await createPlan(parseExperimentArgs(["plan", "--bench-root", original.benchRoot, "--tasks", "fixture",
      "--methods", "baseline", "--repeats", "1"], root), env);
    assert.deepEqual(baselineOnly.methods, ["baseline"]);
    assert.deepEqual(baselineOnly.cells.map(cell => cell.method), ["baseline"]);
    const explicit = parseExperimentArgs(["run", "--bench-root", original.benchRoot, "--output-dir", "custom", "--resume"], root);
    assert.equal((await createPlan(explicit, env)).outputDir, join(root, "custom"));
    assert.equal(parseExperimentArgs(["summarize", "--output-dir", "custom"], root).outputDir, join(root, "custom"));
  });
});

test("prepare prints and persists its default output directory for an explicit resume", async t => {
  await withTempDir("shallow-arc-default-output-", async root => {
    const original = await fixture(root), calls: WorkerRequest[] = [];
    const stdout = t.mock.method(process.stdout, "write", () => true);
    const stderr = t.mock.method(process.stderr, "write", () => true);
    const cwd = t.mock.method(process, "cwd", () => root);
    try {
      const args = ["--bench-root", original.benchRoot, "--repeats", "1", "--concurrency", "2"];
      assert.equal(await experimentMain(["prepare", ...args], env, { runProcess: fakeProcess(calls) }, null), 0);
      const directories = await readdir(join(root, "outputs"));
      assert.equal(directories.length, 1);
      assert.match(directories[0], /^fixture-\d{8}T\d{9}Z$/);
      const output = join(root, "outputs", directories[0]);
      const manifest = JSON.parse(await readFile(join(output, "experiment.json"), "utf8"));
      assert.equal(manifest.outputDir, ".");
      assert.equal(manifest.benchRoot, "../../bench");
      assert(stderr.mock.calls.some(call => String(call.arguments[0]).includes(`[ARC experiment] output outputs/${directories[0]}`)));
      assert.equal(await experimentMain(["run", ...args, "--output-dir", output, "--resume"], env, { runProcess: fakeProcess(calls) }, null), 0);
      assert.equal(calls.length, 5);
      assert.equal(JSON.parse(await readFile(join(output, "summary.json"), "utf8")).cells.length, 2);
    } finally { stdout.mock.restore(); stderr.mock.restore(); cwd.mock.restore(); }
  });
});

test("experiment runs two independent workspaces, preserves inputs and resumes without rerunning finalized cells", async () => {
  await withTempDir("shallow-arc-experiment-", async root => {
    const plan = await fixture(root), output = join(root, "out"), calls: WorkerRequest[] = [];
    assert.doesNotMatch(JSON.stringify(plan), /private-credential/);
    assert.equal(plan.generationTimeoutMs, null); assert.equal(plan.evaluationTimeoutMs, null);
    const result = await runExperiment(plan, output, env, false, { runProcess: fakeProcess(calls) });
    assert.equal(calls.length, 5);
    assert.deepEqual(calls.map(call => call.action), ["catalog", "generate", "evaluate", "generate", "evaluate"]);
    assert(calls.every(call => call.timeoutMs === null));
    const manifest = JSON.parse(await readFile(join(output, "experiment.json"), "utf8"));
    assert.equal(manifest.concurrency, 1);
    assert.equal(manifest.outputDir, ".");
    assert.doesNotMatch(JSON.stringify(manifest), /(?<![A-Za-z])[A-Za-z]:[\\/]/);
    assert.equal(manifest.generationTimeoutMs, null); assert.equal(manifest.evaluationTimeoutMs, null);
    const resultFile = JSON.parse(await readFile(join(output, "fixture", "repeat-1", "baseline", "result.json"), "utf8"));
    assert.equal(resultFile.evaluation.directory, "fixture/repeat-1/baseline/evaluation-1");
    const evaluationFile = JSON.parse(await readFile(join(output, "fixture", "repeat-1", "baseline", "evaluation-1", "evaluation.json"), "utf8"));
    assert.equal(evaluationFile.directory, ".");
    assert.equal(JSON.parse(await readFile(join(output, "summary.json"), "utf8")).cells[0].evaluation.directory,
      "fixture/repeat-1/baseline/evaluation-1");
    assert.deepEqual(result.byMethod.map(row => row.macroPassRate), [0.5, 0.5]);
    assert.equal(await readFile(join(plan.tasks[0].requirementsDir, "requirements.yaml"), "utf8"), source);
    assert.equal(await readFile(join(plan.tasks[0].testsDir, "fixture.spec.ts"), "utf8"), "// private evaluator tests\n");
    const inputs = join(output, "private", "inputs", "fixture");
    assert.equal(await readFile(join(inputs, "source-requirements.yaml"), "utf8"), source);
    const readInput = (method: string, path: string) => readFile(join(output, "fixture", "repeat-1", method, "private", path), "utf8");
    for (const path of ["requirements/requirements.yaml", "requirements/reference/a.png", "source-requirements/conversion-map.json"]) {
      assert.equal(await readInput("baseline", path), await readInput("shallow", path));
    }
    assert.equal(await readFile(join(inputs, "conversion-map.json"), "utf8"),
      await readInput("baseline", "source-requirements/conversion-map.json"));
    assert.equal(result.cells[0].generation.modelUsage?.total, 15);
    await runExperiment(plan, output, env, true, { runProcess: fakeProcess(calls) });
    assert.equal(calls.length, 5);
    await assert.rejects(runExperiment({ ...plan, generationTimeoutMs: 1 }, output, env, true), /settings changed/);
    await assert.rejects(runExperiment({ ...plan, concurrency: 2 }, output, env, true), /settings changed/);
    await assert.rejects(runExperiment(plan, output, env, false), /already exists/);
    assert.match(await readFile(join(output, "runs.csv"), "utf8"), /baseline/);
    assert.match(await readFile(join(output, "runs.csv"), "utf8"), /cacheHitRate/);
    assert.match(await readFile(join(output, "summary.md"), "utf8"), /实验汇总/);
    assert.equal((await writeSummary(output, plan)).cells.length, 2);
  });
});

test("relative manifests keep resumed experiments portable and accept legacy absolute paths", async () => {
  await withTempDir("shallow-arc-paths-", async root => {
    const plan = await fixture(root), output = join(root, "out"), moved = join(root, "moved");
    await runExperiment(plan, output, env, false, { runProcess: fakeProcess([]) });
    await rename(output, moved);
    const movedPlan = await createPlan(parseExperimentArgs(["run", "--bench-root", plan.benchRoot, "--repeats", "1",
      "--output-dir", moved]), env);
    const summary = await runExperiment(movedPlan, moved, env, true, { runProcess: fakeProcess([]) });
    assert.equal(summary.cells.length, 2);
    assert.equal(JSON.parse(await readFile(join(moved, "summary.json"), "utf8")).cells[0].evaluation.directory,
      "fixture/repeat-1/baseline/evaluation-1");

    const manifest = JSON.parse(await readFile(join(moved, "experiment.json"), "utf8"));
    await writeFile(join(moved, "experiment.json"), JSON.stringify({ ...manifest, benchRoot: plan.benchRoot,
      outputDir: moved, setupScript: plan.setupScript, tasks: plan.tasks }, null, 2) + "\n");
    const resultFile = join(moved, "fixture", "repeat-1", "baseline", "result.json");
    const result = JSON.parse(await readFile(resultFile, "utf8"));
    await writeFile(resultFile, JSON.stringify({ ...result, evaluation: { ...result.evaluation,
      directory: join(moved, "fixture", "repeat-1", "baseline", "evaluation-1") } }, null, 2) + "\n");
    assert.equal((await runExperiment(movedPlan, moved, env, true, { runProcess: fakeProcess([]) })).cells.length, 2);
  });
});

test("method selection runs and summarizes only the requested method", async () => {
  await withTempDir("shallow-arc-methods-", async root => {
    const plan = await fixture(root, ["baseline"]), output = join(root, "out"), calls: WorkerRequest[] = [];
    const result = await runExperiment(plan, output, env, false, { runProcess: fakeProcess(calls) });
    assert.deepEqual(calls.map(call => call.action), ["catalog", "generate", "evaluate"]);
    assert.deepEqual(result.byMethod.map(row => row.method), ["baseline"]);
    assert.equal(result.byMethod[0].planned, 1);
    assert.deepEqual(result.byTask.map(row => [row.task, row.method]), [["fixture", "baseline"]]);
    assert.doesNotMatch(await readFile(join(output, "runs.csv"), "utf8"), /shallow/);
    await assert.rejects(stat(join(output, "fixture", "repeat-1", "shallow")), /ENOENT/);
  });
});

test("baseline-only CLI ignores unused Verifier configuration", async t => {
  await withTempDir("shallow-arc-baseline-config-", async root => {
    const original = await fixture(root), calls: WorkerRequest[] = [];
    const stdout = t.mock.method(process.stdout, "write", () => true);
    const stderr = t.mock.method(process.stderr, "write", () => true);
    const invalid = { ...env, SHALLOW_VERIFIER_CONCURRENCY: "9" };
    const args = (methods: string, outputDir: string) => ["run", "--bench-root", original.benchRoot, "--tasks", "fixture",
      "--methods", methods, "--repeats", "1", "--concurrency", "1", "--output-dir", outputDir];
    try {
      const output = join(root, "baseline-out");
      assert.equal(await experimentMain(args("baseline", output), invalid, { runProcess: fakeProcess(calls) }, null), 0);
      assert.deepEqual(calls.map(call => call.action), ["catalog", "generate", "evaluate"]);
      assert.deepEqual(JSON.parse(await readFile(join(output, "experiment.json"), "utf8")).methods, ["baseline"]);
      await assert.rejects(experimentMain(args("baseline,shallow", join(root, "both-out")), invalid,
        { runProcess: fakeProcess(calls) }, null), /CONCURRENCY must be 1 or 2/);
      assert.equal(calls.length, 3);
    } finally { stdout.mock.restore(); stderr.mock.restore(); }
  });
});

test("parallel experiments bound active cells, isolate attempts and resume completed results", { timeout: 15_000 }, async () => {
  await withTempDir("shallow-arc-parallel-", async root => {
    const plan = { ...await fixture(root), repeats: 3, concurrency: 3, cells: planCells(["fixture"], 3) };
    const output = join(root, "out"), calls: WorkerRequest[] = [];
    const run = fakeProcess(calls);
    let active = 0, peak = 0, started = 0;
    let releaseBatch!: () => void;
    const firstBatch = new Promise<void>(resolve => { releaseBatch = resolve; });
    const result = await runExperiment(plan, output, { ...env, SHALLOW_PROBE_PORT: "31000", SHALLOW_EVAL_PORT: "32000" }, false, {
      runProcess: async request => {
        assert.equal(request.env.SHALLOW_PROBE_PORT, undefined);
        assert.equal(request.env.SHALLOW_EVAL_PORT, undefined);
        active++; peak = Math.max(peak, active);
        try {
          if ((request.message as WorkerRequest).action === "generate" && ++started <= 3) {
            if (started === 3) releaseBatch();
            await firstBatch;
          }
          return await run(request);
        } finally { active--; }
      },
    });
    assert.equal(peak, 3);
    assert.equal(active, 0);
    assert.equal(result.cells.length, 6);
    assert.deepEqual(result.byMethod.map(row => row.macroPassRate), [0.5, 0.5]);
    const generations = calls.filter(call => call.action === "generate");
    assert.equal(new Set(generations.map(call => call.projectDir)).size, 6);
    assert.equal(new Set(generations.map(call => call.privateDir)).size, 6);
    assert.equal(calls.filter(call => call.action === "catalog").length, 1);
    assert.equal(calls.filter(call => call.action === "evaluate").length, 6);
    const saved = JSON.parse(await readFile(join(output, "summary.json"), "utf8"));
    assert.equal(saved.cells.length, 6);
    assert.equal((await readFile(join(output, "runs.csv"), "utf8")).trim().split("\n").length, 7);
    await runExperiment(plan, output, env, true, { runProcess: fakeProcess(calls) });
    assert.equal(calls.length, 13);
  });
});

for (const stop of ["failure", "abort"] as const) {
  test(`parallel experiment ${stop} drains active workers before releasing the workspace lock`, { timeout: 15_000 }, async () => {
    await withTempDir("shallow-arc-parallel-stop-", async root => {
      const plan = { ...await fixture(root), repeats: 2, concurrency: 2, cells: planCells(["fixture"], 2) };
      const output = join(root, "out"), calls: WorkerRequest[] = [];
      const run = fakeProcess(calls), controller = new AbortController();
      const failure = new Error(`fixture parallel ${stop}`);
      let started = 0, cleaning = 0, settled = false;
      let releaseStarted!: () => void, releaseCleaning!: () => void, releaseCleanup!: () => void;
      const bothStarted = new Promise<void>(resolve => { releaseStarted = resolve; });
      const workersCleaning = new Promise<void>(resolve => { releaseCleaning = resolve; });
      const cleanup = new Promise<void>(resolve => { releaseCleanup = resolve; });
      const execution = runExperiment(plan, output, env, false, { signal: controller.signal, runProcess: async request => {
        const input = request.message as WorkerRequest;
        if (input.action !== "generate") return run(request);
        calls.push(input);
        if (++started === 2) releaseStarted();
        if (stop === "failure" && input.method === "baseline") {
          await bothStarted;
          throw failure;
        }
        await new Promise<void>(resolve => request.signal!.addEventListener("abort", () => resolve(), { once: true }));
        if (++cleaning === (stop === "failure" ? 1 : 2)) releaseCleaning();
        await cleanup;
        throw request.signal!.reason;
      } });
      void execution.then(() => { settled = true; }, () => { settled = true; });
      const rejected = assert.rejects(execution, error => error === failure);
      try {
        await bothStarted;
        if (stop === "abort") controller.abort(failure);
        await workersCleaning;
        assert.equal(settled, false);
        await assert.rejects(lockWorkspace(output), /Workspace is in use/);
      } finally { releaseCleanup(); }
      await rejected;
      assert.equal(started, 2);
      assert.equal(calls.filter(call => call.action === "evaluate").length, 0);
      for (const method of ["baseline", "shallow"]) {
        await assert.rejects(readFile(join(output, "fixture", "repeat-2", method, "started.json")), /ENOENT/);
      }
      const release = await lockWorkspace(output);
      await release();
      const resumed = await runExperiment(plan, output, env, true, { runProcess: run });
      assert.equal(resumed.cells.length, 4);
      assert.equal(resumed.cells.filter(cell => cell.generation.status === "interrupted").length, 2);
      assert.equal(calls.filter(call => call.action === "generate").length, 4);
    });
  });
}

test("ARC preparation rejects missing and external reference images before generation", async () => {
  await withTempDir("shallow-arc-images-", async root => {
    const plan = await fixture(root);
    const requirementsFile = join(plan.tasks[0].requirementsDir, "requirements.yaml");
    for (const reference of ["reference/missing.png", "../../tests/fixture.spec.ts", "C:\\outside.png"]) {
      const tree = parse(source);
      tree.children[0].description.image[0].reference = reference;
      await writeFile(requirementsFile, JSON.stringify(tree));
      await assert.rejects(fixturePlan(), /ARC image must name a bundled requirement file/);
    }
    function fixturePlan() {
      return createPlan(parseExperimentArgs(["prepare", "--bench-root", join(root, "bench"), "--output-dir", join(root, "out")]), env);
    }
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

test("summaries aggregate tokens, cache hits, cost and minutes for methods, tasks and runs", () => {
  const plan = { tasks: [{ id: "a" }], repeats: 2, concurrency: 1, methods: ["baseline"], cells: [
    { task: "a", repeat: 1, method: "baseline" }, { task: "a", repeat: 2, method: "baseline" }] } as ExperimentPlan;
  const cell = (repeat: number, input: number, cacheRead: number, output: number, generationMs: number,
    evaluationMs: number, cost: number) => ({ task: "a", repeat, method: "baseline",
    generation: { status: "completed", exitCode: 0, durationMs: generationMs,
      modelUsage: { input, output, cacheRead, cacheWrite: 0, total: input + output + cacheRead, cost },
      usageComplete: true },
    evaluation: { status: "completed", durationMs: evaluationMs,
      score: { total: 10, passed: 5, failed: 5, skipped: 0, notRun: 0, passRate: 0.5, errors: [] }, directory: "." },
    finalDigest: "fixture" }) as CellResult;
  const summary = summarize(plan, [
    cell(1, 100, 300, 10, 60_000, 30_000, 0.1),
    cell(2, 0, 100, 5, 120_000, 60_000, 0.05),
  ]);
  const method = summary.byMethod[0];
  assert.equal(method.inputTokens, 100);
  assert.equal(method.outputTokens, 15);
  assert.equal(method.cacheReadTokens, 400);
  assert.equal(method.totalTokens, 515);
  assert.equal(method.cacheHitRate, 0.8);
  assert.equal(method.knownCostUsd!.toFixed(6), "0.150000");
  assert.equal(method.generationMinutes, 3);
  assert.equal(method.evaluationMinutes, 1.5);
  assert.equal(method.totalMinutes, 4.5);
  assert.equal(summary.byTask[0].cacheHitRate, 0.8);
  assert.equal(cacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0 }), null);

  const markdown = summaryMarkdown(plan, summary);
  assert.match(markdown, /\| baseline \| 2\/2 \| 50\.0% \|/);
  assert.match(markdown, /\| 5\/10 \| 50\.0% \|/);
  assert.match(markdown, /\| 0\.8|80\.0%/);
  assert.match(markdown, /缓存命中率 = cacheRead/);
});
