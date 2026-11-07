import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { parse } from "yaml";
import { arcEnvironment, arcUsage, freezeArcBaseline, runArcBaseline, type ArcBaselineSpec } from "../src/experiments/arc-baseline.js";
import { createPlan, parseExperimentArgs, runExperiment } from "../src/experiments/arc-experiment.js";
import { deserializePlan, planCells, serializePlan } from "../src/experiments/protocol.js";
import { normalizeArcCompilerRequirements } from "../src/experiments/requirements.js";
import { digest } from "../src/run-record.js";
import { toolEnvironment } from "../src/process-lifecycle.js";
import { withTempDir } from "./helpers/temp-dir.js";

const environment = { MODEL: "fixture", OPENAI_BASE_URL: "https://fixture.invalid/v1", OPENAI_API_KEY: "private-key",
  MODEL_COST_INPUT: "2", MODEL_COST_OUTPUT: "4", MODEL_COST_CACHE_READ: "1", MODEL_COST_CACHE_WRITE: "0" };
const source = JSON.stringify({ id: "ROOT", name: "Root", description: { text: "Whole application." }, children: [
  { id: "REQ-1", name: "Ready", description: { text: "Show Ready.", image: [{ id: "IMG", reference: "reference/a.png", page: "home" }] },
    scenarios: [{ id: "SCN", name: "Display", steps: [{ id: "STEP", Given: "Fresh data.", When: "Open /.", Then: "Ready appears.",
      references: ["\\ref[image](IMG)"] }] }], children: [] },
] });

test("ARC native input retains clauses, source IDs, image metadata and references", () => {
  const tree = parse(normalizeArcCompilerRequirements(source));
  assert.equal(tree.type, "FOLDER");
  const node = tree.children[0];
  assert.equal(node.description, "Show Ready.\n\n![IMG; page=home](reference/a.png)");
  assert.deepEqual(node.visual_reference, [{ reference_id: "IMG", image_path: "reference/a.png", page: "home" }]);
  assert.deepEqual(node.scenarios[0].steps.map((step: { keyword: string; content: string }) => [step.keyword, step.content]),
    [["GIVEN", "Fresh data."], ["WHEN", "Open /."], ["THEN", "Ready appears."]]);
  assert.deepEqual(node.scenarios[0].steps.map((step: { id: string }) => step.id), ["STEP::Given", "STEP::When", "STEP::Then"]);
  for (const step of node.scenarios[0].steps) {
    assert.equal(step.source_step_id, "STEP");
    assert.deepEqual(step.references, ["\\ref[image](IMG)"]);
  }
  assert.equal(normalizeArcCompilerRequirements(normalizeArcCompilerRequirements(source)), normalizeArcCompilerRequirements(source));
});

test("ARC selection is opt-in, serializes its source/runtime and participates in method ordering", () => {
  const options = parseExperimentArgs(["plan", "--methods", "shallow,arc,baseline", "--arc-root", "../compiler", "--arc-python", "python3"]);
  assert.deepEqual(options.methods, ["baseline", "arc", "shallow"]);
  assert.equal(options.arcRoot, resolve("../compiler"));
  assert.equal(options.arcPython, "python3");
  assert.deepEqual(planCells(["a"], 2, ["arc", "shallow"]).map(cell => cell.method), ["arc", "shallow", "shallow", "arc"]);
  assert.deepEqual(planCells(["a"], 3, options.methods).map(cell => cell.method),
    ["baseline", "arc", "shallow", "arc", "shallow", "baseline", "shallow", "baseline", "arc"]);
  assert.deepEqual(parseExperimentArgs(["run"]).methods, ["baseline", "shallow"]);
});

test("ARC gateway follows Builder defaults and supports explicit model and visual overrides", () => {
  const env = arcEnvironment({ ...environment, SHALLOW_BUILDER_MODEL: "builder-model", SHALLOW_BUILDER_BASE_URL: "https://builder.invalid/v1",
    SHALLOW_BUILDER_API_KEY: "builder-key", SHALLOW_REFERENCE_IMAGES: "0", ARC_MODEL: " ", ARC_BASE_URL: "", ARC_API_KEY: "" });
  assert.equal(env.MODEL, "builder-model"); assert.equal(env.VISUAL_MODEL, "builder-model");
  assert.equal(env.OPENAI_API_KEY, "builder-key"); assert.equal(env.OPENAI_BASE_URL, "https://builder.invalid/v1");
  const explicit = arcEnvironment({ ...env, ARC_MODEL: "arc-model", ARC_API_KEY: "arc-key", VISUAL_MODEL: "vision" });
  assert.equal(explicit.MODEL, "arc-model"); assert.equal(explicit.OPENAI_API_KEY, "arc-key"); assert.equal(explicit.VISUAL_MODEL, "vision");
});

test("ARC usage excludes cached input from uncached billing and marks incomplete records", () => {
  const env = arcEnvironment(environment);
  const row = { stage: "MODEL", model: "fixture", input_tokens: 100, output_tokens: 10, cached_tokens: 40 };
  const usage = arcUsage(JSON.stringify(row), env);
  assert.deepEqual(usage, { modelUsage: { input: 60, output: 10, cacheRead: 40, cacheWrite: 0, total: 110, cost: 0.0002 }, usageComplete: true });
  assert.equal(arcUsage("", env).modelUsage, null);
  assert.equal(arcUsage(JSON.stringify({ ...row, cached_tokens: null }), env).usageComplete, false);
  assert.equal(arcUsage(JSON.stringify({ ...row, cached_tokens: 101 }), env).usageComplete, false);
  assert.equal(arcUsage(JSON.stringify(row) + "\n{", env).usageComplete, false);
});

const python = await promisify(execFile)("python", ["-c", "import sys; print(sys.executable)"], { windowsHide: true })
  .then(result => result.stdout.trim(), () => undefined);

async function compiler(root: string): Promise<ArcBaselineSpec> {
  const files: Record<string, string> = {};
  const contents: Record<string, string> = {
    "pyproject.toml": "[project]\nname='fixture'\nversion='0.0.0'\n",
    "src/arc-template/templates/web-react-express/backend/package.json": "{}",
    "src/core/__init__.py": "",
    "src/core/phases.py": "async def analyze_and_attach_visual_references(**kwargs): return kwargs['requirement_data']\n",
    "src/main.py": `import argparse, json, os
from pathlib import Path
import core.phases
class ARCWorkflowManager:
    async def start_compilation(self, output):
        result = await core.phases.analyze_and_attach_visual_references(requirement_data={'id':'R'}, workspace_path=output)
        assert result == {'id':'R'}
        root = Path(output)
        (root / '.arc').mkdir(parents=True, exist_ok=True)
        (root / '.arc/model_usage.jsonl').write_text(json.dumps({'model':'fixture','stage':'MODEL','input_tokens':100,'output_tokens':10,'cached_tokens':40})+'\\n')
        (root / 'runtime.json').write_text(json.dumps({'db':os.environ['ARC_DB_FILE'],'model':os.environ['MODEL'],'port':os.environ.get('ARC_WEB_PORT'),
            'policyKeys':[key for key in os.environ if key.lower() == 'npm_config_allow_scripts'],'hasModelKey':bool(os.environ.get('OPENAI_API_KEY'))}))
        if os.environ.get('ARC_FIXTURE_HANG'):
            import time
            time.sleep(30)
        for folder in ['frontend','backend']:
            (root / folder).mkdir(exist_ok=True)
            (root / folder / 'package.json').write_text(json.dumps({'scripts':{'build':'node -e "process.exit(0)"','start':'node server.cjs'}}))
        (root / 'backend/server.cjs').write_text("const fs=require('node:fs'),p=require('node:path'); const db=process.env.ARC_DB_FILE; fs.mkdirSync(p.dirname(db),{recursive:true}); const fresh=!fs.existsSync(db); fs.writeFileSync(db,'used'); require('node:http').createServer((req,res)=>res.end('<h1>'+(fresh?'Ready':'Dirty')+'</h1>')).listen(Number(process.env.PORT),'127.0.0.1');")
        return {'ok':os.environ.get('ARC_FIXTURE_PARTIAL')!='1','failed_nodes':['R'] if os.environ.get('ARC_FIXTURE_PARTIAL') else []}
def build_parser():
    p=argparse.ArgumentParser();p.add_argument('command');p.add_argument('requirements');p.add_argument('-o',dest='output');p.add_argument('--type');p.add_argument('--port');return p
async def cmd_compile(args):
    os.environ['ARC_WEB_PORT']=args.port
    await ARCWorkflowManager().start_compilation(args.output)
    return 0
`,
  };
  for (const [path, content] of Object.entries(contents).sort(([a], [b]) => a.localeCompare(b))) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
    files[path] = digest(content);
  }
  // Match compilerFiles' deterministic depth-first order, with metadata last.
  const { ["pyproject.toml"]: project, ...srcFiles } = files;
  return { root, python: python!, pythonVersion: "fixture", packages: {}, files: { ...srcFiles, "pyproject.toml": project } };
}

test("ARC freezes exact source bytes, rejects source drift and requires its template", async () => {
  await withTempDir("arc-freeze-", async root => {
    const spec = await compiler(join(root, "compiler"));
    const target = join(root, "frozen");
    await freezeArcBaseline(spec, target);
    await writeFile(join(spec.root, "src/main.py"), "changed");
    await freezeArcBaseline(spec, target); // Existing frozen bytes remain authoritative.
    await assert.rejects(freezeArcBaseline(spec, join(root, "new")), /source changed/);
    await writeFile(join(target, "src/main.py"), "changed");
    await assert.rejects(freezeArcBaseline(spec, target), /Frozen ARC source changed/);
    await assert.rejects(freezeArcBaseline({ ...spec, files: {} }, join(root, "missing")), /template is missing/);
  });
});

test("ARC Python bridge reports partial completion, keeps data private, and accounts for usage", { skip: !python, timeout: 30_000 }, async () => {
  await withTempDir("arc-bridge-", async root => {
    const spec = await compiler(join(root, "compiler"));
    const projectDir = join(root, "app"), privateDir = join(root, "private");
    await mkdir(projectDir); await mkdir(privateDir);
    const result = await runArcBaseline({ spec, sourceDir: spec.root, requirementsDir: root, projectDir, privateDir,
      env: { ...toolEnvironment(), ...environment, SHALLOW_REFERENCE_IMAGES: "0", ARC_FIXTURE_PARTIAL: "1",
        npm_config_allow_scripts: "outer-package", NPM_CONFIG_ALLOW_SCRIPTS: "outer-package" }, timeoutMs: 20_000 });
    assert.equal(result.status, "partial", await readFile(join(root, "generation.log"), "utf8"));
    assert.equal(result.usageComplete, true);
    assert.equal(result.modelUsage?.total, 110);
    const runtime = JSON.parse(await readFile(join(projectDir, "runtime.json"), "utf8"));
    assert.equal(runtime.db, join(projectDir, "backend", "database.db"));
    assert.equal(runtime.model, "fixture"); assert(Number(runtime.port) > 0);
    assert.deepEqual(runtime.policyKeys, []); assert.equal(runtime.hasModelKey, true);
    const config = JSON.parse(await readFile(join(projectDir, "shallowcode.config.json"), "utf8"));
    assert.equal(config.env.ARC_DB_FILE, undefined, "the evaluator binds its private runtime data directory");
    const timedOut = await runArcBaseline({ spec, sourceDir: spec.root, requirementsDir: root,
      projectDir, privateDir, env: { ...toolEnvironment(), ...environment, ARC_FIXTURE_HANG: "1" }, timeoutMs: 1000 });
    assert.equal(timedOut.status, "timed_out"); assert.equal(timedOut.usageComplete, false);
    assert.equal(timedOut.modelUsage?.total, 110);
  });
});

test("ARC method runs the Python bridge and independent Playwright scoring, then resumes without regeneration", { skip: !python, timeout: 90_000 }, async () => {
  await withTempDir("arc-method-", async root => {
    const spec = await compiler(join(root, "compiler")), bench = join(root, "bench"), task = join(bench, "arc-bench/fixture");
    await mkdir(join(task, "requirements/reference"), { recursive: true }); await mkdir(join(task, "tests"));
    await writeFile(join(task, "requirements/requirements.yaml"), source);
    await writeFile(join(task, "requirements/reference/a.png"), "image");
    await writeFile(join(task, "tests/fixture.spec.ts"), `import {test,expect} from '@playwright/test';test('fresh app',async({page})=>{await page.goto('/');await expect(page.getByRole('heading',{name:'Ready'})).toBeVisible()});`);
    await writeFile(join(bench, "setup-playwright.cjs"), `const fs=require('node:fs'),p=require('node:path');fs.writeFileSync(p.join(process.argv[2],'playwright.config.ts'),"import {defineConfig} from '@playwright/test';export default defineConfig({testDir:'./tests',workers:1,retries:0,timeout:3000,use:{baseURL:"+JSON.stringify(process.argv[3])+"}})");`);
    const plan = { ...await createPlan(parseExperimentArgs(["run", "--bench-root", bench, "--output-dir", join(root, "out"), "--repeats", "1"]), environment),
      arc: spec, methods: ["arc"] as Array<"arc">, cells: planCells(["fixture"], 1, ["arc"]) };
    assert.deepEqual(deserializePlan(serializePlan(plan, plan.outputDir), plan.outputDir), plan);
    const env = { ...toolEnvironment(), ...environment, SHALLOW_REFERENCE_IMAGES: "0" };
    const summary = await runExperiment(plan, plan.outputDir, env, false);
    assert.equal(summary.cells[0].generation.status, "completed");
    assert.equal(summary.cells[0].evaluation.status, "completed", JSON.stringify(summary.cells[0].evaluation));
    assert.equal(summary.cells[0].evaluation.score.passed, 1);
    assert.equal(summary.byMethod[0].method, "arc"); assert.equal(summary.byMethod[0].macroPassRate, 1);
    const cell = join(plan.outputDir, "fixture/repeat-1/arc");
    assert.equal(await readFile(join(plan.outputDir, "private/inputs/fixture/arc-requirements.yaml"), "utf8"), normalizeArcCompilerRequirements(source));
    assert.equal(await readFile(join(cell, "private/source-requirements/requirements.yaml"), "utf8"), source);
    assert.equal(parse(await readFile(join(cell, "private/requirements/requirements.yaml"), "utf8")).children[0].description,
      "Show Ready.\n\n![IMG; page=home](reference/a.png)");
    await assert.rejects(readFile(join(cell, "app/tests/fixture.spec.ts")), /ENOENT/);
    const resumed = await runExperiment(plan, plan.outputDir, env, true, { runProcess: async () => { throw new Error("must not rerun"); } });
    assert.deepEqual(resumed, summary);
  });
});
