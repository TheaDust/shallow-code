import { fillTemplate, loadPrompt } from "../../prompt-assets.js";
import type { ApplicationContract } from "../../application/port.js";
import { loadProjectSpec as loadCommonSpec, parseProjectSpec as parseCommonSpec, resolveApplicationContract, npmExecutable, type ProjectSpec } from "../../project-spec.js";
export { npmExecutable, PROJECT_SPEC_FILENAME, DEFAULT_BUILD_TIMEOUT_MS, DEFAULT_START_TIMEOUT_MS, DEFAULT_TEST_TIMEOUT_MS, type ProjectSpec } from "../../project-spec.js";
export const DEFAULT_READY_PATH = "/health";
export interface WebSettings { readyPath: string; browserPath: string; extraPorts: number[] }
export interface WebRuntimeConfig extends WebSettings { baseUrl: string; port: number; evaluationPort?: number; healthPath: string }

export interface RuntimePorts {
  port: number;
  /** Port reserved for delivery-time grading; generation must never bind it. */
  evaluationPort?: number;
  extraPorts?: number[];
}

/**
 * Declared spec for the shipped minimal-web template. Mirrors the previous
 * fixed frontend/backend contract so template runs behave exactly as before.
 */
export function minimalWebProjectSpec(npm: string): ProjectSpec {
  return parseProjectSpec({
    install: [
      { executable: npm, args: ["install", "--no-audit", "--no-fund"], cwd: "frontend" },
      { executable: npm, args: ["install", "--no-audit", "--no-fund"], cwd: "backend" },
    ],
    build: [{ executable: npm, args: ["run", "build"], cwd: "frontend" }],
    tests: [
      { id: "frontend", executable: process.execPath, args: ["node_modules/vitest/vitest.mjs", "run", "--maxWorkers=1"], cwd: "frontend" },
      { id: "backend", executable: process.execPath, args: ["--test", "--test-concurrency=1"], cwd: "backend" },
    ],
    start: { executable: npm, args: ["run", "start"], cwd: "backend" },
    readyPath: DEFAULT_READY_PATH,
    dataPaths: ["backend/data", "backend/.data"],
    dependencyPaths: ["frontend", "backend"],
    generatedPaths: ["frontend/dist"],
  });
}

/** Runtime contract for the shipped template, used by fixtures and a blank template run. */
export function minimalWebContract(
  ports: RuntimePorts,
  platform: NodeJS.Platform = process.platform,
): ApplicationContract {
  return resolveRuntimeContract(minimalWebProjectSpec(npmExecutable(platform)), ports);
}

export function parseProjectSpec(raw: unknown, origin = "shallowcode.config.json"): ProjectSpec {
  const spec = parseCommonSpec(raw, origin);
  spec.adapter ??= "web";
  if (spec.dataEnvVar === "PORT") throw new Error(`${origin}.dataEnvVar must name a data directory environment variable other than PORT`);
  if (spec.adapter !== "web") throw new Error("Web adapter requires adapter: web");
  const record = raw as Record<string, unknown>;
  const nested = record.adapterConfig;
  if (nested !== undefined && (!nested || typeof nested !== "object" || Array.isArray(nested))) throw new Error(`${origin}.adapterConfig must be an object`);
  const input = { ...record, ...(nested as Record<string, unknown> | undefined) };
  spec.adapterConfig = { readyPath: parseReadyPath(input.readyPath ?? DEFAULT_READY_PATH, `${origin}.readyPath`),
    browserPath: parseReadyPath(input.browserPath ?? "/", `${origin}.browserPath`),
    extraPorts: parsePorts(input.extraPorts ?? [], `${origin}.extraPorts`) } satisfies WebSettings;
  return spec;
}
export function webSettings(spec: ProjectSpec): WebSettings { return parseProjectSpec(spec).adapterConfig as WebSettings; }
export function resolveRuntimeContract(input: ProjectSpec, ports: RuntimePorts): ApplicationContract {
  const spec = parseProjectSpec(input);
  const settings = webSettings(spec);
  const extraPorts = [...new Set([...settings.extraPorts, ...(ports.extraPorts ?? [])])]
    .filter(port => port !== ports.port && port !== ports.evaluationPort).sort((a, b) => a - b);
  const contract: ApplicationContract = { ...resolveApplicationContract(spec), adapterConfig: { ...settings, extraPorts, port: ports.port,
    baseUrl: `http://127.0.0.1:${ports.port}`, healthPath: settings.readyPath,
    ...(ports.evaluationPort === undefined ? {} : { evaluationPort: ports.evaluationPort }) } satisfies WebRuntimeConfig };
  contract.builderInstructions = webBuilderInstructions(contract);
  return contract;
}
export function webRuntimeConfig(contract: ApplicationContract): WebRuntimeConfig {
  if (contract.adapterId !== "web") throw new Error("Expected Web application contract");
  return contract.adapterConfig as WebRuntimeConfig;
}
function parseReadyPath(value: unknown, location: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") ||
    /[\\\u0000-\u0020\u007f]/.test(value) || /(^|\/)\.\.(\/|$)/.test(value)) {
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

export function loadProjectSpec(directory: string, filename?: string): Promise<ProjectSpec> { return loadCommonSpec(directory, filename, parseProjectSpec); }

function webBuilderInstructions(contract: ApplicationContract): string {
  const config = webRuntimeConfig(contract);
  const command = (value: import("../../application/port.js").ProcessCommand) => `cwd=${value.cwd === "output" ? "." : value.cwd}: ${[value.executable, ...value.args].join(" ")}`;
  return fillTemplate(loadPrompt("adapters/web", "runtime"), {
    PROBE_PORT: String(config.port), RESERVED_PORT_CLAUSE: config.evaluationPort === undefined ? "" : `不要占用正式评测端口 ${config.evaluationPort}；`,
    EXTRA_PORTS_SECTION: config.extraPorts.length ? fillTemplate(loadPrompt("adapters/web", "extra-ports"), { EXTRA_PORTS: config.extraPorts.join("、"), PROBE_PORT: String(config.port) }) : "",
    INSTALL_COMMANDS: contract.installCommands.map(command).join("\n") || "无", BUILD_COMMANDS: contract.buildCommands.map(command).join("\n") || "无",
    START_COMMAND: command(contract.startCommand), HEALTH_PATH: config.healthPath, BROWSER_PATH: config.browserPath, BASE_URL: config.baseUrl,
    TEST_TARGETS: (contract.testTargets ?? []).map(target => `${target.id}: ${command(target)}`).join("\n") || "本轮未登记开发测试目标",
    DATA_ENV_VAR: contract.dataEnvVar ?? "SHALLOW_DATA_DIR", DATA_PATHS: contract.dataPaths?.join("、") || "未声明继承数据目录",
  }) + "\n\n" + loadPrompt("adapters/web", "implementation") + "\n\n" + loadPrompt("adapters/web", "self-test");
}
