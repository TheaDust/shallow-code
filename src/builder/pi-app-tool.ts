import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AppAction, AppStatus } from "./builder-app.js";

const parameters = Type.Object({ action: Type.Union([Type.Literal("start"), Type.Literal("status"), Type.Literal("stop")]) });

export function createAppTool(): ToolDefinition<typeof parameters> {
  return {
    name: "app", label: "Manage development app",
    description: "Start, inspect or stop the app using the controller's platform contract and isolated data. Install dependencies and build first. start waits for health readiness and returns baseUrl for browser. stop only stops this call's owned app. Stop before rebuilding, then start to load changes.",
    parameters, executionMode: "sequential",
    async execute(_id, { action }, signal) {
      const status = await requestApp(action, signal);
      return { content: [{ type: "text", text: JSON.stringify(status) }], details: status };
    },
  };
}

function requestApp(action: AppAction, signal?: AbortSignal): Promise<AppStatus> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const cleanup = () => { process.off("message", onMessage); signal?.removeEventListener("abort", onAbort); };
    const onAbort = () => { cleanup(); reject(new Error("Application tool aborted")); };
    const onMessage = (message: unknown) => {
      const response = message as { type?: string; id?: string; error?: string; status: AppStatus } | null;
      if (response?.type !== "builder_app_result" || response.id !== id) return;
      cleanup();
      if (response.error) reject(new Error(response.error)); else resolve(response.status);
    };
    process.on("message", onMessage);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (!process.send) { cleanup(); reject(new Error("Application tool requires a managed Worker")); return; }
    process.send({ type: "builder_app", id, action }, error => {
      if (error) { cleanup(); reject(error); }
    });
  });
}
