import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { WebAppLifecycle, verifyDeclaredPorts } from "../src/adapters/web/runtime.js";
import { webRuntimeConfig } from "../src/adapters/web/project-spec.js";
import type { ApplicationContract, ProcessCommand } from "../src/types.js";
import { reservePort } from "./helpers/fixture-server.js";
import { withTempDir } from "./helpers/temp-dir.js";

test("Declared port verification requires extra spec ports and survival of unknown paths", async () => {
  await withTempDir("shallow-grader-", async (outputDir) => {
    const port = await reservePort();
    const extra = await reservePort();
    const contract = contractFor(port, [], []);
    webRuntimeConfig(contract).extraPorts = [extra];
    await writeFile(join(outputDir, "grader-server.mjs"), `
      import { createServer } from "node:http";
      const handler = (req, res) => {
        if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
        res.writeHead(404); res.end("not found");
      };
      createServer(handler).listen(Number(process.env.PORT), "127.0.0.1");
      if (process.env.SHALLOW_EXTRA_PORTS !== "0") createServer(handler).listen(${extra}, "127.0.0.1");
    `);
    contract.startCommand = { executable: process.execPath, args: ["grader-server.mjs"], cwd: "output" };

    const report = await verifyDeclaredPorts(outputDir, contract);

    assert.deepEqual(report, { ok: true, stage: "complete", message: "Declared service ports verified" });
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
    await assert.rejects(fetch(`http://127.0.0.1:${extra}/health`));
  });
});

test("Declared port verification exposes an isolated copy of inherited default data", async () => {
  await withTempDir("shallow-grader-data-", async outputDir => {
    const port = await reservePort();
    const extra = await reservePort();
    const contract = contractFor(port, [], []);
    contract.dataPaths = ["backend/data"];
    webRuntimeConfig(contract).extraPorts = [extra];
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
      if (process.env.SHALLOW_EXTRA_PORTS !== "0") createServer(handler).listen(${extra}, "127.0.0.1");
    `);
    contract.startCommand = { executable: process.execPath, args: ["grader-server.mjs"], cwd: "output" };
    const report = await verifyDeclaredPorts(outputDir, contract);
    assert.equal(report.ok, true, report.message);
    assert.equal(await readFile(join(outputDir, "backend/data/state.json"), "utf8"), '{"legacy":"kept"}');
  });
});

test("Declared port verification fails with an actionable message when only PORT is bound", async () => {
  await withTempDir("shallow-grader-", async (outputDir) => {
    const port = await reservePort();
    const extra = await reservePort();
    const contract = contractFor(port, [], []);
    webRuntimeConfig(contract).extraPorts = [extra];
    await writeFile(join(outputDir, "grader-server.mjs"), `
      import { createServer } from "node:http";
      createServer((req, res) => { res.writeHead(200); res.end("ok"); }).listen(Number(process.env.PORT), "127.0.0.1");
    `);
    contract.startCommand = { executable: process.execPath, args: ["grader-server.mjs"], cwd: "output" };

    const report = await verifyDeclaredPorts(outputDir, contract);

    assert.equal(report.ok, false);
    assert.equal(report.stage, "readiness");
    assert.match(report.message, /declared services did not respond/);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
  });
});

test("Declared port verification fails when the app dies on an unknown path", async () => {
  await withTempDir("shallow-grader-", async (outputDir) => {
    const port = await reservePort();
    const extra = await reservePort();
    const contract = contractFor(port, [], []);
    webRuntimeConfig(contract).extraPorts = [extra];
    await writeFile(join(outputDir, "grader-server.mjs"), `
      import { createServer } from "node:http";
      const handler = (req, res) => {
        if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
        throw new Error("boom");
      };
      createServer(handler).listen(Number(process.env.PORT), "127.0.0.1");
      if (process.env.SHALLOW_EXTRA_PORTS !== "0") createServer(handler).listen(${extra}, "127.0.0.1");
    `);
    contract.startCommand = { executable: process.execPath, args: ["grader-server.mjs"], cwd: "output" };

    const report = await verifyDeclaredPorts(outputDir, contract);

    assert.equal(report.ok, false);
    assert.match(report.message, /no HTTP response|exited/);
  });
});

test("Declared port verification fails when a foreign process squats a required extra port", async () => {
  await withTempDir("shallow-grader-", async (outputDir) => {
    const port = await reservePort();
    const extra = await reservePort();
    const contract = contractFor(port, [], []);
    webRuntimeConfig(contract).extraPorts = [extra];
    await writeFile(join(outputDir, "grader-server.mjs"), `
      import { createServer } from "node:http";
      const handler = (req, res) => {
        if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
        res.writeHead(404); res.end("not found");
      };
      createServer(handler).listen(Number(process.env.PORT), "127.0.0.1");
      if (process.env.SHALLOW_EXTRA_PORTS !== "0") {
        const extraServer = createServer(handler);
        extraServer.on("error", () => {});
        extraServer.listen(${extra}, "127.0.0.1");
      }
    `);
    contract.startCommand = { executable: process.execPath, args: ["grader-server.mjs"], cwd: "output" };

    const squatter = createServer(() => { /* accepts connections but never answers */ });
    await new Promise<void>((resolveListen) => squatter.listen(extra, "127.0.0.1", () => resolveListen()));
    try {
      const report = await verifyDeclaredPorts(outputDir, contract);
      assert.equal(report.ok, false);
      assert.equal(report.stage, "readiness");
    } finally {
      squatter.closeAllConnections();
      await new Promise<void>((resolveClose) => squatter.close(() => resolveClose()));
    }
  });
});

test("Declared port verification is skipped when the contract declares no extra ports", async () => {
  await withTempDir("shallow-grader-", async (outputDir) => {
    const report = await verifyDeclaredPorts(outputDir, contractFor(await reservePort(), [], []));
    assert.equal(report.ok, true);
    assert.match(report.message, /not configured/);
  });
});

function contractFor(
  port: number,
  installCommands: ProcessCommand[],
  buildCommands: ProcessCommand[],
): ApplicationContract {
  return {
    adapterId: "web", adapterConfig: { baseUrl: `http://127.0.0.1:${port}`, port, evaluationPort: 3000, healthPath: "/health", browserPath: "/", extraPorts: [] },
    installCommands,
    buildCommands,
    startCommand: {
      executable: process.execPath,
      args: ["server.mjs"],
      cwd: "output",
    },
    buildTimeoutMs: 2_000,
    startTimeoutMs: 2_000,
  };
}



test("WebAppLifecycle.stop stays idempotent when port release lags shutdown", async () => {
  await withTempDir("shallow-stop-", async (outputDir) => {
    await cp(resolve("test/fixtures/app"), outputDir, { recursive: true, force: true });
    const port = await reservePort();
    const contract = contractFor(port, [], []);

    const lifecycle = new WebAppLifecycle();
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

test("WebAppLifecycle.stop does not fail shutdown when the port stays occupied", async () => {
  await withTempDir("shallow-stop-", async (outputDir) => {
    await cp(resolve("test/fixtures/app"), outputDir, { recursive: true, force: true });
    const port = await reservePort();
    const contract = contractFor(port, [], []);

    const lifecycle = new WebAppLifecycle();
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
      squatter.once("listening", resolvePromise);
      const attempt = (): void => {
        squatter.once("error", () => setTimeout(attempt, 10));
        squatter.listen(port, "127.0.0.1");
      };
      attempt();
    });
    await stopped;
    await app.stop();
    await new Promise<void>((resolvePromise) => squatter.close(() => resolvePromise()));
  });
});
