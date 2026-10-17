import { randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { NON_APPLICATION_METADATA } from "./controller-metadata.js";
import { atomicWrite, canonicalJson, contentDigest, hashBytes } from "./checker/artifacts.js";
import type { ContentRef } from "./checker/port.js";

export interface SnapshotFile { path: string; digest: string; bytes: number; mode: number }
export interface SnapshotManifest {
  schemaVersion: 1;
  snapshotId: string;
  sourceSha: string;
  packetId: string;
  parent?: ContentRef;
  inputDigest: string;
  files: SnapshotFile[];
}
export interface SealedSnapshot { ref: ContentRef; manifest: SnapshotManifest; sourceDirectory: string }
export interface SealSnapshotInput {
  sourceDirectory: string;
  sourceSha: string;
  packetId: string;
  parent?: ContentRef;
  generatedPaths?: readonly string[];
  /** Data baselines remain inputs even when also declared as generated runtime directories. */
  dataPaths?: readonly string[];
  signal?: AbortSignal;
}
export interface RestoreSnapshotOptions { generatedPaths?: readonly string[]; dataPaths?: readonly string[]; signal?: AbortSignal }
function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\"));
}
function safeRelative(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/$/, "");
  if (!normalized || isAbsolute(path) || /^[a-z]:/i.test(path) || normalized.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Snapshot input path must remain inside the application");
  return normalized;
}
async function destinationPath(path: string): Promise<string> {
  let existing = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try { return resolve(await realpath(existing), ...missing); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(existing) === existing) throw error;
      missing.unshift(basename(existing)); existing = dirname(existing);
    }
  }
}

/**
 * Seals exact bytes from a paused writer. Published copies are never reused as build directories.
 * Reads verify the complete manifest; tampering or accidental writes fail before execution.
 */
export class SnapshotStore {
  readonly directory: string;
  constructor(directory: string) { this.directory = resolve(directory); }
  async seal(input: SealSnapshotInput): Promise<SealedSnapshot> {
    input.signal?.throwIfAborted();
    const source = await realpath(input.sourceDirectory);
    const destination = await destinationPath(this.directory);
    if (inside(source, destination) || inside(destination, source)) throw new Error("Snapshot store must be outside the application workspace");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const store = await realpath(this.directory);
    if ((await lstat(this.directory)).isSymbolicLink() || inside(source, store) || inside(store, source)) throw new Error("Snapshot store must be outside the application workspace");
    if (input.parent) await this.open(input.parent);
    const generated = (input.generatedPaths ?? []).map(safeRelative);
    const data = (input.dataPaths ?? []).map(safeRelative);
    const files = await collect(source, generated, data, input.signal);
    const temporary = join(store, ".sealing-" + randomUUID());
    await mkdir(join(temporary, "source"), { recursive: true, mode: 0o700 });
    try {
      for (const file of files) {
        input.signal?.throwIfAborted();
        const target = join(temporary, "source", file.path);
        await mkdir(resolve(target, ".."), { recursive: true });
        await copyFile(join(source, file.path), target);
        await chmod(target, 0o600 | file.mode);
      }
      const copied = await collect(join(temporary, "source"), [], [], input.signal, false);
      const after = await collect(source, generated, data, input.signal);
      if (canonicalJson(files) !== canonicalJson(copied) || canonicalJson(files) !== canonicalJson(after)) throw new Error("Application changed while sealing snapshot");
      const manifest: SnapshotManifest = { schemaVersion: 1, snapshotId: randomUUID(), sourceSha: input.sourceSha,
        packetId: input.packetId, ...(input.parent ? { parent: input.parent } : {}), inputDigest: contentDigest(files), files };
      const digest = contentDigest(manifest), ref = { id: digest, digest };
      await atomicWrite(join(temporary, "manifest.json"), canonicalJson(manifest));
      input.signal?.throwIfAborted();
      await rename(temporary, join(store, digest));
      return { ref, manifest, sourceDirectory: join(store, digest, "source") };
    } catch (error) {
      // The temporary path is a literal child generated above, never an application input.
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }
  async open(ref: ContentRef): Promise<SealedSnapshot> {
    if (!/^[a-f0-9]{64}$/.test(ref.digest) || ref.id !== ref.digest) throw new Error("Invalid snapshot reference");
    const path = join(this.directory, ref.id);
    const root = await realpath(this.directory);
    if ((await lstat(path)).isSymbolicLink() || !inside(root, await realpath(path))) throw new Error("Invalid snapshot directory");
    const bytes = await readFile(join(path, "manifest.json"));
    if (hashBytes(bytes) !== ref.digest) throw new Error("Snapshot manifest integrity mismatch");
    const manifest = JSON.parse(bytes.toString("utf8")) as SnapshotManifest;
    if (manifest.schemaVersion !== 1 || manifest.inputDigest !== contentDigest(manifest.files)) throw new Error("Invalid snapshot manifest");
    const sourceDirectory = join(path, "source");
    if ((await lstat(sourceDirectory)).isSymbolicLink()) throw new Error("Snapshot source must be a real directory");
    const actual = await collect(sourceDirectory, [], [], undefined, false);
    if (canonicalJson(actual) !== canonicalJson(manifest.files)) throw new Error("Snapshot source integrity mismatch");
    return { ref, manifest, sourceDirectory };
  }
  /** Read-only check that the delivered or resumed workspace still has these exact application inputs. */
  async assertMatches(ref: ContentRef, targetDirectory: string, options: RestoreSnapshotOptions = {}): Promise<void> {
    options.signal?.throwIfAborted();
    const sealed = await this.open(ref);
    if ((await lstat(resolve(targetDirectory))).isSymbolicLink()) throw new Error("Application workspace must be a real directory");
    const target = await realpath(targetDirectory);
    const actual = await collect(target, (options.generatedPaths ?? []).map(safeRelative), (options.dataPaths ?? []).map(safeRelative), options.signal);
    if (canonicalJson(actual) !== canonicalJson(sealed.manifest.files)) throw new Error("Application workspace does not match sealed snapshot inputs");
  }
  /** Restore application inputs after the sole writer has stopped; Git/index handling belongs to the caller. */
  async restore(ref: ContentRef, targetDirectory: string, options: RestoreSnapshotOptions = {}): Promise<void> {
    options.signal?.throwIfAborted();
    const sealed = await this.open(ref);
    const target = await realpath(targetDirectory), store = await realpath(this.directory);
    if ((await lstat(resolve(targetDirectory))).isSymbolicLink() || inside(store, target) || inside(target, store)) throw new Error("Restore target must be separate from the snapshot store");
    const generated = (options.generatedPaths ?? []).map(safeRelative), data = (options.dataPaths ?? []).map(safeRelative);
    // Preflight the complete affected input tree before deleting or overwriting anything.
    const current = await collect(target, generated, data, options.signal);
    const expected = new Map(sealed.manifest.files.map(file => [file.path, file]));
    for (const file of current) {
      options.signal?.throwIfAborted();
      if (!expected.has(file.path)) await rm(join(target, file.path));
    }
    await pruneEmptyInputs(target, generated, data);
    for (const file of sealed.manifest.files) {
      options.signal?.throwIfAborted();
      const path = join(target, safeRelative(file.path));
      const existing = await lstat(path).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return undefined;
        throw error;
      });
      if (existing?.isDirectory()) {
        // A directory occupying an input file may contain preserved generated files. Refuse to remove those.
        await rmdir(path);
      }
      await mkdir(dirname(path), { recursive: true });
      await copyFile(join(sealed.sourceDirectory, file.path), path);
      await chmod(path, 0o600 | file.mode);
    }
    const restored = await collect(target, generated, data, options.signal);
    if (canonicalJson(restored) !== canonicalJson(sealed.manifest.files)) throw new Error("Restored application does not match snapshot inputs");
    await this.open(ref);
  }
}

function excluded(path: string, generated: readonly string[], data: readonly string[]): boolean {
  const parts = path.split("/");
  if (parts.includes("node_modules") || NON_APPLICATION_METADATA.has(parts[0])) return true;
  return generated.some(item => path === item || path.startsWith(item + "/")) &&
    !data.some(item => path === item || path.startsWith(item + "/") || item.startsWith(path + "/"));
}
async function pruneEmptyInputs(root: string, generated: readonly string[], data: readonly string[], prefix = ""): Promise<void> {
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? prefix + "/" + entry.name : entry.name;
    if (!entry.isDirectory() || excluded(path, generated, data)) continue;
    await pruneEmptyInputs(root, generated, data, path);
    await rmdir(join(root, path)).catch(error => {
      if (!["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    });
  }
}

async function collect(root: string, generated: readonly string[], data: readonly string[], signal?: AbortSignal, excludePrivate = true): Promise<SnapshotFile[]> {
  const files: SnapshotFile[] = [];
  async function visit(directory: string, prefix = ""): Promise<void> {
    signal?.throwIfAborted();
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = prefix ? prefix + "/" + entry.name : entry.name;
      if (excludePrivate && excluded(path, generated, data)) continue;
      const absolute = join(directory, entry.name);
      const before = await lstat(absolute);
      if (before.isSymbolicLink()) throw new Error("Application links are not supported: " + path);
      if (before.isDirectory()) await visit(absolute, path);
      else if (before.isFile()) {
        const content = await readFile(absolute), after = await lstat(absolute);
        if (!after.isFile() || before.ctimeMs !== after.ctimeMs || before.size !== after.size || before.mode !== after.mode || before.ino !== after.ino) throw new Error("Application changed while sealing snapshot");
        files.push({ path, digest: hashBytes(content), bytes: content.length, mode: before.mode & 0o111 });
      } else throw new Error("Unsupported application file: " + path);
    }
  }
  await visit(root);
  return files;
}
