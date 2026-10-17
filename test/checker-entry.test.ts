import assert from "node:assert/strict";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../index.js";
import { loadRunRecord } from "../src/run-record.js";
import { withTempDir } from "./helpers/temp-dir.js";

test("production active Checker verifies, resumes its immutable data binding and applies without model calls", { timeout: 90_000 }, async () => {
  await withTempDir("checker-entry-", async root => {
    const source = join(root, "project"), requirements = join(root, "requirements"), runs = join(root, "runs");
    await mkdir(join(source, "storage"), { recursive: true }); await mkdir(requirements);
    await writeFile(join(source, "storage", "seed.json"), '{"initial":true}');
    await writeFile(join(source, "server.mjs"), `import{createServer}from'node:http';createServer((req,res)=>{res.setHeader('content-type','text/html');res.end('<html><body>Ready</body></html>')}).listen(Number(process.env.PORT),'127.0.0.1');`);
    await writeFile(join(source, "shallowcode.config.json"), JSON.stringify({ start: { executable: process.execPath, args: ["server.mjs"] },
      dataPaths: ["storage"], generatedPaths: ["storage"] }));
    await writeFile(join(requirements, "requirements.yaml"), "id: ROOT\nname: Demo\ntype: ROOT\nchildren: []\n");
    const env = { OPENAI_API_KEY: "unused-test-key", OPENAI_BASE_URL: "http://127.0.0.1:1/v1", MODEL: "test-model",
      SHALLOW_RUN_DIR: runs, SHALLOW_CHECKER_MODE: "active", SHALLOW_REFERENCE_IMAGES: "0" };
    assert.equal(await main(["--requirements-dir", requirements, "--project", source], env, undefined, null), 0);
    const first = join(runs, (await readdir(runs))[0]);
    const record = await loadRunRecord(first);
    assert.equal(record.version, 2); assert.equal(record.checker?.mode, "active");
    const baseline = await readFile(join(first, "checker", "baseline.json"), "utf8");
    const result = JSON.parse(await readFile(join(first, "result.json"), "utf8"));
    assert.equal(result.checker.mode, "active"); assert.equal(result.modelUsage.total, 0);
    await access(join(first, "checker-report.md"));
    await writeFile(join(record.outputDir, "storage", "seed.json"), '{"interrupted":true}');
    assert.equal(await main(["resume", "--run-dir", first], env, undefined, null), 0);
    const second = join(runs, (await readdir(runs)).find(name => join(runs, name) !== first)!);
    const resumed = await loadRunRecord(second);
    assert.equal(resumed.checkerRunId, record.checkerRunId);
    assert.equal(await readFile(join(second, "checker", "baseline.json"), "utf8"), baseline);
    assert.equal(await readFile(join(record.outputDir, "storage", "seed.json"), "utf8"), '{"initial":true}');
    await assert.rejects(main(["resume", "--run-dir", second], { ...env, SHALLOW_CHECKER_MODE: "legacy" }, undefined, null), /Checker settings changed/);
    assert.equal(await main(["apply", "--run-dir", second], {}, undefined, null), 0);
  });
});
