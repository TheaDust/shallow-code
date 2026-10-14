import { fileURLToPath } from "node:url";

/** Explicit, controller-owned resources; Pi's workspace/global discovery stays disabled. */
export const BUILDER_SKILLS_DIR = fileURLToPath(new URL("../../prompts/skills/", import.meta.url));
