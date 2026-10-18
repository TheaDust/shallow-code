import type { RuntimeAdapter } from "./port.js";

/** Registration is explicit at composition roots, including Worker entrypoints. */
export class ApplicationRegistry {
  private readonly adapters = new Map<string, RuntimeAdapter>();
  constructor(adapters: readonly RuntimeAdapter[]) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.id)) throw new Error(`Duplicate application adapter: ${adapter.id}`);
      this.adapters.set(adapter.id, adapter);
    }
  }
  get(id: string): RuntimeAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Unknown application adapter ${id}; available: ${[...this.adapters.keys()].join(", ")}`);
    return adapter;
  }
}
