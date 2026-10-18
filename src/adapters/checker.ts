import { CheckerAdapterRegistry } from "../checker/adapters/registry.js";
import { createWebExecutionAdapter } from "../checker/adapters/web/index.js";
import { webRuntimeConfig } from "./web/project-spec.js";

export const checkerAdapters = new CheckerAdapterRegistry(new Map([["web", async options => {
  const config = webRuntimeConfig(options.applicationContract);
  return createWebExecutionAdapter({ ...options, reservedPorts: [config.port, ...(config.evaluationPort ? [config.evaluationPort] : [])] });
}]]));
