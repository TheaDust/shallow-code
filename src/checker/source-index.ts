import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { SealedSnapshot, SnapshotStore } from "../snapshot-store.js";
import { NON_APPLICATION_METADATA } from "../controller-metadata.js";
import type { ContentRef } from "./port.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".py", ".pyi", ".go", ".rs", ".java", ".kt", ".cs", ".php", ".rb", ".vue", ".svelte", ".html", ".css", ".scss", ".sass", ".less", ".sql"]);
const TEST_DIRECTORIES = new Set(["test", "tests", "__tests__", "__snapshots__", "e2e", "cypress"]);
const TEST_FILE = /\.(?:test|spec)\.[^.]+$|^(?:test_.+|.+_test)\.py$|_test\.go$|^(?:vitest|jest|playwright|cypress)\.config\./i;
const READ_CHARACTERS = 12_000;
const DEFAULT_TREE_DEPTH = 3;
const DEFAULT_TREE_LIMIT = 200;
export const SOURCE_TREE_MAX_DEPTH = 10;
export const SOURCE_TREE_MAX_LIMIT = 500;

/** Only generated output and persisted data are hidden from Checker source lookup.
 * dependencyPaths describe application roots whose manifests provide dependency
 * inputs; they are not source exclusions.
 */
export function checkerSourceExclusions(contract: { generatedPaths?: readonly string[]; dataPaths?: readonly string[] }): string[] {
  return [...contract.generatedPaths ?? [], ...contract.dataPaths ?? []];
}

export interface SourceFile { fileId: string; path: string; lineCount: number }
export interface SourceTreeEntry {
  path: string;
  kind: "directory" | "file";
  depth: number;
  fileCount?: number;
  fileId?: string;
  lineCount?: number;
}
export interface SourceTreePage { entries: SourceTreeEntry[]; truncated: boolean }
export interface SourceExcerpt {
  snapshot: ContentRef;
  fileId: string;
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  truncated: boolean;
  partialLine?: boolean;
  nextLine?: number;
}
interface IndexedFile { metadata: SourceFile; lines: string[] }

function sourcePath(path: string, excluded: readonly string[]): boolean {
  const parts = path.split("/"), name = parts.at(-1)!;
  return SOURCE_EXTENSIONS.has(extname(name).toLowerCase())
    && !NON_APPLICATION_METADATA.has(parts[0]!)
    && !parts.some(part => part === "node_modules" || TEST_DIRECTORIES.has(part.toLowerCase()))
    && !TEST_FILE.test(name)
    && !excluded.some(item => path === item || path.startsWith(item + "/"));
}
function sourceLines(text: string): string[] {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
function queryTerms(terms: readonly string[]): string[] {
  const values = [...new Set(terms.map(term => term.trim().toLowerCase()).filter(Boolean))];
  if (!values.length) throw new Error("Source search requires nonempty literal terms");
  return values;
}

/** Read-only source structure and text from one sealed snapshot. Lookups never become behavior evidence. */
export class CheckerSourceView {
  constructor(readonly snapshot: ContentRef, private readonly files: IndexedFile[]) {}

  list(): SourceFile[] { return this.files.map(file => file.metadata); }

  tree(pathPrefix?: string, depth = DEFAULT_TREE_DEPTH, limit = DEFAULT_TREE_LIMIT): SourceTreePage {
    if (!Number.isInteger(depth) || depth < 1 || depth > SOURCE_TREE_MAX_DEPTH)
      throw new Error(`Source tree depth requires an integer from 1 to ${SOURCE_TREE_MAX_DEPTH}`);
    if (!Number.isInteger(limit) || limit < 1 || limit > SOURCE_TREE_MAX_LIMIT)
      throw new Error(`Source tree limit requires an integer from 1 to ${SOURCE_TREE_MAX_LIMIT}`);
    const raw = pathPrefix?.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, "") ?? "";
    const prefix = raw === "." ? "" : raw;
    const files = this.files.map(file => file.metadata)
      .filter(file => !prefix || file.path === prefix || file.path.startsWith(prefix + "/"));
    if (!files.length) return { entries: [], truncated: false };
    const directoryCounts = new Map<string, number>();
    const entries = new Map<string, SourceTreeEntry>();
    for (const file of files) {
      if (prefix && file.path === prefix) {
        entries.set(file.path, { path: file.path, kind: "file", depth: 0, fileId: file.fileId, lineCount: file.lineCount });
        continue;
      }
      const relative = prefix ? file.path.slice(prefix.length + 1) : file.path;
      const segments = relative.split("/");
      for (let index = 1; index < segments.length; index++) {
        const relativeDirectory = segments.slice(0, index).join("/");
        const path = prefix ? `${prefix}/${relativeDirectory}` : relativeDirectory;
        directoryCounts.set(path, (directoryCounts.get(path) ?? 0) + 1);
        if (index <= depth && !entries.has(path)) entries.set(path, { path, kind: "directory", depth: index });
      }
      if (segments.length <= depth) entries.set(file.path, { path: file.path, kind: "file", depth: segments.length,
        fileId: file.fileId, lineCount: file.lineCount });
    }
    for (const [path, fileCount] of directoryCounts) {
      const entry = entries.get(path);
      if (entry) entry.fileCount = fileCount;
    }
    const sorted = [...entries.values()].sort((left, right) => left.path.localeCompare(right.path, "en"));
    return { entries: sorted.slice(0, limit), truncated: sorted.length > limit };
  }

  search(terms: readonly string[], pathPrefix?: string) {
    const query = queryTerms(terms);
    const prefix = pathPrefix?.replaceAll("\\", "/").replace(/\/$/, "");
    const matches = this.files.flatMap(({ metadata, lines }) => {
      if (prefix && metadata.path !== prefix && !metadata.path.startsWith(prefix + "/")) return [];
      const allHits = lines.flatMap((text, index) => query.some(term => text.toLowerCase().includes(term))
        ? [{ line: index + 1, text: text.slice(0, 200), truncated: text.length > 200 }] : []);
      const hits = allHits.slice(0, 3);
      const score = (hits.length ? 2 : 0) + (query.some(term => metadata.path.toLowerCase().includes(term)) ? 1 : 0);
      return score ? [{ metadata, hits, score, hitsTruncated: allHits.length > 3 }] : [];
    }).sort((left, right) => right.score - left.score || left.metadata.path.localeCompare(right.metadata.path, "en"));
    return { truncated: matches.length > 5, matches: matches.slice(0, 5).map(({ metadata, hits, hitsTruncated }) =>
      ({ ...metadata, hits, ...(hitsTruncated ? { hitsTruncated: true } : {}) })) };
  }

  read(fileId: string, startLine: number, lineCount = 80): SourceExcerpt {
    const file = this.files.find(item => item.metadata.fileId === fileId);
    if (!file) throw new Error("Source fileId is not in this snapshot index");
    const { metadata, lines } = file;
    if (!Number.isInteger(startLine) || startLine < 1 || startLine > Math.max(1, lines.length)
      || !Number.isInteger(lineCount) || lineCount < 1) throw new Error("Source range requires valid positive line numbers");
    const requestedEnd = Math.min(lines.length, startLine - 1 + lineCount);
    const selected: string[] = [];
    let characters = 0, endLine = startLine - 1, partialLine = false;
    for (let index = startLine - 1; index < requestedEnd; index++) {
      const line = `${index + 1}: ${lines[index]}`;
      if (characters + line.length + 1 > READ_CHARACTERS) {
        if (!selected.length) { selected.push(line.slice(0, READ_CHARACTERS)); endLine = index + 1; partialLine = true; }
        break;
      }
      selected.push(line); characters += line.length + 1; endLine = index + 1;
    }
    return { snapshot: this.snapshot, fileId, path: metadata.path, startLine, endLine,
      content: selected.join("\n"), truncated: partialLine || endLine < requestedEnd,
      ...(partialLine ? { partialLine: true } : endLine < requestedEnd ? { nextLine: endLine + 1 } : {}) };
  }
}

/** Builds a local index from verified immutable inputs, independent of the application adapter. */
export class CheckerSourceIndex {
  private readonly cache = new Map<string, Promise<CheckerSourceView>>();
  constructor(private readonly snapshots: SnapshotStore, private readonly excludedPaths: readonly string[] = []) {}

  async open(snapshot: ContentRef, signal?: AbortSignal): Promise<CheckerSourceView> {
    signal?.throwIfAborted();
    const sealed = await this.snapshots.open(snapshot);
    let indexed = this.cache.get(snapshot.digest);
    if (!indexed) { indexed = this.build(sealed); this.cache.set(snapshot.digest, indexed); }
    try { const view = await indexed; signal?.throwIfAborted(); return view; }
    catch (error) { this.cache.delete(snapshot.digest); throw error; }
  }

  private async build(sealed: SealedSnapshot): Promise<CheckerSourceView> {
    const excluded = this.excludedPaths.map(path => path.replaceAll("\\", "/").replace(/\/$/, ""));
    const files: IndexedFile[] = [];
    for (const file of sealed.manifest.files.filter(file => sourcePath(file.path, excluded))) {
      const bytes = await readFile(join(sealed.sourceDirectory, file.path));
      if (bytes.includes(0)) continue;
      const lines = sourceLines(bytes.toString("utf8"));
      files.push({ metadata: { fileId: `f${files.length + 1}`, path: file.path, lineCount: lines.length }, lines });
    }
    return new CheckerSourceView(sealed.ref, files);
  }
}
