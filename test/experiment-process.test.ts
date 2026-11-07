import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { runProcess } from "../src/experiments/process.js";
import { npmExecutable } from "../src/project-spec.js";
import { toolEnvironment } from "../src/process-lifecycle.js";
import { withTempDir } from "./helpers/temp-dir.js";

test("experiment descendants omit outer npm policy and retain model and tooling configuration", async () => {
  await withTempDir("experiment-env-", async directory => {
    const probe = `process.stdout.write(JSON.stringify({
      policyKeys: Object.keys(process.env).filter(key => /^npm_config_allow_scripts$/i.test(key)),
      modelKey: process.env.OPENAI_API_KEY, registry: process.env.npm_config_registry,
      proxy: process.env.HTTPS_PROXY
    }));`;
    const script = `process.once('message', () => {
      process.disconnect();
      const child = require('node:child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(probe)}], {encoding:'utf8', windowsHide:true});
      process.stdout.write(child.stdout); process.stderr.write(child.stderr); process.exitCode = child.status ?? 1;
    });`;
    const env = { ...toolEnvironment(), npm_config_allow_scripts: "outer-package",
      NPM_CONFIG_ALLOW_SCRIPTS: "outer-package", NpM_CoNfIg_AlLoW_sCrIpTs: "outer-package",
      OPENAI_API_KEY: "fixture-model-key", npm_config_registry: "https://registry.example.test",
      HTTPS_PROXY: "https://proxy.example.test" };
    const logFile = join(directory, "process.log");
    const result = await runProcess({ executable: process.execPath, args: ["-e", script], cwd: directory,
      env, logFile, timeoutMs: 10_000, message: {} });
    const log = await readFile(logFile, "utf8");
    assert.equal(result.exitCode, 0, log);
    assert.deepEqual(JSON.parse(log), { policyKeys: [], modelKey: env.OPENAI_API_KEY,
      registry: env.npm_config_registry, proxy: env.HTTPS_PROXY });
    assert.equal(env.npm_config_allow_scripts, "outer-package");
  });
});

test("experiment npm installs use project policy and execute lifecycle scripts offline", { timeout: 30_000 }, async () => {
  await withTempDir("experiment-npm-", async directory => {
    const userConfig = join(directory, "user.npmrc");
    await writeFile(userConfig, "allow-scripts=outer-package\n");
    const pkg = { name: "experiment-install-fixture", version: "1.0.0", private: true,
      allowScripts: { "project-package": true }, scripts: { postinstall: "node postinstall.cjs" } };
    await writeFile(join(directory, "package.json"), JSON.stringify(pkg));
    await writeFile(join(directory, "postinstall.cjs"), "require('node:fs').writeFileSync('installed.txt', 'ok');\n");
    const logFile = join(directory, "install.log");
    const result = await runProcess({ executable: npmExecutable(),
      args: ["install", "--offline", "--no-package-lock", "--no-audit", "--no-fund"], cwd: directory,
      env: { ...toolEnvironment(), npm_config_allow_scripts: "outer-package", npm_config_userconfig: userConfig,
        npm_config_cache: join(directory, "npm-cache"), npm_config_update_notifier: "false" },
      logFile, timeoutMs: 20_000 });
    assert.equal(result.exitCode, 0, await readFile(logFile, "utf8"));
    assert.equal(await readFile(join(directory, "installed.txt"), "utf8"), "ok");
    assert.deepEqual(JSON.parse(await readFile(join(directory, "package.json"), "utf8")), pkg);
    assert.equal(await readFile(userConfig, "utf8"), "allow-scripts=outer-package\n");
  });
});
