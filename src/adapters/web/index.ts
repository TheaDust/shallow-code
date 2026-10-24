import type { RuntimeAdapter } from "../../application/port.js";
import { loadPrompt } from "../../prompt-assets.js";
import { parseEvaluationPort, parseProbePortOverride, pickFreePort } from "./ports.js";
import { installStarterScaffold } from "./scaffold.js";
import { webBuilderCapabilities } from "./builder-capabilities.js";
import { WebAppLifecycle, verifyDeclaredPorts } from "./runtime.js";
import { minimalWebProjectSpec, npmExecutable, parseProjectSpec, resolveRuntimeContract, webSettings } from "./project-spec.js";

export const webApplicationAdapter: RuntimeAdapter = {
  id: "web", parseSpec: parseProjectSpec,
  initializationInstructions: loadPrompt("adapters/web", "initialization"),
  defaultSpec: () => minimalWebProjectSpec(npmExecutable()),
  async configure(spec, env) {
    const evaluationPort = parseEvaluationPort(env);
    const extras = webSettings(spec).extraPorts;
    const override = parseProbePortOverride(env);
    if (override !== null && (override === evaluationPort || extras.includes(override))) {
      throw new Error(`SHALLOW_PROBE_PORT must differ from the evaluation port ${evaluationPort} and the project extra ports ${extras.join(", ") || "(none)"}`);
    }
    const port = override ?? await pickFreePort([...(evaluationPort === null ? [] : [evaluationPort]), ...extras]);
    return resolveRuntimeContract(spec, { port, ...(evaluationPort === null ? {} : { evaluationPort }) });
  },
  lifecycle: new WebAppLifecycle(),
  installScaffold: installStarterScaffold,
  builderCapabilities: webBuilderCapabilities,
  verifyDelivery: verifyDeclaredPorts,
};
