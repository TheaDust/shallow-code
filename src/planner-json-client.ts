import { sanitizeDiagnosticText } from "./diagnostics.js";
import { httpGatewayFailure, type GatewayFailure } from "./gateway-failure.js";

/** Normalized planner token counts, matching the Builder's usage semantics. */
export interface PlannerUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/** Diagnostics sink; failures must never change the planner decision path. */
export type PlannerUsageListener = (usage: PlannerUsage) => void | Promise<void>;
export interface PlannerJsonConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export interface PlannerJsonOptions {
  timeoutMs?: number;
  onUsage?: PlannerUsageListener;
  signal?: AbortSignal;
  maxTokens?: number;
}

const PLANNER_USER_AGENT = "ShallowCode/1.0";

export type PlannerRequestErrorCategory =
  | "transport"
  | "response"
  | "json"
  | "schema"
  | "refinement"
  | "review";

export class PlannerRequestError extends Error {
  readonly gatewayFailure?: GatewayFailure;
  readonly retryable: boolean;
  readonly fatal: boolean;
  readonly diagnostics: {
    category: PlannerRequestErrorCategory;
    message: string;
    validationError?: string;
    contentPreview?: string;
    retryable: boolean;
    fatal: boolean;
    httpStatus?: number;
  };

  constructor(
    readonly category: PlannerRequestErrorCategory,
    message: string,
    options?: ErrorOptions & { content?: string; apiKey?: string; httpStatus?: number; retryAfter?: string | null },
  ) {
    super(message, options);
    this.name = "PlannerRequestError";
    const status = options?.httpStatus;
    if (category === "transport") this.gatewayFailure = status === undefined
      ? { kind: "unavailable", retryable: true } : httpGatewayFailure(status, options?.retryAfter);
    this.retryable = category === "transport" && (status === undefined || status === 408 || status === 429 || status >= 500);
    this.fatal = category === "response" || (category === "transport" && !this.retryable);
    this.diagnostics = {
      category,
      retryable: this.retryable,
      fatal: this.fatal,
      ...(status === undefined ? {} : { httpStatus: status }),
      message: sanitizePlannerDiagnostic(message, options?.apiKey),
      ...(options?.cause instanceof Error ? {
        validationError: sanitizePlannerDiagnostic(options.cause.message, options.apiKey),
      } : {}),
      ...(options?.content !== undefined ? {
        contentPreview: sanitizePlannerDiagnostic(options.content, options.apiKey),
      } : {}),
    };
  }
}

export class PlannerJsonClient {
  constructor(private readonly config: PlannerJsonConfig, private readonly fetchFn: typeof fetch = globalThis.fetch,
    private readonly label = "Probe planner") {}

  async complete(messages: Array<{ role: "system" | "user"; content: string }>, schema: unknown,
    options: PlannerJsonOptions = {}): Promise<string> {
    const { timeoutMs = this.config.timeoutMs, onUsage, signal, maxTokens } = options;
    // Structured outputs (`json_schema`) are unavailable on several
    // OpenAI-compatible gateways, including the ARC-Bench model proxy, so the
    // schema travels in the system message and the request asks for generic
    // JSON mode instead. Each caller parses and validates its own response contract.
    const requestMessages = messages.map((message, index) => index === 0
      ? { ...message, content: `${message.content}\n\n仅返回符合此 schema 的 JSON：\n${JSON.stringify(schema)}` }
      : message);
    const timeoutSignal = Number.isFinite(timeoutMs) ? AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs))) : undefined;
    const requestSignal = signal && timeoutSignal ? AbortSignal.any([signal, timeoutSignal]) : signal ?? timeoutSignal;
    let response: Response;
    try {
      response = await this.fetchFn(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json",
          "user-agent": PLANNER_USER_AGENT,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: requestMessages,
          response_format: { type: "json_object" },
          ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
          stream: true,
          stream_options: { include_usage: true },
        }),
        ...(requestSignal ? { signal: requestSignal } : {}),
      });
    } catch (error) {
      throw new PlannerRequestError("transport", `${this.label} request failed`, {
        cause: error,
        apiKey: this.config.apiKey,
      });
    }
    if (!response.ok) {
      throw new PlannerRequestError(
        "transport",
        `${this.label} returned HTTP ${response.status}`,
        { httpStatus: response.status, retryAfter: response.headers.get("retry-after") },
      );
    }

    let content: string | undefined;
    let usage: PlannerUsage | undefined;
    let cutOff = false;
    try {
      if (/^text\/event-stream\b/i.test(response.headers.get("content-type") ?? "")) {
        const parsed = extractSseContent(await response.text(), this.label);
        content = parsed.content;
        usage = parsed.usage;
        cutOff = parsed.cutOff === true;
      } else {
        const parsed = extractContent(await response.json());
        content = parsed.content;
        usage = parsed.usage;
        cutOff = parsed.cutOff === true;
      }
    } catch (error) {
      throw new PlannerRequestError(error instanceof SyntaxError ? "response" : "transport", `${this.label} response body failed`, {
        cause: error,
        apiKey: this.config.apiKey,
      });
    }
    // Token accounting is diagnostics and includes attempts that fail validation below.
    if (usage !== undefined && onUsage) {
      try { await onUsage(usage); } catch { /* Diagnostics must never change the decision path. */ }
    }
    if (cutOff) throw new PlannerRequestError("response", `${this.label} response body failed`, {
      cause: new SyntaxError(`${this.label} stream was cut off by the model`), apiKey: this.config.apiKey,
    });
    if (content === undefined) {
      throw new PlannerRequestError("response", `${this.label} response has no message content`);
    }
    return content;
  }
}

function sanitizePlannerDiagnostic(text: string, apiKey?: string): string {
  return sanitizeDiagnosticText(text, apiKey ? [apiKey] : []);
}

export function extractJsonPayload(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*[\r\n]+([\s\S]*?)[\r\n]*```$/);
  const candidate = fenced ? fenced[1] : trimmed;
  const blocks = balancedBlocks(candidate);
  const parsed = blocks.filter((block) => {
    try {
      JSON.parse(block);
      return true;
    } catch {
      return false;
    }
  });
  if (parsed.length === 0) return candidate;
  return parsed.reduce((best, block) => (block.length > best.length ? block : best));
}

function balancedBlocks(content: string): string[] {
  const blocks: string[] = [];
  let searchFrom = 0;
  while (searchFrom < content.length) {
    const start = content.indexOf("{", searchFrom);
    if (start < 0) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let index = start; index < content.length; index += 1) {
      const char = content[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    if (end < 0) {
      searchFrom = start + 1;
      continue;
    }
    blocks.push(content.slice(start, end + 1));
    searchFrom = end + 1;
  }
  return blocks;
}

function extractSseContent(body: string, label: string): { content?: string; usage?: PlannerUsage; cutOff?: boolean } {
  let content = "";
  let usage: PlannerUsage | undefined;
  let finished = false;
  let done = false;
  let cutOff = false;
  for (const block of body.split(/\r\n\r\n|\n\n|\r\r/)) {
    const data = block.split(/\r\n|\n|\r/).filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data) continue;
    if (data.trim() === "[DONE]") { done = true; break; }
    let event: unknown;
    try { event = JSON.parse(data); }
    catch (error) {
      // A damaged usage trailer after the terminal choice cannot change the plan.
      if (finished && !/"(?:choices|tool_calls)"\s*:/.test(data)) continue;
      throw new Error(`${label} stream contains an incomplete content event`, { cause: error });
    }
    if (typeof event !== "object" || event === null) continue;
    const envelope = event as { error?: { message?: string }; usage?: unknown; choices?: Array<{
      index?: number; delta?: { content?: unknown }; finish_reason?: unknown; usage?: unknown;
    }> };
    if (envelope.error) throw new Error(envelope.error.message ?? `${label} stream returned an error`);
    const choice = envelope.choices?.find(item => item?.index === 0);
    usage = parseUsage(envelope.usage ?? choice?.usage) ?? usage;
    if (!choice) continue;
    if (typeof choice.delta?.content === "string") content += choice.delta.content;
    if (typeof choice.finish_reason === "string") {
      if (choice.finish_reason === "length") cutOff = true;
      finished = true;
    }
  }
  if (!done && !finished) throw new Error(`${label} stream ended before completion`);
  return { ...(content ? { content } : {}), ...(usage ? { usage } : {}), ...(cutOff ? { cutOff } : {}) };
}

function extractContent(value: unknown): { content?: string; usage?: PlannerUsage; cutOff?: boolean } {
  if (typeof value !== "object" || value === null) return {};
  const record = value as { choices?: unknown; usage?: unknown };
  const result: { content?: string; usage?: PlannerUsage; cutOff?: boolean } = {};
  const usage = parseUsage(record.usage);
  if (usage) result.usage = usage;
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) return result;
  const first = choices[0];
  if (typeof first !== "object" || first === null) return result;
  if ((first as { finish_reason?: string }).finish_reason === "length") result.cutOff = true;
  const message = (first as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return result;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") result.content = content;
  return result;
}

/** Mirrors the Pi provider's normalization: input excludes cached tokens; total is the sum. */
function parseUsage(raw: unknown): PlannerUsage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const usage = raw as Record<string, unknown>;
  const details = typeof usage.prompt_tokens_details === "object" && usage.prompt_tokens_details !== null
    ? usage.prompt_tokens_details as Record<string, unknown> : undefined;
  const reported = [usage.prompt_tokens, usage.completion_tokens, details?.cached_tokens,
    usage.prompt_cache_hit_tokens, details?.cache_write_tokens];
  if (!reported.some(value => typeof value === "number" && Number.isFinite(value))) return undefined;
  const promptTokens = finiteNumber(usage.prompt_tokens) ?? 0;
  const reportedCached = finiteNumber(details?.cached_tokens) ?? finiteNumber(usage.prompt_cache_hit_tokens) ?? 0;
  const cacheWrite = finiteNumber(details?.cache_write_tokens) ?? 0;
  // Some OpenAI-compatible providers report cached_tokens as (previous hits + current writes).
  const cacheRead = cacheWrite > 0 ? Math.max(0, reportedCached - cacheWrite) : Math.max(0, reportedCached);
  const output = Math.max(0, finiteNumber(usage.completion_tokens) ?? 0);
  const input = Math.max(0, promptTokens - cacheRead - cacheWrite);
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
