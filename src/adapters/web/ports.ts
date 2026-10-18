import { createServer } from "node:net";

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

