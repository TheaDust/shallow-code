import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { applications } from "../../src/adapters/index.js";
import type { CodingAgentPort } from "../../src/builder/execution-port.js";
import { initializeProject } from "../../src/project-initialization.js";
import { verifyInitializedWebProject } from "../../src/adapters/web/initialization.js";
import { loadRunRecord } from "../../src/run-record.js";
import { main } from "../../index.js";
import { withTempDir } from "../helpers/temp-dir.js";

test("a custom single-process Web project passes real runtime and browser initialization checks", async () => {
  await withTempDir("shallow-custom-browser-", async root => {
    const outputDir = join(root, "app");
    await mkdir(outputDir);
    const builder: CodingAgentPort = {
      async run() {
        await writeFile(join(outputDir, "server.mjs"), [
          'import { createServer } from "node:http";',
          'createServer((request, response) => {',
          '  if (request.url === "/health") { response.writeHead(200); response.end("ok"); return; }',
          '  response.writeHead(200, { "content-type": "text/html" });',
          '  response.end("<!doctype html><html><body><main>Custom stack ready</main></body></html>");',
          '}).listen(Number(process.env.PORT), "127.0.0.1");',
        ].join("\n"));
        await writeFile(join(outputDir, "shallowcode.config.json"), JSON.stringify({
          adapter: "web", start: { executable: process.execPath, args: ["server.mjs"] },
          readyPath: "/health", browserPath: "/", install: [], build: [], dataPaths: [],
        }));
        return { sessionId: "fake", outcome: "completed", summary: "created" };
      },
      async close() {},
    };
    const result = await initializeProject({ outputDir, privateDir: join(root, "private"),
      requirementsContext: "A Web app", intent: "使用不含默认模板的单进程服务", env: {},
      startedAtMs: Date.now(), budgetMs: 180_000, applications, createBuilder: () => builder,
      verify: verifyInitializedWebProject });
    assert.equal(result.path, "custom");
    assert.equal(result.contract.startCommand.cwd, "output");
    assert.match(await readFile(join(outputDir, "server.mjs"), "utf8"), /Custom stack ready/);

    const requirementsDir = join(root, "requirements");
    const runsDir = join(root, "runs");
    await mkdir(requirementsDir);
    await writeFile(join(requirementsDir, "requirements.yaml"), "id: ROOT\nname: Web\ntype: ROOT\nchildren: []\n");
    assert.equal(await main(["--requirements-dir", requirementsDir, "--project", outputDir], {
      OPENAI_API_KEY: "test", OPENAI_BASE_URL: "https://gateway.example/v1", MODEL: "provider/model",
      SHALLOW_RUN_DIR: runsDir,
    }, undefined, null), 0);
    const runDir = join(runsDir, (await readdir(runsDir))[0]);
    const record = await loadRunRecord(runDir);
    assert.equal(record.initializationPath, "existing");
    assert.equal(record.projectSpec.start.executable, process.execPath);
    assert.equal(JSON.parse(await readFile(join(runDir, "result.json"), "utf8")).status, "delivered");
  });
});
