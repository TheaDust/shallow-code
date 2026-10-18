import type { ApplicationLifecycle } from "../application/port.js";
import type { ApplicationContract } from "../types.js";

export type AppAction = "start" | "status" | "stop";
export interface AppStatus { running: boolean; metadata?: unknown }

/** Parent-owned: survives Worker termination long enough to finish cleanup. */
export class BuilderApp {
  private application?: Awaited<ReturnType<ApplicationLifecycle["start"]>>;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(private outputDir: string, private contract: ApplicationContract,
    private lifecycle: ApplicationLifecycle) {}

  run(action: AppAction): Promise<AppStatus> {
    if (this.closed) return Promise.reject(new Error("Builder application manager is closed"));
    return this.serial(async () => {
      if (action === "stop") await this.stop();
      if (this.application) {
        try { await this.application.assertUnchanged?.(); }
        catch { await this.stop(); }
      }
      if (action === "start" && !this.application) {
        this.application = await this.lifecycle.start(this.outputDir, this.contract);
      }
      return { running: Boolean(this.application), metadata: this.application?.metadata };
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.serial(() => this.stop());
  }
  private async stop(): Promise<void> {
    if (this.application) { await this.application.stop(); this.application = undefined; }
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
}
