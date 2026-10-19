import { join } from "node:path";
import { chromium } from "@playwright/test";
import { CandidateRuntime } from "../../application/candidate-runtime.js";
import type { ApplicationContract } from "../../application/port.js";
import { WebAppLifecycle } from "./runtime.js";

/** Verify the declared Web contract against an isolated installed and built copy. */
export async function verifyInitializedWebProject(outputDir: string, contract: ApplicationContract, privateDir: string): Promise<void> {
  if (contract.adapterId !== "web") throw new Error(`Initialization verification is unavailable for adapter ${contract.adapterId}`);
  const config = contract.adapterConfig as { baseUrl: string; browserPath: string };
  const runtime = new CandidateRuntime(outputDir, join(privateDir, "initialization-candidate"), contract,
    new WebAppLifecycle());
  try {
    const app = await runtime.start(outputDir, contract);
    try {
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        const response = await page.goto(new URL(config.browserPath, config.baseUrl).href);
        if (!response?.ok()) throw new Error(`Browser entry returned ${response?.status() ?? "no response"}`);
        const type = response.headers()["content-type"] ?? "";
        if (!type.includes("text/html")) throw new Error(`Browser entry is not HTML: ${type}`);
        await app.assertUnchanged?.();
      } finally { await browser.close(); }
    } finally { await app.stop(); }
  } finally { await runtime.dispose(); }
}
