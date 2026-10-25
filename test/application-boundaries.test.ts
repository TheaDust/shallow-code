import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { test } from "node:test";

test("Core modules cannot import concrete application adapters or browser implementations", async () => {
  const files = await readdir("src", { recursive: true });
  for (const file of files.filter(file => file.endsWith(".ts"))) {
    const path = file.replaceAll("\\", "/");
    if (path.startsWith("adapters/") || path.startsWith("verifier/adapters/web/") || path === "pi-worker-entry.ts") continue;
    const source = await readFile(join("src", file), "utf8");
    const imports = source.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/g);
    for (const [, name] of imports) {
      assert.notEqual(name, "@playwright/test", path);
      if (!name.startsWith(".")) continue;
      const target = relative("src", join("src", file, "..", name)).replaceAll("\\", "/");
      assert.ok(!/^(?:adapters\/|verifier\/adapters\/web\/)/.test(target), `${path} imports ${target}`);
    }
    assert.doesNotMatch(source, /\.(?:browserPath|healthPath|browserEntry|extraPorts)\b/, path);
  }
});

test("Generic prompt assets keep execution-specific instructions in their owning adapters", async () => {
  const files = await readdir("prompts", { recursive: true });
  for (const file of files.filter(file => file.endsWith(".md"))) {
    const path = file.replaceAll("\\", "/");
    if (path.startsWith("adapters/") || path.startsWith("verifier/web/")) continue;
    const source = await readFile(join("prompts", file), "utf8");
    assert.doesNotMatch(source, /\b(?:Web|Playwright|JavaScript|DOM|ARIA|PDF|PNG|OCR|browser|viewport)\b|\b(?:page|locator)\.\w+|\brole\s*\/\s*label\b/, path);
  }
});
