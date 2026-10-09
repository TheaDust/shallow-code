import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { GatewayRequestError, httpGatewayFailure } from "../src/gateway-failure.js";
import { LlmFeatureGrouper } from "../src/llm-feature-grouper.js";
import { withModulePipeline, pass, testPlan } from "./helpers/module-pipeline.js";
import { loadRequirementCatalog } from "../src/catalog.js";
import { auditPackets } from "../src/scheduler.js";
import { PlanCache } from "../src/judge/plan-cache.js";

const proposal = { groups: [
  { requirementIds: ["A"], purpose: "模型说明不能修改原文" },
  { requirementIds: ["B"], purpose: "独立业务增量" },
  { requirementIds: ["C"], purpose: "后续模块" },
] };

test("Progressive stages schedule current requirements while treating prior-stage IDs as context", async () => {
  await withModulePipeline(async f => {
    await writeFile(f.options.requirementsFile, JSON.stringify({
      id: "ROOT", name: "Repository Workspace — Phase 2", type: "FOLDER", dependencies: [],
      description: "Add the next set of repository capabilities.",
      children: [{ id: "REQ-3", name: "Repositories", type: "FOLDER", dependencies: ["REQ-1-1-2"],
        description: "Repository area.", children: [
          { id: "REQ-3-1", name: "Browse repositories", type: "ATOMIC", dependencies: [],
            description: "Display the repository workspace." },
        ] }],
    }));
    f.options.stageStartingPoint = "inherited_application";
    let plannedExternal: string[] | undefined;
    f.deps.planner.plan = async packet => {
      plannedExternal = packet.externalPrerequisiteIds;
      return { packetId: packet.id, cases: [{ id: "case-stage", requirementIds: packet.requirementIds,
        purpose: "happy_path", expectationBasis: [packet.requirements[0].text],
        steps: [{ op: "goto", path: "/" }, { op: "expectVisible", locator: { by: "role", role: "main" } }] }] };
    };

    const result = await f.run();
    assert.equal(result.status, "delivered");
    assert.equal(f.builder.requests.length, 1);
    const request = f.builder.requests[0];
    if (request.mode !== "implement") throw new Error("expected implement request");
    assert.deepEqual(request.packet.requirementIds, ["REQ-3-1"]);
    assert.deepEqual(request.projectContext.progressiveStage, {
      index: 2,
      currentStageTestsOnly: true,
      startingPoint: "inherited_application",
      externalPrerequisiteIds: ["REQ-1-1-2"],
    });
    assert.deepEqual(plannedExternal, ["REQ-1-1-2"]);
    const started = (await f.events()).find(event => event.type === "pipeline_started");
    assert.equal(started?.detail?.progressiveStage?.index, 2);
    assert.equal(started?.detail?.progressiveStage?.startingPoint, "inherited_application");
  });
});

test("Tagged and untagged inherited increments schedule and audit only current requirements", async () => {
  for (const [rootName, stageIndex] of [
    ["GitHub", undefined], ["GitHub - Evolution", undefined], ["GitHub - Evolution - Stage 2", 2],
  ] as const) {
    await withModulePipeline(async f => {
      await writeFile(f.options.requirementsFile, JSON.stringify({
        id: "ROOT", name: rootName,
        type: "FOLDER", description: "Extend the existing repository workspace.",
        children: [{ id: "REQ-3", name: "Repositories", type: "FOLDER", dependencies: ["REQ-1"], children: [
          { id: "REQ-3-1", name: "Browse repositories", type: "ATOMIC", description: "Display the repository workspace." },
        ] }],
      }));
      f.options.stageStartingPoint = "inherited_application";
      const plannedIds: string[][] = [];
      f.deps.planner.plan = async packet => {
        plannedIds.push(packet.requirementIds);
        assert.deepEqual(packet.externalPrerequisiteIds, ["REQ-1"]);
        assert.equal(packet.requirements[0].product.kind, "repository_collaboration");
        return { packetId: packet.id, cases: [{ id: "case-evolution", requirementIds: packet.requirementIds,
          purpose: "happy_path", expectationBasis: [packet.requirements[0].text],
          steps: [{ op: "goto", path: "/" }, { op: "expectVisible", locator: { by: "role", role: "main" } }] }] };
      };

      const result = await f.run();
      assert.equal(result.status, "delivered");
      assert.deepEqual(result.implementedRequirementIds, ["REQ-3-1"]);
      assert.deepEqual(result.verifiedRequirementIds, ["REQ-3-1"]);
      assert.deepEqual(plannedIds, [["REQ-3-1"]]);
      assert.equal(f.builder.requests.length, 1);
      const request = f.builder.requests[0];
      if (request.mode !== "implement") throw new Error("expected implement request");
      assert.deepEqual(request.projectContext.evolution, {
        startingPoint: "inherited_application", externalPrerequisiteIds: ["REQ-1"],
        ...(stageIndex === undefined ? {} : { stageIndex }),
      });
      assert.equal(request.projectContext.progressiveStage, undefined);
      assert.deepEqual(request.projectContext.product.stage,
        stageIndex === undefined ? undefined : { index: stageIndex, currentStageTestsOnly: true });
      const started = (await f.events()).find(event => event.type === "pipeline_started");
      assert.deepEqual(started?.detail?.evolution, {
        startingPoint: "inherited_application", externalDependencyIds: ["REQ-1"],
        ...(stageIndex === undefined ? {} : { stageIndex }),
      });
    });
  }
});

test("Inherited plans cannot substitute for fresh audits of updated and new requirements", async () => {
  await withModulePipeline(async f => {
    await writeFile(f.options.requirementsFile, JSON.stringify({
      id: "ROOT", name: "GitHub", type: "FOLDER", children: [
        { id: "AREA", name: "Current area", type: "FOLDER", children: [
          { id: "OLD", name: "Updated feature", type: "ATOMIC", description: "Original Feature Description\n\nDisplay the old workspace.\n\nModified Feature Description\n\nDisplay the updated workspace." },
          { id: "NEW", name: "New feature", type: "ATOMIC", description: "Display the new feature." },
        ] },
      ],
    }));
    f.options.stageStartingPoint = "inherited_application";
    f.options.progressDir = join(f.options.outputDir, "shallow-progress");
    const mirror = join(f.options.progressDir, "plans");
    const catalog = await loadRequirementCatalog(f.options.requirementsFile, { inheritedApplication: true });
    const [oldPacket] = auditPackets(catalog);
    const previous = new PlanCache(join(dirname(f.options.outputDir), "previous-run"), mirror);
    const inherited = testPlan(oldPacket);
    inherited.cases[0].id = "inherited-case";
    inherited.coverageReview = "verified";
    await previous.write(oldPacket.id, inherited);
    const [oldFile] = await readdir(mirror);

    const planned: string[] = [];
    const executed: string[] = [];
    f.deps.planner.plan = async packet => {
      planned.push(...packet.requirementIds);
      const fresh = testPlan(packet);
      fresh.cases[0].id = `current-${packet.requirementIds[0]}`;
      return fresh;
    };
    f.deps.runner.run = async plan => {
      executed.push(...plan.cases.map(item => item.id));
      return pass(plan);
    };
    const result = await f.run();
    assert.equal(result.status, "delivered");
    assert.deepEqual(planned.sort(), ["NEW", "OLD"]);
    assert.deepEqual(result.verifiedRequirementIds.sort(), ["NEW", "OLD"]);
    assert.ok(executed.includes("current-OLD") && executed.includes("current-NEW"));
    assert.ok(!executed.includes("inherited-case"));
    assert.equal(JSON.parse(await readFile(join(mirror, oldFile), "utf8")).cases[0].id, "current-OLD");
  });
});

test("The main pipeline uses the runtime proposal once while auditing every original atomic", async () => {
  await withModulePipeline(async f => {
    let calls = 0;
    f.deps.grouper = { group: async (catalog, options) => {
      calls++;
      assert.equal(f.builder.requests.length, 0);
      assert.equal(catalog.requirements.length, 3);
      await options.onUsage?.({ input: 30, output: 10, cacheRead: 20, cacheWrite: 0, total: 60 });
      return proposal;
    } };
    const result = await f.run();
    assert.equal(calls, 1);
    assert.equal(result.status, "delivered");
    assert.deepEqual(f.builder.requests.map(request => "packet" in request ? request.packet.requirementIds : []), [["A"], ["B"], ["C"]]);
    assert.deepEqual(result.verifiedRequirementIds.sort(), ["A", "B", "C"]);
    const first = f.builder.requests[0];
    assert.ok(first.mode === "implement");
    assert.equal(first.packet.requirements[0].text, "Display the main workspace.");
    const events = await f.events();
    const grouping = events.find(event => event.type === "feature_grouping_finished");
    assert.ok(grouping?.type === "feature_grouping_finished");
    assert.equal(grouping.detail?.source, "llm");
    assert.equal(grouping.detail?.grouping.packets, 3);
    assert.equal(events.filter(event => event.type === "feature_grouping_usage").length, 1);
    assert.equal(events.find(event => event.type === "pipeline_started")?.detail?.groupingSource, "pending_llm");
  });
});

test("Invalid model coverage gets feedback retry before fallback without losing requirements", async () => {
  await withModulePipeline(async f => {
    let calls = 0;
    f.deps.diagnosticSecrets = ["fixture-key"];
    f.deps.grouper = { group: async () => { calls++; return { groups: [{ requirementIds: ["fixture-key"], purpose: "unknown" }] }; } };
    const result = await f.run();
    assert.equal(calls, 2);
    assert.equal(result.status, "delivered");
    assert.deepEqual(f.builder.requests.map(request => "packet" in request ? request.packet.requirementIds : []), [["A", "B"], ["C"]]);
    const event = (await f.events()).find(event => event.type === "feature_grouping_finished");
    assert.ok(event?.type === "feature_grouping_finished");
    assert.equal(event.detail?.source, "deterministic");
    assert.match(event.detail?.reason ?? "", /Unknown/);
    assert.doesNotMatch(event.detail?.reason ?? "", /fixture-key/);
    const retry = (await f.events()).find(event => event.type === "feature_grouping_retry");
    assert.ok(retry?.type === "feature_grouping_retry");
    assert.doesNotMatch(retry.detail?.reason ?? "", /fixture-key/);
  });
});

test("Cross-module grouping gives exact ownership feedback before accepting the corrected LLM proposal", async () => {
  await withModulePipeline(async f => {
    let calls = 0;
    f.deps.grouper = new LlmFeatureGrouper({ baseUrl: "https://gateway.example/v1",
      apiKey: "fixture-key", model: "fixture-model", timeoutMs: 1000 }, async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const payload = JSON.parse(body.messages[1].content);
      assert.equal(f.builder.requests.length, 0);
      assert.deepEqual(payload.modules, [
        { moduleId: "FIRST", requirementIds: ["A", "B"] },
        { moduleId: "SECOND", requirementIds: ["C"] },
      ]);
      const response = ++calls === 1 ? { groups: [proposal.groups[0],
        { requirementIds: ["B", "C"], purpose: "shared dependency" }] } : proposal;
      if (calls === 2) {
        assert.equal(payload.previousAttempt.validationError, "Feature group 2 crosses ROOT modules: B=FIRST, C=SECOND");
        assert.equal(payload.previousAttempt.cutOffByModel, false);
        assert.equal(body.max_tokens, 65536);
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }));
    });
    const result = await f.run();
    assert.equal(result.status, "delivered");
    assert.equal(calls, 2);
    assert.deepEqual(result.verifiedRequirementIds.sort(), ["A", "B", "C"]);
    assert.deepEqual(f.builder.requests.map(request => "packet" in request ? request.packet.requirementIds : []),
      [["A"], ["B"], ["C"]]);
    const events = await f.events();
    const finished = events.find(event => event.type === "feature_grouping_finished");
    assert.equal(finished?.detail?.source, "llm");
    assert.equal(finished?.detail?.attempts, 2);
    assert.match(events.find(event => event.type === "feature_grouping_retry")?.detail?.reason ?? "",
      /B=FIRST, C=SECOND/);
  });
});

test("Grouping response failure retries with the underlying diagnosis and then uses the valid proposal", async () => {
  await withModulePipeline(async f => {
    const { PlannerRequestError } = await import("../src/planner-json-client.js");
    let calls = 0;
    f.deps.grouper = { group: async (_catalog, options) => {
      assert.equal(f.builder.requests.length, 0);
      if (++calls === 1) throw new PlannerRequestError("response", "Feature grouper response body failed", {
        cause: new SyntaxError("Feature grouper stream was cut off by the model"),
      });
      assert.match(options.feedback?.validationError ?? "", /cut off by the model/);
      assert.equal(options.feedback?.cutOffByModel, true);
      return proposal;
    } };
    assert.equal((await f.run()).status, "delivered");
    assert.equal(calls, 2);
    const event = (await f.events()).find(item => item.type === "feature_grouping_finished");
    assert.equal(event?.detail?.source, "llm");
    assert.equal(event?.detail?.attempts, 2);
    assert.deepEqual(f.builder.requests.map(request => "packet" in request ? request.packet.requirementIds : []), [["A"], ["B"], ["C"]]);
  });
});

test("Grouping authentication rejection remains local and does not retry invalid credentials", async () => {
  await withModulePipeline(async f => {
    const { PlannerRequestError } = await import("../src/planner-json-client.js");
    let calls = 0;
    f.deps.grouper = { group: async () => { calls++; throw new PlannerRequestError("transport", "unauthorized", { httpStatus: 401 }); } };
    assert.equal((await f.run()).status, "delivered");
    assert.equal(calls, 1);
    assert.equal(f.builder.requests.length, 2);
  });
});

test("Gateway transport recovery retries grouping before any Builder dispatch", async () => {
  await withModulePipeline(async f => {
    let calls = 0;
    f.deps.grouper = { group: async () => {
      assert.equal(f.builder.requests.length, 0);
      if (++calls === 1) throw new GatewayRequestError(httpGatewayFailure(503));
      return proposal;
    } };
    assert.equal((await f.run()).status, "delivered");
    assert.equal(calls, 2);
    const events = await f.events();
    assert.equal(events.filter(event => event.type === "feature_grouping_started").length, 1);
    assert.ok(events.some(event => event.type === "gateway_wait" && event.packetId === "feature-grouping"));
    assert.equal(events.filter(event => event.type === "feature_grouping_finished").length, 1);
  });
});

test("Unlimited grouping waits for its pending response and preserves caller cancellation", async () => {
  await withModulePipeline(async f => {
    f.options.totalBudgetMs = 0;
    let ready!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    f.deps.grouper = { group: async (_catalog, options) => {
      assert.equal(options.timeoutMs, Infinity);
      assert.ok(options.signal);
      assert.equal(options.signal.aborted, false);
      ready();
      await pending;
      return proposal;
    } };
    const running = f.run();
    await started;
    assert.equal(f.builder.requests.length, 0);
    release();
    assert.equal((await running).status, "delivered");
  });
});

test("Grouping time is charged to the explicit implementation budget", async () => {
  await withModulePipeline(async f => {
    let now = 0;
    f.deps.clock = { nowMs: () => now };
    f.deps.grouper = { group: async (_catalog, options) => {
      assert.equal(options.timeoutMs, 36000);
      now = 37000;
      return proposal;
    } };
    const result = await f.run();
    assert.equal(f.builder.requests.length, 0);
    assert.equal(result.status, "partial");
    assert.deepEqual(result.implementedRequirementIds, []);
  });
});
