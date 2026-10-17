import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SnapshotStore } from "../src/snapshot-store.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "snapshot-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "app"); await mkdir(source);
  return { root, source, store: new SnapshotStore(join(root, "snapshots")) };
}

test("snapshot preserves untracked binary and CRLF inputs independently of later Builder edits", async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, "new.ts"), "line1\r\nline2\r\n");
  await writeFile(join(f.source, "asset.bin"), Buffer.from([0, 255, 13, 10]));
  await chmod(join(f.source, "new.ts"), 0o755);
  await mkdir(join(f.source, ".requirements-agent")); await writeFile(join(f.source, ".requirements-agent", "secret"), "secret");
  await mkdir(join(f.source, "node_modules")); await writeFile(join(f.source, "node_modules", "ignored"), "dependency");
  await mkdir(join(f.source, "dist")); await writeFile(join(f.source, "dist", "ignored"), "build");
  const sealed = await f.store.seal({ sourceDirectory: f.source, sourceSha: "sha1", packetId: "p", generatedPaths: ["dist"] });
  assert.deepEqual(sealed.manifest.files.map(file => file.path), ["asset.bin", "new.ts"]);
  await writeFile(join(f.source, "new.ts"), "later");
  assert.equal(await readFile(join(sealed.sourceDirectory, "new.ts"), "utf8"), "line1\r\nline2\r\n");
  assert.deepEqual(await readFile(join(sealed.sourceDirectory, "asset.bin")), Buffer.from([0, 255, 13, 10]));
  await f.store.open(sealed.ref);
  const next = await f.store.seal({ sourceDirectory: f.source, sourceSha: "sha2", packetId: "p2", parent: sealed.ref });
  assert.deepEqual(next.manifest.parent, sealed.ref);
  assert.notEqual(next.ref.digest, sealed.ref.digest);
});

test("inherited baseline data remains immutable even when runtime data is generated", async t => {
  const f = await fixture(t);
  await mkdir(join(f.source, "data")); await writeFile(join(f.source, "data", "db.bin"), "baseline");
  const snapshot = await f.store.seal({ sourceDirectory: f.source, sourceSha: "s", packetId: "p", generatedPaths: ["data"], dataPaths: ["data"] });
  assert.equal(await readFile(join(snapshot.sourceDirectory, "data", "db.bin"), "utf8"), "baseline");
  await writeFile(join(f.source, "data", "db.bin"), "mutated");
  await f.store.open(snapshot.ref);
  await writeFile(join(snapshot.sourceDirectory, "data", "db.bin"), "tampered");
  await assert.rejects(f.store.open(snapshot.ref), /source integrity/);
});

test("snapshot rejects in-workspace stores and traversal; manifest and unexpected private files are checked", async t => {
  const f = await fixture(t); await writeFile(join(f.source, "app.ts"), "source");
  await assert.rejects(new SnapshotStore(join(f.source, "private")).seal({ sourceDirectory: f.source, sourceSha: "s", packetId: "p" }), /outside/);
  await assert.rejects(f.store.seal({ sourceDirectory: f.source, sourceSha: "s", packetId: "p", generatedPaths: ["../outside"] }), /inside/);
  await assert.rejects(readFile(join(f.source, "private")), /ENOENT/);
  const sealed = await f.store.seal({ sourceDirectory: f.source, sourceSha: "s", packetId: "p" });
  await mkdir(join(sealed.sourceDirectory, ".git")); await writeFile(join(sealed.sourceDirectory, ".git", "unexpected"), "input");
  await assert.rejects(f.store.open(sealed.ref), /source integrity/);
  await rm(join(sealed.sourceDirectory, ".git"), { recursive: true });
  await writeFile(join(f.store.directory, sealed.ref.id, "manifest.json"), "{}");
  await assert.rejects(f.store.open(sealed.ref), /manifest integrity/);
});

test("snapshot rejects links instead of following application files outside the workspace", async t => {
  const f = await fixture(t); const outside = join(f.root, "outside"); await mkdir(outside);
  await symlink(outside, join(f.source, "linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.store.seal({ sourceDirectory: f.source, sourceSha: "s", packetId: "p" }), /links/);
});

test("a writer changing inputs during sealing cannot publish a mixed-version snapshot", async t => {
  const f = await fixture(t);
  for (let index = 0; index < 80; index++) await writeFile(join(f.source, `file-${index}.bin`), Buffer.alloc(4096, index));
  const changing = join(f.source, "zz-changing.log"); await writeFile(changing, "");
  const writer = setInterval(() => appendFileSync(changing, "changed\n"), 1);
  try {
    await assert.rejects(f.store.seal({ sourceDirectory: f.source, sourceSha: "s", packetId: "p" }), /changed while sealing/);
  } finally { clearInterval(writer); }
  assert.ok((await readFile(changing)).length > 0);
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual(await readdir(f.store.directory), []);
});

test("restore reinstates exact ignored data and source while preserving private metadata, dependencies and generated outputs", async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, ".gitignore"), "data/\n");
  await writeFile(join(f.source, "app.ts"), "baseline\r\n");
  await mkdir(join(f.source, "data")); await writeFile(join(f.source, "data", "db.bin"), Buffer.from([0, 255]));
  const sealed = await f.store.seal({ sourceDirectory: f.source, sourceSha: "s", packetId: "p", generatedPaths: ["data", "dist"], dataPaths: ["data"] });
  await writeFile(join(f.source, "app.ts"), "rejected repair"); await writeFile(join(f.source, "new.ts"), "new input");
  await writeFile(join(f.source, "data", "db.bin"), "changed data"); await writeFile(join(f.source, "data", "new.bin"), "new data");
  for (const directory of ["dist", "node_modules", ".git", ".requirements-agent"]) {
    await mkdir(join(f.source, directory)); await writeFile(join(f.source, directory, "preserved"), directory);
  }
  await f.store.restore(sealed.ref, f.source, { generatedPaths: ["data", "dist"], dataPaths: ["data"] });
  assert.equal(await readFile(join(f.source, "app.ts"), "utf8"), "baseline\r\n");
  assert.deepEqual(await readFile(join(f.source, "data", "db.bin")), Buffer.from([0, 255]));
  await assert.rejects(readFile(join(f.source, "new.ts")), /ENOENT/);
  await assert.rejects(readFile(join(f.source, "data", "new.bin")), /ENOENT/);
  for (const directory of ["dist", "node_modules", ".git", ".requirements-agent"]) assert.equal(await readFile(join(f.source, directory, "preserved"), "utf8"), directory);
});

test("restore rejects application symlinks before modifying any target input", async t => {
  const f = await fixture(t); await writeFile(join(f.source, "app.ts"), "baseline");
  const sealed = await f.store.seal({ sourceDirectory: f.source, sourceSha: "s", packetId: "p" });
  await writeFile(join(f.source, "app.ts"), "current");
  const outside = join(f.root, "outside"); await mkdir(outside);
  await symlink(outside, join(f.source, "linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.store.restore(sealed.ref, f.source), /links/);
  assert.equal(await readFile(join(f.source, "app.ts"), "utf8"), "current");
  await assert.rejects(f.store.restore(sealed.ref, sealed.sourceDirectory), /separate/);
});

test("restore handles input file/directory replacements introduced by a rejected repair", async t => {
  const f = await fixture(t); await writeFile(join(f.source, "old-file"), "baseline file");
  await mkdir(join(f.source, "old-directory")); await writeFile(join(f.source, "old-directory", "source"), "baseline child");
  const sealed = await f.store.seal({ sourceDirectory: f.source, sourceSha: "s", packetId: "p" });
  await rm(join(f.source, "old-file")); await mkdir(join(f.source, "old-file", "nested"), { recursive: true });
  await writeFile(join(f.source, "old-file", "nested", "repair"), "extra");
  await rm(join(f.source, "old-directory"), { recursive: true }); await writeFile(join(f.source, "old-directory"), "changed shape");
  await f.store.restore(sealed.ref, f.source);
  assert.equal(await readFile(join(f.source, "old-file"), "utf8"), "baseline file");
  assert.equal(await readFile(join(f.source, "old-directory", "source"), "utf8"), "baseline child");
});

test("read-only input comparison detects external source and inherited-data drift", async t => {
  const f = await fixture(t); await writeFile(join(f.source, "app.ts"), "source\r\n");
  await mkdir(join(f.source, "data")); await writeFile(join(f.source, "data", "db.bin"), Buffer.from([0, 255]));
  const options = { generatedPaths: ["dist", "data"], dataPaths: ["data"] };
  const sealed = await f.store.seal({ sourceDirectory: f.source, sourceSha: "s", packetId: "p", ...options });
  await f.store.assertMatches(sealed.ref, f.source, options);
  await mkdir(join(f.source, "dist")); await writeFile(join(f.source, "dist", "generated"), "ignored output");
  await f.store.assertMatches(sealed.ref, f.source, options);
  await writeFile(join(f.source, "data", "db.bin"), "drift");
  await assert.rejects(f.store.assertMatches(sealed.ref, f.source, options), /does not match/);
  assert.equal(await readFile(join(f.source, "data", "db.bin"), "utf8"), "drift");
  await f.store.restore(sealed.ref, f.source, options);
  await writeFile(join(f.source, "untracked.ts"), "external input");
  await assert.rejects(f.store.assertMatches(sealed.ref, f.source, options), /does not match/);
});
