import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { BuilderCapabilityPack } from "../../application/port.js";
import type { BuilderTool } from "../../builder/tool-contract.js";
import { assertToolPath } from "../../builder/pi-tools.js";
import { createBrowserTool, closeSharedBrowser } from "./browser-tool.js";
import { listCapabilities, installCapability } from "./capability-catalog.js";

export function webBuilderCapabilities(directory: string): BuilderCapabilityPack {
  const tools: BuilderTool[] = [createBrowserTool(), {
    name: "list_capabilities", label: "List approved capabilities",
    description: "List approved task-neutral Web component packs and their installation status.",
    parameters: Type.Object({}), executionMode: "sequential",
    async execute() {
      await assertToolPath(directory, "frontend/src/ui");
      const capabilities = await listCapabilities(directory);
      return { content: [{ type: "text", text: JSON.stringify(capabilities) }], details: { capabilities } };
    },
  }, {
    name: "install_capability", label: "Install approved capability",
    description: "Install an approved task-neutral Web component pack; existing differing files are preserved.",
    parameters: Type.Object({ id: Type.String() }), executionMode: "sequential",
    async execute(_id, params) {
      await assertToolPath(directory, "frontend/src/ui");
      const result = await installCapability(directory, (params as { id: string }).id);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  }];
  return { tools, skillDirectories: [fileURLToPath(new URL("../../../prompts/adapters/web/skills/", import.meta.url))], close: closeSharedBrowser };
}
