import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createPlan, parseExperimentArgs, runExperiment } from "../src/experiments/arc-experiment.js";
import { runProcess } from "../src/experiments/process.js";
import type { WorkerRequest } from "../src/experiments/worker.js";
import { toolEnvironment } from "../src/process-lifecycle.js";
import { withTempDir } from "./helpers/temp-dir.js";

test("parallel experiment evaluators serve separate ports and score real Playwright results", { timeout: 90_000 }, async () => {
  await withTempDir("shallow-arc-evaluator-", async root => {
    const bench = join(root, "bench"), task = join(bench, "arc-bench", "fixture");
    await mkdir(join(task, "requirements"), { recursive: true }); await mkdir(join(task, "tests"));
    await writeFile(join(task, "requirements", "requirements.yaml"), JSON.stringify({ id: "ROOT", name: "Fixture", type: "ROOT",
      children: [{ id: "R", name: "Ready", type: "ATOMIC", description: "Display a Ready heading." }] }));
    await writeFile(join(task, "tests", "fixture.spec.ts"), `import { test, expect } from '@playwright/test';
test('heading passes', async ({ page }) => { await page.goto('/'); await expect(page.getByRole('heading', {name:'Ready'})).toBeVisible(); });
test('missing heading fails', async ({ page }) => { await page.goto('/'); await expect(page.getByRole('heading', {name:'Missing'})).toBeVisible(); });
`);
    await writeFile(join(bench, "setup-playwright.cjs"), `const fs = require('node:fs'), path = require('node:path');
fs.writeFileSync(path.join(process.argv[2], 'playwright.config.ts'), "import {defineConfig} from '@playwright/test'; export default defineConfig({testDir:'./tests',workers:1,retries:0,timeout:2000,expect:{timeout:100},use:{baseURL:" + JSON.stringify(process.argv[3]) + "},projects:[{name:'chromium',use:{browserName:'chromium'}}]});");
`);
    const plan = await createPlan(parseExperimentArgs(["run", "--bench-root", bench, "--output-dir", join(root, "out"),
      "--repeats", "1", "--concurrency", "2"]), {});
    assert.equal(plan.generationTimeoutMs, null); assert.equal(plan.evaluationTimeoutMs, null);
    let active = 0, peak = 0, started = 0;
    let releaseEvaluators!: () => void;
    const bothEvaluators = new Promise<void>(resolve => { releaseEvaluators = resolve; });
    const result = await runExperiment(plan, join(root, "out"), toolEnvironment(), false, { runProcess: async request => {
      const input = request.message as WorkerRequest;
      if (input.action === "evaluate") {
        active++; peak = Math.max(peak, active);
        if (++started === 2) releaseEvaluators();
        try { await bothEvaluators; return await runProcess(request); }
        finally { active--; }
      }
      if (input.action !== "generate") return runProcess(request);
      // Deterministic fixture generation belongs only to the test; the evaluator is real.
      await writeFile(join(input.projectDir, "server.cjs"), `require('node:http').createServer((req,res)=>{
if(req.url==='/health') return res.end('ok'); res.setHeader('content-type','text/html'); res.end('<h1>Ready</h1>');
}).listen(Number(process.env.PORT),'127.0.0.1');`);
      await writeFile(join(input.projectDir, "shallowcode.config.json"), JSON.stringify({ adapter: "web",
        start: { executable: process.execPath, args: ["server.cjs"] }, readyPath: "/health" }));
      return { exitCode: 0, timedOut: false, durationMs: 1 };
    } });
    assert.equal(peak, 2);
    assert.equal(active, 0);
    const urls = new Set<string>();
    for (const cell of result.cells) {
      if (cell.evaluation.status !== "completed") {
        assert.fail(JSON.stringify(cell.evaluation));
      }
      assert.equal(cell.evaluation.score.total, 2); assert.equal(cell.evaluation.score.passed, 1);
      assert.equal(cell.evaluation.score.failed, 1); assert.equal(cell.evaluation.score.passRate, 0.5);
      const report = JSON.parse(await readFile(join(cell.evaluation.directory, "playwright.json"), "utf8"));
      assert.equal(report.stats.unexpected, 1);
      const config = await readFile(join(cell.evaluation.directory, "playwright.config.ts"), "utf8");
      urls.add(JSON.parse(config.match(/baseURL:("[^"]+")/)![1]));
    }
    assert.equal(urls.size, 2);
  });
});

test("experiment wall timeout terminates the worker and its detached descendant", { timeout: 15_000 }, async () => {
  await withTempDir("shallow-arc-process-", async root => {
    const logFile = join(root, "process.log");
    const result = await runProcess({ executable: process.execPath, args: ["-e", `const child = require('node:child_process').spawn(process.execPath,
      ['-e','setInterval(() => {}, 1000)'], {detached:true, windowsHide:true, stdio:'ignore'});
      console.log(process.pid, child.pid); setInterval(() => {}, 1000);`],
      cwd: root, env: toolEnvironment(), logFile, timeoutMs: 1000 });
    assert.equal(result.timedOut, true);
    const pids = (await readFile(logFile, "utf8")).trim().split(/\s+/).map(Number);
    assert.equal(pids.length, 2);
    for (const pid of pids) {
      assert.ok(Number.isInteger(pid) && pid > 0);
      assert.throws(() => process.kill(pid, 0), /ESRCH/);
    }
  });
});

test("an unlimited experiment process runs to completion without a wall timer", { timeout: 15_000 }, async () => {
  await withTempDir("shallow-arc-unlimited-", async root => {
    const logFile = join(root, "process.log");
    const result = await runProcess({ executable: process.execPath,
      args: ["-e", "setTimeout(() => console.log('completed naturally'), 150)"],
      cwd: root, env: toolEnvironment(), logFile, timeoutMs: null });
    assert.equal(result.exitCode, 0); assert.equal(result.timedOut, false);
    assert.match(await readFile(logFile, "utf8"), /completed naturally/);
    assert(result.durationMs >= 150);
  });
});

test("unlimited experiment processes still cancel and clean up their process tree", { timeout: 15_000 }, async () => {
  await withTempDir("shallow-arc-unlimited-abort-", async root => {
    const logFile = join(root, "process.log");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("stop unlimited experiment")), 1000);
    try {
      await assert.rejects(runProcess({ executable: process.execPath, args: ["-e", `const child = require('node:child_process').spawn(process.execPath,
        ['-e','setInterval(() => {}, 1000)'], {detached:true, windowsHide:true, stdio:'ignore'});
        console.log(process.pid, child.pid); setInterval(() => {}, 1000);`],
        cwd: root, env: toolEnvironment(), logFile, timeoutMs: null, signal: controller.signal }), /stop unlimited experiment/);
      const pids = (await readFile(logFile, "utf8")).trim().split(/\s+/).map(Number);
      assert.equal(pids.length, 2);
      for (const pid of pids) { assert(Number.isInteger(pid) && pid > 0); assert.throws(() => process.kill(pid, 0), /ESRCH/); }
    } finally { clearTimeout(timer); }
  });
});
