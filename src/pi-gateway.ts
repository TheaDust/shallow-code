import { SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { acquireSseResilience } from "./builder/sse-resilience.js";
import { GatewayRequestError, observeGatewayFailures, providerGatewayFailure } from "./gateway-failure.js";

/** One Pi retry policy for Builder, Verifier and Grouper; the caller owns its total deadline. */
export function piGatewaySettings(timeoutMs: number): SettingsManager {
  return SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 1_000,
    provider: { maxRetries: 0, timeoutMs: Math.max(1, Math.min(2_147_483_647, timeoutMs)) } },
    compaction: { enabled: true }, enableInstallTelemetry: false });
}

/** Transport repair and provider-error translation, independent of an agent's tools and acceptance rules. */
export function createPiGateway(baseUrl: string, onRepair?: (raw: string) => void) {
  const observation = observeGatewayFailures(baseUrl);
  const resilience = acquireSseResilience(onRepair);
  return {
    async prompt(session: Pick<AgentSession, "prompt" | "waitForIdle" | "subscribe" | "abort">,
      text: string, options?: Parameters<AgentSession["prompt"]>[1] & { signal?: AbortSignal }): Promise<void> {
      const { signal, ...promptOptions } = options ?? {};
      signal?.throwIfAborted();
      return observation.track(async () => {
        // Failed SDK attempts can disappear from projected session history.
        let providerError: string | undefined;
        const unsubscribe = session.subscribe(event => {
          if (event.type !== "message_end" || event.message.role !== "assistant") return;
          providerError = event.message.stopReason === "error" || event.message.stopReason === "aborted"
            ? event.message.errorMessage ?? event.message.stopReason : undefined;
        });
        const abort = () => { void session.abort(); };
        signal?.addEventListener("abort", abort, { once: true });
        try {
          await session.prompt(text, { ...promptOptions, expandPromptTemplates: false });
          // A terminal message alone does not settle SDK retries, compaction or continuation.
          await session.waitForIdle();
          signal?.throwIfAborted();
          if (providerError) throw new Error(providerError);
        } catch (error) {
          signal?.throwIfAborted();
          if (error instanceof GatewayRequestError) throw error;
          const failure = providerGatewayFailure(providerError ?? (error instanceof Error ? error.message : String(error)), observation.failure());
          if (failure) throw new GatewayRequestError(failure, { cause: error });
          throw error;
        } finally {
          signal?.removeEventListener("abort", abort);
          unsubscribe();
        }
      });
    },
    dispose() {
      resilience.uninstall();
      observation.uninstall();
    },
  };
}
