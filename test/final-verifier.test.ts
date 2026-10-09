import assert from "node:assert/strict";
import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { CommandAppLifecycle, FinalVerifier, runCommand, verifyGraderLikeStart } from "../src/final-verifier.js";
import type { PlatformContract, ProcessCommand } from "../src/types.js";
import { reservePort } from "./helpers/fixture-server.js";
import { withTempDir } from "./helpers/temp-dir.js";

test("Final Verifier runs fixed commands, readiness, and a real browser smoke", async () => {
  await withTempDir("shallow-final-", async (outputDir) => {
    await cp(resolve("test/fixtures/app"), outputDir, { recursive: true, force: true });
    const port = await reservePort();
    const contract = contractFor(port, [writeMarker("installed.txt")], [writeMarker("built.txt")]);

    const report = await new FinalVerifier().verify(outputDir, contract);

    assert.deepEqual(report, { ok: true, stage: "complete", message: "Final verification passed" });
    assert.equal(await readFile(join(outputDir, "installed.txt"), "utf8"), "ok");
    assert.equal(await readFile(join(outputDir, "built.txt"), "utf8"), "ok");
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
  });
});

test("Final Verifier stops before launch and reports the failing build command", async () => {
  await withTempDir("shallow-final-", async (outputDir) => {
    await cp(resolve("test/fixtures/app"), outputDir, { recursive: true, force: true });
    const port = await reservePort();
    const contract = contractFor(port, [], [
      {
        executable: process.execPath,
        args: ["-e", "process.stderr.write('build broke'); process.exit(3)"],
        cwd: "output",
      },
    ]);

    const report = await new FinalVerifier().verify(outputDir, contract);

    assert.equal(report.ok, false);
    assert.equal(report.stage, "build");
    assert.match(report.message, /build broke/);
    await assert.rejects(access(join(outputDir, "started.txt")));
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
  });
});

test("Final Verifier reports readiness failure and terminates its start process", async () => {
  await withTempDir("shallow-final-", async (outputDir) => {
    const port = await reservePort();
    const contract = contractFor(port, [], []);
    contract.startTimeoutMs = 100;
    contract.startCommand = {
      executable: process.execPath,
      args: [
        "-e",
        "require('node:fs').writeFileSync('started.txt','yes'); setInterval(() => {}, 1000)",
      ],
      cwd: "output",
    };

    const report = await new FinalVerifier().verify(outputDir, contract);

    assert.equal(report.ok, false);
    assert.equal(report.stage, "readiness");
    assert.equal(await readFile(join(outputDir, "started.txt"), "utf8"), "yes");
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
  });
});

test("Final Verifier clears command timeout handles after an early exit", async () => {
  await withTempDir("shallow-final-", async (outputDir) => {
    const port = await reservePort();
    const contract = contractFor(port, [writeMarker("installed.txt")], [
      {
        executable: process.execPath,
        args: ["-e", "process.exit(2)"],
        cwd: "output",
      },
    ]);
    contract.buildTimeoutMs = 30_000;
    const before = timeoutResourceCount();

    await new FinalVerifier().verify(outputDir, contract);

    assert.equal(timeoutResourceCount(), before);
  });
});

test("Final Verifier reports a missing start executable as a readiness failure", async () => {
  await withTempDir("shallow-final-", async (outputDir) => {
    const contract = contractFor(await reservePort(), [], []);
    contract.startCommand.executable = join(outputDir, "missing-server.exe");
    const report = await new FinalVerifier().verify(outputDir, contract);
    assert.equal(report.ok, false);
    assert.equal(report.stage, "readiness");
    assert.match(report.message, /ENOENT/);
  });
});

test("Install/build commands never inherit the controller's gateway credentials", async () => {
  await withTempDir("shallow-final-", async (outputDir) => {
    const prior = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "do-not-leak";
    try {
      await runCommand(outputDir, {
        executable: process.execPath,
        args: ["-e", "require('node:fs').writeFileSync('seen.txt', process.env.OPENAI_API_KEY ?? 'absent')"],
        cwd: "output",
      }, 5_000);
      assert.equal(await readFile(join(outputDir, "seen.txt"), "utf8"), "absent");
    } finally {
      if (prior === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prior;
    }
  });
});

test("The candidate runtime process never inherits the controller's gateway credentials", async () => {
  await withTempDir("shallow-final-", async (outputDir) => {
    const prior = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "do-not-leak";
    try {
      const port = await reservePort();
      const contract = contractFor(port, [], []);
      contract.startCommand = {
        executable: process.execPath,
        args: ["-e", "require('node:fs').writeFileSync('app-env.txt', process.env.OPENAI_API_KEY ?? 'absent'); require('node:http').createServer((req,res) => { res.setHeader('content-type', 'text/html'); res.end(req.url === '/health' ? 'ok' : '<main>ready</main>'); }).listen(Number(process.env.PORT), '127.0.0.1')"],
        cwd: "output",
      };
      const report = await new FinalVerifier().verify(outputDir, contract);
      assert.equal(report.ok, true, report.message);
      assert.equal(await readFile(join(outputDir, "app-env.txt"), "utf8"), "absent");
    } finally {
      if (prior === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prior;
    }
  });
});

test("Final Verifier drains verbose startup logs before checking health", async () => {
  await withTempDir("shallow-final-", async (outputDir) => {
    const port = await reservePort();
    const contract = contractFor(port, [], []);
    contract.startTimeoutMs = 5_000;
    contract.startCommand = {
      executable: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(1024*1024), () => process.stderr.write('x'.repeat(1024*1024), () => require('node:http').createServer((req,res) => { res.setHeader('content-type', 'text/html'); res.end(req.url === '/health' ? 'ok' : '<main>ready</main>'); }).listen(Number(process.env.PORT), '127.0.0.1')));"],
      cwd: "output",
    };
    const report = await new FinalVerifier().verify(outputDir, contract);
    assert.equal(report.ok, true, report.message);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
  });
});

test("Final Verifier stops a POSIX launcher's server child as well as the launcher", { skip: process.platform === "win32" }, async () => {
  await withTempDir("shallow-final-", async (outputDir) => {
    await cp(resolve("test/fixtures/app"), outputDir, { recursive: true });
    await writeFile(join(outputDir, "launcher.cjs"), "require('node:child_process').spawn(process.execPath, ['server.mjs'], { stdio: 'inherit' }); setInterval(() => {}, 1000);");
    const port = await reservePort();
    const contract = contractFor(port, [], []);
    contract.startCommand.args = ["launcher.cjs"];
    const report = await new FinalVerifier().verify(outputDir, contract);
    assert.equal(report.ok, true, report.message);
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try {
        await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(100) });
      } catch {
        return;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    assert.fail("server child kept its port open after verification");
  });
});

test("Grader-like verification requires extra spec ports and survival of unknown paths", async () => {
  await withTempDir("shallow-grader-", async (outputDir) => {
    const port = await reservePort();
    const extra = await reservePort();
    const contract = contractFor(port, [], []);
    contract.extraPorts = [extra];
    await writeFile(join(outputDir, "grader-server.mjs"), `
      import { createServer } from "node:http";
      const handler = (req, res) => {
        if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
        res.writeHead(404); res.end("not found");
      };
      createServer(handler).listen(Number(process.env.PORT), "127.0.0.1");
      if (process.env.ARC_EXTRA_PORTS !== "0") createServer(handler).listen(${extra}, "127.0.0.1");
    `);
    contract.startCommand = { executable: process.execPath, args: ["grader-server.mjs"], cwd: "output" };

    const report = await verifyGraderLikeStart(outputDir, contract);

    assert.deepEqual(report, { ok: true, stage: "complete", message: "Grader-like startup verified" });
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
    await assert.rejects(fetch(`http://127.0.0.1:${extra}/health`));
  });
});

test("Grader-like verification exposes an isolated copy of inherited default data", async () => {
  await withTempDir("shallow-grader-data-", async outputDir => {
    const port = await reservePort();
    const extra = await reservePort();
    const contract = contractFor(port, [], []);
    contract.extraPorts = [extra];
    await mkdir(join(outputDir, "backend/data"), { recursive: true });
    await writeFile(join(outputDir, "backend/data/state.json"), '{"legacy":"kept"}');
    await writeFile(join(outputDir, "grader-server.mjs"), `
      import { createServer } from "node:http";
      import { readFileSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const state = join(process.env.SHALLOW_DATA_DIR, "state.json");
      if (!readFileSync(state, "utf8").includes("legacy")) process.exit(7);
      writeFileSync(state, '{"legacy":"kept","migrated":true}');
      const handler = (req, res) => { res.writeHead(req.url === "/health" ? 200 : 404); res.end("ok"); };
      createServer(handler).listen(Number(process.env.PORT), "127.0.0.1");
      if (process.env.ARC_EXTRA_PORTS !== "0") createServer(handler).listen(${extra}, "127.0.0.1");
    `);
    contract.startCommand = { executable: process.execPath, args: ["grader-server.mjs"], cwd: "output" };
    const report = await verifyGraderLikeStart(outputDir, contract);
    assert.equal(report.ok, true, report.message);
    assert.equal(await readFile(join(outputDir, "backend/data/state.json"), "utf8"), '{"legacy":"kept"}');
  });
});

test("Grader-like verification fails with an actionable message when only PORT is bound", async () => {
  await withTempDir("shallow-grader-", async (outputDir) => {
    const port = await reservePort();
    const extra = await reservePort();
    const contract = contractFor(port, [], []);
    contract.extraPorts = [extra];
    await writeFile(join(outputDir, "grader-server.mjs"), `
      import { createServer } from "node:http";
      createServer((req, res) => { res.writeHead(200); res.end("ok"); }).listen(Number(process.env.PORT), "127.0.0.1");
    `);
    contract.startCommand = { executable: process.execPath, args: ["grader-server.mjs"], cwd: "output" };

    const report = await verifyGraderLikeStart(outputDir, contract);

    assert.equal(report.ok, false);
    assert.equal(report.stage, "readiness");
    assert.match(report.message, /bound PORT but not/);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
  });
});

test("Grader-like verification fails when the app dies on an unknown path", async () => {
  await withTempDir("shallow-grader-", async (outputDir) => {
    const port = await reservePort();
    const extra = await reservePort();
    const contract = contractFor(port, [], []);
    contract.extraPorts = [extra];
    await writeFile(join(outputDir, "grader-server.mjs"), `
      import { createServer } from "node:http";
      const handler = (req, res) => {
        if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
        throw new Error("boom");
      };
      createServer(handler).listen(Number(process.env.PORT), "127.0.0.1");
      if (process.env.ARC_EXTRA_PORTS !== "0") createServer(handler).listen(${extra}, "127.0.0.1");
    `);
    contract.startCommand = { executable: process.execPath, args: ["grader-server.mjs"], cwd: "output" };

    const report = await verifyGraderLikeStart(outputDir, contract);

    assert.equal(report.ok, false);
    assert.match(report.message, /no HTTP response|exited/);
  });
});

test("Grader-like verification fails when a foreign process squats a required extra port", async () => {
  await withTempDir("shallow-grader-", async (outputDir) => {
    const port = await reservePort();
    const extra = await reservePort();
    const contract = contractFor(port, [], []);
    contract.extraPorts = [extra];
    await writeFile(join(outputDir, "grader-server.mjs"), `
      import { createServer } from "node:http";
      const handler = (req, res) => {
        if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
        res.writeHead(404); res.end("not found");
      };
      createServer(handler).listen(Number(process.env.PORT), "127.0.0.1");
      if (process.env.ARC_EXTRA_PORTS !== "0") {
        const extraServer = createServer(handler);
        extraServer.on("error", () => {});
        extraServer.listen(${extra}, "127.0.0.1");
      }
    `);
    contract.startCommand = { executable: process.execPath, args: ["grader-server.mjs"], cwd: "output" };

    const squatter = createServer(() => { /* accepts connections but never answers */ });
    await new Promise<void>((resolveListen) => squatter.listen(extra, "127.0.0.1", () => resolveListen()));
    try {
      const report = await verifyGraderLikeStart(outputDir, contract);
      assert.equal(report.ok, false);
      assert.equal(report.stage, "readiness");
    } finally {
      squatter.closeAllConnections();
      await new Promise<void>((resolveClose) => squatter.close(() => resolveClose()));
    }
  });
});

test("Grader-like verification is skipped when the contract declares no extra ports", async () => {
  await withTempDir("shallow-grader-", async (outputDir) => {
    const report = await verifyGraderLikeStart(outputDir, contractFor(await reservePort(), [], []));
    assert.equal(report.ok, true);
    assert.match(report.message, /not configured/);
  });
});

function contractFor(
  port: number,
  installCommands: ProcessCommand[],
  buildCommands: ProcessCommand[],
): PlatformContract {
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    evaluationPort: 3000,
    installCommands,
    buildCommands,
    startCommand: {
      executable: process.execPath,
      args: ["server.mjs"],
      cwd: "output",
    },
    healthPath: "/health",
    buildTimeoutMs: 2_000,
    startTimeoutMs: 2_000,
  };
}

function writeMarker(file: string): ProcessCommand {
  return {
    executable: process.execPath,
    args: [
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(file)}, 'ok')`,
    ],
    cwd: "output",
  };
}

function timeoutResourceCount(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
}

test("CommandAppLifecycle.stop stays idempotent when port release lags shutdown", async () => {
  await withTempDir("shallow-stop-", async (outputDir) => {
    await cp(resolve("test/fixtures/app"), outputDir, { recursive: true, force: true });
    const port = await reservePort();
    const contract = contractFor(port, [], []);

    const lifecycle = new CommandAppLifecycle();
    const app = await lifecycle.start(outputDir, contract);
    await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.text());

    // Stop once and let the port be released.
    await app.stop();
    // A second stop is a no-op, not a fresh port assertion that could race a
    // lingering socket on the just-freed port.
    await app.stop();

    const { createServer: createProbe } = await import("node:net");
    const probe = createProbe();
    await new Promise<void>((resolvePromise, rejectPromise) => {
      probe.once("error", rejectPromise);
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolvePromise()));
    });
  });
});

test("CommandAppLifecycle.stop does not fail shutdown when the port stays occupied", async () => {
  await withTempDir("shallow-stop-", async (outputDir) => {
    await cp(resolve("test/fixtures/app"), outputDir, { recursive: true, force: true });
    const port = await reservePort();
    const contract = contractFor(port, [], []);

    const lifecycle = new CommandAppLifecycle();
    const app = await lifecycle.start(outputDir, contract);
    await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.text());

    // Stop in the background while an unrelated listener squats on the port
    // the moment the candidate releases it, mimicking the kernel freeing the
    // candidate's socket slightly after the process exits on POSIX. Shutdown
    // must still complete (idempotently), not throw "port already occupied".
    const { createServer } = await import("node:net");
    const squatter = createServer();
    const stopped = app.stop();
    // Bind only after the candidate has released the port.
    await new Promise<void>((resolvePromise) => {
      const attempt = (): void => {
        squatter.listen(port, "127.0.0.1", () => resolvePromise());
        squatter.once("error", () => setTimeout(attempt, 10));
      };
      attempt();
    });
    await stopped;
    await app.stop();
    await new Promise<void>((resolvePromise) => squatter.close(() => resolvePromise()));
  });
});
