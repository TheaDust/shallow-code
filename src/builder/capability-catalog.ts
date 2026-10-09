import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export type CapabilityStatus = "available" | "installed" | "partial" | "conflict";

export interface ApprovedCapability {
  id: string;
  description: string;
  targetDirectory: string;
  files: readonly string[];
  usage: string;
}

export interface CapabilityInspection extends ApprovedCapability {
  status: CapabilityStatus;
  installedFiles: string[];
  missingFiles: string[];
  conflictingFiles: string[];
}

export interface CapabilityInstallResult extends CapabilityInspection {
  copiedFiles: string[];
}

const UI_FILES = [
  "Button.tsx",
  "Combobox.tsx",
  "Dialog.tsx",
  "FormField.tsx",
  "Menu.tsx",
  "Tabs.tsx",
  "Toast.tsx",
  "index.ts",
  "primitives.css",
] as const;

export const APPROVED_CAPABILITIES: readonly ApprovedCapability[] = [
  {
    id: "accessible-ui",
    description: "Dependency-free React primitives for accessible buttons, native modal dialogs, menus, tabs, form fields, native comboboxes and live-region notifications.",
    targetDirectory: "frontend/src/ui",
    files: UI_FILES,
    usage: "Import components from frontend/src/ui and import ./ui/primitives.css once from the frontend entry point or global stylesheet. Dialog unmounts its content when closed; existing copies require an in-place Builder update. Consumers decide whether a successful save closes a dialog or returns to its updated management list.",
  },
] as const;

const DEFAULT_ASSET_ROOT = fileURLToPath(
  new URL("../../scaffold/minimal-web/frontend/src/ui/", import.meta.url),
);

export async function inspectCapability(
  outputDir: string,
  id: string,
  assetRoot = DEFAULT_ASSET_ROOT,
): Promise<CapabilityInspection> {
  const capability = capabilityById(id);
  const installedFiles: string[] = [];
  const missingFiles: string[] = [];
  const conflictingFiles: string[] = [];
  for (const file of capability.files) {
    const source = join(assetRoot, file);
    const target = join(outputDir, capability.targetDirectory, file);
    if (!(await exists(target))) {
      missingFiles.push(file);
      continue;
    }
    const [sourceContent, targetContent] = await Promise.all([readFile(source), readFile(target)]);
    if (sourceContent.equals(targetContent)) installedFiles.push(file);
    else conflictingFiles.push(file);
  }
  const status: CapabilityStatus = conflictingFiles.length > 0
    ? "conflict"
    : missingFiles.length === 0
      ? "installed"
      : installedFiles.length > 0
        ? "partial"
        : "available";
  return { ...capability, status, installedFiles, missingFiles, conflictingFiles };
}

export async function listCapabilities(
  outputDir: string,
  assetRoot = DEFAULT_ASSET_ROOT,
): Promise<CapabilityInspection[]> {
  return Promise.all(APPROVED_CAPABILITIES.map(capability => inspectCapability(outputDir, capability.id, assetRoot)));
}

export async function installCapability(
  outputDir: string,
  id: string,
  assetRoot = DEFAULT_ASSET_ROOT,
): Promise<CapabilityInstallResult> {
  const before = await inspectCapability(outputDir, id, assetRoot);
  if (before.conflictingFiles.length > 0) {
    throw new Error(
      `Capability ${id} would overwrite existing files: ${before.conflictingFiles.join(", ")}. ` +
      "Preserve the existing implementation or move it explicitly before retrying.",
    );
  }
  const frontendSource = join(outputDir, "frontend", "src");
  if (!(await isDirectory(frontendSource))) {
    throw new Error("Capability installation requires an existing frontend/src directory");
  }
  const targetDirectory = join(outputDir, before.targetDirectory);
  await mkdir(targetDirectory, { recursive: true });
  const copiedFiles: string[] = [];
  for (const file of before.missingFiles) {
    await copyFile(join(assetRoot, file), join(targetDirectory, file));
    copiedFiles.push(`${before.targetDirectory}/${file}`);
  }
  return { ...await inspectCapability(outputDir, id, assetRoot), copiedFiles };
}

function capabilityById(id: string): ApprovedCapability {
  const capability = APPROVED_CAPABILITIES.find(entry => entry.id === id);
  if (!capability) {
    throw new Error(`Unknown capability ${JSON.stringify(id)}. Approved ids: ${APPROVED_CAPABILITIES.map(entry => entry.id).join(", ")}`);
  }
  return capability;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
