import { VerifierAdapterRegistry } from "../verifier/adapters/registry.js";
import { createWebExecutionAdapter } from "../verifier/adapters/web/index.js";
import { webRuntimeConfig } from "./web/project-spec.js";

export const verifierAdapters = new VerifierAdapterRegistry(new Map([["web", async options => {
  const config = webRuntimeConfig(options.applicationContract);
  return createWebExecutionAdapter({ ...options, reservedPorts: [config.port, ...(config.evaluationPort ? [config.evaluationPort] : [])] });
}]]));
