import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { PlatformContract, ProcessCommand } from "./types.js";

/** Project run description, loaded next to (and independently of) requirements.yaml. */
export const PROJECT_SPEC_FILENAME = "shallowcode.config.json";
export const DEFAULT_READY_PATH = "/health";
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
  /** Path probed on the base URL to decide the application is ready. */
  readyPath?: string;
  /** Additional ports the application must bind, declared rather than inferred. */
  extraPorts?: number[];
  /** Project-relative directories whose manifests define the dependency inputs. */
  dependencyPaths?: string[];
  /** Project-relative directories that are generated output and never source. */
  generatedPaths?: string[];
  /** Project-relative directories seeded into each isolated execution directory. */
  dataPaths?: string[];
}

/** Ports are assigned per run; they are runtime state, not project declaration. */
export interface RuntimePorts {
  port: number;
  /** Port reserved for the platform at evaluation time; generation must never bind it. */
  evaluationPort: number;
  extraPorts?: number[];
}

/**
 * Declared spec for the shipped minimal-web template. Mirrors the previous
 * fixed frontend/backend contract so template runs behave exactly as before.
 */
export function minimalWebProjectSpec(npm: string): ProjectSpec {
  return {
    install: [
      { executable: npm, args: ["install", "--no-audit", "--no-fund"], cwd: "frontend" },
      { executable: npm, args: ["install", "--no-audit", "--no-fund"], cwd: "backend" },
    ],
    build: [{ executable: npm, args: ["run", "build"], cwd: "frontend" }],
    start: { executable: npm, args: ["run", "start"], cwd: "backend" },
    readyPath: DEFAULT_READY_PATH,
    dataPaths: ["backend/data", "backend/.data"],
  };
}

/** Read and validate the project run description for `projectRoot`. */
export async function loadProjectSpec(
  projectRoot: string,
  filename = PROJECT_SPEC_FILENAME,
): Promise<ProjectSpec> {
  const file = join(resolve(projectRoot), filename);
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch {
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
  return parseProjectSpec(raw, file);
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
  if (record.readyPath !== undefined) spec.readyPath = parseReadyPath(record.readyPath, `${origin}.readyPath`);
  if (record.extraPorts !== undefined) spec.extraPorts = parsePorts(record.extraPorts, `${origin}.extraPorts`);
  if (record.dependencyPaths !== undefined) {
    spec.dependencyPaths = parseRelativePaths(record.dependencyPaths, `${origin}.dependencyPaths`);
  }
  if (record.generatedPaths !== undefined) {
    spec.generatedPaths = parseRelativePaths(record.generatedPaths, `${origin}.generatedPaths`);
  }
  if (record.dataPaths !== undefined) {
    spec.dataPaths = parseRelativePaths(record.dataPaths, `${origin}.dataPaths`);
  }
  return spec;
}

/**
 * Resolve a declared spec plus this run's ports into the runtime contract every
 * phase shares. Commands are normalized to the resolved shape; unknown project
 * timeouts win over the phase default.
 */
export function resolveRuntimeContract(spec: ProjectSpec, ports: RuntimePorts): PlatformContract {
  // Ports the project declares plus ports reserved for this run, minus the two
  // ports generation must never bind. Duplicates collapse so a repeated
  // declaration cannot double-bind.
  const extraPorts = [...new Set([...(spec.extraPorts ?? []), ...(ports.extraPorts ?? [])])]
    .filter((port) => port !== ports.port && port !== ports.evaluationPort)
    .sort((left, right) => left - right);
  return {
    baseUrl: `http://127.0.0.1:${ports.port}`,
    port: ports.port,
    evaluationPort: ports.evaluationPort,
    installCommands: (spec.install ?? []).map(toProcessCommand),
    buildCommands: (spec.build ?? []).map(toProcessCommand),
    startCommand: toProcessCommand(spec.start),
    healthPath: spec.readyPath ?? DEFAULT_READY_PATH,
    ...(extraPorts.length > 0 ? { extraPorts } : {}),
    buildTimeoutMs: DEFAULT_BUILD_TIMEOUT_MS,
    startTimeoutMs: DEFAULT_START_TIMEOUT_MS,
  };
}

/** The npm executable to use on this platform. */
export function npmExecutable(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "npm.cmd" : "npm";
}

function toProcessCommand(command: ProjectCommand): ProcessCommand {
  return { executable: command.executable, args: [...(command.args ?? [])], cwd: normalizeCwd(command.cwd) };
}

function normalizeCwd(cwd: string | undefined): string {
  const value = cwd?.trim();
  return !value || value === "." ? "output" : value;
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

function parseReadyPath(value: unknown, location: string): string {
  if (typeof value !== "string" || !value.startsWith("/")) {
    throw new Error(`${location} must be an absolute path beginning with "/"`);
  }
  return value;
}

function parsePorts(value: unknown, location: string): number[] {
  if (!Array.isArray(value)) throw new Error(`${location} must be an array of port numbers`);
  const ports: number[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry <= 0 || entry > 65_535) {
      throw new Error(`${location}[${index}] must be a port number between 1 and 65535`);
    }
    if (ports.includes(entry)) throw new Error(`${location}[${index}] repeats an earlier port: ${entry}`);
    ports.push(entry);
  }
  return ports;
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
  if (text.startsWith("/") || /^[A-Za-z]:\//.test(text)) {
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