import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { createDocumentReadTool, READ_MAX_BYTES, READ_MAX_LINES } from "../src/read-tool.js";

function textOf(result: Awaited<ReturnType<ReturnType<typeof createDocumentReadTool>["execute"]>>): string {
  const first = result.content[0];
  assert.equal(first?.type, "text");
  return first?.type === "text" ? first.text : "";
}

test("read tool preserves Pi path forms and resolves relative paths against the context cwd", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "requirements-read-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const file = join(base, "requirements doc.md");
  await writeFile(file, "需求文档");
  const paths = [
    "requirements doc.md",
    "@requirements doc.md",
    "requirements\u00A0doc.md",
    file,
    pathToFileURL(file).href,
    `~/${relative(homedir(), file).replaceAll("\\", "/")}`,
  ];
  if (process.platform === "win32") {
    paths.push(`~\\${relative(homedir(), file)}`);
    const drivePath = file.match(/^([a-z]):\\(.*)$/i);
    assert.ok(drivePath);
    for (const prefix of ["/", "/mnt/", "/cygdrive/"]) {
      paths.push(`${prefix}${drivePath[1].toLowerCase()}/${drivePath[2].replaceAll("\\", "/")}`);
    }
  }
  const tool = createDocumentReadTool(join(base, "other"));
  for (const path of paths) {
    const result = await tool.execute("read-path", { path }, undefined, undefined, { cwd: base });
    assert.equal(textOf(result), "需求文档", path);
  }
});

test("read tool accepts documents above the old 50KB / 2000-line limits", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "requirements-read-"));
  t.after(() => rm(base, { recursive: true, force: true }));

  const lines = Array.from({ length: 3_000 }, (_, index) => `line ${index + 1} ${"x".repeat(40)}`);
  const content = lines.join("\n");
  assert.ok(Buffer.byteLength(content, "utf8") > 50 * 1024);
  assert.ok(lines.length > 2_000);
  await writeFile(join(base, "large.md"), content);

  const tool = createDocumentReadTool(base);
  const result = await tool.execute("read-large", { path: "large.md" }, undefined, undefined, undefined);
  assert.equal(textOf(result), content);
  assert.equal(result.details, undefined);
});

test("read tool truncates at 500KB and tells the caller how to continue", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "requirements-read-"));
  t.after(() => rm(base, { recursive: true, force: true }));

  const lines = Array.from({ length: 6_000 }, (_, index) => `line ${index + 1} ${"y".repeat(90)}`);
  lines.push("END-MARKER");
  const content = lines.join("\n");
  assert.ok(Buffer.byteLength(content, "utf8") > READ_MAX_BYTES);
  await writeFile(join(base, "huge.md"), content);

  const tool = createDocumentReadTool(base);
  const result = await tool.execute("read-huge", { path: join(base, "huge.md") }, undefined, undefined, undefined);
  const text = textOf(result);

  assert.equal(result.details?.truncation?.truncated, true);
  assert.equal(result.details?.truncation?.truncatedBy, "bytes");
  assert.match(text, /\[Showing lines 1-\d+ of \d+ \(500\.0KB limit\)\. Use offset=\d+ to continue\.\]/);
  assert.ok(!text.includes("END-MARKER"));
});

test("read tool keeps offset and limit behavior", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "requirements-read-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  await writeFile(join(base, "small.md"), ["a", "b", "c", "d", "e"].join("\n"));

  const tool = createDocumentReadTool(base);
  const result = await tool.execute("read-range", { path: "small.md", offset: 2, limit: 2 }, undefined, undefined, undefined);
  const text = textOf(result);

  assert.ok(text.startsWith("b\nc"));
  assert.match(text, /\[2 more lines in file\. Use offset=4 to continue\.\]/);
  assert.ok(!text.includes("END-MARKER"));
});

test("read tool does not read binary reference files as text", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "requirements-read-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  await writeFile(join(base, "reference.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const tool = createDocumentReadTool(base);
  const result = await tool.execute("read-image", { path: "reference.png" }, undefined, undefined, undefined);

  assert.match(textOf(result), /binary\/image reference file/);
});

test("read limits remain explicit constants", () => {
  assert.equal(READ_MAX_BYTES, 500 * 1024);
  assert.equal(READ_MAX_LINES, 20_000);
});
