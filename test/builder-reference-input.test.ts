import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { PromptBuilder } from "../src/builder/prompt-builder.js";
import type { CodingAgentRequest, CodingAgentResult } from "../src/builder/execution-port.js";
import { loadRequirementCatalog } from "../src/catalog.js";
import { auditPackets } from "../src/scheduler.js";
import { minimalWebContract } from "../src/adapters/web/project-spec.js";
import { VisionCapability } from "../src/builder/vision-probe.js";
import { UsageTotals, type ModelRates, type UsageSummary } from "../src/model-usage.js";

async function fixture(results: CodingAgentResult[], options: { referenceImages?: boolean; visionProbe?: VisionCapability; timeoutMs?: number; modelCost?: ModelRates } = {}) {
  const calls: CodingAgentRequest[] = [];
  const catalog = await loadRequirementCatalog(resolve("test/fixtures/requirements.yaml"));
  const packet = auditPackets(catalog)[0];
  const builder = new PromptBuilder({ run: async request => { calls.push(request); return results.shift()!; }, close: async () => {} },
    { timeoutMs: options.timeoutMs ?? 1000, requirementsDir: resolve("test/fixtures"), contextWindow: 256_000,
      referenceImages: options.referenceImages, visionProbe: options.visionProbe, modelCost: options.modelCost });
  const request = { mode: "implement" as const, packet, outputDir: "application", applicationContract: minimalWebContract({ port: 43210 }, "linux"),
    projectContext: { product: packet.requirements[0].product, ancestors: [], satisfiedDependencies: [] } };
  return { builder, calls, request };
}
const completed: CodingAgentResult = { sessionId: "done", outcome: "completed", summary: "done" };

test("Builder accounts for image preflight and every fallback call without repeating cached preflight usage", async () => {
  const result = (input: number, output: number, cost: number): CodingAgentResult => ({ ...completed,
    execution: { engine: "pi", version: "test", nodeVersion: process.version, workerPid: 1, resumed: false,
      durationMs: 0, cleanupMs: 0, usage: { status: "available", input, output, cacheRead: 0, cacheWrite: 0, total: input + output, cost } } });
  const visionProbe = new VisionCapability({ baseUrl: "https://fake.invalid/v1", model: "fake", apiKey: "fake" },
    async () => new Response(JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 1 } })));
  const f = await fixture([{ ...result(10, 2, 0.001), outcome: "failed", imageUnsupported: true },
    result(20, 4, 0.002), result(5, 1, 0.001)], { referenceImages: true, visionProbe,
    modelCost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });
  const seen: UsageSummary[] = [];
  const onUsage = (usage: UsageSummary) => { seen.push(usage); };
  assert.equal((await f.builder.run(f.request, { onUsage })).outcome, "completed");
  assert.equal((await f.builder.run(f.request, { onUsage })).outcome, "completed");
  assert.deepEqual(seen.map(usage => usage.total), [101, 12, 24, 6]);
  const totals = new UsageTotals();
  seen.forEach(usage => totals.add(usage));
  assert.equal(totals.summary().total, 143);
  assert.ok(Math.abs(totals.summary().cost! - 0.004101) < 1e-10);
});

test("Usage diagnostics cannot turn a completed Builder call into a failure", async () => {
  const f = await fixture([{ ...completed,
    execution: { engine: "pi", version: "test", nodeVersion: process.version, workerPid: 1, resumed: false,
      durationMs: 0, cleanupMs: 0, usage: { status: "available", input: 10, output: 2, cacheRead: 0, cacheWrite: 0, total: 12 } } }]);
  assert.equal((await f.builder.run(f.request, { onUsage: () => { throw new Error("log failed"); } })).outcome, "completed");
});

test("Builder forwards structured gateway failure metadata to the controller", async () => {
  const gatewayFailure = { kind: "rate_limit", retryable: true, status: 429, retryAfterMs: 30_000 } as const;
  const f = await fixture([{ ...completed, outcome: "failed", gatewayFailure }]);
  assert.deepEqual((await f.builder.run(f.request)).gatewayFailure, gatewayFailure);
});

test("Builder preserves the engine termination reason and asks a fresh session to finish existing work", async () => {
  const f = await fixture([{ ...completed, outcome: "failed", terminationReason: "missing_terminal_response" }]);
  const result = await f.builder.run(f.request, { resumeInterrupted: true });
  assert.equal(result.terminationReason, "missing_terminal_response");
  assert.match(f.calls[0].taskPrompt, /使用新会话.*当前文件/);
  assert.match(f.calls[0].taskPrompt, /已成功且输入未变的确定性检查沿用结果/);
  assert.match(f.calls[0].taskPrompt, /状态与集成检查按本次输入实际执行/);
});

test("Engine-neutral Builder preserves separate prompts, references, key and smaller timeout", async () => {
  const f = await fixture([completed], { referenceImages: true });
  await f.builder.run(f.request, { timeoutMs: 300, sessionKey: "module" });
  // Preflight reserves time from the call window, so the smaller timeout wins
  // minus the wall clock already spent inside this call.
  const forwarded = f.calls[0].timeoutMs!;
  assert.ok(forwarded <= 300 && forwarded > 250, `expected the 300ms window minus preflight, got ${forwarded}`);
  assert.equal(f.calls[0].sessionKey, "module");
  assert.equal(f.calls[0].contextWindow, 256_000);
  assert.deepEqual(f.calls[0].applicationContract, f.request.applicationContract);
  assert.ok(f.calls[0].references?.includes("reference/profile.png"));
  assert.match(f.calls[0].systemPrompt, /唯一代码实现者/);
  assert.match(f.calls[0].taskPrompt, /REQ-A/);
});

test("Continuation keeps the packet and adds concrete failure feedback", async () => {
  const f = await fixture([completed]);
  await f.builder.run(f.request, { sessionKey: "same-packet", continuationFeedback: "Missing export {{literal}}" });
  assert.equal(f.calls[0].sessionKey, "same-packet");
  assert.match(f.calls[0].taskPrompt, /Missing export \{\{literal\}\}/);
  assert.match(f.calls[0].taskPrompt, /REQ-A/);
});

test("Reference images stay out of the model input unless the run enables them", async () => {
  const f = await fixture([completed, completed]);
  await f.builder.run(f.request);
  await f.builder.run(f.request);
  assert.equal(f.calls[0].attachReferences, false);
  assert.equal(f.calls[1].attachReferences, false);
  // The packet still declares references so the run log can report the switch state.
  assert.ok(f.calls[0].references?.includes("reference/profile.png"));
});

test("Enabling images probes vision once and skips attachment when the model has none", async () => {
  let probes = 0;
  const probe = { supports: async () => { probes += 1; return "unsupported"; } } as unknown as VisionCapability;
  const f = await fixture([completed, completed, completed], { referenceImages: true, visionProbe: probe });
  await f.builder.run(f.request);
  await f.builder.run(f.request);
  assert.equal(probes, 1, "the verdict is cached for the whole run");
  assert.equal(f.calls[0].visionUnsupported, true);
  assert.equal(f.calls[0].attachReferences, false);
  assert.equal(f.calls[1].visionUnsupported, true);
  assert.equal(f.calls[1].attachReferences, false);
});

test("A vision-capable model keeps attaching images and is probed once", async () => {
  let probes = 0;
  const probe = { supports: async () => { probes += 1; return "supported"; } } as unknown as VisionCapability;
  const f = await fixture([completed, completed], { referenceImages: true, visionProbe: probe });
  await f.builder.run(f.request);
  await f.builder.run(f.request);
  assert.equal(probes, 1);
  assert.equal(f.calls[0].visionUnsupported, false);
  assert.equal(f.calls[0].attachReferences, true);
  assert.equal(f.calls[1].attachReferences, true);
});

test("An unknown vision result keeps images eligible and is probed only once", async () => {
  let probes = 0;
  const probe = { supports: async () => { probes += 1; return "unknown"; } } as unknown as VisionCapability;
  const f = await fixture([completed, completed], { referenceImages: true, visionProbe: probe });
  await f.builder.run(f.request);
  await f.builder.run(f.request);
  assert.equal(probes, 1);
  assert.equal(f.calls[0].attachReferences, true);
  assert.equal(f.calls[0].visionUnsupported, false);
  assert.equal(f.calls[1].attachReferences, true);
});

test("Preflight time is deducted from the Builder call and exhaustion prevents dispatch", async () => {
  const probeBudgets: number[] = [];
  const probe = { supports: async (budgetMs: number) => {
    probeBudgets.push(budgetMs);
    await new Promise(resolve => setTimeout(resolve, 25));
    return "unknown";
  } } as unknown as VisionCapability;
  const f = await fixture([completed], { referenceImages: true, visionProbe: probe, timeoutMs: 200 });
  assert.equal((await f.builder.run(f.request)).outcome, "completed");
  assert.ok(f.calls[0].timeoutMs > 0 && f.calls[0].timeoutMs < 200);
  assert.ok(probeBudgets[0] > 0 && probeBudgets[0] <= 20);

  const expired = await fixture([completed], { referenceImages: true, visionProbe: probe, timeoutMs: 10 });
  assert.equal((await expired.builder.run(expired.request)).outcome, "timed_out");
  assert.equal(expired.calls.length, 0);
  assert.ok(probeBudgets[1] <= 1);
});

test("A disabled switch never probes the gateway", async () => {
  let probes = 0;
  const probe = { supports: async () => { probes += 1; return "supported"; } } as unknown as VisionCapability;
  const f = await fixture([completed], { referenceImages: false, visionProbe: probe });
  await f.builder.run(f.request);
  assert.equal(probes, 0);
});

test("Unsupported images fall back once and subsequent calls retain text mode", async () => {
  const f = await fixture([{ ...completed, outcome: "failed", imageUnsupported: true }, completed, completed], { referenceImages: true });
  assert.equal((await f.builder.run(f.request)).outcome, "completed");
  assert.equal((await f.builder.run(f.request)).outcome, "completed");
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[0].textOnly, false);
  assert.equal(f.calls[1].textOnly, true);
  assert.equal(f.calls[2].textOnly, true);
  assert.ok(f.calls[1].timeoutMs <= f.calls[0].timeoutMs);
});

test("Ordinary failures do not replay and repeated image rejection stops after one fallback", async () => {
  for (const imageUnsupported of [false, true]) {
    const failed: CodingAgentResult = { sessionId: "failed", outcome: "failed", summary: "failure", imageUnsupported };
    const f = await fixture([failed, failed], { referenceImages: true });
    assert.equal((await f.builder.run(f.request)).outcome, "failed");
    assert.equal(f.calls.length, imageUnsupported ? 2 : 1);
  }
});
