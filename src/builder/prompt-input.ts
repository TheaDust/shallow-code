import type {
  ApplicationContract,
  ProductContext,
  RequirementAncestor,
  WorkPacket,
} from "../types.js";

export interface BuilderProjectContext {
  product: ProductContext;
  ancestors: RequirementAncestor[];
  satisfiedDependencies: Array<{ id: string; name: string; contract?: string }>;
  startingPoint?: "inherited_application" | "blank_template" | "unknown";
  externalPrerequisiteIds?: string[];
}

export interface BuilderShadowObservation {
  packetId: string;
  passedCaseIds: string[];
  failures: Array<{
    caseId: string;
    stepIndex: number;
    category: "assertion" | "locator" | "navigation" | "timeout" | "runner" | "precondition";
    message: string;
    inputSummary?: string;
    accessibilityExcerpt?: string;
  }>;
  applicationStartupFailed: boolean;
}

export interface DeliveryFailureObservation {
  stage: "install" | "build" | "readiness" | "entry" | "candidate" | "complete";
  command?: string;
  expected: string;
  actual: string;
}

export type BuilderPromptInput = (
  | {
      mode: "implement";
      packet: WorkPacket;
      projectContext: BuilderProjectContext;
      outputDir: string;
      applicationContract: ApplicationContract;
    }
  | {
      mode: "repair" | "root_cause_repair";
      packet: WorkPacket;
      projectContext: BuilderProjectContext;
      shadowObservation: BuilderShadowObservation;
      outputDir: string;
      applicationContract: ApplicationContract;
    }
  | {
      mode: "delivery_repair";
      deliveryFailure: DeliveryFailureObservation;
      outputDir: string;
      applicationContract: ApplicationContract;
    }) & { initialization?: { path: import("../project-initialization.js").InitializationPath; intent: string | null } };
