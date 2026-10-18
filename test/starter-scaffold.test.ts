import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { installStarterScaffold } from "../src/adapters/web/scaffold.js";
import { GitCliOps, runGit } from "../src/git-ops.js";
import type { ApplicationContract } from "../src/types.js";
import { withTempDir } from "./helpers/temp-dir.js";

const contract = (extraPorts = [3301, 4312]): ApplicationContract => ({
  adapterId: "web", adapterConfig: { baseUrl: "http://127.0.0.1:43210", port: 43210, healthPath: "/health", browserPath: "/", extraPorts: extraPorts },
  installCommands: [],
  buildCommands: [],
  startCommand: { executable: "npm", args: ["run", "start"], cwd: "backend" },
  buildTimeoutMs: 1_000,
  startTimeoutMs: 1_000,
});

test("starter scaffold installs the generic platform shell into metadata-only output", async () => {
  await withTempDir("shallow-starter-", async directory => {
    await mkdir(join(directory, ".git"));
    await mkdir(join(directory, ".arc"));
    await writeFile(join(directory, ".gitignore"), "node_modules/\n");
    await mkdir(join(directory, ".requirements-agent"));
    const draft = join(directory, ".requirements-agent", "draft.json");
    await writeFile(draft, "{}");

    const result = await installStarterScaffold(directory, contract());

    assert.equal(result.status, "installed");
    assert.equal(await readFile(draft, "utf8"), "{}", "需求草稿不阻止安装，也不被覆盖");
    const saved = JSON.parse(await readFile(join(directory, "shallowcode.config.json"), "utf8"));
    assert.equal(saved.start.cwd, "backend");
    assert.deepEqual(saved.dataPaths, ["backend/data", "backend/.data"]);
    assert.ok(result.files.includes("frontend/package-lock.json"));
    assert.ok(result.files.includes("frontend/src/lib/hash-route.ts"));
    assert.ok(result.files.includes("frontend/src/lib/api.ts"));
    assert.ok(result.files.includes("frontend/src/ui/Dialog.tsx"));
    assert.ok(result.files.includes("frontend/src/ui/Menu.tsx"));
    assert.ok(!result.files.some(file => /\/ui\/.*\.test\.tsx?$/u.test(file)));
    assert.ok(result.files.includes("backend/src/server.mjs"));
    assert.ok(result.files.includes("backend/src/lib/json-store.mjs"));
    assert.deepEqual(JSON.parse(await readFile(join(directory, "backend/src/platform-ports.json"), "utf8")), [3301, 4312]);
    const frontend = await readFile(join(directory, "frontend/src/App.tsx"), "utf8");
    const hashRoute = await readFile(join(directory, "frontend/src/lib/hash-route.ts"), "utf8");
    const dialog = await readFile(join(directory, "frontend/src/ui/Dialog.tsx"), "utf8");
    const combobox = await readFile(join(directory, "frontend/src/ui/Combobox.tsx"), "utf8");
    const primitives = await readFile(join(directory, "frontend/src/ui/index.ts"), "utf8");
    const backend = await readFile(join(directory, "backend/src/server.mjs"), "utf8");
    const store = await readFile(join(directory, "backend/src/lib/json-store.mjs"), "utf8");
    assert.match(frontend, /<main>/);
    assert.match(hashRoute, /shallowcode:navigation/);
    assert.match(hashRoute, /document\.addEventListener\("click"/);
    assert.match(dialog, /className="dialog ui-dialog"/);
    assert.match(combobox, /<select/);
    assert.doesNotMatch(combobox, /<input/);
    assert.match(combobox, /role="listbox"/);
    assert.match(combobox, /role="option"/);
    assert.match(combobox, /aria-hidden="true"/);
    assert.match(combobox, /\\u2060/);
    assert.doesNotMatch(`${frontend}\n${primitives}\n${backend}\n${store}`, /github|spreadsheet|repository|workbook/i);
    assert.match(backend, /\/api\/health/);
    assert.match(backend, /SHALLOW_EXTRA_PORTS/);
    assert.match(backend, /frontend\/dist/);
    await assert.rejects(access(join(directory, "frontend", "node_modules")));
    await assert.rejects(access(join(directory, "frontend", "dist")));
  });
});

test("starter scaffold is part of the first pipeline baseline after Git initialization", async () => {
  await withTempDir("shallow-starter-git-", async directory => {
    const git = await GitCliOps.open(directory);
    const result = await installStarterScaffold(directory, contract([3301]));
    const baseline = await git.captureAccepted("shallow: initial state");
    const tree = await runGit(directory, ["ls-tree", "-r", "--name-only", baseline], false);

    assert.equal(result.status, "installed");
    assert.match(tree.stdout, /frontend\/src\/App\.tsx/);
    assert.match(tree.stdout, /backend\/src\/server\.mjs/);
    assert.match(tree.stdout, /backend\/src\/platform-ports\.json/);
  });
});

test("a first run keeps requirements metadata out of the application baseline", async () => {
  await withTempDir("shallow-starter-metadata-", async directory => {
    await mkdir(join(directory, "requirements"));
    await writeFile(join(directory, "requirements", "requirements.yaml"), "id: ROOT\nname: Root\ntype: FOLDER\nchildren: []\n");
    await mkdir(join(directory, ".requirements-agent"));
    const draft = join(directory, ".requirements-agent", "draft.json");
    await writeFile(draft, "{}");

    const git = await GitCliOps.open(directory);
    const result = await installStarterScaffold(directory, contract([3301]));
    const baseline = await git.captureAccepted("shallow: initial state");
    const tree = await runGit(directory, ["ls-tree", "-r", "--name-only", baseline], false);

    assert.equal(result.status, "installed");
    assert.match(tree.stdout, /frontend\/src\/App\.tsx/);
    assert.doesNotMatch(tree.stdout, /\.requirements-agent/, "草稿目录不进入应用历史");
    assert.equal(await readFile(draft, "utf8"), "{}", "草稿文件保留");
  });
});

test("starter scaffold never overwrites an existing delivered application", async () => {
  await withTempDir("shallow-starter-existing-", async directory => {
    await mkdir(join(directory, "frontend"));
    await mkdir(join(directory, "backend"));
    const marker = join(directory, "frontend", "custom.txt");
    await writeFile(marker, "keep me");

    const result = await installStarterScaffold(directory, contract());

    assert.equal(result.status, "skipped_existing_application");
    assert.equal(await readFile(marker, "utf8"), "keep me");
    await assert.rejects(access(join(directory, "frontend", "src", "App.tsx")));
  });
});

test("starter scaffold skips partial or nonempty project directories", async () => {
  for (const prepare of [
    async (directory: string) => { await writeFile(join(directory, "README.md"), "existing project"); },
    async (directory: string) => { await mkdir(join(directory, "frontend")); },
  ]) {
    await withTempDir("shallow-starter-nonempty-", async directory => {
      await prepare(directory);
      const result = await installStarterScaffold(directory, contract());
      assert.equal(result.status, "skipped_nonempty_output");
      await assert.rejects(access(join(directory, "backend", "src", "server.mjs")));
    });
  }
});
