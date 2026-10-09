import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";

import { PromptBuilder } from "../src/builder/prompt-builder.js";
import { PiWorkerClient } from "../src/builder/pi-worker-client.js";
import { CommandAppLifecycle, FinalVerifier } from "../src/final-verifier.js";
import { LlmProbePlanner } from "../src/judge/llm-probe-planner.js";
import { PlaywrightProbeRunner } from "../src/judge/playwright-probe-runner.js";
import { createArcPlatformContract, pickFreePort, readEnvFile, readGatewayConfig } from "../src/runtime-config.js";
import type { WorkPacket } from "../src/types.js";
import { withTempDir } from "./helpers/temp-dir.js";

for (const [name, value] of Object.entries(await readEnvFile(".env"))) {
  if (!(name in process.env)) process.env[name] = value;
}

const required = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "MODEL"] as const;
const missing = required.filter((name) => !process.env[name]);
const enabled = process.env.RUN_CREDENTIAL_SMOKE === "1" && missing.length === 0;
const skipReason = enabled
  ? false
  : `set RUN_CREDENTIAL_SMOKE=1 and ${required.join(", ")} (missing: ${missing.join(", ") || "opt-in"})`;

test(
  "credential smoke uses real Pi, LLM planning, and Playwright",
  { skip: skipReason },
  async () => {
    await withTempDir("shallow-credential-", async (outputDir) => {
      const contract = createArcPlatformContract(process.platform, await pickFreePort());
      const packet = smokePacket();
      const builder = new PromptBuilder(new PiWorkerClient(readGatewayConfig(process.env), join(outputDir, "..", `pi-smoke-${process.pid}`)), { timeoutMs: 240_000 });
      try {
        const built = await builder.run({
          mode: "implement",
          packet,
          projectContext: {
            product: packet.requirements[0].product,
            ancestors: packet.requirements[0].ancestors,
            satisfiedDependencies: [],
          },
          outputDir,
          platformContract: contract,
        });
        assert.equal(built.outcome, "completed", built.summary);

        const planner = new LlmProbePlanner({
          apiKey: process.env.OPENAI_API_KEY!,
          baseUrl: process.env.OPENAI_BASE_URL!,
          model: process.env.MODEL!,
          timeoutMs: 60_000,
        });
        const plan = await planner.plan(packet);
        const runner = new PlaywrightProbeRunner();
        const lifecycle = new CommandAppLifecycle();
        const delivery = await new FinalVerifier(runner, lifecycle).verify(
          outputDir,
          contract,
        );
        assert.equal(delivery.ok, true, delivery.message);

        const application = await lifecycle.start(outputDir, contract);
        try {
          const report = await runner.run(plan, {
            baseUrl: application.baseUrl,
            stepTimeoutMs: 5_000,
            caseTimeoutMs: 30_000,
          });
          assert.equal(report.verdict, "pass", JSON.stringify(report.failures));
        } finally {
          await application.stop();
        }
      } finally {
        await builder.close();
      }
    });
  },
);

function smokePacket(): WorkPacket {
  return {
    id: "credential-smoke",
    requirementIds: ["REQ-SMOKE"],
    attempt: 1,
    requirements: [
      {
        id: "REQ-SMOKE",
        folderPath: ["ROOT", "SMOKE"],
        declarationIndex: 0,
        name: "Persist a profile name",
        text:
          "Create the ARC frontend/backend application. The root page has a main landmark, a visibly labelled Profile name input, a Save button, and a status named Saved after saving. The saved value remains after refresh. The backend exposes GET /health with a 2xx response.",
        dependencyIds: [],
        scenarios: [
          "Save and refresh\nWHEN: Enter Ada in Profile name and click Save.\nTHEN: Saved is visible and Profile name remains Ada after refresh.",
        ],
        references: [],
        exactUiStrings: ["Profile name", "Save", "Saved"],
        seedDeclarations: [],
        product: {
          kind: "generic_web",
          rootId: "ROOT",
          rootName: "Demo Product",
          description: "Root description.",
          seedData: [],
        },
        ancestors: [
          { id: "SMOKE", name: "SMOKE", description: "SMOKE area" },
        ],
      },
    ],
  };
}
