import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { BuilderTool } from "./tool-contract.js";

export interface RepairDiffInput { caseId: string; path?: string; offset?: number }
export type RepairDiffReader = (input: RepairDiffInput) => Promise<unknown>;
const parameters = Type.Object({ caseId: Type.String({ minLength: 1 }), path: Type.Optional(Type.String({ minLength: 1 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })) });

/** The worker sees only application diffs returned by the owning controller. */
export function createRepairDiffTool(): BuilderTool<typeof parameters> {
  return { name: "repair_diff", label: "Read application changes", parameters, executionMode: "sequential",
    description: "Read application changes between a scenario's compatible historical passing snapshot and its failing snapshot. Start with caseId for a file summary, then request path and optional offset for paged diff text. These immutable changes are localization clues; repair current code while preserving later features. An unavailable baseline does not establish a regression.",
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const result = await new Promise<unknown>((resolve, reject) => {
        const id = randomUUID();
        const cleanup = () => { process.off("message", onMessage); signal?.removeEventListener("abort", onAbort); };
        const onAbort = () => { cleanup(); reject(new Error("Repair diff aborted")); };
        const onMessage = (message: unknown) => {
          const response = message as { type?: string; id?: string; result?: unknown; error?: string } | null;
          if (response?.type !== "builder_diff_result" || response.id !== id) return;
          cleanup();
          if (response.error) reject(new Error(response.error)); else resolve(response.result);
        };
        process.on("message", onMessage);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (!process.send) { cleanup(); reject(new Error("Repair diff requires a managed Worker")); return; }
        process.send({ type: "builder_diff", id, input }, error => { if (error) { cleanup(); reject(error); } });
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    } };
}
