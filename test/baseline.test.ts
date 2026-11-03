import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { runBaseline, type BaselineOptions } from "../src/baseline.js";
import { baselineMain, parseBaselineArgs } from "../src/baseline-entry.js";
import type { CodingAgentRequest, CodingAgentResult } from "../src/builder/execution-port.js";
import { digest, lockWorkspace } from "../src/run-record.js";
import { withTempDir } from "./helpers/temp-dir.js";

const env = { OPENAI_API_KEY: "baseline-secret", OPENAI_BASE_URL: "https://baseline.invalid/v1", MODEL: "fixture",
  SHALLOW_BUILDER_MODEL: "builder-fixture", SHALLOW_BUILDER_CONTEXT_WINDOW: "200000" };

async function fixture(root: string): Promise<BaselineOptions> {
  const requirementsDir = join(root, "requirements"), outputDir = join(root, "app");
  await mkdir(requirementsDir); await mkdir(outputDir);
  await writeFile(join(requirementsDir, "requirements.yaml"), JSON.stringify({ id: "ROOT", type: "FOLDER", name: "Notebook",
    description: "Render literal {{name}}.", children: [
      { id: "SAVE", type: "ATOMIC", name: "Save", description: "Save a note.", scenarios: [
        { id: "save-refresh", name: "Retain after refresh", steps: [
          { keyword: "WHEN", content: "Save a note and refresh." }, { keyword: "THEN", content: "The note remains." },
        ] },
      ] },
      { id: "DELETE", type: "ATOMIC", name: "Delete", dependencies: ["SAVE"], description: "Delete a saved note." },
    ] }));
  await writeFile(join(outputDir, "server.js"), "// existing application\n");
  await writeFile(join(outputDir, "shallowcode.config.json"), JSON.stringify({ adapter: "web",
    start: { executable: "node", args: ["server.js"] }, generatedPaths: ["dist"] }));
  return { requirementsDir, outputDir, runDirectory: join(root, "private"), env, timeoutMs: 12345 };
}

function response(outcome: CodingAgentResult["outcome"] = "completed"): CodingAgentResult {
  return { sessionId: "fixture", outcome, summary: "SAVE/save-refresh：通过；DELETE：未检查。",
    execution: { engine: "pi", version: "fixture", nodeVersion: process.version, workerPid: 1, resumed: false,
      durationMs: 100, cleanupMs: 0, usage: { status: "available", input: 10, output: 2, cacheRead: 3, cacheWrite: 0, total: 15, cost: 0.01 } } };
}

test("baseline develops the whole input in one session and archives self-check separately from technical checks", async () => {
  await withTempDir("shallow-baseline-", async root => {
    const options = await fixture(root);
    const requests: CodingAgentRequest[] = [];
    let closed = 0, verified = 0;
    const result = await runBaseline(options, {
      createBuilder: () => ({ async run(request) {
        requests.push(request);
        // A later edit to the source requirements cannot change this run's input.
        await writeFile(join(options.requirementsDir, "requirements.yaml"), "changed after snapshot");
        await writeFile(join(options.outputDir, "server.js"), "// implemented\n");
        return response();
      }, async close() { closed++; } }),
      verifyProject: async () => { verified++; },
    });
    assert.equal(result.status, "completed"); assert.equal(result.runtimeCheck, "passed");
    assert.equal(requests.length, 1); assert.equal(closed, 1); assert.equal(verified, 2);
    const request = requests[0];
    assert.match(request.taskPrompt, /SAVE/); assert.match(request.taskPrompt, /DELETE/);
    assert.match(request.taskPrompt, /save-refresh/); assert.match(request.taskPrompt, /\{\{name\}\}/);
    assert.match(request.taskPrompt, /run_tests/); assert.match(request.systemPrompt, /自检报告/);
    assert.match(request.systemPrompt, /ARCHITECTURE\.md/);
    assert.equal(request.contextWindow, 200000); assert.equal(request.attachReferences, false);
    assert.ok(request.timeoutMs > 0 && request.timeoutMs <= options.timeoutMs!);
    assert.equal(request.sessionKey, undefined);
    assert.equal(request.requirementsDir, join(options.runDirectory, "requirements"));
    assert.equal(request.applicationContract?.adapterId, "web");
    const record = JSON.parse(await readFile(join(options.runDirectory, "baseline.json"), "utf8"));
    assert.equal(record.gateway.model, "builder-fixture"); assert.equal(record.timeoutMs, 12345);
    assert.equal(record.startingPoint, "inherited_application");
    assert.equal(record.inputFiles["server.js"], digest("// existing application\n"));
    assert.equal(result.finalFiles?.["server.js"], digest("// implemented\n"));
    assert.equal(result.finalDigest, digest(JSON.stringify(result.finalFiles)));
    assert.equal(result.modelUsage.total, 15); assert.equal(result.modelUsage.cost, 0.01);
    assert.equal(result.usageComplete, true);
    assert.equal("verifiedRequirementIds" in result, false);
    assert.equal(await readFile(join(options.runDirectory, "self-check.md"), "utf8"), response().summary + "\n");
    assert.doesNotMatch(JSON.stringify(record), /baseline-secret/);
    assert.equal(JSON.parse(await readFile(join(options.runDirectory, "result.json"), "utf8")).status, "completed");
    const unlock = await lockWorkspace(options.outputDir); await unlock();
  });
});

test("baseline installs the shared scaffold for an empty application", async () => {
  await withTempDir("shallow-baseline-scaffold-", async root => {
    const options = await fixture(root);
    options.outputDir = join(root, "new-app");
    let calls = 0;
    const result = await runBaseline(options, { createBuilder: () => ({ async run() { calls++; return response(); }, async close() {} }),
      verifyProject: async () => {} });
    assert.equal(result.status, "completed"); assert.equal(calls, 1);
    const record = JSON.parse(await readFile(join(options.runDirectory, "baseline.json"), "utf8"));
    assert.equal(record.initializationPath, "default_scaffold");
    assert.equal(record.startingPoint, "blank_template");
    assert.match(await readFile(join(options.outputDir, "frontend", "package.json"), "utf8"), /vite/);
  });
});

test("baseline counts initialization calls and passes the explicit project intent to development", async () => {
  await withTempDir("shallow-baseline-init-", async root => {
    const options = await fixture(root);
    await writeFile(join(options.requirementsDir, "project-intent.md"), "沿用 Node 技术栈。");
    const requests: CodingAgentRequest[] = [];
    let closed = 0;
    const result = await runBaseline(options, { createBuilder: () => ({ async run(request) {
      requests.push(request);
      return request.toolMode === "read_only" ? { ...response(), summary: "COMPATIBLE" } : response();
    }, async close() { closed++; } }), verifyProject: async () => {} });
    assert.equal(result.status, "completed"); assert.equal(requests.length, 2); assert.equal(closed, 2);
    assert.equal(requests[0].toolMode, "read_only"); assert.match(requests[1].taskPrompt, /沿用 Node 技术栈/);
    assert.equal(result.modelUsage.total, 30); assert.equal(result.modelUsage.cost, 0.02);
    assert.equal(result.usageComplete, true);
  });
});

test("baseline CLI loads the shared env file with process overrides", async () => {
  await withTempDir("shallow-baseline-cli-", async root => {
    const options = await fixture(root);
    const envFile = join(root, "baseline.env"), runs = join(root, "runs");
    await writeFile(envFile, ["OPENAI_API_KEY=baseline-secret", "OPENAI_BASE_URL=https://baseline.invalid/v1",
      "MODEL=from-file", `SHALLOW_RUN_DIR=${runs}`].join("\n"));
    const code = await baselineMain(["--requirements-dir", options.requirementsDir, "--project", options.outputDir],
      { SHALLOW_BUILDER_MODEL: "from-process", MODEL: undefined },
      { createBuilder: () => ({ async run() { return response(); }, async close() {} }), verifyProject: async () => {} }, envFile);
    assert.equal(code, 0);
    const { readdir } = await import("node:fs/promises");
    const [run] = await readdir(runs);
    const record = JSON.parse(await readFile(join(runs, run, "baseline.json"), "utf8"));
    assert.equal(record.gateway.model, "from-process");
    await assert.rejects(baselineMain(["--requirements-dir", options.requirementsDir, "--project", join(root, "missing")],
      env, {}, null), /ENOENT/);
  });
});

test("baseline timeout retains the partial program and usage without retrying development", async () => {
  await withTempDir("shallow-baseline-timeout-", async root => {
    const options = await fixture(root);
    let calls = 0, verified = 0;
    const result = await runBaseline(options, { createBuilder: () => ({ async run() {
      calls++; await writeFile(join(options.outputDir, "partial.txt"), "partial"); return response("timed_out");
    }, async close() {} }), verifyProject: async () => { verified++; } });
    assert.equal(result.status, "timed_out"); assert.equal(result.runtimeCheck, "not_run");
    assert.equal(calls, 1); assert.equal(verified, 1); assert.equal(result.modelUsage.total, 15);
    assert.equal(result.finalFiles?.["partial.txt"], digest("partial"));
  });
});

test("a failed final runtime check cannot turn a self-check into a successful run", async () => {
  await withTempDir("shallow-baseline-runtime-", async root => {
    const options = await fixture(root);
    let checks = 0;
    const result = await runBaseline(options, { createBuilder: () => ({ async run() { return response(); }, async close() {} }),
      verifyProject: async () => { if (++checks === 2) throw new Error("Cannot start baseline-secret"); } });
    assert.equal(result.status, "failed"); assert.equal(result.runtimeCheck, "failed");
    assert.equal(result.builder?.outcome, "completed"); assert.equal(result.modelUsage.total, 15);
    assert.equal(result.error, "Cannot start [redacted]");
    assert.doesNotMatch(await readFile(join(options.runDirectory, "result.json"), "utf8"), /baseline-secret/);
  });
});

test("baseline rejects changes to the frozen run configuration", async () => {
  await withTempDir("shallow-baseline-contract-", async root => {
    const options = await fixture(root);
    let checks = 0;
    const result = await runBaseline(options, { createBuilder: () => ({ async run() {
      await writeFile(join(options.outputDir, "shallowcode.config.json"), JSON.stringify({ start: { executable: "python" } }));
      return response();
    }, async close() {} }), verifyProject: async () => { checks++; } });
    assert.equal(result.status, "failed"); assert.match(result.error!, /configuration changed/); assert.equal(checks, 1);
  });
});

test("baseline records thrown worker failures and refuses to overwrite a previous run", async () => {
  await withTempDir("shallow-baseline-error-", async root => {
    const options = await fixture(root);
    let closed = false;
    const result = await runBaseline(options, { createBuilder: () => ({ async run() { throw new Error("Worker baseline-secret crashed"); },
      async close() { closed = true; } }), verifyProject: async () => {} });
    assert.equal(result.status, "failed"); assert.equal(result.usageComplete, false); assert.equal(closed, true);
    assert.equal(result.error, "Worker [redacted] crashed");
    const saved = await readFile(join(options.runDirectory, "result.json"), "utf8");
    await assert.rejects(runBaseline(options), /EEXIST/);
    assert.equal(await readFile(join(options.runDirectory, "result.json"), "utf8"), saved);
  });
});

test("baseline diagnostics must stay outside both application and requirements", async () => {
  await withTempDir("shallow-baseline-private-", async root => {
    const options = await fixture(root);
    await assert.rejects(runBaseline({ ...options, runDirectory: join(options.outputDir, "private") }), /outside/);
    await assert.rejects(runBaseline({ ...options, runDirectory: join(options.requirementsDir, "private") }), /outside/);
  });
});

test("baseline CLI shares project arguments and validates its development timeout", async () => {
  const parsed = parseBaselineArgs(["--requirements-dir", ".", "--project", "app", "--timeout-ms", "60000"], process.cwd());
  assert.equal(parsed.projectDir, parsed.outputDir); assert.equal(parsed.timeoutMs, 60000);
  for (const value of ["0", "-1", "1.5", "NaN", "2147483648"]) {
    assert.throws(() => parseBaselineArgs(["--timeout-ms", value], process.cwd()), /timeout-ms/);
  }
  assert.throws(() => parseBaselineArgs(["--timeout-ms"], process.cwd()), /timeout-ms/);
  assert.throws(() => parseBaselineArgs(["--requirements-dir", ".", "--budget-ms", "1000"], process.cwd()), /Unknown argument/);
  assert.equal(await baselineMain(["--help"], {}, {}, null), 0);
});
