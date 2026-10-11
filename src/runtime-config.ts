import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { DEFAULT_CONTEXT_WINDOW } from "./builder/pi-model-config.js";

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

/**
 * 读取一份网关配置。公共值来自 OPENAI_API_KEY / OPENAI_BASE_URL / MODEL；
 * 传入 component（如 "SHALLOW_BUILDER"、"SHALLOW_JUDGE"）时，
 * `<component>_API_KEY` / `<component>_BASE_URL` / `<component>_MODEL`
 * 可分别覆盖对应字段，未覆盖的字段回退公共值。
 */
export function readGatewayConfig(
  env: Record<string, string | undefined>,
  component?: string,
): GatewayConfig {
  const apiKey = gatewayEnv(env, component, "API_KEY", "OPENAI_API_KEY");
  const baseUrl = gatewayEnv(env, component, "BASE_URL", "OPENAI_BASE_URL").replace(/\/+$/, "");
  const model = gatewayEnv(env, component, "MODEL", "MODEL");
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

export function parseProbePortOverride(
  env: Record<string, string | undefined>,
): number | null {
  const raw = env["SHALLOW_PROBE_PORT"]?.trim();
  if (!raw) return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`SHALLOW_PROBE_PORT must be a port number, got "${raw}"`);
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

/** 组件变量优先，公共变量兜底；两者都没有时给出包含两者名称的错误。 */
function gatewayEnv(
  env: Record<string, string | undefined>,
  component: string | undefined,
  name: "API_KEY" | "BASE_URL" | "MODEL",
  fallbackName: string,
): string {
  const scopedName = component ? `${component}_${name}` : undefined;
  const scoped = scopedName ? env[scopedName]?.trim() : undefined;
  if (scoped) return scoped;
  const fallback = env[fallbackName]?.trim();
  if (fallback) return fallback;
  throw new Error(scopedName ? `${scopedName} or ${fallbackName} is required` : `${fallbackName} is required`);
}
