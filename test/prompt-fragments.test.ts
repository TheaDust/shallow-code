import assert from "node:assert/strict";
import { test } from "node:test";

import { selectPromptFragments } from "../src/builder/prompt-fragments.js";
import type {
  BuilderPromptInput,
  BuilderProjectContext,
  BuilderShadowObservation,
} from "../src/builder/prompt-input.js";
import type {
  AtomicRequirement,
  PlatformContract,
  WorkPacket,
} from "../src/types.js";

test("Known repository products always load the four base fragments", () => {
  assert.deepEqual(selectPromptFragments(repositoryRequest()), [
    "accessible_web_controls",
    "server_persistence",
    "auth_and_permission",
    "repository_collaboration",
  ]);
});

test("Known spreadsheet products always load the three base fragments", () => {
  assert.deepEqual(selectPromptFragments(spreadsheetRequest()), [
    "accessible_web_controls",
    "server_persistence",
    "spreadsheet_grid",
  ]);
});

test("Delivery repair loads only the delivery contract", () => {
  assert.deepEqual(selectPromptFragments(deliveryRequest()), [
    "delivery_contract",
  ]);
});

test("Generic web products select fragments only through the versioned lexicon", () => {
  assert.deepEqual(
    selectPromptFragments(genericRequest("User may rename a user role")),
    ["accessible_web_controls", "auth_and_permission"],
  );

  assert.deepEqual(
    selectPromptFragments(genericRequest("Refresh the synced history after saving")),
    ["accessible_web_controls", "server_persistence"],
  );

  assert.deepEqual(
    selectPromptFragments(genericRequest("合并请求的议题列表")),
    ["accessible_web_controls", "repository_collaboration"],
  );

  assert.deepEqual(
    selectPromptFragments(genericRequest("工作表公式引用单元格")),
    ["accessible_web_controls", "spreadsheet_grid"],
  );
});

test("Generic fragments use requirement text and this packet's public contracts", () => {
  const request = genericRequest("Manage objects");
  if (request.mode !== "implement") throw new Error("expected implement request");
  const contract = "Users can save private objects and reopen them after refresh.";
  const expected = ["accessible_web_controls", "server_persistence", "auth_and_permission"];
  request.packet.requirements[0].text = contract;
  assert.deepEqual(selectPromptFragments(request), expected);

  request.packet.requirements[0].text = "Manage objects.";
  request.projectContext.product.description = contract;
  assert.deepEqual(selectPromptFragments(request), expected);

  request.projectContext.product.description = "Root description.";
  request.projectContext.ancestors[0].description = contract;
  assert.deepEqual(selectPromptFragments(request), expected);
});

test("ARIA role wording does not select permission rules", () => {
  assert.deepEqual(selectPromptFragments(genericRequest("The title uses ARIA role heading")),
    ["accessible_web_controls"]);
  assert.deepEqual(selectPromptFragments(genericRequest("Apply access control to shared objects")),
    ["accessible_web_controls", "auth_and_permission"]);
});

test("Accessible region wording does not select spreadsheet rules", () => {
  assert.deepEqual(selectPromptFragments(genericRequest('A region named "Preview" is visible')),
    ["accessible_web_controls"]);
  assert.deepEqual(selectPromptFragments(genericRequest("可访问区域 Preview")),
    ["accessible_web_controls"]);
  assert.deepEqual(selectPromptFragments(genericRequest("Select a cell range")),
    ["accessible_web_controls", "spreadsheet_grid"]);
});

test("Arbitrary Shadow error text cannot select a domain fragment", () => {
  assert.deepEqual(
    selectPromptFragments(genericRepairWithMessage("spreadsheet formula failed")),
    ["accessible_web_controls"],
  );
});

test("Structured signals extend fragments without replacing the product base", () => {
  assert.deepEqual(
    selectPromptFragments(
      withObservation(genericRequest("Widget behaves per spec"), {
        applicationStartupFailed: true,
        failures: [],
      }),
    ),
    ["accessible_web_controls", "delivery_contract"],
  );

  assert.deepEqual(
    selectPromptFragments(
      withObservation(repositoryRequest(), {
        applicationStartupFailed: true,
        failures: [
          {
            caseId: "open-page",
            stepIndex: 0,
            category: "locator",
            message: "Could not find control",
          },
        ],
      }),
    ),
    [
      "accessible_web_controls",
      "server_persistence",
      "auth_and_permission",
      "repository_collaboration",
      "delivery_contract",
    ],
  );
});

function repositoryRequest(): BuilderPromptInput {
  return packetRequest("repository_collaboration", ["Repository work"]);
}

function spreadsheetRequest(): BuilderPromptInput {
  return packetRequest("spreadsheet", ["Workbook work"]);
}

function deliveryRequest(): BuilderPromptInput {
  return {
    mode: "delivery_repair",
    deliveryFailure: {
      stage: "build",
      expected: "平台构建命令成功退出并生成生产构建产物",
      actual: "production build failed",
    },
    outputDir: "C:\\candidate-app",
    platformContract: platformContract(),
  };
}

function genericRequest(requirementName: string): BuilderPromptInput {
  return packetRequest("generic_web", ["Profile"], [requirementName]);
}

function genericRepairWithMessage(message: string): BuilderPromptInput {
  const base = genericRequest("Widget behaves per spec");
  if (base.mode !== "implement") throw new Error("expected implement request");
  return {
    ...base,
    mode: "repair",
    shadowObservation: observation({
      applicationStartupFailed: false,
      failures: [
        {
          caseId: "case-1",
          stepIndex: 1,
          category: "assertion",
          message,
        },
      ],
    }),
  };
}

function withObservation(
  request: BuilderPromptInput,
  overrides: Pick<BuilderShadowObservation, "applicationStartupFailed" | "failures">,
): BuilderPromptInput {
  if (request.mode === "delivery_repair") throw new Error("expected packet request");
  return {
    ...request,
    mode: request.mode === "implement" ? "repair" : request.mode,
    shadowObservation: observation(overrides),
  };
}

function observation(
  overrides: Pick<BuilderShadowObservation, "applicationStartupFailed" | "failures">,
): BuilderShadowObservation {
  return {
    packetId: "packet-generic",
    passedCaseIds: [],
    ...overrides,
  };
}

function packetRequest(
  kind: BuilderProjectContext["product"]["kind"],
  ancestorNames: string[],
  requirementNames: string[] = ["Packet work"],
): BuilderPromptInput {
  return {
    mode: "implement",
    packet: packet(kind, requirementNames),
    projectContext: {
      product: {
        kind,
        rootId: "ROOT",
        rootName: "Demo Product",
        description: "Root description.",
        seedData: [],
      },
      ancestors: ancestorNames.map((name, index) => ({
        id: `AREA-${index}`,
        name,
        description: `${name} area`,
      })),
      satisfiedDependencies: [],
    },
    outputDir: "C:\\candidate-app",
    platformContract: platformContract(),
  };
}

function packet(kind: string, requirementNames: string[]): WorkPacket {
  return {
    id: "packet-generic",
    requirementIds: requirementNames.map((_, index) => `REQ-${index}`),
    attempt: 1,
    requirements: requirementNames.map((name, index): AtomicRequirement => ({
      id: `REQ-${index}`,
      folderPath: ["ROOT", "AREA-0"],
      declarationIndex: index,
      name,
      text: "Packet work description.",
      dependencyIds: [],
      scenarios: [`${name} scenario`],
      references: [],
      exactUiStrings: [],
      seedDeclarations: [],
      product: {
        kind: kind as never,
        rootId: "ROOT",
        rootName: "Demo Product",
        description: "Root description.",
        seedData: [],
      },
      ancestors: [
        { id: "AREA-0", name: "Area", description: "Area description." },
      ],
    })),
  };
}

function platformContract(): PlatformContract {
  return {
    baseUrl: "http://127.0.0.1:3000",
    port: 3000,
    evaluationPort: 3000,
    installCommands: [],
    buildCommands: [],
    startCommand: { executable: "npm", args: ["run", "start"], cwd: "backend" },
    healthPath: "/health",
    buildTimeoutMs: 120_000,
    startTimeoutMs: 30_000,
  };
}
