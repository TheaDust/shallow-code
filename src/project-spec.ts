import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { ApplicationContract, ProcessCommand } from "./application/port.js";

/** Project run description, loaded next to (and independently of) requirements.yaml. */
export const PROJECT_SPEC_FILENAME = "shallowcode.config.json";
export const DEFAULT_BUILD_TIMEOUT_MS = 180_000;
export const DEFAULT_START_TIMEOUT_MS = 30_000;
export const DEFAULT_TEST_TIMEOUT_MS = 600_000;

/**
 * A command the project declares. `cwd` is project-relative and may name any
 * directory: no phase of the pipeline may assume a fixed frontend/backend split.
 */
export interface ProjectCommand {
  executable: string;
  args?: string[];
  /** Project-relative working directory; absent or "." means the project root. */
  cwd?: string;
  /** Per-command timeout in milliseconds; falls back to the phase default. */
  timeoutMs?: number;
}

/** A development test target the Builder may run through run_tests. */
export interface ProjectTestTarget extends ProjectCommand {
  id: string;
}

export interface ProjectSpec {
  install?: ProjectCommand[];
  build?: ProjectCommand[];
  tests?: ProjectTestTarget[];
  start: ProjectCommand;
  env?: Record<string, string>;
  adapter?: string;
  adapterConfig?: unknown;
  /** Project-relative directories whose manifests define the dependency inputs. */
  dependencyPaths?: string[];
  /** Project-relative directories that are generated output and never source. */
  generatedPaths?: string[];
  /** Project-relative directories seeded into each isolated execution directory. */
  dataPaths?: string[];
  /** Environment variable through which the application accepts its isolated data directory. */
  dataEnvVar?: string;
}

/** Read and validate the project run description for `projectRoot`. */
export async function loadProjectSpec(
  projectRoot: string,
  filename = PROJECT_SPEC_FILENAME,
  parser: (raw: unknown, origin: string) => ProjectSpec = parseProjectSpec,
): Promise<ProjectSpec> {
  const file = join(resolve(projectRoot), filename);
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new Error(
      `Missing project run configuration: ${file}. Declare install, build, test and start ` +
        "commands before the run; critical run information that cannot be derived is reported as a pending item.",
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parser(raw, file);
}

export function parseProjectSpec(raw: unknown, origin = PROJECT_SPEC_FILENAME): ProjectSpec {
  const record = asRecord(raw, origin);
  if (record.start === undefined) {
    throw new Error(`${origin}.start is required: declare the command that starts the application`);
  }
  const spec: ProjectSpec = { start: parseCommand(record.start, `${origin}.start`) };
  if (record.install !== undefined) spec.install = parseCommandList(record.install, `${origin}.install`);
  if (record.build !== undefined) spec.build = parseCommandList(record.build, `${origin}.build`);
  if (record.tests !== undefined) spec.tests = parseTestTargets(record.tests, `${origin}.tests`);
  if (record.env !== undefined) spec.env = parseEnv(record.env, `${origin}.env`);
  if (record.dependencyPaths !== undefined) {
    spec.dependencyPaths = parseRelativePaths(record.dependencyPaths, `${origin}.dependencyPaths`);
  }
  if (record.generatedPaths !== undefined) {
    spec.generatedPaths = parseRelativePaths(record.generatedPaths, `${origin}.generatedPaths`);
    if (spec.generatedPaths.includes(".")) throw new Error(`${origin}.generatedPaths cannot exclude the entire project`);
  }
  if (record.dataPaths !== undefined) {
    spec.dataPaths = parseRelativePaths(record.dataPaths, `${origin}.dataPaths`);
  }
  if (record.dataEnvVar !== undefined) {
    if (typeof record.dataEnvVar !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(record.dataEnvVar)) {
      throw new Error(`${origin}.dataEnvVar must name a data directory environment variable`);
    }
    spec.dataEnvVar = record.dataEnvVar;
  }
  if (record.adapter !== undefined && (typeof record.adapter !== "string" || !record.adapter.trim())) throw new Error(`${origin}.adapter must be a non-empty string`);
  if (record.adapter !== undefined) spec.adapter = record.adapter as string;
  if (record.adapterConfig !== undefined) spec.adapterConfig = record.adapterConfig;
  return spec;
}

export function resolveApplicationContract(spec: ProjectSpec): ApplicationContract {
  if (!spec.adapter) throw new Error("Select an application adapter before resolving its contract");
  return {
    adapterId: spec.adapter, adapterConfig: spec.adapterConfig ?? {},
    installCommands: (spec.install ?? []).map(toProcessCommand),
    buildCommands: (spec.build ?? []).map(toProcessCommand),
    startCommand: toProcessCommand(spec.start),
    testTargets: (spec.tests ?? []).map(target => ({ ...toProcessCommand(target), id: target.id })),
    env: { ...(spec.env ?? {}) },
    dataPaths: [...(spec.dataPaths ?? [])],
    ...(spec.dataEnvVar ? { dataEnvVar: spec.dataEnvVar } : {}),
    ...(spec.dependencyPaths ? { dependencyPaths: [...spec.dependencyPaths] } : {}),
    generatedPaths: [...(spec.generatedPaths ?? [])],
    buildTimeoutMs: DEFAULT_BUILD_TIMEOUT_MS,
    startTimeoutMs: spec.start.timeoutMs ?? DEFAULT_START_TIMEOUT_MS,
  };
}

/** The npm executable to use on this platform. */
export function npmExecutable(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "npm.cmd" : "npm";
}

function toProcessCommand(command: ProjectCommand): ProcessCommand {
  return { executable: command.executable, args: [...(command.args ?? [])], cwd: normalizeCwd(command.cwd),
    ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }) };
}

/**
 * The literal "output" is the legacy spelling of the project root: every
 * consumer of `ProcessCommand.cwd` resolves it that way, so a declaration that
 * names it must keep meaning the root rather than a subdirectory of that name.
 */
function normalizeCwd(cwd: string | undefined): string {
  const value = cwd?.trim();
  return !value || value === "." || value === "output" ? "output" : value;
}

function asRecord(value: unknown, origin: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${origin} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function parseCommand(value: unknown, location: string): ProjectCommand {
  const record = asRecord(value, location);
  const executable = record.executable;
  if (typeof executable !== "string" || executable.trim() === "") {
    throw new Error(`${location}.executable must be a non-empty string`);
  }
  const command: ProjectCommand = { executable };
  if (record.args !== undefined) command.args = parseStringList(record.args, `${location}.args`);
  if (record.cwd !== undefined) command.cwd = parseRelativePath(record.cwd, `${location}.cwd`);
  if (record.timeoutMs !== undefined) command.timeoutMs = parseTimeout(record.timeoutMs, `${location}.timeoutMs`);
  return command;
}

function parseCommandList(value: unknown, location: string): ProjectCommand[] {
  if (!Array.isArray(value)) throw new Error(`${location} must be an array of commands`);
  return value.map((entry, index) => parseCommand(entry, `${location}[${index}]`));
}

function parseTestTargets(value: unknown, location: string): ProjectTestTarget[] {
  if (!Array.isArray(value)) throw new Error(`${location} must be an array of test targets`);
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const target = parseCommand(entry, `${location}[${index}]`) as ProjectTestTarget;
    const id = (entry as Record<string, unknown>).id;
    if (typeof id !== "string" || id.trim() === "") {
      throw new Error(`${location}[${index}].id must be a non-empty string`);
    }
    if (id === "all") throw new Error(`${location}[${index}].id all is reserved for running every test target`);
    if (seen.has(id)) throw new Error(`${location}[${index}].id duplicates an earlier test target: ${id}`);
    seen.add(id);
    return { ...target, id };
  });
}

function parseEnv(value: unknown, location: string): Record<string, string> {
  const record = asRecord(value, location);
  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "string") throw new Error(`${location}.${key} must be a string`);
    env[key] = entry;
  }
  return env;
}

function parseStringList(value: unknown, location: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${location} must be an array of strings`);
  return value.map((entry, index) => {
    if (typeof entry !== "string") throw new Error(`${location}[${index}] must be a string`);
    return entry;
  });
}

function parseRelativePaths(value: unknown, location: string): string[] {
  return parseStringList(value, location).map((entry, index) => parseRelativePath(entry, `${location}[${index}]`));
}

/**
 * Project-relative paths only. Absolute paths and `..` escapes would let a run
 * reach outside the project it owns, so they are rejected at parse time.
 */
function parseRelativePath(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${location} must be a non-empty project-relative path`);
  }
  const text = value.replace(/\\/g, "/").trim();
  if (text.startsWith("/") || /^[A-Za-z]:/.test(text)) {
    throw new Error(`${location} must be project-relative, received an absolute path: ${value}`);
  }
  const segments = text.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) {
    throw new Error(`${location} must stay inside the project, received an escaping path: ${value}`);
  }
  // "." and "./" name the project root itself, which stays inside the project.
  return segments.length === 0 ? "." : segments.join("/");
}

function parseTimeout(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${location} must be a positive integer number of milliseconds`);
  }
  return value;
}
