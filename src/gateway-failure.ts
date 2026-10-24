import { AsyncLocalStorage } from "node:async_hooks";

/** Emitted only by the transport rewriter, never inferred from assistant text. */
export const INCOMPLETE_GATEWAY_STREAM = "provider returned error: gateway truncated a content-bearing SSE event";

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

/**
 * Pi reports an HTTP failure as `<status>: <json body>`. Return the provider
 * message used by `classifyGatewayFailure`, preserving non-HTTP error text.
 */
export function providerErrorMessage(error: string | undefined): string | undefined {
  if (error === undefined) return undefined;
  const envelope = error.match(/^(?:Error: )?(\d{3}): ([\s\S]*)$/);
  if (!envelope) return error;
  try {
    const body = JSON.parse(envelope[2]) as unknown;
    if (typeof body === "object" && body !== null) {
      const record = body as { message?: unknown; error?: { message?: unknown } };
      if (typeof record.message === "string") return record.message;
      if (typeof record.error?.message === "string") return record.error.message;
    }
  } catch { /* Preserve the SDK error when the body is not valid JSON. */ }
  return error;
}

/**
 * Derive transport metadata from the provider error Pi exposes. A status in the
 * error envelope always wins; the fetch observation supplies Retry-After and
 * covers transport failures that never produced an HTTP response.
 */
export function providerGatewayFailure(providerError: string | undefined, observed?: GatewayFailure): GatewayFailure | undefined {
  const status = /^(?:Error: )?(\d{3})(?::|\s)/.exec(providerError ?? "")?.[1];
  const retryAfter = observed?.retryAfterMs === undefined ? {} : { retryAfterMs: observed.retryAfterMs };
  const failure = status === undefined
    ? observed
    : { ...httpGatewayFailure(Number(status)), ...(observed?.status === Number(status) ? retryAfter : {}) };
  if (!failure) {
    return providerError?.replace(/^Error: /, "") === INCOMPLETE_GATEWAY_STREAM
      ? { kind: "unavailable", retryable: true } : undefined;
  }
  return classifyGatewayFailure(failure, providerErrorMessage(providerError));
}

export class GatewayRequestError extends Error {
  constructor(readonly gatewayFailure: GatewayFailure, options?: ErrorOptions) {
    super(`Model gateway ${gatewayFailure.kind}${gatewayFailure.status ? ` (HTTP ${gatewayFailure.status})` : ""}`, options);
  }
}

export interface GatewayFailureObservation {
  /** Last failure outside a tracked scope, or the failure of the current scope. */
  failure(): GatewayFailure | undefined;
  /**
   * Runs work with asynchronous-call-scoped failure tracking. Concurrent clients
   * that share the same endpoint therefore cannot overwrite each other's status.
   */
  track<T>(operation: () => Promise<T>): Promise<T>;
  uninstall(): void;
}

interface ObservationState { failure?: GatewayFailure }
interface ObservationRegistration {
  endpoint: string;
  global: ObservationState;
  scoped: AsyncLocalStorage<ObservationState>;
}
interface ObservationRegistry {
  original: typeof fetch;
  registrations: Set<ObservationRegistration>;
}

let observationRegistry: ObservationRegistry | undefined;

function ensureObservationRegistry(): ObservationRegistry {
  if (observationRegistry) return observationRegistry;
  const original = globalThis.fetch;
  const registry: ObservationRegistry = { original, registrations: new Set() };
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const registrations = [...registry.registrations].filter(registration => registration.endpoint === url);
    if (registrations.length === 0) return original(input, init);
    try {
      const response = await original(input, init);
      const failure = response.ok ? undefined : httpGatewayFailure(response.status, response.headers.get("retry-after"));
      for (const registration of registrations) {
        (registration.scoped.getStore() ?? registration.global).failure = failure;
      }
      return response;
    } catch (error) {
      for (const registration of registrations) {
        (registration.scoped.getStore() ?? registration.global).failure = { kind: "unavailable", retryable: true };
      }
      throw error;
    }
  }) as typeof globalThis.fetch;
  observationRegistry = registry;
  return registry;
}

/** Observe only this worker's configured model endpoint, preserving response bodies. */
export function observeGatewayFailures(baseUrl: string): GatewayFailureObservation {
  const endpoint = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  const registration: ObservationRegistration = {
    endpoint,
    global: {},
    scoped: new AsyncLocalStorage<ObservationState>(),
  };
  const registry = ensureObservationRegistry();
  registry.registrations.add(registration);
  let installed = true;
  return {
    failure: () => {
      const scoped = registration.scoped.getStore();
      return scoped ? scoped.failure : registration.global.failure;
    },
    track: operation => registration.scoped.run({}, operation),
    uninstall() {
      if (!installed) return;
      installed = false;
      registry.registrations.delete(registration);
      // Other registrations may still use the wrapper installed for this process.
      if (observationRegistry === registry && registry.registrations.size === 0) {
        globalThis.fetch = registry.original;
        observationRegistry = undefined;
      }
    },
  };
}
