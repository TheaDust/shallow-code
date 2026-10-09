import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readdir, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { CandidateRuntime } from "../src/candidate-runtime.js";
import { runPipeline } from "../src/pipeline.js";
import { PlaywrightProbeRunner } from "../src/judge/playwright-probe-runner.js";
import { FakeGitOps } from "./fakes/fake-git-ops.js";
import { FakeProbePlanner } from "./fakes/fake-probe-planner.js";
import { CommandAppLifecycle, FinalVerifier } from "../src/final-verifier.js";
import type { PlatformContract, RunEvent } from "../src/types.js";
import { reservePort } from "./helpers/fixture-server.js";
import { withTempDir } from "./helpers/temp-dir.js";

async function fixture(run: (context: {
  output: string; workspace: string; candidate: CandidateRuntime; contract: PlatformContract;
  events: RunEvent[]; counts: () => Promise<string>;
}) => Promise<void>) {
  await withTempDir("shallow-candidate-", async (root) => {
    const output = join(root, "output");
    const workspace = join(root, "runtime");
    await mkdir(output);
    const log = join(root, "commands.txt");
    await writeFile(log, "");
    await writeFile(join(output, "package.json"), JSON.stringify({ private: true }));
    await writeFile(join(output, "view.txt"), "current");
    await writeFile(join(output, "install.cjs"), String.raw`const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(log)}, 'install\n'); fs.mkdirSync('node_modules', {recursive:true}); fs.writeFileSync('node_modules/owned.txt', 'installed');`);
    await writeFile(join(output, "build.cjs"), String.raw`const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(log)}, 'build\n'); fs.mkdirSync('dist', {recursive:true}); fs.writeFileSync('dist/index.html', '<main>' + fs.readFileSync('view.txt','utf8') + '</main>');`);
    await writeFile(join(output, "server.cjs"), `const fs = require('node:fs'); const path = require('node:path');
require('node:http').createServer((req,res) => {res.setHeader('content-type','text/html');
fs.writeFileSync(path.join(process.env.SHALLOW_DATA_DIR, 'requests.txt'), 'data');
res.end(req.url === '/health' ? 'ok' : fs.readFileSync('dist/index.html'));}).listen(Number(process.env.PORT),'127.0.0.1');`);
    const port = await reservePort();
    const contract: PlatformContract = { port, baseUrl: `http://127.0.0.1:${port}`, evaluationPort: 3000, healthPath: "/health",
      installCommands: [{ executable: process.execPath, args: ["install.cjs"], cwd: "output" }],
      buildCommands: [{ executable: process.execPath, args: ["build.cjs"], cwd: "output" }],
      startCommand: { executable: process.execPath, args: ["server.cjs"], cwd: "output" },
      buildTimeoutMs: 5_000, startTimeoutMs: 5_000 };
    const candidate = new CandidateRuntime(output, workspace, contract);
    const events: RunEvent[] = [];
    candidate.setRecorder(async (event) => { events.push(event); });
    try { await run({ output, workspace, candidate, contract, events, counts: () => readFile(log, "utf8") }); }
    finally { await candidate.close(); }
  });
}

test("one owned build serves independent module checks, Judge and final Chromium smoke", async () => {
  await fixture(async ({ output, workspace, candidate, contract, counts, events }) => {
    const selfTest = await candidate.start(output, contract);
    assert.match(await (await fetch(selfTest.baseUrl)).text(), /current/);
    await selfTest.stop();
    await assert.rejects(fetch(selfTest.baseUrl));
    const judged = await candidate.start(output, contract);
    assert.match(await (await fetch(judged.baseUrl)).text(), /current/);
    await judged.assertUnchanged?.();
    await judged.stop();
    const report = await new FinalVerifier(undefined, candidate, candidate).verify(output, contract);
    assert.equal(report.ok, true, report.message);
    assert.equal(report.candidate?.buildId, judged.candidate?.buildId);
    assert.notEqual(report.candidate?.runtimeId, judged.candidate?.runtimeId);
    assert.equal(await counts(), "install\nbuild\n");
    assert.deepEqual(await readdir(join(workspace, "data")), []);
    assert.equal(events.filter((event) => event.type === "candidate_prepared" && event.detail?.reused).length, 2);
  });
});

test("dispose removes only the private build workspace and is idempotent", async () => {
  await fixture(async ({ workspace, candidate }) => {
    await candidate.prepare();
    const audit = join(dirname(workspace), "run-ledger.jsonl");
    await writeFile(audit, "audit\n");
    await candidate.dispose();
    await assert.rejects(access(workspace));
    assert.equal(await readFile(audit, "utf8"), "audit\n");
    await candidate.dispose();
  });
});

test("new source and untracked files invalidate the build but retain owned dependencies", async () => {
  await fixture(async ({ output, candidate, contract, counts }) => {
    await mkdir(join(output, "dist"));
    await writeFile(join(output, "dist/index.html"), "old-output");
    await candidate.prepare();
    await writeFile(join(output, "view.txt"), "new-source");
    await writeFile(join(output, "new-business.txt"), "new");
    const app = await candidate.start(output, contract);
    assert.match(await (await fetch(app.baseUrl)).text(), /new-source/);
    assert.equal(await counts(), "install\nbuild\nbuild\n");
    await app.stop();
  });
});

test("output audit changes do not invalidate a build; runtime data stays outside it", async () => {
  await fixture(async ({ output, candidate, contract, counts }) => {
    const app = await candidate.start(output, contract);
    await mkdir(join(output, ".arc"));
    await writeFile(join(output, ".arc/events.jsonl"), "audit");
    await app.assertUnchanged?.();
    await app.stop();
    await candidate.prepare();
    assert.equal(await counts(), "install\nbuild\n");
    await assert.rejects(access(join(candidate.directory, ".arc")));
  });
});

test("candidate probes start from an isolated copy of inherited default storage", async () => {
  await fixture(async ({ output, candidate, contract }) => {
    await mkdir(join(output, "backend/data"), { recursive: true });
    await writeFile(join(output, "backend/data/state.json"), '{"legacy":"kept"}');
    await writeFile(join(output, "server.cjs"), `const fs = require('node:fs'); const path = require('node:path');
require('node:http').createServer((req,res) => {res.setHeader('content-type','text/html');
const file = path.join(process.env.SHALLOW_DATA_DIR, 'state.json'); const state = fs.readFileSync(file, 'utf8');
fs.writeFileSync(file, '{"legacy":"kept","migrated":true}');
res.end(req.url === '/health' ? 'ok' : '<main>' + state + '</main>');}).listen(Number(process.env.PORT),'127.0.0.1');`);
    const app = await candidate.start(output, contract);
    assert.match(await (await fetch(app.baseUrl)).text(), /legacy/);
    await app.stop();
    assert.equal(await readFile(join(output, "backend/data/state.json"), "utf8"), '{"legacy":"kept"}');
    const freshCopy = await candidate.start(output, contract);
    assert.match(await (await fetch(freshCopy.baseUrl)).text(), /legacy/);
    await freshCopy.stop();
  });
});

test("a real Sheet entry probe exposes a missing inherited seed until migration is implemented", async () => {
  await fixture(async ({ output, candidate, contract }) => {
    const workbookFile = join(output, "backend/data/workbooks.json");
    await mkdir(dirname(workbookFile), { recursive: true });
    await writeFile(workbookFile, JSON.stringify([{ name: "Legacy workbook", value: "keep me" }]));
    await writeFile(join(output, "server.cjs"), `const fs = require('node:fs'); const path = require('node:path');
const file = path.join(process.env.SHALLOW_DATA_DIR, 'workbooks.json');
let workbooks = JSON.parse(fs.readFileSync(file, 'utf8'));
if (fs.existsSync('migrate.flag') && !workbooks.some(item => item.name === 'EVO Revenue Model')) {
  workbooks.push({name:'EVO Revenue Model', value:'seed'}); fs.writeFileSync(file, JSON.stringify(workbooks));
}
require('node:http').createServer((req,res) => {res.setHeader('content-type','text/html');
res.end(req.url === '/health' ? 'ok' : '<main>' + workbooks.map(item => '<a href="#">' + item.name + '</a>').join('') + '</main>');
}).listen(Number(process.env.PORT),'127.0.0.1');`);
    const plan = { packetId: "sheet-inherited-seed", cases: [{ id: "open-workbook", requirementIds: ["REQ-SHEET"],
      purpose: "happy_path" as const, expectationBasis: ["Open EVO Revenue Model from the workbook list."], steps: [
        { op: "goto" as const, path: "/" },
        { op: "click" as const, locator: { by: "role" as const, role: "link", name: "EVO Revenue Model", exact: true } },
        { op: "expectVisible" as const, locator: { by: "role" as const, role: "main" } },
      ] }] };
    const browser = new PlaywrightProbeRunner();

    const before = await candidate.start(output, contract);
    const failed = await browser.run(plan, { baseUrl: before.baseUrl, stepTimeoutMs: 500, caseTimeoutMs: 3_000 });
    await before.stop();
    assert.notEqual(failed.verdict, "pass");
    assert.equal(failed.failures[0]?.stepIndex, 1);

    // Simulate the Builder adding an idempotent old-store migration. The next
    // Judge run receives a fresh copy of the same inherited delivery data.
    await writeFile(join(output, "migrate.flag"), "enabled\n");
    const after = await candidate.start(output, contract);
    const passed = await browser.run(plan, { baseUrl: after.baseUrl, stepTimeoutMs: 1_000, caseTimeoutMs: 5_000 });
    await after.stop();
    assert.equal(passed.verdict, "pass", JSON.stringify(passed.failures));
    assert.deepEqual(JSON.parse(await readFile(workbookFile, "utf8")), [{ name: "Legacy workbook", value: "keep me" }]);
  });
});

for (const mutation of ["source", "artifact", "dependency", "new-file"] as const) {
  test(`verification rejects ${mutation} mutation after launch`, async () => {
    await fixture(async ({ output, candidate, contract }) => {
      const app = await candidate.start(output, contract);
      const path = mutation === "source" ? join(output, "view.txt")
        : mutation === "artifact" ? join(candidate.directory, "dist/index.html")
        : mutation === "dependency" ? join(candidate.directory, "node_modules/owned.txt")
        : join(output, "late.txt");
      await writeFile(path, "changed");
      await assert.rejects(candidate.assertCurrent(app.candidate!), /evidence is invalid/);
      await app.stop();
    });
  });
}

const execFileAsync = promisify(execFile);

test("ignored output artifacts do not invalidate accepted input evidence", async () => {
  await fixture(async ({ output, candidate, contract }) => {
    await writeFile(join(output, ".gitignore"), "dist/\nnode_modules/\ndata/\n");
    await execFileAsync("git", ["-C", output, "init"]);
    await execFileAsync("git", ["-C", output, "add", "."]);
    await execFileAsync("git", ["-C", output, "-c", "user.name=ShallowCode", "-c", "user.email=shallowcode@local.invalid", "commit", "-m", "base"]);
    const app = await candidate.start(output, contract);
    candidate.recordAccepted(app.candidate!);
    // Ignored runtime/build drift (as left by a rolled-back repair) must not fail delivery.
    await mkdir(join(output, "data"), { recursive: true });
    await mkdir(join(output, "dist"), { recursive: true });
    await writeFile(join(output, "data/notes.json"), "runtime");
    await writeFile(join(output, "dist/late.html"), "stale");
    await candidate.assertAcceptedInput();
    await app.assertUnchanged?.();
    // Tracked source drift must still fail.
    await writeFile(join(output, "view.txt"), "changed");
    await assert.rejects(candidate.assertAcceptedInput(), /evidence is invalid/);
    await assert.rejects(candidate.assertCurrent(app.candidate!), /evidence is invalid/);
    await app.stop();
  });
});

test("CRLF re-checkout of tracked files does not invalidate accepted input evidence", async () => {
  await fixture(async ({ output, candidate, contract }) => {
    await writeFile(join(output, ".gitignore"), "dist/\nnode_modules/\n");
    await writeFile(join(output, "view.txt"), "line one\nline two\n");
    await execFileAsync("git", ["-C", output, "init"]);
    await execFileAsync("git", ["-C", output, "config", "core.autocrlf", "true"]);
    await execFileAsync("git", ["-C", output, "add", "."]);
    await execFileAsync("git", ["-C", output, "-c", "user.name=ShallowCode", "-c", "user.email=shallowcode@local.invalid", "commit", "-m", "base"]);
    const app = await candidate.start(output, contract);
    candidate.recordAccepted(app.candidate!);
    // Git re-checkout on Windows (core.autocrlf=true) rewrites LF as CRLF; the
    // application is unchanged, so acceptance evidence must survive it.
    await writeFile(join(output, "view.txt"), "line one\r\nline two\r\n");
    await candidate.assertAcceptedInput();
    // A real content change must still be rejected.
    await writeFile(join(output, "view.txt"), "line one\nline two changed\n");
    await assert.rejects(candidate.assertAcceptedInput(), /evidence is invalid/);
    await app.stop();
  });
});

for (const scenario of ["binary-tracked", "binary-untracked", "explicit-binary", "conversion-disabled", "committed-crlf"] as const) {
  test(`Candidate detects byte changes in ${scenario} input`, async () => {
    await fixture(async ({ output, candidate, contract, counts }) => {
      const binary = scenario.startsWith("binary-");
      const before = Buffer.from(binary ? [0, 137, 80, 13, 10, 26, 10] : "one\r\ntwo\r\n");
      const after = Buffer.from(binary ? [0, 137, 80, 10, 26, 10] : "one\ntwo\n");
      // Spaces exercise the NUL-delimited --eol filename parsing.
      const asset = "asset sample.dat";
      await writeFile(join(output, ".gitignore"), "dist/\nnode_modules/\n");
      await writeFile(join(output, asset), before);
      await execFileAsync("git", ["-C", output, "init"]);
      await execFileAsync("git", ["-C", output, "config", "core.autocrlf",
        scenario === "conversion-disabled" || scenario === "committed-crlf" ? "false" : "true"]);
      if (scenario === "explicit-binary") await writeFile(join(output, ".gitattributes"), "*.dat -text\n");
      if (scenario !== "binary-untracked") await execFileAsync("git", ["-C", output, "add", "."]);
      if (scenario === "committed-crlf") await writeFile(join(output, ".gitattributes"), "*.dat text=auto\n");
      const app = await candidate.start(output, contract);
      candidate.recordAccepted(app.candidate!);
      await app.stop();
      await writeFile(join(output, asset), after);
      await assert.rejects(candidate.assertAcceptedInput(), /evidence is invalid/);
      await candidate.prepare();
      assert.deepEqual(await readFile(join(candidate.directory, asset)), after);
      assert.equal(await counts(), "install\nbuild\nbuild\n");
    });
  });
}

for (const attributes of ["text", "text=auto", "eol=lf"] as const) {
  test(`Git ${attributes} attributes normalize text with core.autocrlf=false`, async () => {
    await fixture(async ({ output, candidate, contract, counts }) => {
      await writeFile(join(output, ".gitignore"), "dist/\nnode_modules/\n");
      await writeFile(join(output, ".gitattributes"), `view.txt ${attributes}\n`);
      await writeFile(join(output, "view.txt"), "one\ntwo\n");
      await execFileAsync("git", ["-C", output, "init"]);
      await execFileAsync("git", ["-C", output, "config", "core.autocrlf", "false"]);
      await execFileAsync("git", ["-C", output, "add", "."]);
      const app = await candidate.start(output, contract);
      candidate.recordAccepted(app.candidate!);
      await app.stop();
      await writeFile(join(output, "view.txt"), "one\r\ntwo\r\n");
      await candidate.assertAcceptedInput();
      await candidate.prepare();
      assert.equal(await counts(), "install\nbuild\n");
    });
  });
}

test("the product-visible progress journal does not invalidate accepted input evidence", async () => {
  await fixture(async ({ output, candidate, contract }) => {
    await writeFile(join(output, ".gitignore"), "dist/\nnode_modules/\n");
    await execFileAsync("git", ["-C", output, "init"]);
    await execFileAsync("git", ["-C", output, "add", "."]);
    await execFileAsync("git", ["-C", output, "-c", "user.name=ShallowCode", "-c", "user.email=shallowcode@local.invalid", "commit", "-m", "base"]);
    const app = await candidate.start(output, contract);
    candidate.recordAccepted(app.candidate!);
    // The journal is untracked but not ignored, so it must be excluded by path.
    await mkdir(join(output, "shallow-progress"), { recursive: true });
    await writeFile(join(output, "shallow-progress", "progress.log"), "step 1\n");
    await candidate.assertAcceptedInput();
    await app.stop();
  });
});

test("deleted source and old private artifacts are removed on rebuild", async () => {
  await fixture(async ({ output, candidate }) => {
    await writeFile(join(output, "obsolete.txt"), "old");
    await candidate.prepare();
    await writeFile(join(candidate.directory, "dist/obsolete.html"), "old");
    await rm(join(output, "obsolete.txt"));
    await candidate.prepare();
    await assert.rejects(access(join(candidate.directory, "obsolete.txt")));
    await assert.rejects(access(join(candidate.directory, "dist/obsolete.html")));
  });
});

test("dependency declaration changes and missing install state cause reinstall", async () => {
  await fixture(async ({ output, candidate, counts }) => {
    await candidate.prepare();
    await writeFile(join(output, "package-lock.json"), "{}");
    await candidate.prepare();
    await rm(join(candidate.directory, "node_modules"), { recursive: true });
    await candidate.prepare();
    assert.equal(await counts(), "install\nbuild\ninstall\nbuild\ninstall\nbuild\n");
  });
});

test("local dependencies and installation scripts include application source in the install key", async () => {
  await fixture(async ({ output, candidate, counts }) => {
    await writeFile(join(output, "package.json"), JSON.stringify({ scripts: { prepare: "node generate.cjs" } }));
    await candidate.prepare();
    await writeFile(join(output, "view.txt"), "changed");
    await candidate.prepare();
    assert.equal(await counts(), "install\nbuild\ninstall\nbuild\n");
  });
});

test("failed build cannot create a reusable credential", async () => {
  await fixture(async ({ output, candidate, contract, counts }) => {
    await writeFile(join(output, "build.cjs"), "process.exit(2)");
    const report = await new FinalVerifier(undefined, candidate, candidate).verify(output, contract);
    assert.equal(report.ok, false);
    assert.equal(report.stage, "build");
    await assert.rejects(candidate.prepare(), /exited 2/);
    assert.equal(await counts(), "install\ninstall\n");
  });
});

test("late source writes during a build cannot produce a credential", async () => {
  await fixture(async ({ output, candidate }) => {
    const build = await readFile(join(output, "build.cjs"), "utf8");
    await writeFile(join(output, "build.cjs"), `${build}\nrequire('node:fs').writeFileSync(${JSON.stringify(join(output, "view.txt"))}, 'late');`);
    await assert.rejects(candidate.prepare(), /changed during preparation/);
  });
});

test("an old healthy process occupying the target port cannot pass verification", async () => {
  await fixture(async ({ output, candidate, contract }) => {
    await candidate.prepare();
    const old = await new CommandAppLifecycle().start(candidate.directory, { ...contract, dataDirectory: join(candidate.directory, "node_modules") });
    try {
      await assert.rejects(candidate.start(output, contract), /already occupied/);
      assert.equal((await fetch(`${contract.baseUrl}/health`)).ok, true, "unowned process must not be killed");
    } finally { await old.stop(); }
  });
});

for (const mutation of ["none", "probe", "commit", "delivery"] as const) {
  test(`pipeline binds acceptance to the candidate and rejects mutation at ${mutation}`, async () => {
    await fixture(async ({ output, workspace, candidate, contract, counts }) => {
      await mkdir(workspace, { recursive: true });
      const requirementsFile = join(workspace, "requirements.yaml");
      await writeFile(requirementsFile, `id: ROOT
name: Candidate fixture
type: ROOT
children:
  - id: REQ-PROFILE
    name: Main content
    type: ATOMIC
    dependencies: []
    description: Show current in the main content.
`);
      const ledgerFile = join(workspace, "run-ledger.jsonl");
      const git = new FakeGitOps(["baseline", "accepted"]);
      const capture = git.captureAccepted.bind(git);
      git.captureAccepted = async (message) => {
        const sha = await capture(message);
        if (mutation === "commit" && message.includes("checkpoint")) await writeFile(join(output, "late.txt"), "late");
        return sha;
      };
      const browser = new PlaywrightProbeRunner();
      const run = runPipeline({ requirementsFile, outputDir: output,
        ledgerFile, totalBudgetMs: 0, platformContract: contract }, {
        builder: {
          async run() {
            return { sessionId: "fixture-session", outcome: "completed", summary: "fixture ready" };
          },
          async close() {},
        },
        planner: new FakeProbePlanner([{ packetId: "packet-req-profile", cases: [{ id: "main", requirementIds: ["REQ-PROFILE"],
          purpose: "happy_path", expectationBasis: ["Show current in the main content."],
          steps: [{ op: "goto", path: "/" }, { op: "expectText", locator: { by: "role", role: "main" }, text: "current" }] }] }]),
        runner: { async run(plan, options) {
          const report = await browser.run(plan, options);
          if (mutation === "probe") await writeFile(join(output, "late.txt"), "late");
          return report;
        } },
        git, appLifecycle: candidate, candidate, clock: { nowMs: () => Date.now() },
        finalVerifier: { async verify(directory, platform) {
          if (mutation === "delivery") await writeFile(join(output, "late.txt"), "late");
          return new FinalVerifier(browser, candidate, candidate).verify(directory, platform);
        } },
      });
      if (mutation === "none") {
        const result = await run;
        assert.equal(result.status, "delivered");
        assert.deepEqual(result.verifiedRequirementIds, ["REQ-PROFILE"]);
        assert.equal(await counts(), "install\nbuild\n");
        const events: RunEvent[] = (await readFile(ledgerFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
        const probe = events.find((event) => event.type === "probe_finished");
        const accepted = events.find((event) => event.type === "checkpoint_saved");
        assert.ok(probe?.type === "probe_finished" && accepted?.type === "checkpoint_saved");
        assert.equal(accepted.detail?.candidate?.inputDigest, probe.detail?.candidate?.inputDigest);
        assert.equal(accepted.detail?.candidate?.buildId, probe.detail?.candidate?.buildId);
        assert.ok(accepted.detail?.candidate?.applicationDigest);
      } else {
        await assert.rejects(run, /evidence is invalid/);
        const ledger = await readFile(ledgerFile, "utf8");
        if (mutation !== "delivery") assert.doesNotMatch(ledger, /"type":"packet_accepted"/);
        assert.deepEqual(git.restoredShas, [mutation === "commit" ? "baseline" : "accepted"]);
      }
    });
  });
}

test("grader-like delivery verification prepares the real output directory", async () => {
  await withTempDir("shallow-grader-candidate-", async (root) => {
    const output = join(root, "output");
    const workspace = join(root, "runtime");
    await mkdir(output);
    await writeFile(join(output, ".gitignore"), "dist/\nnode_modules/\n");
    await execFileAsync("git", ["-C", output, "init"]);
    await execFileAsync("git", ["-C", output, "add", "."]);
    await execFileAsync("git", ["-C", output, "-c", "user.name=ShallowCode", "-c", "user.email=shallowcode@local.invalid", "commit", "-m", "base"]);
    await writeFile(join(output, "install.cjs"), String.raw`const fs = require('node:fs'); fs.mkdirSync('node_modules', { recursive: true });`);
    await writeFile(join(output, "build.cjs"), String.raw`const fs = require('node:fs'); fs.mkdirSync('dist', { recursive: true });`);
    // The server only starts when the build artifact exists in its own cwd, so a
    // grader-like start on raw outputDir fails unless install/build ran there.
    const extra = await reservePort();
    await writeFile(join(output, "server.cjs"), String.raw`const fs = require('node:fs');
if (!fs.existsSync('dist')) process.exit(9);
const handler = (req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  res.setHeader('content-type', 'text/html'); res.writeHead(200); res.end('<main>ready</main>');
};
require('node:http').createServer(handler).listen(Number(process.env.PORT), '127.0.0.1');
if (process.env.ARC_EXTRA_PORTS !== '0') require('node:http').createServer(handler).listen(${extra}, '127.0.0.1');`);
    const port = await reservePort();
    const contract: PlatformContract = { port, baseUrl: `http://127.0.0.1:${port}`, evaluationPort: 3000, healthPath: "/health",
      extraPorts: [extra],
      installCommands: [{ executable: process.execPath, args: ["install.cjs"], cwd: "output" }],
      buildCommands: [{ executable: process.execPath, args: ["build.cjs"], cwd: "output" }],
      startCommand: { executable: process.execPath, args: ["server.cjs"], cwd: "output" },
      buildTimeoutMs: 5_000, startTimeoutMs: 5_000 };
    const candidate = new CandidateRuntime(output, workspace, contract);
    try {
      const report = await new FinalVerifier(undefined, candidate, candidate).verify(output, contract);
      assert.equal(report.ok, true, report.message);
      // The candidate probe built its private copy; the grader-like start must
      // have seen an output directory prepared by the controller.
      await access(join(output, "dist"));
    } finally { await candidate.close(); }
  });
});
