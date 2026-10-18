import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readdir, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { CandidateRuntime } from "../src/application/candidate-runtime.js";
import { WebAppLifecycle } from "../src/adapters/web/runtime.js";
import { webRuntimeConfig } from "../src/adapters/web/project-spec.js";
import type { ApplicationContract, RunEvent } from "../src/types.js";
import { reservePort } from "./helpers/fixture-server.js";
import { withTempDir } from "./helpers/temp-dir.js";

async function fixture(run: (context: {
  output: string; workspace: string; candidate: CandidateRuntime; contract: ApplicationContract;
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
    const contract: ApplicationContract = { adapterId: "web", adapterConfig: { port, baseUrl: `http://127.0.0.1:${port}`, healthPath: "/health", browserPath: "/", extraPorts: [] }, dataPaths: ["backend/data", "backend/.data"],
      installCommands: [{ executable: process.execPath, args: ["install.cjs"], cwd: "output" }],
      buildCommands: [{ executable: process.execPath, args: ["build.cjs"], cwd: "output" }],
      startCommand: { executable: process.execPath, args: ["server.cjs"], cwd: "output" },
      buildTimeoutMs: 5_000, startTimeoutMs: 5_000 };
    const candidate = new CandidateRuntime(output, workspace, contract, new WebAppLifecycle());
    const events: RunEvent[] = [];
    candidate.setRecorder(async (event) => { events.push(event); });
    try { await run({ output, workspace, candidate, contract, events, counts: () => readFile(log, "utf8") }); }
    finally { await candidate.close(); }
  });
}

test("Declared data paths, environment and generated output work through a real candidate lifecycle", async () => {
  await fixture(async ({ output, candidate, contract, counts }) => {
    contract.env = { PROJECT_FLAG: "declared" };
    contract.dataPaths = ["storage"];
    contract.dataEnvVar = "APP_DATA_DIR";
    contract.generatedPaths = ["dist"];
    webRuntimeConfig(contract).healthPath = "/ready";
    await mkdir(join(output, "storage"));
    await writeFile(join(output, "storage/state.json"), '{"legacy":"kept"}');
    for (const file of ["install.cjs", "build.cjs"]) {
      await writeFile(join(output, file), "require('node:assert/strict').equal(process.env.PROJECT_FLAG, 'declared');\n" + await readFile(join(output, file), "utf8"));
    }
    await writeFile(join(output, "server.cjs"), `const fs = require('node:fs'); const path = require('node:path');
      const data = path.join(process.env.APP_DATA_DIR, 'state.json');
      const state = JSON.parse(fs.readFileSync(data, 'utf8')); fs.writeFileSync(data, '{"migrated":true}');
      require('node:http').createServer((req,res)=>res.end(req.url==='/ready' ? 'ok' : '<main>'+process.env.PROJECT_FLAG+':'+state.legacy+'</main>')).listen(Number(process.env.PORT), '127.0.0.1');`);
    const app = await candidate.start(output, contract);
    assert.match(await (await fetch((app.metadata as { baseUrl: string }).baseUrl)).text(), /declared:kept/);
    await app.assertUnchanged?.();
    await app.stop();
    assert.equal(await readFile(join(output, "storage/state.json"), "utf8"), '{"legacy":"kept"}');
    await mkdir(join(output, "dist"));
    await writeFile(join(output, "dist/stale.html"), "ignored output");
    await candidate.prepare();
    assert.equal(await counts(), "install\nbuild\n");
    const second = await candidate.start(output, contract);
    assert.match(await (await fetch((second.metadata as { baseUrl: string }).baseUrl)).text(), /declared:kept/);
    await second.stop();
  });
});

test("Declared dependency inputs govern install reuse while other source still triggers a build", async () => {
  await fixture(async ({ output, candidate, contract, counts }) => {
    contract.dependencyPaths = ["web"];
    await mkdir(join(output, "web"));
    await writeFile(join(output, "web/package.json"), "{}");
    await candidate.prepare();
    await writeFile(join(output, "package.json"), '{"irrelevant":"metadata"}');
    await candidate.prepare();
    assert.equal(await counts(), "install\nbuild\nbuild\n");
    await writeFile(join(output, "web/package.json"), '{"dependencies":{"example":"1.0"}}');
    await candidate.prepare();
    assert.equal(await counts(), "install\nbuild\nbuild\ninstall\nbuild\n");
  });
});

test("one owned build serves independent checks with fresh runtime identities", async () => {
  await fixture(async ({ output, workspace, candidate, contract, counts, events }) => {
    const selfTest = await candidate.start(output, contract);
    assert.match(await (await fetch((selfTest.metadata as { baseUrl: string }).baseUrl)).text(), /current/);
    await selfTest.stop();
    await assert.rejects(fetch((selfTest.metadata as { baseUrl: string }).baseUrl));
    const judged = await candidate.start(output, contract);
    assert.match(await (await fetch((judged.metadata as { baseUrl: string }).baseUrl)).text(), /current/);
    await judged.assertUnchanged?.();
    await judged.stop();
    const delivered = await candidate.start(output, contract);
    const report = { ok: true, message: "Ready", candidate: delivered.candidate };
    await delivered.assertUnchanged?.();
    await delivered.stop();
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
    assert.match(await (await fetch((app.metadata as { baseUrl: string }).baseUrl)).text(), /new-source/);
    assert.equal(await counts(), "install\nbuild\nbuild\n");
    await app.stop();
  });
});

test("output audit and requirements metadata changes do not invalidate a build; runtime data stays outside it", async () => {
  await fixture(async ({ output, candidate, contract, counts }) => {
    const app = await candidate.start(output, contract);
    await mkdir(join(output, ".arc"));
    await writeFile(join(output, ".arc/events.jsonl"), "audit");
    await mkdir(join(output, ".requirements-agent"));
    await writeFile(join(output, ".requirements-agent/draft.json"), "{}");
    await app.assertUnchanged?.();
    await app.stop();
    await candidate.prepare();
    assert.equal(await counts(), "install\nbuild\n");
    await assert.rejects(access(join(candidate.directory, ".arc")));
    await assert.rejects(access(join(candidate.directory, ".requirements-agent")));
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
    assert.match(await (await fetch((app.metadata as { baseUrl: string }).baseUrl)).text(), /legacy/);
    await app.stop();
    assert.equal(await readFile(join(output, "backend/data/state.json"), "utf8"), '{"legacy":"kept"}');
    const freshCopy = await candidate.start(output, contract);
    assert.match(await (await fetch((freshCopy.metadata as { baseUrl: string }).baseUrl)).text(), /legacy/);
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
    const before = await candidate.start(output, contract);
    assert.doesNotMatch(await (await fetch((before.metadata as { baseUrl: string }).baseUrl)).text(), /EVO Revenue Model/);
    await before.stop();

    // Simulate the Builder adding an idempotent old-store migration. The next
    // Checker run receives a fresh copy of the same inherited delivery data.
    await writeFile(join(output, "migrate.flag"), "enabled\n");
    const after = await candidate.start(output, contract);
    assert.match(await (await fetch((after.metadata as { baseUrl: string }).baseUrl)).text(), /EVO Revenue Model/);
    await after.stop();
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

test("the product-visible progress journal and requirements draft do not invalidate accepted input evidence", async () => {
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
    await mkdir(join(output, ".requirements-agent"), { recursive: true });
    await writeFile(join(output, ".requirements-agent", "draft.json"), "{}");
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
  await fixture(async ({ output, candidate, counts }) => {
    await writeFile(join(output, "build.cjs"), "process.exit(2)");
    await assert.rejects(candidate.prepare(), /exited 2/);
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
    const old = await new WebAppLifecycle().start(candidate.directory, { ...contract, dataDirectory: join(candidate.directory, "node_modules") });
    try {
      await assert.rejects(candidate.start(output, contract), /already occupied/);
      assert.equal((await fetch(`${webRuntimeConfig(contract).baseUrl}/health`)).ok, true, "unowned process must not be killed");
    } finally { await old.stop(); }
  });
});
