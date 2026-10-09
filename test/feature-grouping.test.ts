import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { loadRequirementCatalog } from "../src/catalog.js";
import { FEATURE_GROUPING_SCHEMA, parseFeatureGrouping } from "../src/feature-grouper.js";
import { LlmFeatureGrouper } from "../src/llm-feature-grouper.js";
import { DEFAULT_FEATURE_GROUP_THRESHOLDS, featureGroupPackets } from "../src/scheduler.js";
import { PlannerRequestError, type PlannerUsage } from "../src/planner-json-client.js";

const config = { baseUrl: "https://gateway.example/v1", apiKey: "fixture-key", model: "provider/model", timeoutMs: 1000 };
const groups = (ids: string[][]) => ({ groups: ids.map(requirementIds => ({ requirementIds, purpose: "共同状态操作" })) });
const github = () => loadRequirementCatalog("data/official-competition/hackathon--github/requirements.yaml");
const sheet = () => loadRequirementCatalog("data/official-competition/hackathon--sheet/requirements.yaml");

test("Cutoff grouping keeps usage and expands the retry output allowance with explicit feedback", async () => {
  const catalog = await sheet();
  const response = groups(featureGroupPackets(catalog).packets.map(packet => packet.requirementIds));
  let calls = 0;
  const usages: PlannerUsage[] = [];
  const grouper = new LlmFeatureGrouper(config, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (++calls === 1) return new Response(`data: ${JSON.stringify({ choices: [{ index: 0,
      delta: { content: '{"groups":[' }, finish_reason: "length" }], usage: { prompt_tokens: 100, completion_tokens: 16384 } })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } });
    assert.equal(body.max_tokens, 131072);
    assert.match(body.messages[1].content, /cut off/);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }));
  });
  await assert.rejects(grouper.group(catalog, { timeoutMs: 1000, onUsage: usage => { usages.push(usage); } }),
    error => error instanceof PlannerRequestError && error.diagnostics.validationError === "Feature grouper stream was cut off by the model");
  assert.equal(usages[0].total, 16484);
  assert.deepEqual(await grouper.group(catalog, { timeoutMs: 1000,
    feedback: { validationError: "cut off", cutOffByModel: true } }), response);
});

test("Observed runtime proposals preserve Catalog objects, scenarios and independent atomic coverage", async () => {
  for (const [app, count] of [["github", 17], ["sheet", 12]] as const) {
    const catalog = app === "github" ? await github() : await sheet();
    const proposal = JSON.parse(await readFile(`test/fixtures/feature-grouping/${app}.json`, "utf8"));
    const result = parseFeatureGrouping(proposal, catalog);
    assert.equal(result.packets.length, count);
    assert.equal(result.stats.requirements, catalog.requirements.length);
    for (const requirement of result.packets.flatMap(packet => packet.requirements)) {
      assert.equal(requirement, catalog.requirements.find(item => item.id === requirement.id));
    }
    assert.deepEqual(catalog.statusById, Object.fromEntries(catalog.requirements.map(item => [item.id, "todo"])));
    assert.equal(result.packets[0].requirements[0].text, catalog.requirements[0].text);
    assert.ok(result.purposes?.length);
    assert.equal(result.packets[0].requirements[0].scenarios.length, catalog.requirements[0].scenarios.length);
  }
});

test("Grouping rejects duplicate, missing, unknown, reversed and cross-module assignments", async () => {
  const catalog = await github();
  const baseline = featureGroupPackets(catalog).packets.map(packet => packet.requirementIds);
  for (const [ids, expected] of [
    [[...baseline, baseline[0]], /appears in more than one/],
    [baseline.slice(1), /do not cover every requirement/],
    [[...baseline, ["UNKNOWN"]], /Unknown/],
    [[baseline[0].slice().reverse(), ...baseline.slice(1)], /must precede/],
    [[[baseline[0][0], baseline[2][0]], ...baseline], /crosses ROOT modules/],
  ] as Array<[string[][], RegExp]>) assert.throws(() => parseFeatureGrouping(groups(ids), catalog), expected);
});

test("Grouping uses original capacity metrics and keeps a single oversized atomic intact", async () => {
  const catalog = await github();
  const baseline = featureGroupPackets(catalog).packets.map(packet => packet.requirementIds);
  assert.throws(() => parseFeatureGrouping(groups([[...baseline[0], ...baseline[1]], ...baseline.slice(2)]), catalog), /exceeds capacity/);
  const first = structuredClone(catalog.requirements[0]);
  first.text = "x".repeat(21000);
  first.scenarios = Array(13).fill("same scenario");
  const other = structuredClone(first);
  other.id = "SECOND";
  other.text = "small";
  other.scenarios = [];
  const input = { requirements: [first, other], statusById: { [first.id]: "todo" as const, SECOND: "todo" as const } };
  const single = parseFeatureGrouping(groups([[first.id], [other.id]]), input);
  assert.equal(single.packets[0].requirements[0].text.length, 21000);
  assert.equal(single.packets[0].requirements[0].scenarios.length, 13);
  assert.throws(() => parseFeatureGrouping(groups([[first.id, other.id]]), input), /exceeds capacity/);
});

test("The proposal schema permits explanatory purposes but cannot amend requirement contracts", async () => {
  const catalog = await github();
  const proposal = groups(featureGroupPackets(catalog).packets.map(packet => packet.requirementIds));
  assert.throws(() => parseFeatureGrouping({ ...proposal, requirements: [] }, catalog), /unsupported field/);
  proposal.groups[0].purpose = "模型认为记录不受影响";
  const parsed = parseFeatureGrouping(proposal, catalog);
  assert.equal(parsed.packets[0].requirements[0], catalog.requirements[0]);
  assert.throws(() => parseFeatureGrouping({ groups: [{ ...proposal.groups[0], text: "change behavior" }] }, catalog), /unsupported field/);
  assert.throws(() => parseFeatureGrouping({ groups: [{ requirementIds: [1], purpose: "purpose" }] }, catalog), /string requirementIds/);
  assert.throws(() => parseFeatureGrouping({ groups: [{ requirementIds: [], purpose: "purpose" }] }, catalog), /empty/);
  assert.throws(() => parseFeatureGrouping({ groups: [{ requirementIds: [catalog.requirements[0].id], purpose: " " }] }, catalog), /purpose/);
  assert.deepEqual(parseFeatureGrouping({ groups: [] }, { requirements: [], statusById: {} }).stats, featureGroupPackets({ requirements: [], statusById: {} }).stats);
});

test("LLM grouping sends descriptions and original metrics once, with independent JSON usage", async () => {
  const catalog = await sheet();
  const response = groups(featureGroupPackets(catalog).packets.map(packet => packet.requirementIds));
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const usages: PlannerUsage[] = [];
  const grouper = new LlmFeatureGrouper(config, async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(response)}\n\`\`\`` } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 40 } }), { headers: { "content-type": "application/json" } });
  });
  const proposal = await grouper.group(catalog, { timeoutMs: Infinity, onUsage: usage => { usages.push(usage); } });
  assert.deepEqual(proposal, response);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, config.baseUrl + "/chat/completions");
  assert.equal(new Headers(calls[0].init?.headers).get("authorization"), "Bearer fixture-key");
  assert.equal(calls[0].init?.signal, undefined);
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.model, config.model);
  assert.equal(body.max_tokens, 65536);
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.match(body.messages[0].content, /moduleId/);
  assert.match(body.messages[0].content, /"groups"/);
  const payload = JSON.parse(body.messages[1].content);
  assert.deepEqual(payload.limits, DEFAULT_FEATURE_GROUP_THRESHOLDS);
  assert.deepEqual(payload.referenceGroups, featureGroupPackets(catalog).packets.map(packet => packet.requirementIds));
  const reference = parseFeatureGrouping(groups(payload.referenceGroups), catalog);
  assert.equal(reference.stats.requirements, catalog.requirements.length);
  assert.equal(payload.requirements.length, 24);
  assert.deepEqual(payload.modules.flatMap((module: { requirementIds: string[] }) => module.requirementIds).sort(),
    catalog.requirements.map(requirement => requirement.id).sort());
  assert.equal(new Set(payload.modules.map((module: { moduleId: string }) => module.moduleId)).size, payload.modules.length);
  for (let i = 0; i < catalog.requirements.length; i++) {
    const original = catalog.requirements[i], sent = payload.requirements[i];
    assert.equal(sent.moduleId, original.folderPath[1] ?? original.id);
    assert.ok(payload.modules.find((module: { moduleId: string; requirementIds: string[] }) =>
      module.moduleId === sent.moduleId)?.requirementIds.includes(original.id));
    assert.equal(sent.text, original.text);
    assert.equal(sent.scenarioCount, original.scenarios.length);
    assert.equal(sent.textChars, original.text.length + original.scenarios.reduce((sum, scenario) => sum + scenario.length, 0));
    assert.equal("scenarios" in sent, false);
  }
  assert.equal(new Set(payload.ancestors.map((ancestor: { id: string }) => ancestor.id)).size, payload.ancestors.length);
  assert.deepEqual(usages, [{ input: 60, output: 20, cacheRead: 40, cacheWrite: 0, total: 120 }]);
  assert.equal(FEATURE_GROUPING_SCHEMA.properties.groups.items.additionalProperties, false);
});
