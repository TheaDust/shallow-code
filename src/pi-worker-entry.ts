import { applications } from "./adapters/index.js";
import { runPiWorker } from "./builder/pi-worker.js";
import type { PiWorkerRequest } from "./builder/pi-worker-client.js";

process.once("message", (input: PiWorkerRequest) => {
  void (async () => {
    const capabilities = input.applicationContract ? applications.get(input.applicationContract.adapterId).builderCapabilities(input.outputDir) : undefined;
    try { return await runPiWorker(input, capabilities); }
    finally { await capabilities?.close(); }
  })().then(result => process.send?.(result), error => process.send?.({ sessionId: "unavailable", outcome: "failed", summary: String(error) }));
});
process.on("disconnect", () => process.exit(1));
