import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { agentEnv, agentEnvName, isAgentRole, type AgentRole } from "./agent-config.js";
import { DEFAULT_CONTEXT_WINDOW } from "./builder/pi-model-config.js";

export interface GatewayConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface VerifierConfig {
  mode: "active";
  concurrency: number;
  semanticReview?: boolean;
  replay?: boolean;
}

export function parseVerifierConfig(env: Record<string, string | undefined>): VerifierConfig {
  const mode = agentEnv(env, "verifier", "MODE") ?? "active";
  if (mode !== "active") {
    throw new Error(`${agentEnvName("verifier", "MODE")} only supports active; start a new Verifier run to replace legacy/observe`);
  }
  const concurrency = Number(agentEnv(env, "verifier", "CONCURRENCY") ?? "2");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) {
    throw new Error(`${agentEnvName("verifier", "CONCURRENCY")} must be 1 or 2`);
  }
  const flag = (suffix: string): boolean => {
    const name = agentEnvName("verifier", suffix);
    const raw = agentEnv(env, "verifier", suffix);
    if (!raw || /^(0|false|no|off)$/i.test(raw)) return false;
    if (/^(1|true|yes|on)$/i.test(raw)) return true;
    throw new Error(`${name} must be 1/true/yes/on or 0/false/no/off`);
  };
  return { mode, concurrency, semanticReview: flag("SEMANTIC_REVIEW"), replay: flag("REPLAY") };
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
 * 传入 Grouper / Builder / Verifier 角色时，各自可用
 * `SHALLOW_GROUPER_*` / `SHALLOW_BUILDER_*` / `SHALLOW_VERIFIER_*`
 * 分别覆盖 API key、地址和模型，未覆盖的字段回退公共值。
 */
export function readGatewayConfig(
  env: Record<string, string | undefined>,
  agent?: AgentRole | string,
): GatewayConfig {
  const apiKey = gatewayEnv(env, agent, "API_KEY", "OPENAI_API_KEY");
  const baseUrl = gatewayEnv(env, agent, "BASE_URL", "OPENAI_BASE_URL").replace(/\/+$/, "");
  const model = gatewayEnv(env, agent, "MODEL", "MODEL");
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

export function deriveModelTimeouts(totalBudgetMs: number): {
  builderTimeoutMs: number;
  verifierTimeoutMs: number;
} {
  if (totalBudgetMs <= 0) {
    return {
      builderTimeoutMs: 5_400_000,
      verifierTimeoutMs: 720_000,
    };
  }
  return {
    builderTimeoutMs: Math.max(30_000, Math.min(5_400_000, totalBudgetMs * 0.4)),
    verifierTimeoutMs: Math.max(10_000, Math.min(720_000, totalBudgetMs * 0.1)),
  };
}

/** 角色变量优先，公共变量兜底；两者都没有时给出包含两者名称的错误。 */
function gatewayEnv(
  env: Record<string, string | undefined>,
  agent: AgentRole | string | undefined,
  name: "API_KEY" | "BASE_URL" | "MODEL",
  fallbackName: string,
): string {
  const scopedName = agent === undefined ? undefined
    : isAgentRole(agent) ? agentEnvName(agent, name) : `${agent}_${name}`;
  const scoped = agent === undefined ? undefined
    : isAgentRole(agent) ? agentEnv(env, agent, name) : env[scopedName!]?.trim();
  if (scoped) return scoped;
  const fallback = env[fallbackName]?.trim();
  if (fallback) return fallback;
  throw new Error(scopedName ? `${scopedName} or ${fallbackName} is required` : `${fallbackName} is required`);
}
