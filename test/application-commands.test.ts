import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { runCommand } from "../src/application/commands.js";
import { withTempDir } from "./helpers/temp-dir.js";

test("Declared commands use their project directory and environment and surface nonzero exits", async () => {
  await withTempDir("application-commands-", async directory => {
    await writeFile(join(directory, "command.cjs"), "require('node:fs').writeFileSync('result.txt', process.env.APP_FLAG)");
    await runCommand(directory, { executable: process.execPath, args: ["command.cjs"], cwd: "output" }, 5_000, undefined, { APP_FLAG: "declared" });
    assert.equal(await readFile(join(directory, "result.txt"), "utf8"), "declared");
    await assert.rejects(runCommand(directory, { executable: process.execPath,
      args: ["-e", "console.error('command failed'); process.exit(7)"], cwd: "output" }, 5_000), /exited 7: command failed/);
  });
});

test("Command cancellation awaits process cleanup and permits another command", async () => {
  await withTempDir("application-command-cancel-", async directory => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("cancel command")), 250);
    try {
      await assert.rejects(runCommand(directory, { executable: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"], cwd: "output" }, 5_000, controller.signal), /cancel command/);
    } finally { clearTimeout(timer); }
    await runCommand(directory, { executable: process.execPath, args: ["-e", "process.exit(0)"], cwd: "output" }, 5_000);
  });
});
