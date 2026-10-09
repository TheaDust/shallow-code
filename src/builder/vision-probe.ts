import { randomUUID } from "node:crypto";

/** 1x1 PNG: the smallest payload that still exercises real image decoding. */
export const PROBE_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export type VisionSupport = "supported" | "unsupported" | "unknown";

const DEFAULT_TIMEOUT_MS = 15_000;

/** A rejection must specifically name image input; generic gateway errors prove nothing. */
export function isImageUnsupportedMessage(message: string): boolean {
  return /\b(?:image(?:_url| input|s)?|vision|multimodal)\b.{0,60}\b(?:not supported|unsupported)\b|\b(?:model|endpoint|provider)\b.{0,40}\b(?:does not support|cannot accept)\b.{0,30}\bimage/i.test(message);
}

/**
 * Checks image input once before the first attached Builder call.
 *
 * A successful request proves support. Only an explicit image rejection proves
 * lack of support. Other failures leave the result unknown so the regular
 * Builder gateway recovery and image fallback can make the decision.
 */
export class VisionCapability {
  private verdict: VisionSupport | undefined;
  private inFlight: Promise<VisionSupport> | undefined;
  constructor(
    private readonly gateway: { baseUrl: string; model: string; apiKey: string },
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  /** Cached: concurrent and later callers reuse the first verdict. */
  async supports(remainingMs: number = Infinity): Promise<VisionSupport> {
    if (this.verdict) return this.verdict;
    this.inFlight ??= this.probe(remainingMs);
    try {
      this.verdict = await this.inFlight;
      return this.verdict;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async probe(remainingMs: number): Promise<VisionSupport> {
    const timeoutMs = Math.floor(Math.min(this.timeoutMs, remainingMs));
    if (timeoutMs <= 0) return "unknown";
    try {
      const response = await this.fetchImpl(`${this.gateway.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.gateway.apiKey}`,
          "content-type": "application/json",
          // Some OpenAI-compatible gateways route on this header; the Planner sends the same one.
          "x-opencode-session": randomUUID(),
        },
        body: JSON.stringify({
          model: this.gateway.model,
          max_tokens: 1,
          stream: false,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: "ok" },
              { type: "image_url", image_url: { url: `data:image/png;base64,${PROBE_IMAGE_BASE64}` } },
            ],
          }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return "supported";
      }
      if ([400, 415, 422].includes(response.status)) {
        const message = await response.text();
        return isImageUnsupportedMessage(message) ? "unsupported" : "unknown";
      }
      await response.body?.cancel().catch(() => undefined);
    } catch {
      // Timeout and transport errors are gateway observations, not model capability.
    }
    return "unknown";
  }
}
