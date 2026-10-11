import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface GatewayEnv {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** 本 agent 的组件级变量前缀，可分别覆盖公共网关配置。 */
export const COMPONENT_PREFIX = "REQUIREMENTS_AGENT";

const COMMON_NAMES = {
  API_KEY: "OPENAI_API_KEY",
  BASE_URL: "OPENAI_BASE_URL",
  MODEL: "MODEL",
} as const;
type FieldName = keyof typeof COMMON_NAMES;

/**
 * 组件变量（REQUIREMENTS_AGENT_*）优先、公共变量兜底；字段级回退。
 * 缺失时抛出包含两层变量名的清单。
 */
export function resolveGatewayEnv(env: Record<string, string | undefined>): GatewayEnv {
  const value = (field: FieldName): string | undefined =>
    env[`${COMPONENT_PREFIX}_${field}`]?.trim() || env[COMMON_NAMES[field]]?.trim();
  const apiKey = value("API_KEY");
  const baseUrl = value("BASE_URL");
  const model = value("MODEL");
  const missing = (Object.keys(COMMON_NAMES) as FieldName[])
    .filter((field) => !value(field))
    .map((field) => `${COMPONENT_PREFIX}_${field} 或 ${COMMON_NAMES[field]}`);
  if (missing.length) {
    throw new Error(
      `缺少模型配置（${missing.join("、")}）：请写在仓库根目录或当前目录的 .env 中，或设为进程环境变量。`,
    );
  }
  return { apiKey: apiKey ?? "", baseUrl: (baseUrl ?? "").replace(/\/+$/, ""), model: model ?? "" };
}

/**
 * opencode.ai 的 Zen / Go 网关要求第三方客户端为每个会话发送稳定的
 * x-opencode-session，否则请求被 400 拒绝；其他网关不附加该头。
 */
export function opencodeSessionHeaders(baseUrl: string, sessionId: string): Record<string, string> {
  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    return {};
  }
  if (host !== "opencode.ai" && !host.endsWith(".opencode.ai")) return {};
  return { "x-opencode-session": sessionId };
}

/**
 * 合并配置来源：仓库根 .env < 当前目录 .env < 进程环境变量。
 * 文件缺失视为空。
 */
export async function loadGatewayEnv(options: {
  cwd: string;
  rootEnvFile?: string;
  env?: Record<string, string | undefined>;
}): Promise<GatewayEnv> {
  const paths = [
    ...(options.rootEnvFile ? [options.rootEnvFile] : []),
    join(options.cwd, ".env"),
  ];
  const merged: Record<string, string | undefined> = { ...(await readEnvValues(paths)) };
  for (const [key, value] of Object.entries(options.env ?? process.env)) {
    if (value !== undefined) merged[key] = value;
  }
  return resolveGatewayEnv(merged);
}

/** 依序读取 .env 文件，后面的覆盖前面的；同一路径只读一次。 */
export async function readEnvValues(paths: string[]): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  const seen = new Set<string>();
  for (const path of paths) {
    const key = resolve(path);
    if (seen.has(key)) continue;
    seen.add(key);
    Object.assign(values, await readEnvFile(path));
  }
  return values;
}

async function readEnvFile(path: string): Promise<Record<string, string>> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
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
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}
