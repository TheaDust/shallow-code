import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TEMPLATE_PLACEHOLDER = /\{\{([^{}]+)\}\}/g;

export class PromptAssetError extends Error {}

const cache = new Map<string, string>();

export function loadPrompt(
  category: "system" | "fragments" | "judge" | "planning",
  name: string,
): string {
  const key = `${category}/${name}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const assetPath = fileURLToPath(
    new URL(`../prompts/${category}/${name}.md`, import.meta.url),
  );
  let raw: string;
  try {
    raw = readFileSync(assetPath, "utf8");
  } catch (error) {
    throw new PromptAssetError(
      `Unable to read prompt asset ${key} (looked for ${assetPath}): ${String(error)}`,
    );
  }
  const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
  cache.set(key, text);
  return text;
}

export function fillTemplate(
  template: string,
  values: Record<string, string>,
): string {
  let filled = template;
  for (const [key, value] of Object.entries(values)) {
    if (value.includes("{{")) {
      throw new Error(`Value for placeholder ${key} contains literal "{{"; fillTemplate refuses ambiguous substitution`);
    }
    filled = filled.split(`{{${key}}}`).join(value);
  }
  const residual = [...filled.matchAll(TEMPLATE_PLACEHOLDER)].map(
    (match) => match[1].trim(),
  );
  if (residual.length > 0) {
    throw new Error(
      `Template still has unfilled placeholders after substitution: ${[...new Set(residual)].join(", ")}`,
    );
  }
  return filled;
}
