import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { CandidateRuntime } from "../../application/candidate-runtime.js";
import type { ApplicationContract } from "../../application/port.js";
import { WebAppLifecycle } from "./runtime.js";

/** Verify the declared Web contract against an isolated installed and built copy. */
export async function verifyInitializedWebProject(outputDir: string, contract: ApplicationContract, _privateDir: string): Promise<void> {
  if (contract.adapterId !== "web") throw new Error(`Initialization verification is unavailable for adapter ${contract.adapterId}`);
  const config = contract.adapterConfig as { baseUrl: string; browserPath: string };
  // Candidate builds create deep node_modules paths. Use the short OS temp root
  // rather than the caller's private directory, whose length depends on the run path.
  const workspace = await mkdtemp(join(tmpdir(), "sci-"));
  try {
    const runtime = new CandidateRuntime(outputDir, workspace, contract, new WebAppLifecycle());
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
  } finally { await rm(workspace, { recursive: true, force: true }).catch(() => {}); }
}
