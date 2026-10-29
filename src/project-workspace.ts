import { readdir } from "node:fs/promises";
import { CONTROLLER_METADATA } from "./controller-metadata.js";

/** A fresh output may carry configuration, requirements or run metadata before a scaffold exists. */
export async function hasProjectFiles(directory: string): Promise<boolean> {
  return (await readdir(directory)).some(name => !CONTROLLER_METADATA.has(name));
}
