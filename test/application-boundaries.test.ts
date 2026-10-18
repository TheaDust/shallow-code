import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { test } from "node:test";

test("Core modules cannot import concrete application adapters, browser implementations or retired Judge code", async () => {
  const files = await readdir("src", { recursive: true });
  for (const file of files.filter(file => file.endsWith(".ts"))) {
    const path = file.replaceAll("\\", "/");
    if (path.startsWith("adapters/") || path.startsWith("checker/adapters/web/") || path === "pi-worker-entry.ts") continue;
    const source = await readFile(join("src", file), "utf8");
    const imports = source.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/g);
    for (const [, name] of imports) {
      assert.notEqual(name, "@playwright/test", path);
      if (!name.startsWith(".")) continue;
      const target = relative("src", join("src", file, "..", name)).replaceAll("\\", "/");
      assert.ok(!/^(?:judge\/|adapters\/|checker\/adapters\/web\/)/.test(target), `${path} imports ${target}`);
    }
    assert.doesNotMatch(source, /\.(?:browserPath|healthPath|browserEntry|extraPorts)\b/, path);
  }
});
