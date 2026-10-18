import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
  CONTROLLER_METADATA,
  CONTROLLER_METADATA_NAMES,
  EXCLUDED_METADATA_NAMES,
  GIT_METADATA_NAMES,
  IGNORED_METADATA_NAMES,
  IGNORED_METADATA_RULES,
  NON_APPLICATION_METADATA_NAMES,
  PATH_EXCLUDED_METADATA_NAMES,
  TRACKED_METADATA_NAMES,
  isNonApplicationMetadataPath,
} from "../src/controller-metadata.js";
import { GitCliOps, runGit } from "../src/git-ops.js";
import { PROGRESS_DIR_NAME } from "../src/progress-journal.js";
import { copyProjectWorkspace, hasProjectFiles } from "../src/project-workspace.js";
import { PROJECT_SPEC_FILENAME } from "../src/project-spec.js";
import { snapshotFiles } from "../src/run-record.js";
import { installStarterScaffold } from "../src/adapters/web/scaffold.js";
import type { ApplicationContract } from "../src/types.js";
import { withTempDir } from "./helpers/temp-dir.js";

const contract = (): ApplicationContract => ({
  adapterId: "web", adapterConfig: { baseUrl: "http://127.0.0.1:43210", port: 43210, healthPath: "/health", browserPath: "/", extraPorts: [] },
  startCommand: { executable: "npm", args: ["run", "start"], cwd: "backend" },
  installCommands: [],
  buildCommands: [],
  buildTimeoutMs: 1_000,
  startTimeoutMs: 1_000,
});

const FILE_METADATA: readonly string[] = [".gitignore", PROJECT_SPEC_FILENAME];

/**
 * 写入整份元数据名单（可跳过个别项）。下面的站点测试都遍历共享名单，
 * 新增元数据时会在每个站点一起失败，提醒同步全部白名单。
 */
async function seedMetadata(root: string, skip: readonly string[] = []): Promise<void> {
  for (const name of CONTROLLER_METADATA_NAMES) {
    if (skip.includes(name)) continue;
    if (FILE_METADATA.includes(name)) {
      await writeFile(join(root, name), name === ".gitignore" ? "node_modules/\n" : "{}\n");
    } else {
      await mkdir(join(root, name));
      await writeFile(join(root, name, "content.txt"), `${name}\n`);
    }
  }
}

test("controller metadata classification stays exhaustive and non-overlapping", () => {
  const classified: string[] = [
    ...GIT_METADATA_NAMES, ...TRACKED_METADATA_NAMES, ...PATH_EXCLUDED_METADATA_NAMES, ...IGNORED_METADATA_NAMES,
  ];
  assert.deepEqual([...classified].sort(), [...CONTROLLER_METADATA_NAMES].sort(), "新增元数据必须归入某一类");
  assert.equal(new Set(classified).size, classified.length, "分类不得重叠");
  assert.deepEqual([...NON_APPLICATION_METADATA_NAMES].sort(),
    [...GIT_METADATA_NAMES, ...PATH_EXCLUDED_METADATA_NAMES, ...IGNORED_METADATA_NAMES].sort());
  assert.deepEqual([...EXCLUDED_METADATA_NAMES].sort(),
    [...PATH_EXCLUDED_METADATA_NAMES, ...IGNORED_METADATA_NAMES].sort());
  assert.deepEqual(IGNORED_METADATA_RULES, IGNORED_METADATA_NAMES.map(name => `${name}/`));
  for (const name of NON_APPLICATION_METADATA_NAMES) {
    assert.ok(CONTROLLER_METADATA.has(name), `${name} 应属于控制器元数据`);
    assert.equal(isNonApplicationMetadataPath(`${name}/child.txt`), true);
  }
  for (const name of TRACKED_METADATA_NAMES) {
    assert.ok(!(NON_APPLICATION_METADATA_NAMES as readonly string[]).includes(name), `${name} 属于交付内容`);
  }
  assert.equal(isNonApplicationMetadataPath("frontend/src/App.tsx"), false);
});

test("a directory holding only controller metadata has no project files", async () => {
  await withTempDir("shallow-metadata-", async root => {
    await seedMetadata(root);
    assert.equal(await hasProjectFiles(root), false);
    await writeFile(join(root, "app.txt"), "source");
    assert.equal(await hasProjectFiles(root), true);
  });
});

test("a fresh run accepts every controller metadata entry except .git itself", async () => {
  await withTempDir("shallow-metadata-", async root => {
    // `.git` 由 GitOps 单独判定：走到首轮检查时该目录还不是仓库根。
    await seedMetadata(root, [".git"]);
    const git = await GitCliOps.open(root);
    await git.captureAccepted("shallow: baseline");
    const tracked = (await runGit(root, ["ls-files"], false)).stdout.split(/\r?\n/);

    for (const name of [...IGNORED_METADATA_NAMES, PROGRESS_DIR_NAME]) {
      assert.ok(!tracked.some(path => path === name || path.startsWith(`${name}/`)), `${name} 不应进入应用历史`);
    }
    for (const name of TRACKED_METADATA_NAMES) {
      assert.ok(tracked.some(path => path === name || path.startsWith(`${name}/`)), `${name} 属于交付内容，应进入历史`);
    }
    assert.equal(await readFile(join(root, ".requirements-agent", "content.txt"), "utf8"), ".requirements-agent\n",
      "草稿文件应保留");
  });
});

test("starter scaffold installs over every controller metadata entry except a pre-existing run configuration", async () => {
  await withTempDir("shallow-metadata-", async root => {
    // 预置 shallowcode.config.json 表示项目自带运行合同，模板不安装也不覆盖。
    await seedMetadata(root, [PROJECT_SPEC_FILENAME]);
    const result = await installStarterScaffold(root, contract());
    assert.equal(result.status, "installed");
    assert.equal(await readFile(join(root, ".requirements-agent", "content.txt"), "utf8"), ".requirements-agent\n");
  });
});

test("workspace copies skip every non-application metadata entry", async () => {
  await withTempDir("shallow-metadata-", async root => {
    const source = join(root, "source");
    await mkdir(source);
    await seedMetadata(source);
    await writeFile(join(source, "app.txt"), "source");
    const work = join(root, "run/workspace");
    await copyProjectWorkspace(source, work);
    for (const name of NON_APPLICATION_METADATA_NAMES) {
      await assert.rejects(access(join(work, name)), `${name} 不应复制到运行副本`);
    }
    for (const name of TRACKED_METADATA_NAMES) await access(join(work, name));
    assert.equal(await readFile(join(work, "app.txt"), "utf8"), "source");
  });
});

test("input snapshots skip every non-application metadata entry", async () => {
  await withTempDir("shallow-metadata-", async root => {
    await seedMetadata(root);
    await writeFile(join(root, "app.txt"), "source");
    const files = await snapshotFiles(root);
    for (const name of NON_APPLICATION_METADATA_NAMES) {
      assert.ok(!Object.keys(files).some(path => path === name || path.startsWith(`${name}/`)),
        `${name} 不应进入输入摘要`);
    }
    for (const name of TRACKED_METADATA_NAMES) {
      assert.ok(Object.keys(files).some(path => path === name || path.startsWith(`${name}/`)), `${name} 属于输入内容`);
    }
    assert.ok(files["app.txt"]);
  });
});
