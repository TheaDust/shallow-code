import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { VerifierSourceIndex, verifierSourceExclusions } from "../src/verifier/source-index.js";
import { minimalWebContract } from "../src/adapters/web/project-spec.js";
import { SnapshotStore } from "../src/snapshot-store.js";

async function fixture(t: { after(fn: () => Promise<void>): void }, inputs: Record<string, string | Buffer>,
  excludedPaths: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), "verifier-source-index-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "application");
  await mkdir(source);
  for (const [path, value] of Object.entries(inputs)) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), value);
  }
  const snapshots = new SnapshotStore(join(root, "snapshots"));
  const sealed = await snapshots.seal({ sourceDirectory: source, sourceSha: "first", packetId: "p1" });
  const index = new VerifierSourceIndex(snapshots, excludedPaths);
  const view = await index.open(sealed.ref);
  return { source, snapshots, sealed, index, view };
}

test("source index exposes implementation files and excludes tests, data, generated files and non-source inputs", async t => {
  const f = await fixture(t, {
    "ui/App.tsx": "export function App() { return <button>导入</button>; }\n",
    "server.py": "def import_document():\n    return 'ready'\n",
    "ui/App.test.tsx": "test-only-secret",
    "ui/App.spec.tsx": "test-only-secret",
    "nested/__tests__/check.ts": "test-only-secret",
    "backend/test_store.py": "test-only-secret",
    "backend/store_test.go": "test-only-secret",
    "e2e/upload.ts": "test-only-secret",
    "vitest.config.ts": "test-only-secret",
    "persist/seed.ts": "data-only-secret",
    "compiled/output.js": "generated-only-secret",
    "ARCHITECTURE.md": "builder-only-claim",
    "requirements/requirements.yaml": "requirements-input",
    ".env": "API_KEY=secret",
    "binary.ts": Buffer.from([0, 255]),
  }, ["persist", "compiled"]);
  assert.deepEqual(f.view.list().map(file => file.path), ["server.py", "ui/App.tsx"]);
  assert.deepEqual(f.view.search(["test-only-secret", "data-only-secret", "generated-only-secret"]).matches, []);
  const match = f.view.search(["导入"], "ui").matches[0]!;
  assert.equal(match.path, "ui/App.tsx");
  assert.equal(match.hits[0]!.line, 1);
  assert.match(match.hits[0]!.text, /导入/);
  assert.deepEqual(f.view.search(["导入"], "backend").matches, []);
  assert.throws(() => f.view.read("../.env", 1), /fileId/);
  assert.throws(() => f.view.read(join(f.sealed.sourceDirectory, ".env"), 1), /fileId/);
});

test("production Web source exclusions keep dependency roots indexable", async t => {
  const contract = minimalWebContract({ port: 31_001 });
  const f = await fixture(t, {
    "frontend/src/App.tsx": "export function App() { return <main />; }\n",
    "frontend/dist/index.js": "generated output",
    "backend/src/server.mjs": "export function start() {}\n",
    "backend/data/seed.json": "persisted data",
  }, verifierSourceExclusions(contract));
  assert.deepEqual(f.view.list().map(file => file.path), ["backend/src/server.mjs", "frontend/src/App.tsx"]);
});

test("source tree lists indexed directories and files with bounded depth and deterministic order", async t => {
  const f = await fixture(t, {
    "server.py": "def main():\n    pass\n",
    "ui/App.tsx": "export function App() { return <main />; }\n",
    "ui/components/Button.tsx": "export function Button() { return <button />; }\n",
    "ui/components/deep/Icon.tsx": "export function Icon() { return <i />; }\n",
    "ui/App.test.tsx": "test-only-secret",
    "data/state.json": "{}",
    "dist/bundle.js": "generated-only-secret",
  }, ["data", "dist"]);
  const root = f.view.tree(undefined, 1);
  assert.deepEqual(root.entries.map(entry => [entry.path, entry.kind, entry.depth]), [
    ["server.py", "file", 1],
    ["ui", "directory", 1],
  ]);
  assert.equal(root.entries[1]!.fileCount, 3);
  assert.deepEqual(f.view.tree(), f.view.tree());

  const shallow = f.view.tree("ui", 1);
  assert.deepEqual(shallow.entries.map(entry => [entry.path, entry.kind]), [
    ["ui/App.tsx", "file"],
    ["ui/components", "directory"],
  ]);
  assert.equal(shallow.entries[1]!.fileCount, 2);

  const nested = f.view.tree("ui", 2);
  assert.deepEqual(nested.entries.map(entry => entry.path), [
    "ui/App.tsx",
    "ui/components",
    "ui/components/Button.tsx",
    "ui/components/deep",
  ]);
  const app = nested.entries[0]!;
  assert(nested.entries.every(entry => entry.path !== "ui/App.test.tsx"));
  assert.equal(app.lineCount, 1);
  assert.match(f.view.read(app.fileId!, 1).content, /export function App/);

  const exact = f.view.tree("ui/App.tsx");
  assert.deepEqual(exact.entries.map(entry => [entry.path, entry.kind, entry.depth]), [["ui/App.tsx", "file", 0]]);
  assert.deepEqual(f.view.tree("ui\\", 1).entries.map(entry => entry.path), shallow.entries.map(entry => entry.path));
  assert.deepEqual(f.view.tree("missing").entries, []);

  const limited = f.view.tree(undefined, 3, 2);
  assert.equal(limited.truncated, true);
  assert.equal(limited.entries.length, 2);
  assert.throws(() => f.view.tree(undefined, 0), /depth/);
  assert.throws(() => f.view.tree(undefined, 11), /depth/);
  assert.throws(() => f.view.tree(undefined, 1, 0), /limit/);
  assert.throws(() => f.view.tree(undefined, 1, 501), /limit/);
});

test("source reads preserve CRLF line numbers and indentation", async t => {
  const f = await fixture(t, { "app.ts": [
    "export function render() {",
    '    const label = "a  b";',
    "    return label;",
    "}", "",
  ].join("\r\n") });
  const file = f.view.list()[0]!;
  assert.equal(file.lineCount, 4);
  const result = f.view.read(file.fileId, 2, 2);
  assert.equal(result.startLine, 2); assert.equal(result.endLine, 3); assert.equal(result.truncated, false);
  assert.match(result.content, /^2: {5}const label = "a {2}b";/);
  assert.doesNotMatch(result.content, /\r/);
  assert.deepEqual(result.snapshot, f.sealed.ref);
  assert.throws(() => f.view.read(file.fileId, 0), /positive line/);
  assert.throws(() => f.view.read(file.fileId, 5), /positive line/);
  assert.throws(() => f.view.read(file.fileId, 1, 0), /positive line/);
});

test("source search is literal, supports paths, and marks bounded search results", async t => {
  const inputs: Record<string, string> = {};
  for (let i = 0; i < 10; i++) inputs[`ui/Part${i}.tsx`] = `export function Part${i}() { return 'a.*b'; }\n`;
  inputs["ui/Other.ts"] = "export const unrelated = 'a beta';\n";
  const f = await fixture(t, inputs);
  assert.throws(() => f.view.search([" "]), /nonempty/);
  const result = f.view.search(["a.*b"]);
  assert.equal(result.matches.length, 5); assert.equal(result.truncated, true);
  assert(!result.matches.some(match => match.path.endsWith("Other.ts")));
  assert.deepEqual(f.view.search(["a beta gamma"]).matches, []);
  assert.equal(f.view.search(["Part9.tsx"]).matches[0]!.path, "ui/Part9.tsx");
});

test("source views retain the sealed version and refresh for a new snapshot", async t => {
  const f = await fixture(t, { "app.ts": "export const state = 'first';\n" });
  const fileId = f.view.list()[0]!.fileId;
  await writeFile(join(f.source, "app.ts"), "export const state = 'second';\n");
  assert.match(f.view.read(fileId, 1).content, /first/);
  assert.equal(await f.index.open(f.sealed.ref), f.view);
  const next = await f.snapshots.seal({ sourceDirectory: f.source, sourceSha: "second", packetId: "p2", parent: f.sealed.ref });
  const view = await f.index.open(next.ref);
  assert.notEqual(view, f.view);
  assert.match(view.read(view.list()[0]!.fileId, 1).content, /second/);
});

test("source reads return explicit truncation and continue from a named line", async t => {
  const f = await fixture(t, { "large.ts": Array.from({ length: 500 }, (_, i) => `export const item${i} = '${"x".repeat(100)}';`).join("\n") });
  const fileId = f.view.list()[0]!.fileId;
  const result = f.view.read(fileId, 1, 500);
  assert(result.truncated); assert(result.content.length <= 12_000);
  assert.equal(result.nextLine, result.endLine + 1);
  const next = f.view.read(fileId, result.nextLine!, 1);
  assert(next.content.startsWith(`${result.nextLine}: `));
  assert.equal(next.truncated, false);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(f.index.open(f.sealed.ref, aborted.signal), /abort/i);
});
