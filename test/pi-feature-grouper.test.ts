import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { PiFeatureGrouper } from "../src/llm-feature-grouper.js";
import { GatewayRecovery } from "../src/gateway-recovery.js";
import { GatewayRequestError } from "../src/gateway-failure.js";
import { loadRequirementCatalog } from "../src/catalog.js";
import { featureGroupPackets } from "../src/scheduler.js";
import type { RequirementCatalog } from "../src/types.js";
import type { UsageSummary } from "../src/model-usage.js";
import { withTempDir } from "./helpers/temp-dir.js";

type Payload = { model: string; messages: Array<{ role: string; content: string | Array<{ text: string }> }>;
  tools: Array<{ function: { name: string; parameters: { type: string } } }> };
const groups = (ids: string[][]) => ({ groups: ids.map(requirementIds => ({ requirementIds, purpose: "共同状态操作" })), scenarioPrerequisites: [] });
const text = (message: Payload["messages"][number]) => typeof message.content === "string"
  ? message.content : message.content.map(item => item.text).join("\n");
const observation = (payload: Payload) => JSON.parse(text(payload.messages.filter(message => message.role === "tool").at(-1)!));
const call = (name: string, args: unknown) => ({ name, args });

function send(response: ServerResponse, calls: Array<{ name: string; args: unknown }>, tail = "data: [DONE]\n\n") {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const delta = calls.length ? { role: "assistant", tool_calls: calls.map((tool, index) => ({ index,
    id: `${tool.name}-${Math.random()}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } })) }
    : { role: "assistant", content: "I am considering the grouping." };
  response.write(`data: ${JSON.stringify({ id: "grouper", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ id: "grouper", choices: [{ index: 0, delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } })}\n\n`);
  response.end(tail);
}

function catalog(): RequirementCatalog {
  return { requirements: ["MOVE", "ACCESS"].map((id, index) => ({ id, name: id, folderPath: ["ROOT", "M"],
    declarationIndex: index, dependencyIds: [], scenarios: [], references: [], exactUiStrings: [], seedDeclarations: [], ancestors: [],
    text: index === 0 ? "Move a folder while preserving child visibility." : "Children inherit destination permissions after moving the folder.",
    product: { kind: "generic_web", rootId: "ROOT", rootName: "Example", description: "Example", seedData: [] },
  })), statusById: { MOVE: "todo", ACCESS: "todo" } };
}

async function withGrouper(handler: (payload: Payload, res: ServerResponse, request: IncomingMessage) => void | Promise<void>,
  run: (grouper: PiFeatureGrouper, root: string, requests: Payload[], waits: number[]) => Promise<void>) {
  await withTempDir("pi-grouper-", async root => {
    const requests: Payload[] = [], errors: unknown[] = [], waits: number[] = [];
    const server = createServer(async (request, response) => {
      try {
        const parts: Buffer[] = []; for await (const part of request) parts.push(Buffer.from(part));
        const payload = JSON.parse(Buffer.concat(parts).toString()) as Payload;
        requests.push(payload); await handler(payload, response, request);
      } catch (error) { errors.push(error); response.writeHead(500); response.end(); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert(address && typeof address !== "string");
    let now = 0;
    const recovery = new GatewayRecovery({ now: () => now, sleep: async ms => { waits.push(ms); now += ms; } });
    recovery.setRecorder(async event => { assert.equal(event.source, "grouper"); });
    const grouper = new PiFeatureGrouper({ gateway: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "grouper-fixture-key", model: "test-grouper" },
      sessionDir: join(root, "sessions"), recovery, modelCost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 } });
    try { await run(grouper, root, requests, waits); }
    finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    assert.deepEqual(errors, []);
  });
}

test("Pi Grouper preserves original inputs and output, exposes only its two native tools, and accounts for usage", async () => {
  const input = await loadRequirementCatalog("data/official-competition/hackathon--sheet/requirements.yaml");
  const proposal = groups(featureGroupPackets(input).packets.map(packet => packet.requirementIds));
  let calls = 0;
  await withGrouper((payload, res) => {
    assert.equal(payload.model, "test-grouper");
    assert.deepEqual(payload.tools.map(tool => tool.function.name), ["validate_grouping", "finish"]);
    for (const tool of payload.tools) assert.equal(tool.function.parameters.type, "object");
    if (++calls === 1) send(res, [call("validate_grouping", { grouping: proposal })]);
    else { assert.equal(observation(payload).valid, true); send(res, [call("finish", proposal)]); }
  }, async (grouper, root, requests) => {
    const usage: UsageSummary[] = [];
    assert.deepEqual(await grouper.group(input, { timeoutMs: 10_000, onUsage: item => { usage.push(item); } }), proposal);
    assert.equal(requests.length, 2);
    const source = JSON.parse(text(requests[0].messages.find(message => message.role === "user")!));
    assert.deepEqual(source.limits, { maxRequirements: 4, maxScenarios: 12, maxTextChars: 20000 });
    assert.equal(source.requirements.length, input.requirements.length);
    for (let i = 0; i < input.requirements.length; i++) {
      assert.equal(source.requirements[i].text, input.requirements[i].text);
      assert.equal(source.requirements[i].scenarioCount, input.requirements[i].scenarios.length);
      assert.equal(source.requirements[i].scenarioFacts.flatMap((fact: { sources: unknown[] }) => fact.sources).length,
        input.requirements[i].scenarioContracts!.reduce((sum, scenario) => sum + scenario.steps.length, 0));
    }
    assert.deepEqual(usage.map(({ cost, ...counts }) => counts), [{ input: 120, output: 40, cacheRead: 80, cacheWrite: 0, total: 240 }]);
    assert(Math.abs(usage[0].cost! - 0.00024) < 1e-12);
    assert.equal((await readdir(join(root, "sessions"))).length, 1);
    const files = await readdir(join(root, "sessions"), { recursive: true });
    for (const file of files.filter(file => file.endsWith(".jsonl"))) assert(!(await readFile(join(root, "sessions", file), "utf8")).includes("grouper-fixture-key"));
  });
});

test("Pi Grouper repairs invalid grouping and regroups coupled state without declared dependency edges", async () => {
  const input = catalog(), merged = groups([["MOVE", "ACCESS"]]);
  const actions = [call("validate_grouping", { grouping: groups([["MOVE"], ["MOVE"]]) }),
    call("validate_grouping", { grouping: groups([["MOVE"], ["ACCESS"]]) }), call("validate_grouping", { grouping: merged }), call("finish", merged)];
  let calls = 0;
  await withGrouper((payload, res) => {
    if (calls === 1) { assert.equal(observation(payload).valid, false); assert.match(observation(payload).error, /appears in more than one/); }
    if (calls === 2) {
      assert.deepEqual(observation(payload).crossGroupDependencies, []);
      assert.deepEqual(observation(payload).mergeableAdjacentGroups, [{ groups: [1, 2], requirementIds: ["MOVE", "ACCESS"] }]);
      assert.match(text(payload.messages[0]), /没有显式 dependencyIds 的共享状态耦合/);
    }
    send(res, [actions[calls++]]);
  }, async grouper => {
    assert.deepEqual(await grouper.group(input, { timeoutMs: 10_000 }), merged);
    assert.equal(calls, 4); assert.deepEqual(input.statusById, { MOVE: "todo", ACCESS: "todo" });
  });
});

test("Pi Grouper requires a later turn to read validation feedback and rejects a changed finish proposal", async () => {
  const split = groups([["MOVE"], ["ACCESS"]]), merged = groups([["MOVE", "ACCESS"]]);
  let calls = 0;
  await withGrouper((payload, res) => {
    if (calls === 0) send(res, [call("validate_grouping", { grouping: split }), call("finish", split)]);
    if (calls === 1) { assert.match(JSON.stringify(payload.messages), /subsequent turn/); send(res, [call("finish", merged)]); }
    if (calls === 2) { assert.match(text(payload.messages.at(-1)!), /exact proposal/); send(res, [call("validate_grouping", { grouping: merged })]); }
    if (calls === 3) send(res, [call("finish", merged)]);
    calls++;
  }, async grouper => { assert.deepEqual(await grouper.group(catalog(), { timeoutMs: 10_000 }), merged); assert.equal(calls, 4); });
});

test("Pi Grouper corrects scenario prerequisite order and binds finish to the reviewed evidence", async () => {
  const input = catalog();
  input.requirements[0].folderPath = ["ROOT", "operations"];
  input.requirements[1].folderPath = ["ROOT", "access"];
  input.requirements[0].scenarioContracts = [{ id: "move", name: "Move", steps: [
    { keyword: "GIVEN", content: "The destination permissions have been configured" },
    { keyword: "WHEN", content: "Move the folder" }, { keyword: "THEN", content: "Children retain visibility" },
  ] }];
  const edge = { requirementId: "MOVE", scenarioId: "move", stepIndex: 0, prerequisiteId: "ACCESS",
    prerequisiteQuote: input.requirements[1].text };
  const reversed = { ...groups([["MOVE"], ["ACCESS"]]), scenarioPrerequisites: [edge] };
  const ordered = { ...groups([["ACCESS"], ["MOVE"]]), scenarioPrerequisites: [edge] };
  const actions = [call("validate_grouping", { grouping: reversed }), call("validate_grouping", { grouping: ordered }),
    call("finish", { ...ordered, scenarioPrerequisites: [] }), call("finish", ordered)];
  let calls = 0;
  await withGrouper((payload, res) => {
    if (calls === 0) {
      assert.match(text(payload.messages[0]), /模块连续性让位于场景前置/);
      const source = JSON.parse(text(payload.messages.find(message => message.role === "user")!));
      assert.match(source.prerequisiteReview, /given/);
      assert.deepEqual(source.requirements[0].scenarioFacts[0].sources, [{ scenarioId: "move", stepIndex: 0 }]);
    }
    if (calls === 1) { assert.equal(observation(payload).valid, false); assert.match(observation(payload).error, /must precede MOVE/); }
    if (calls === 2) assert.deepEqual(observation(payload).scenarioPrerequisites, [{ ...edge, fromGroup: 1, toGroup: 2 }]);
    if (calls === 3) assert.match(text(payload.messages.at(-1)!), /exact proposal/);
    send(res, [actions[calls++]]);
  }, async grouper => {
    assert.deepEqual(await grouper.group(input, { timeoutMs: 10_000 }), ordered);
    assert.deepEqual(input.requirements.map(item => item.dependencyIds), [[], []]);
  });
});

test("Pi Grouper bounds text-only answers to six planning turns and retains their failed-call usage", async () => {
  await withGrouper((_payload, res) => send(res, []), async (grouper, _root, requests) => {
    const usage: UsageSummary[] = [];
    await assert.rejects(grouper.group(catalog(), { timeoutMs: 10_000, onUsage: item => { usage.push(item); } }), /within 6 turns/);
    assert.equal(requests.length, 6); assert.equal(usage[0].total, 720);
  });
});

test("Pi Grouper resumes the same session after repeated HTTP 400 upstream resets without spending planning turns", async () => {
  const proposal = groups([["MOVE", "ACCESS"]]);
  let calls = 0;
  await withGrouper((payload, res) => {
    calls++;
    if (calls === 1) { send(res, [call("validate_grouping", { grouping: proposal })]); return; }
    assert.equal(observation(payload).valid, true);
    if (calls <= 7) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: '400 Post "https://api.example/v1/chat/completions": read tcp 127.0.0.1:60000->127.0.0.1:443: read: connection reset by peer (request id: grouper)' }));
    } else send(res, [call("finish", proposal)]);
  }, async (grouper, root, requests, waits) => {
    assert.deepEqual(await grouper.group(catalog(), { timeoutMs: 15_000 }), proposal);
    assert.equal(requests.length, 8); assert(waits.length >= 6); assert.equal(waits[0], 5000);
    assert.equal((await readdir(join(root, "sessions"))).length, 1);
    assert.equal(requests.at(-1)!.messages.filter(message => message.role === "user" && text(message).includes('"referenceGroups"')).length, 1);
  });
});

test("Pi Grouper recovers from rate limits with shared Retry-After handling and retains validated results", { timeout: 20_000 }, async () => {
  const proposal = groups([["MOVE", "ACCESS"]]);
  let calls = 0;
  await withGrouper((payload, res) => {
    calls++;
    if (calls === 1) send(res, [call("validate_grouping", { grouping: proposal })]);
    else if (calls <= 4) { res.writeHead(429, { "content-type": "application/json", "retry-after": "40" }); res.end(JSON.stringify({ error: { message: "rate limit" } })); }
    else { assert.equal(observation(payload).valid, true); send(res, [call("finish", proposal)]); }
  }, async (grouper, root, _requests, waits) => {
    assert.deepEqual(await grouper.group(catalog(), { timeoutMs: 15_000 }), proposal);
    assert.equal(calls, 5); assert.equal(waits.reduce((sum, value) => sum + value, 0), 40000);
    assert.equal((await readdir(join(root, "sessions"))).length, 1);
  });
});

test("Pi Grouper tolerates a damaged terminal SSE trailer without repeating its submission", async () => {
  const proposal = groups([["MOVE", "ACCESS"]]);
  let calls = 0;
  await withGrouper((_payload, res) => {
    if (++calls === 1) send(res, [call("validate_grouping", { grouping: proposal })]);
    else send(res, [call("finish", proposal)], 'data: {"created":1,"usage":nu');
  }, async grouper => { assert.deepEqual(await grouper.group(catalog(), { timeoutMs: 10_000 }), proposal); assert.equal(calls, 2); });
});

test("Pi Grouper retries a truncated content-bearing SSE turn and preserves earlier tool results", { timeout: 15_000 }, async () => {
  const proposal = groups([["MOVE", "ACCESS"]]);
  let calls = 0;
  await withGrouper((payload, res) => {
    calls++;
    if (calls === 1) send(res, [call("validate_grouping", { grouping: proposal })]);
    else if (calls === 2) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0,
        id: "truncated-finish", type: "function", function: { name: "finish", arguments: '{"groups":[' } }] }, finish_reason: null }] })}\n\n`);
      res.end('data: {"choices":[');
    } else { assert.equal(observation(payload).valid, true); send(res, [call("finish", proposal)]); }
  }, async (grouper, root) => {
    assert.deepEqual(await grouper.group(catalog(), { timeoutMs: 10_000 }), proposal);
    assert.equal(calls, 3); assert.equal((await readdir(join(root, "sessions"))).length, 1);
  });
});

test("Pi Grouper recovers from a dropped connection in its private session", { timeout: 15_000 }, async () => {
  const proposal = groups([["MOVE", "ACCESS"]]);
  let calls = 0;
  await withGrouper((_payload, res, request) => {
    if (++calls === 1) request.socket.destroy();
    else send(res, [calls === 2 ? call("validate_grouping", { grouping: proposal }) : call("finish", proposal)]);
  }, async grouper => { assert.deepEqual(await grouper.group(catalog(), { timeoutMs: 10_000 }), proposal); assert.equal(calls, 3); });
});

test("Pi Grouper rejects authentication failures without retry and remains separate from Builder authentication", async () => {
  await withGrouper((_payload, res) => { res.writeHead(401, { "content-type": "application/json" }); res.end('{"error":{"message":"Unauthorized"}}'); },
    async (grouper, _root, requests) => {
      await assert.rejects(grouper.group(catalog(), { timeoutMs: 10_000 }),
        error => error instanceof GatewayRequestError && error.gatewayFailure.kind === "authentication");
      assert.equal(requests.length, 1);
    });
});

test("Pi Grouper cancels an in-flight request and enforces one deadline across the session", async () => {
  for (const cancel of [true, false]) {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    await withGrouper(() => { started(); }, async (grouper, _root, requests) => {
      const controller = new AbortController(), reason = new Error("cancel grouper");
      const pending = grouper.group(catalog(), { timeoutMs: cancel ? 10_000 : 500, signal: controller.signal });
      const rejected = assert.rejects(pending, error => cancel ? error === reason : error instanceof Error && /timeout|deadline/i.test(error.message));
      await ready;
      if (cancel) controller.abort(reason);
      await rejected; assert.equal(requests.length, 1);
    });
  }
});
