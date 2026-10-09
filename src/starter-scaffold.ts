import { cp, readdir, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, join, resolve } from "node:path";

import type { PlatformContract } from "./types.js";

export type StarterScaffoldStatus =
  | "installed"
  | "skipped_existing_application"
  | "skipped_nonempty_output";

export interface StarterScaffoldResult {
  status: StarterScaffoldStatus;
  reason: string;
  files: string[];
}

const EMPTY_OUTPUT_METADATA = new Set([
  ".arc",
  ".git",
  ".gitignore",
  "requirements",
  "shallow-progress",
]);
const SCAFFOLD_RUNTIME_ARTIFACTS = new Set(["node_modules", "dist", "build"]);

/**
 * Installs only the task-neutral platform shell, accessible UI primitives and
 * unconnected infrastructure helpers. Business navigation, API routes, domain
 * data, composed product views and requirement behavior remain Builder-owned.
 */
export async function installStarterScaffold(
  outputDir: string,
  contract: PlatformContract,
  assetRoot = fileURLToPath(new URL("../scaffold/minimal-web/", import.meta.url)),
): Promise<StarterScaffoldResult> {
  const root = resolve(outputDir);
  const entries = await readdir(root);
  const [frontendExists, backendExists] = await Promise.all([
    isDirectory(join(root, "frontend")),
    isDirectory(join(root, "backend")),
  ]);
  if (frontendExists && backendExists) {
    return {
      status: "skipped_existing_application",
      reason: "frontend and backend already exist",
      files: [],
    };
  }

  const applicationEntries = entries.filter(name => !EMPTY_OUTPUT_METADATA.has(name));
  if (frontendExists || backendExists || applicationEntries.length > 0) {
    return {
      status: "skipped_nonempty_output",
      reason: frontendExists || backendExists
        ? "partial frontend/backend layout already exists"
        : `output contains existing project files: ${applicationEntries.slice(0, 5).join(", ")}`,
      files: [],
    };
  }

  await cp(join(assetRoot, "frontend"), join(root, "frontend"), {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: source => !SCAFFOLD_RUNTIME_ARTIFACTS.has(basename(source)),
  });
  await cp(join(assetRoot, "backend"), join(root, "backend"), {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: source => !SCAFFOLD_RUNTIME_ARTIFACTS.has(basename(source)),
  });
  await writeFile(
    join(root, "backend", "src", "platform-ports.json"),
    `${JSON.stringify(contract.extraPorts ?? [], null, 2)}\n`,
    "utf8",
  );
  const files = await listFiles(root, ["frontend", "backend"]);
  return {
    status: "installed",
    reason: "installed task-neutral web capability and platform shell",
    files,
  };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function listFiles(root: string, directories: string[]): Promise<string[]> {
  const files: string[] = [];
  const visit = async (relative: string): Promise<void> => {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  for (const directory of directories) await visit(directory);
  return files.sort();
}
