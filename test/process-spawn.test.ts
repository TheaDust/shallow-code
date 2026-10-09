import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "./helpers/temp-dir.js";

import { spawnProcess } from "../src/process-spawn.js";

function collect(child: ChildProcess): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

test(
  "spawnProcess launches a Windows .cmd command through cmd.exe",
  { skip: process.platform !== "win32" },
  async () => {
    const result = await collect(
      spawnProcess("npm.cmd", ["--version"], {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    assert.equal(result.code, 0);
    assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
  },
);

test(
  "spawnProcess refuses shell metacharacters in cmd.exe arguments",
  { skip: process.platform !== "win32" },
  () => {
    assert.throws(
      () =>
        spawnProcess("npm.cmd", ["install", "pkg&whoami"], {
          shell: false,
          stdio: "ignore",
        }),
      /metacharacters/,
    );
  },
);

test("spawnProcess spawns regular executables directly", async () => {
  const result = await collect(
    spawnProcess(process.execPath, ["-e", "process.stdout.write('ok')"], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "ok");
});

test("spawnProcess preserves Windows batch arguments containing spaces, empty strings and trailing backslashes", { skip: process.platform !== "win32" }, async () => {
  await withTempDir("shallow-spawn-", async (directory) => {
    const script = join(directory, "echo args.cmd");
    const echo = join(directory, "echo.cjs");
    await writeFile(echo, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
    await writeFile(script, `@echo off\r\n"${process.execPath}" "${echo}" %*\r\n`);
    const args = ["a path with spaces", "", "C:\\path with spaces\\", "argument(with)parentheses"];
    const result = await collect(spawnProcess(script, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }));
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), args);
  });
});
