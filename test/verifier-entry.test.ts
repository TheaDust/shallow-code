import assert from "node:assert/strict";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../index.js";
import { loadRunRecord } from "../src/run-record.js";
import { SnapshotStore } from "../src/snapshot-store.js";
import { withTempDir } from "./helpers/temp-dir.js";

test("production builds freeze current data independently and accept current Verifier settings without model calls", { timeout: 90_000 }, async () => {
  await withTempDir("verifier-entry-", async root => {
    const source = join(root, "project"), requirements = join(root, "requirements"), runs = join(root, "runs");
    await mkdir(join(source, "storage"), { recursive: true }); await mkdir(requirements);
    await writeFile(join(source, "storage", "seed.json"), '{"initial":true}');
    await writeFile(join(source, "server.mjs"), `import{createServer}from'node:http';createServer((req,res)=>{res.setHeader('content-type','text/html');res.end('<html><body>Ready</body></html>')}).listen(Number(process.env.PORT),'127.0.0.1');`);
    await writeFile(join(source, "shallowcode.config.json"), JSON.stringify({ start: { executable: process.execPath, args: ["server.mjs"] },
      dataPaths: ["storage"], generatedPaths: ["storage"] }));
    await writeFile(join(requirements, "requirements.yaml"), "id: ROOT\nname: Demo\ntype: ROOT\nchildren: []\n");
    const env = { OPENAI_API_KEY: "unused-test-key", OPENAI_BASE_URL: "http://127.0.0.1:1/v1", MODEL: "test-model",
      SHALLOW_RUN_DIR: runs, SHALLOW_VERIFIER_MODE: "active", SHALLOW_REFERENCE_IMAGES: "0" };
    assert.equal(await main(["--requirements-dir", requirements, "--project", source], env, undefined, null), 0);
    const first = join(runs, (await readdir(runs)).find(name => !name.startsWith("."))!);
    const record = await loadRunRecord(first);
    assert.equal(record.version, 4); assert.equal(record.verifier?.mode, "active");
    assert.equal(record.verifier.semanticReview, false); assert.equal(record.verifier.replay, false);
    const baseline = await readFile(join(first, "verifier", "baseline.json"), "utf8");
    const result = JSON.parse(await readFile(join(first, "result.json"), "utf8"));
    assert.equal(result.verifier.mode, "active"); assert.equal(result.modelUsage.total, 0);
    assert.equal(result.verifier.semanticReview, false); assert.equal(result.verifier.replay, false);
    await access(join(first, "verifier-report.md"));
    await writeFile(join(record.outputDir, "storage", "seed.json"), '{"interrupted":true}');
    assert.equal(await main(["--requirements-dir", requirements], { ...env,
      SHALLOW_VERIFIER_SEMANTIC_REVIEW: "1", SHALLOW_VERIFIER_REPLAY: "1" }, undefined, null, source), 0);
    const second = join(runs, (await readdir(runs)).find(name => !name.startsWith(".") && join(runs, name) !== first)!);
    const continued = await loadRunRecord(second);
    assert.notEqual(continued.verifierRunId, record.verifierRunId);
    assert.equal(continued.outputDir, source);
    assert.equal(continued.verifier.semanticReview, true);
    assert.equal(continued.verifier.replay, true);
    assert.equal(await readFile(join(first, "verifier", "baseline.json"), "utf8"), baseline);
    const currentBaseline = await readFile(join(second, "verifier", "baseline.json"), "utf8");
    assert.notEqual(currentBaseline, baseline);
    for (const [run, ref, expected] of [[first, baseline, '{"initial":true}'], [second, currentBaseline, '{"interrupted":true}']]) {
      const snapshot = await new SnapshotStore(join(run, "verifier", "snapshots")).open(JSON.parse(ref));
      assert.equal(await readFile(join(snapshot.sourceDirectory, "storage", "seed.json"), "utf8"), expected);
    }
    assert.equal(await readFile(join(source, "storage", "seed.json"), "utf8"), '{"interrupted":true}');
    await assert.rejects(main(["--requirements-dir", requirements], { ...env, SHALLOW_VERIFIER_MODE: "legacy" }, undefined, null, source), /only supports active/);
    assert.equal(JSON.parse(await readFile(join(second, "result.json"), "utf8")).modelUsage.total, 0);
  });
});
