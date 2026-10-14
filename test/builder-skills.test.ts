import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { BUILDER_SKILLS_DIR } from "../src/builder/skills.js";

test("Bundled skills have discoverable metadata, matching names and independent LF bodies", async () => {
  const names = new Set<string>();
  for (const entry of await readdir(BUILDER_SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const content = await readFile(join(BUILDER_SKILLS_DIR, entry.name, "SKILL.md"), "utf8");
    assert.ok(!content.includes("\r"));
    assert.ok(!content.includes("{{"));
    const match = content.match(/^---\n([\s\S]+?)\n---\n([\s\S]+)$/);
    assert.ok(match, entry.name);
    const metadata = parse(match[1]);
    assert.equal(metadata.name, entry.name);
    assert.match(metadata.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(typeof metadata.description === "string" && metadata.description.length > 0);
    assert.ok(!names.has(metadata.name));
    names.add(metadata.name);
    assert.ok(match[2].trim().length > 0);
    assert.notEqual(metadata["disable-model-invocation"], true);
  }
  assert.equal(names.size, 6);
});
