import { copyFile, lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Conventional delivery locations used when SHALLOW_DATA_DIR is absent. */
const DEFAULT_DATA_PATHS = ["backend/data", "backend/.data"] as const;

export interface InheritedDataCopy {
  source?: string;
  files: number;
}

/**
 * Seed an isolated execution directory from the delivery's existing default
 * persistence. The application still owns migrations and current seed data;
 * the controller only presents an untouched inherited-state copy.
 */
export async function copyInheritedData(applicationRoot: string, target: string): Promise<InheritedDataCopy> {
  const sources: string[] = [];
  for (const relative of DEFAULT_DATA_PATHS) {
    const absolute = join(applicationRoot, relative);
    const stat = await lstat(absolute).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Inherited data path must be a real directory: ${relative}`);
    }
    sources.push(relative);
  }
  if (sources.length > 1) {
    throw new Error(`Multiple default data directories are ambiguous: ${sources.join(", ")}`);
  }
  await mkdir(target, { recursive: true, mode: 0o700 });
  if (sources.length === 0) return { files: 0 };
  let files = 0;
  const source = sources[0];
  async function copyDirectory(from: string, to: string): Promise<void> {
    await mkdir(to, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(from, { withFileTypes: true })) {
      const sourcePath = join(from, entry.name);
      const targetPath = join(to, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Inherited data links are not supported: ${source}/${entry.name}`);
      if (entry.isDirectory()) await copyDirectory(sourcePath, targetPath);
      else if (entry.isFile()) { await copyFile(sourcePath, targetPath); files++; }
      else throw new Error(`Unsupported inherited data entry: ${source}/${entry.name}`);
    }
  }
  await copyDirectory(join(applicationRoot, source), target);
  return { source, files };
}
