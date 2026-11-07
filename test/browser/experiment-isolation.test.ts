import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { executeWorker } from "../../src/experiments/worker.js";
import { snapshotFiles } from "../../src/run-record.js";
import type { ArcTask, TestEntry } from "../../src/experiments/protocol.js";
import { withTempDir } from "../helpers/temp-dir.js";

test("experiment worker resets persisted data per scenario, retains reload/cross-account state, and builds once", { timeout: 90_000 }, async () => {
  await withTempDir("sc-isolation-", async root => {
    const project = join(root, "app"), tests = join(root, "tests"), counts = join(root, "counts.txt");
    await mkdir(join(project, "data"), { recursive: true }); await mkdir(tests);
    await writeFile(join(project, "data", "count.txt"), "7");
    await writeFile(join(project, "package.json"), '{"private":true}');
    await writeFile(join(project, "build.cjs"), "require('node:fs').appendFileSync(process.env.COUNTS, 'build\\n');");
    await writeFile(join(project, "server.cjs"), `const fs=require('node:fs'),path=require('node:path');
      const file=path.join(process.env.SHALLOW_DATA_DIR,'count.txt');
      fs.appendFileSync(process.env.COUNTS,'start '+process.pid+' '+process.env.SHALLOW_DATA_DIR+'\\n');
      require('node:http').createServer((req,res)=>{
        if(req.url==='/health'){res.end('ok');return;}
        if(req.url==='/increment'){fs.writeFileSync(file,String(Number(fs.readFileSync(file,'utf8'))+1));res.writeHead(302,{Location:'/'});res.end();return;}
        res.setHeader('Content-Type','text/html');res.end('<p role="status">'+fs.readFileSync(file,'utf8')+'</p><a href="/increment">Increment</a>');
      }).listen(Number(process.env.PORT),'127.0.0.1');`);
    await writeFile(join(project, "shallowcode.config.json"), JSON.stringify({ adapter: "web", install: [],
      build: [{ executable: process.execPath, args: ["build.cjs"] }], start: { executable: process.execPath, args: ["server.cjs"] },
      readyPath: "/health", dataPaths: ["data"], env: { COUNTS: counts } }));
    await writeFile(join(tests, "isolation.spec.ts"), `import {test,expect} from '@playwright/test';
      for(const i of [0,1,2]) test('persisted [case '+i+']',async({page,browser})=>{
        await page.goto('/'); await expect(page.getByRole('status')).toHaveText('7');
        await page.getByRole('link',{name:'Increment'}).click();
        await page.reload(); await expect(page.getByRole('status')).toHaveText('8');
        const other=await browser.newContext();try{const p=await other.newPage();await p.goto(page.url());await expect(p.getByRole('status')).toHaveText('8');}finally{await other.close();}
        if(i===1) await expect(page.getByRole('status')).toHaveText('deliberate business failure');
      });`);
    const setup = join(root, "setup.cjs");
    await writeFile(setup, `require('node:fs').writeFileSync(require('node:path').join(process.argv[2],'playwright.config.cjs'),
      'module.exports='+JSON.stringify({testDir:'./tests',workers:1,retries:0,timeout:10000,expect:{timeout:200},projects:[{name:'chromium',use:{baseURL:process.argv[3],browserName:'chromium'}}]}));`);
    const task: ArcTask = { id: "fixture", requirementsDir: root, testsDir: tests, requirementFiles: {},
      testFiles: await snapshotFiles(tests), normalizedRequirementsDigest: "fixture", requirements: 1, scenarios: 3 };
    const catalogDir = join(root, "catalog"), directory = join(root, "eval");
    await executeWorker({ action: "catalog", task, setupScript: setup, directory: catalogDir, timeoutMs: 20_000 });
    const catalog = JSON.parse(await readFile(join(catalogDir, "catalog.json"), "utf8")) as TestEntry[];
    await executeWorker({ action: "evaluate", method: "baseline", task, setupScript: setup, directory, projectDir: project, catalog, timeoutMs: 20_000 });
    const evaluation = JSON.parse(await readFile(join(directory, "evaluation.json"), "utf8"));
    assert.equal(evaluation.status, "completed", JSON.stringify(evaluation));
    assert.deepEqual([evaluation.score.total,evaluation.score.passed,evaluation.score.failed,evaluation.score.notRun], [3,2,1,0]);
    const lines = (await readFile(counts,"utf8")).trim().split("\n");
    assert.equal(lines.filter(line=>line==="build").length,1);
    const starts = lines.filter(line=>line.startsWith("start "));
    assert.equal(starts.length,3);
    assert.equal(new Set(starts.map(line=>line.split(" ")[1])).size,3);
    assert.equal(new Set(starts.map(line=>line.split(" ").slice(2).join(" "))).size,3);
    assert.equal(await readFile(join(project,"data","count.txt"),"utf8"),"7");
  });
});
