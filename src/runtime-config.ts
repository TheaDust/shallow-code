import { createServer } from "node:net";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { DEFAULT_CONTEXT_WINDOW } from "./builder/pi-model-config.js";
import type { PlatformContract } from "./types.js";

/**
 * Ports the platform's acceptance specs hard-code as their default base URL.
 * Mirrors arc-adapter's discovery: every `http://127.0.0.1:<port>` /
 * `http://localhost:<port>` literal in the task's spec bundle is a port the
 * grader's backend must serve, because the grader sets only PORT.
 */
const LOOPBACK_URL_PORT = /https?:\/\/(?:127\.0\.0\.1|localhost):(\d{2,5})(?!\d)/g;
/** Where the runner mounts the acceptance spec bundle. */
export const DEFAULT_ACCEPTANCE_TESTS_DIR = "/workspace/tests";
/** Published compatibility port used by main without inspecting test files. */
export const FALLBACK_EXTRA_PORTS = [3301];

export interface GatewayConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export const MIN_BUILDER_CONTEXT_WINDOW = 131_072;
export const MAX_BUILDER_CONTEXT_WINDOW = 1_000_000;

/** Mainline Pi context limit. Keeping this below the gateway maximum prevents
 * repeated full-history input from overwhelming the cost of small packets. */
export function parseBuilderContextWindow(
  env: Record<string, string | undefined>,
): number {
  const raw = env["SHALLOW_BUILDER_CONTEXT_WINDOW"]?.trim();
  if (!raw) return DEFAULT_CONTEXT_WINDOW;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_BUILDER_CONTEXT_WINDOW || value > MAX_BUILDER_CONTEXT_WINDOW) {
    throw new Error(
      `SHALLOW_BUILDER_CONTEXT_WINDOW must be an integer from ${MIN_BUILDER_CONTEXT_WINDOW} to ${MAX_BUILDER_CONTEXT_WINDOW}, got "${raw}"`,
    );
  }
  return value;
}

export function readGatewayConfig(
  env: Record<string, string | undefined>,
): GatewayConfig {
  const apiKey = requiredEnv(env, "OPENAI_API_KEY");
  const baseUrl = requiredEnv(env, "OPENAI_BASE_URL").replace(/\/+$/, "");
  const model = requiredEnv(env, "MODEL");
  return { apiKey, baseUrl, model };
}

export async function readEnvFile(
  envFile: string,
): Promise<Record<string, string>> {
  let content: string;
  try {
    content = await readFile(envFile, "utf8");
  } catch {
    return {};
  }

  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function createArcPlatformContract(
  platform: NodeJS.Platform = process.platform,
  port = 3000,
  evaluationPort = 3000,
  extraPorts?: number[],
): PlatformContract {
  const npm = platform === "win32" ? "npm.cmd" : "npm";
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    evaluationPort,
    installCommands: [
      {
        executable: npm,
        args: ["install", "--no-audit", "--no-fund"],
        cwd: "frontend",
      },
      {
        executable: npm,
        args: ["install", "--no-audit", "--no-fund"],
        cwd: "backend",
      },
    ],
    buildCommands: [
      { executable: npm, args: ["run", "build"], cwd: "frontend" },
    ],
    startCommand: {
      executable: npm,
      args: ["run", "start"],
      cwd: "backend",
    },
    healthPath: "/health",
    // The grader sets only PORT; bind the configured compatibility ports too.
    extraPorts: extraPorts ? [...extraPorts] : [...FALLBACK_EXTRA_PORTS],
    buildTimeoutMs: 180_000,
    startTimeoutMs: 30_000,
  };
}

/** Loopback base-URL ports referenced by an acceptance spec source. */
export function extractBasePorts(text: string): number[] {
  const ports = new Set<number>();
  for (const match of text.matchAll(LOOPBACK_URL_PORT)) {
    const port = Number(match[1]);
    if (Number.isInteger(port) && port > 0 && port <= 65_535) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

/** Every loopback port the spec bundle under `testsDir` hard-codes, sorted. */
export async function collectSpecBasePorts(testsDir: string): Promise<number[]> {
  let entries: string[];
  try {
    entries = await readdir(testsDir, { recursive: true, encoding: "utf8" });
  } catch {
    return [];
  }
  const ports = new Set<number>();
  for (const entry of entries) {
    if (!entry.endsWith(".ts")) continue;
    let text: string;
    try {
      text = await readFile(resolve(testsDir, entry), "utf8");
    } catch {
      continue;
    }
    for (const port of extractBasePorts(text)) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

/** First candidate directory that actually ships `*.spec.ts` files. */
export async function locateAcceptanceTestsDir(
  env: Record<string, string | undefined>,
  fallbackDir: string | null = DEFAULT_ACCEPTANCE_TESTS_DIR,
): Promise<string | null> {
  const candidates: string[] = [];
  const fromEnv = env["ARCBENCH_TESTS_DIR"]?.trim();
  if (fromEnv) candidates.push(resolve(fromEnv));
  if (fallbackDir) candidates.push(resolve(fallbackDir));
  for (const candidate of candidates) {
    try {
      if ((await readdir(candidate, { recursive: true, encoding: "utf8" })).some((entry) => entry.endsWith(".spec.ts"))) {
        return candidate;
      }
    } catch {
      // Missing/unreadable candidate: try the next one.
    }
  }
  return null;
}

/**
 * Extra ports the platform contract must bind, discovered from the task's own
 * acceptance specs (excluding the evaluation port the grader sets as PORT).
 * Falls back to {@link FALLBACK_EXTRA_PORTS} only when no spec bundle is present.
 */
export async function resolvePlatformExtraPorts(
  env: Record<string, string | undefined>,
  evaluationPort: number,
  fallbackDir: string | null = DEFAULT_ACCEPTANCE_TESTS_DIR,
): Promise<number[]> {
  const testsDir = await locateAcceptanceTestsDir(env, fallbackDir);
  const source = testsDir ? await collectSpecBasePorts(testsDir) : FALLBACK_EXTRA_PORTS;
  return source.filter((port) => port !== evaluationPort).sort((a, b) => a - b);
}

export function parseProbePortOverride(
  env: Record<string, string | undefined>,
): number | null {
  const raw = env["SHALLOW_PROBE_PORT"]?.trim();
  if (!raw) return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`SHALLOW_PROBE_PORT must be a port number, got "${raw}"`);
  }
  if (port === 3000) {
    throw new Error("SHALLOW_PROBE_PORT must not use reserved evaluation port 3000");
  }
  return port;
}

export function parseEvaluationPort(
  env: Record<string, string | undefined>,
): number | null {
  const raw = env["SHALLOW_EVAL_PORT"]?.trim();
  if (!raw) return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`SHALLOW_EVAL_PORT must be a port number, got "${raw}"`);
  }
  return port;
}

export function parseRunDirOverride(
  env: Record<string, string | undefined>,
): string | null {
  const raw = env["SHALLOW_RUN_DIR"]?.trim();
  if (!raw) return null;
  return resolve(raw);
}

/**
 * Opt-in SSE capture destination for the Pi worker. Unset/off disables the tap;
 * a bare truthy flag writes to `<defaultDir>`, any other value is a path.
 */
export function resolveSseCaptureDir(
  env: Record<string, string | undefined>,
  defaultDir: string,
): string | null {
  const raw = env["SHALLOW_CAPTURE_SSE"]?.trim();
  if (!raw) return null;
  if (/^(0|false|no|off)$/i.test(raw)) return null;
  if (/^(1|true|yes|on)$/i.test(raw)) return resolve(defaultDir);
  return resolve(raw);
}

/**
 * Reference images are opt-in. Off by default: they add base64 weight to every
 * turn, and the official run showed the textual requirements already carry the
 * signal. When enabled, `VisionCapability` probes the gateway once before the
 * first attached call so a text-only model is detected up front.
 */
export function referenceImagesEnabled(env: Record<string, string | undefined>): boolean {
  const raw = env["SHALLOW_REFERENCE_IMAGES"]?.trim();
  return raw !== undefined && /^(1|true|yes|on)$/i.test(raw);
}

/** Finals default to the delta; operators can restore inherited requirement audits. */
export function parseEvolutionAuditInherited(env: Record<string, string | undefined>): boolean {
  const raw = env["SHALLOW_EVOLUTION_AUDIT_INHERITED"]?.trim();
  if (!raw || /^(0|false|no|off)$/i.test(raw)) return false;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  throw new Error("SHALLOW_EVOLUTION_AUDIT_INHERITED must be 1/true/yes/on or 0/false/no/off");
}

/** Final audits reuse cached plans by default instead of spending tokens to replace missing ones. */
export function parseFinalAuditGeneratePlan(env: Record<string, string | undefined>): boolean {
  const raw = env["SHALLOW_FINAL_AUDIT_GENERATE_PLAN"]?.trim();
  if (!raw || /^(0|false|no|off)$/i.test(raw)) return false;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  throw new Error("SHALLOW_FINAL_AUDIT_GENERATE_PLAN must be 1/true/yes/on or 0/false/no/off");
}

export async function pickFreePort(exclude: readonly number[] = []): Promise<number> {
  for (let attempt = 0; ; attempt += 1) {
    const port = await new Promise<number>((resolvePort, reject) => {
      const server = createServer();
      server.unref();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const candidate = typeof address === "object" && address ? address.port : 0;
        server.close(() => {
          if (candidate > 0) resolvePort(candidate);
          else reject(new Error("no free port available"));
        });
      });
    });
    if (!exclude.includes(port)) return port;
    // The OS hands out sequential ephemeral ports; a collision with the
    // evaluation port is resolved by asking again, with a hard cap.
    if (attempt >= 9) throw new Error(`no free port available outside ${exclude.join(", ")}`);
  }
}

export function deriveModelTimeouts(totalBudgetMs: number): {
  builderTimeoutMs: number;
  plannerTimeoutMs: number;
} {
  if (totalBudgetMs <= 0) {
    return {
      builderTimeoutMs: 5_400_000,
      plannerTimeoutMs: 720_000,
    };
  }
  return {
    builderTimeoutMs: Math.max(30_000, Math.min(5_400_000, totalBudgetMs * 0.4)),
    plannerTimeoutMs: Math.max(10_000, Math.min(720_000, totalBudgetMs * 0.1)),
  };
}

function requiredEnv(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
