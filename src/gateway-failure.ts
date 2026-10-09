/** Transport metadata only. Model text and tool failures are not gateway errors. */
export interface GatewayFailure {
  kind: "rate_limit" | "unavailable" | "authentication" | "request";
  retryable: boolean;
  status?: number;
  retryAfterMs?: number;
}

export function httpGatewayFailure(status: number, retryAfter: string | null = null, now = Date.now()): GatewayFailure {
  const seconds = retryAfter === null || retryAfter.trim() === "" ? NaN : Number(retryAfter);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : retryAfter ? Date.parse(retryAfter) - now : NaN;
  return {
    kind: status === 429 ? "rate_limit" : status === 401 || status === 403 ? "authentication"
      : status === 408 || status >= 500 ? "unavailable" : "request",
    retryable: status === 429 || status === 408 || status >= 500,
    status,
    ...(Number.isFinite(delay) && delay >= 0 ? { retryAfterMs: delay } : {}),
  };
}

/** The ARC proxy sometimes reports an upstream TCP reset as HTTP 400. */
export function classifyGatewayFailure(failure: GatewayFailure, providerError?: string): GatewayFailure {
  if (failure.status === 400 && providerError &&
    /^(?:400 )?400 Post "https?:\/\/[^"\r\n]+\/chat\/completions": read tcp [^\r\n]+: read: connection reset by peer(?: \(request id: [^)\r\n]+\))?$/i.test(providerError)) {
    return { ...failure, kind: "unavailable", retryable: true };
  }
  return failure;
}

export class GatewayRequestError extends Error {
  constructor(readonly gatewayFailure: GatewayFailure, options?: ErrorOptions) {
    super(`Model gateway ${gatewayFailure.kind}${gatewayFailure.status ? ` (HTTP ${gatewayFailure.status})` : ""}`, options);
  }
}

/** Observe only this worker's configured model endpoint, preserving response bodies. */
export function observeGatewayFailures(baseUrl: string) {
  const original = globalThis.fetch;
  const endpoint = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  let failure: GatewayFailure | undefined;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== endpoint) return original(input, init);
    try {
      const response = await original(input, init);
      failure = response.ok ? undefined : httpGatewayFailure(response.status, response.headers.get("retry-after"));
      return response;
    } catch (error) {
      failure = { kind: "unavailable", retryable: true };
      throw error;
    }
  };
  return { failure: () => failure, uninstall: () => { globalThis.fetch = original; } };
}
