import { register } from "tsx/esm/api";

// Keep the worker entry executable as ordinary Node JavaScript in source distributions.
register();
const { executeSandboxRealm } = await import("./program-runtime.ts");
const pending = new Map();
let nextId = 0;
process.on("message", async (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "response") {
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    if (message.error) call.reject(new Error(message.error));
    else call.resolve(message.value);
  } else if (message.type === "execute") {
    try {
      const value = await executeSandboxRealm(message.source, (method, input) => new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        process.send({ type: "invoke", id, method, input });
      }), { signal: new AbortController().signal, timeoutMs: message.timeoutMs, memoryLimitBytes: message.memoryLimitBytes });
      process.send({ type: "result", value: value ?? null });
    } catch (error) { process.send({ type: "error", error: error instanceof Error ? error.message : String(error) }); }
  }
});
process.on("disconnect", () => process.exit(0));
