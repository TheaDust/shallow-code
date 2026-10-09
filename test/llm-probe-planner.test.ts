import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";

import { loadRequirementCatalog } from "../src/catalog.js";
import {
  LlmProbePlanner,
  ProbePlannerError,
} from "../src/judge/llm-probe-planner.js";
import {
  assertLocatorOnlyRefinement,
  NoLocatorProgressError,
  parseProbePlan,
  probePlanSha256,
  toWireProbePlan,
  PROBE_PLAN_JSON_SCHEMA,
  PROBE_REFINEMENT_JSON_SCHEMA,
} from "../src/judge/probe-schema.js";
import type { ProbeFailure, SeedDataCategory, WorkPacket } from "../src/types.js";
import { scenarioOutcomes } from "../src/judge/probe-coverage.js";

test("Probe Planner accepts a bounded declarative plan", () => {
  const plan = parseProbePlan(validPlan(), packet());

  assert.equal(plan.packetId, "packet-profile");
  assert.equal(plan.cases.length, 2);
  assert.deepEqual(plan.cases[0].steps[1], {
    op: "fill",
    locator: { by: "label", text: "Profile name", exact: true },
    value: "Ada",
  });
});

test("Probe plans require an assertion per case and coverage of every packet requirement", () => {
  const withoutAssertion = validPlan();
  withoutAssertion.cases[0].steps = [{ op: "goto", path: "/" }];
  assert.throws(() => parseProbePlan(withoutAssertion, packet()), /assertion/);
  assert.throws(() => parseProbePlan(validPlan(), { id: packet().id, requirementIds: ["REQ-PROFILE", "REQ-OMITTED"] }), /REQ-OMITTED/);
});

test("Initial plans require semantic alternatives for unanchored text and allow structural roles", () => {
  const input = packet();
  input.requirements[0].exactUiStrings = [];
  const plan = validPlan();
  plan.cases[0].steps = [{ op: "goto", path: "/" },
    { op: "expectVisible", locator: { by: "text", text: "Home" } }];
  assert.throws(() => parseProbePlan(plan, input), /unanchored text locator.*role or label fallback/);
  plan.cases[0].steps[1] = { op: "expectVisible", locator: { by: "role", role: "main" } };
  assert.doesNotThrow(() => parseProbePlan(plan, input));
  plan.cases[0].steps[1] = { op: "expectVisible", locator: {
    by: "text", text: "Home", fallbacks: [{ by: "role", role: "button", name: "Home" }],
  } };
  assert.doesNotThrow(() => parseProbePlan(plan, input));
});

test("Literal text assertions keep declared labels, seed items and data entered earlier in the case", () => {
  for (const source of ["label", "seed", "input"] as const) {
    const input = packet(source === "seed" ? [{ category: "notes", items: ["Sample"] }] : []);
    input.requirements[0].exactUiStrings = source === "label" ? ["Sample"] : [];
    const plan = validPlan();
    plan.cases[0].steps = [{ op: "goto", path: "/" },
      ...(source === "input" ? [{ op: "fill", locator: { by: "role", role: "textbox" }, value: "Sample" }] : []),
      { op: "expectVisible", locator: { by: "text", text: "Sample" } }];
    assert.doesNotThrow(() => parseProbePlan(plan, input));
  }
});

test("A matching root id echo is ignored without relaxing the probe schema", () => {
  const valid = validPlan();
  assert.equal(parseProbePlan({ ...valid, id: valid.packetId }, packet()).cases.length, 2);
  assert.throws(() => parseProbePlan({ ...valid, id: "another-packet" }, packet()), /unsupported ProbePlan field: id/);
  assert.throws(() => parseProbePlan({ ...valid, id: valid.packetId, extra: true }, packet()), /unsupported ProbePlan field: extra/);
});

test("Inline seed prose alone does not authorize a bare text locator", () => {
  const input = packet();
  input.requirements[0].exactUiStrings = [];
  input.requirements[0].seedDeclarations = ["Seed values: record Sample"];
  const plan = validPlan();
  plan.cases[0].steps = [{ op: "goto", path: "/" },
    { op: "expectVisible", locator: { by: "text", text: "Sample" } }];
  assert.throws(() => parseProbePlan(plan, input), /unanchored text locator.*role or label fallback/);
  plan.cases[0].steps[1] = { op: "expectVisible", locator: { by: "text", text: "Sample",
    fallbacks: [{ by: "role", role: "listitem", name: "Sample" }] } };
  assert.doesNotThrow(() => parseProbePlan(plan, input));
});

test("Refinement rejects unchanged, reordered and equivalent candidates when no failed step improves", () => {
  const original = parseProbePlan(validPlan(), packet());
  const fill = original.cases[0].steps[1];
  if (fill.op !== "fill") assert.fail("expected fill");
  fill.locator = { by: "label", text: "Missing", fallbacks: [{ by: "text", text: "Home" }] };
  for (const locator of [fill.locator,
    { by: "text", text: "Home", fallbacks: [{ by: "label", text: "Missing" }] },
    { by: "label", text: "missing", exact: false, fallbacks: [{ by: "text", text: "home", exact: false }] },
  ]) {
    const changed = structuredClone(original);
    changed.cases[0].steps[1] = { ...fill, locator } as typeof fill;
    assert.throws(() => assertLocatorOnlyRefinement(original, changed, locatorFailures()), /new locator candidate.*save-profile step 1/);
  }
  const changed = structuredClone(original);
  changed.cases[0].steps[1] = { ...fill, locator: { by: "role", role: "textbox", name: "Profile name" } };
  assert.doesNotThrow(() => assertLocatorOnlyRefinement(original, changed, locatorFailures()));
  assert.doesNotThrow(() => assertLocatorOnlyRefinement(original, changed, [
    ...locatorFailures(), { caseId: "refresh-profile", stepIndex: 2 },
  ]));
});

test("Probe plans support empty inputs and empty-value assertions with strict-schema null optionals", () => {
  const candidate = validPlan();
  candidate.cases[0].steps = [
    { op: "goto", path: "/" },
    { op: "fill", locator: { by: "role", role: "textbox", name: null, exact: null }, value: "" },
    { op: "expectValue", locator: { by: "label", text: "Profile name", exact: null }, value: "" },
    { op: "expectText", locator: { by: "role", role: "status", name: null, exact: null }, text: "", exact: null },
  ];
  const parsed = parseProbePlan(candidate, packet());
  assert.deepEqual(parsed.cases[0].steps[1], { op: "fill", locator: { by: "role", role: "textbox" }, value: "" });
});

test("Wire schema fully describes the DSL and closes every structured-output object", () => {
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const item = value as Record<string, unknown>;
    if (item.type === "object") {
      assert.equal(item.additionalProperties, false);
      assert.deepEqual(item.required, Object.keys(item.properties as object));
      for (const property of Object.values(item.properties as Record<string, Record<string, unknown>>)) {
        assert.ok(property.type || property.$ref || property.anyOf, "each property needs a declared type or union/reference");
      }
    }
    Object.values(item).forEach(visit);
  };
  visit(PROBE_PLAN_JSON_SCHEMA);
  visit(PROBE_REFINEMENT_JSON_SCHEMA);
  const wire = JSON.stringify(PROBE_PLAN_JSON_SCHEMA);
  assert.match(wire, /"locator"/);
  assert.match(wire, /"expectValue"/);
  assert.match(wire, /"fallbacks"/);
  assert.match(wire, /"anyOf"/);
  assert.match(wire, /locatorFlat/);
});

test("Probe plans accept bounded keyboard and pointer actions with enumerated keys", () => {
  const candidate = validPlan();
  candidate.cases[0].steps = [
    { op: "goto", path: "/" },
    { op: "doubleClick", locator: { by: "label", text: "Profile name" } },
    { op: "hover", locator: { by: "role", role: "button", name: "Hint" } },
    { op: "fill", locator: { by: "label", text: "Profile name" }, value: "Ada" },
    { op: "press", locator: { by: "label", text: "Profile name" }, key: "Enter" },
    { op: "expectText", locator: { by: "role", role: "status" }, text: "Saved" },
  ];
  const parsed = parseProbePlan(candidate, packet());
  assert.deepEqual(parsed.cases[0].steps[4], {
    op: "press",
    locator: { by: "label", text: "Profile name" },
    key: "Enter",
  });

  const badKey = validPlan();
  badKey.cases[0].steps = JSON.parse(`[
    {"op": "goto", "path": "/"},
    {"op": "press", "locator": {"by": "label", "text": "Profile name"}, "key": "Control+a"},
    {"op": "expectVisible", "locator": {"by": "role", "role": "status"}}
  ]`);
  assert.throws(() => parseProbePlan(badKey, packet()), /key must be one of/);

  const wire = JSON.stringify(PROBE_PLAN_JSON_SCHEMA);
  assert.match(wire, /"doubleClick"/);
  assert.match(wire, /"hover"/);
  assert.match(wire, /"Enter"/);
});

test("Probe Planner rejects executable, selector, and cross-origin operations", () => {
  const invalidSteps = [
    { op: "evaluate", code: "document.cookie" },
    { op: "click", selector: "#save" },
    { op: "goto", path: "https://example.com" },
    { op: "goto", path: "//example.com/path" },
    { op: "goto", path: "/../secret" },
    { op: "request", url: "/api/private" },
  ];

  for (const step of invalidSteps) {
    const candidate = validPlan();
    candidate.cases[0].steps = [step];
    assert.throws(() => parseProbePlan(candidate, packet()), /ProbePlan/);
  }
});

test("Probe Planner rejects empty, oversized, duplicate, or unrelated cases", () => {
  const empty = validPlan();
  empty.cases = [];
  assert.throws(() => parseProbePlan(empty, packet()), /at least one case/);

  const oversized = validPlan();
  oversized.cases[0].steps = Array.from({ length: 31 }, () => ({ op: "reload" }));
  assert.throws(() => parseProbePlan(oversized, packet()), /at most 30 steps/);

  const duplicate = validPlan();
  duplicate.cases[1].id = duplicate.cases[0].id;
  assert.throws(() => parseProbePlan(duplicate, packet()), /Duplicate case id/);

  const unrelated = validPlan();
  unrelated.cases[0].requirementIds = ["REQ-OTHER"];
  assert.throws(() => parseProbePlan(unrelated, packet()), /outside packet/);
});

test("Probe plans accept locator fallbacks and expectText alternatives within bounds", () => {
  const candidate = validPlan();
  candidate.cases[0].steps = [
    { op: "goto", path: "/" },
    {
      op: "click",
      locator: {
        by: "role", role: "tab", name: "Save",
        fallbacks: [{ by: "role", role: "button", name: "Save" }, { by: "text", text: "Save" }],
      },
    },
    {
      op: "expectText",
      locator: { by: "role", role: "status" },
      text: "Saved",
      anyOf: ["Stored", "Profile saved"],
    },
  ];
  const parsed = parseProbePlan(candidate, packet());
  assert.deepEqual(parsed.cases[0].steps[1], {
    op: "click",
    locator: {
      by: "role", role: "tab", name: "Save",
      fallbacks: [{ by: "role", role: "button", name: "Save" }, { by: "text", text: "Save" }],
    },
  });
  const expectStep = parsed.cases[0].steps[2];
  if (expectStep.op !== "expectText") throw new Error("fixture step must be expectText");
  assert.deepEqual(expectStep.anyOf, ["Stored", "Profile saved"]);
});

test("Probe plans bound fallbacks, forbid nesting, and bound text alternatives", () => {
  const nested = validPlan();
  nested.cases[0].steps = [{
    op: "goto", path: "/",
  }, {
    op: "click",
    locator: {
      by: "role", role: "button", name: "Save",
      fallbacks: [{ by: "role", role: "link", name: "Save", fallbacks: [{ by: "text", text: "Save" }] }],
    },
  }];
  assert.throws(() => parseProbePlan(nested, packet()), /fallbacks must not be nested/);

  const oversized = validPlan();
  oversized.cases[0].steps = [{
    op: "goto", path: "/",
  }, {
    op: "click",
    locator: {
      by: "role", role: "button", name: "Save",
      fallbacks: [
        { by: "text", text: "1" }, { by: "text", text: "2" },
        { by: "text", text: "3" }, { by: "text", text: "4" },
      ],
    },
  }];
  assert.throws(() => parseProbePlan(oversized, packet()), /at most 3 fallbacks/);

  const manyAlternatives = validPlan();
  manyAlternatives.cases[0].steps = [{
    op: "goto", path: "/",
  }, {
    op: "expectText", locator: { by: "role", role: "status" }, text: "Saved",
    anyOf: ["1", "2", "3", "4", "5"],
  }];
  assert.throws(() => parseProbePlan(manyAlternatives, packet()), /at most 4 anyOf/);
});

test("Probe Planner refinement may change locators but not behavior", () => {
  const original = parseProbePlan(validPlan(), packet());
  const locatorOnly = structuredClone(original);
  const fill = locatorOnly.cases[0].steps[1];
  if (fill.op !== "fill") throw new Error("fixture step must be fill");
  fill.locator = { by: "role", role: "textbox", name: "Profile name" };

  assert.doesNotThrow(() => assertLocatorOnlyRefinement(original, locatorOnly));

  const changedValue = structuredClone(locatorOnly);
  const changedFill = changedValue.cases[0].steps[1];
  if (changedFill.op !== "fill") throw new Error("fixture step must be fill");
  changedFill.value = "Mallory";
  assert.throws(
    () => assertLocatorOnlyRefinement(original, changedValue),
    /locator fields/,
  );
});

test("Refinement may rewrite fallbacks but not expectText alternatives", () => {
  const base = validPlan();
  base.cases[0].steps[3] = {
    op: "expectText", locator: { by: "role", role: "status" }, text: "Saved", anyOf: ["Stored"],
  };
  const original = parseProbePlan(base, packet());

  const fallbackOnly = structuredClone(original);
  const click = fallbackOnly.cases[0].steps[2];
  if (click.op !== "click") throw new Error("fixture step must be click");
  click.locator = { by: "role", role: "button", name: "Save", fallbacks: [{ by: "text", text: "Save" }] };
  assert.doesNotThrow(() => assertLocatorOnlyRefinement(original, fallbackOnly));

  const changedAnyOf = structuredClone(original);
  const expectStep = changedAnyOf.cases[0].steps[3];
  if (expectStep.op !== "expectText") throw new Error("fixture step must be expectText");
  expectStep.anyOf = ["Different"];
  assert.throws(() => assertLocatorOnlyRefinement(original, changedAnyOf), /locator fields/);
});

test("Probe Planner sends one source-blind OpenAI-compatible request", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return jsonResponse({
      choices: [{ message: { content: JSON.stringify(validPlan()) } }],
    });
  };
  const planner = new LlmProbePlanner(
    {
      baseUrl: "https://gateway.example/v1",
      apiKey: "secret-key",
      model: "provider/model",
      timeoutMs: 1_000,
    },
    fetchFn,
  );

  const result = await planner.plan(packet());

  assert.equal(result.cases.length, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://gateway.example/v1/chat/completions");
  const headers = new Headers(calls[0].init?.headers);
  assert.equal(headers.get("authorization"), "Bearer secret-key");
  assert.equal(headers.get("user-agent"), "ShallowCode/1.0");
  assert.equal(headers.get("x-opencode-session"), null);
  const parsedBody = JSON.parse(String(calls[0].init?.body)) as { stream?: unknown; stream_options?: unknown };
  const body = JSON.stringify(parsedBody);
  assert.equal(parsedBody.stream, true);
  assert.deepEqual(parsedBody.stream_options, { include_usage: true });
  assert.match(body, /Keep the profile after refresh/);
  assert.match(body, /happy_path/);
  assert.doesNotMatch(
    body,
    /candidate-app|source code|git diff|acceptedSha|SECRET-OTHER-REQ|\/workspace\/tests/,
  );
});

test("Probe Planner reports normalized token usage from a streaming usage trailer", async () => {
  const json = JSON.stringify(validPlan());
  const payload = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: json }, finish_reason: null }] })}\n\n`
    + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
    + `data: ${JSON.stringify({ choices: [], usage: {
      prompt_tokens: 1000, completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 300, cache_write_tokens: 100 },
    } })}\n\n`
    + "data: [DONE]\n\n";
  const seen: unknown[] = [];
  const planner = new LlmProbePlanner(config(), async () => sseResponse([payload]));
  const plan = await planner.plan(packet(), undefined, { timeoutMs: 1_000,
    onUsage: usage => { seen.push(usage); } });
  assert.equal(plan.cases.length, 2);
  assert.deepEqual(seen, [{ input: 700, output: 50, cacheRead: 200, cacheWrite: 100, total: 1050 }]);
});

test("Probe Planner reports usage from a non-stream JSON response", async () => {
  const seen: unknown[] = [];
  const planner = new LlmProbePlanner(config(), async () => jsonResponse({
    choices: [{ message: { content: JSON.stringify(validPlan()) } }],
    usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
  }));
  await planner.plan(packet(), undefined, { timeoutMs: 1_000, onUsage: usage => { seen.push(usage); } });
  assert.deepEqual(seen, [{ input: 120, output: 30, cacheRead: 0, cacheWrite: 0, total: 150 }]);
});

test("Usage is reported even when the plan fails validation, and omitted when the gateway has none", async () => {
  const seen: unknown[] = [];
  const invalid = new LlmProbePlanner(config(), async () => jsonResponse({
    choices: [{ message: { content: "{}" } }],
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  }));
  await assert.rejects(invalid.plan(packet(), undefined, { timeoutMs: 1_000,
    onUsage: usage => { seen.push(usage); } }), ProbePlannerError);
  assert.equal(seen.length, 1);

  const silent = new LlmProbePlanner(config(), async () => jsonResponse({
    choices: [{ message: { content: JSON.stringify(validPlan()) } }],
  }));
  await silent.plan(packet(), undefined, { timeoutMs: 1_000, onUsage: usage => { seen.push(usage); } });
  assert.equal(seen.length, 1);
});

test("Probe Planner assembles split SSE deltas and tolerates a damaged usage trailer", async () => {
  const json = JSON.stringify(validPlan());
  const event = (content: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
  const payload = event(json.slice(0, 17)) + event(json.slice(17))
    + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
    + 'data: {"created":123,"usage":nu';
  const chunks = [payload.slice(0, 9), payload.slice(9, 41), payload.slice(41)];
  const planner = new LlmProbePlanner(config(), async () => sseResponse(chunks));
  assert.equal((await planner.plan(packet())).cases.length, 2);
});

test("Planner retries preserve scenario coverage and shorten model-length responses within the schema limits", async () => {
  for (const validationError of ["Probe planner stream was cut off by the model", "Invalid plan schema"]) {
    let instruction = "";
    const planner = new LlmProbePlanner(config(), async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      const feedback = JSON.parse(body.messages.at(-1).content);
      instruction = feedback.instruction;
      assert.equal(Object.hasOwn(feedback, "schema"), false);
      assert.equal(feedback.validationError, validationError);
      assert.equal(feedback.previousResponsePreview, "Untrusted previous response");
      const systemSchema = body.messages[0].content.split("仅返回符合此 schema 的 JSON：\n").at(-1);
      assert.deepEqual(JSON.parse(systemSchema), PROBE_PLAN_JSON_SCHEMA);
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(validPlan()) } }] });
    });
    await planner.plan(packet(), { validationError, contentPreview: "Untrusted previous response" });
    assert.match(instruction, /保持每个需求 ID 和各场景独立约束的覆盖/);
    assert.match(instruction, /outcomeChecks 映射/);
    assert.match(instruction, /每个 case 的终末 assertion/);
    assert.doesNotMatch(instruction, /最多两个 case/);
    if (validationError === "Probe planner stream was cut off by the model") {
      assert.match(instruction, /等价条件合并重复路径/);
      assert.match(instruction, /planLimits/);
      assert.match(instruction, /uncoveredOutcomes/);
    }
  }
});

test("Probe Planner rejects an SSE stream that ends before completion", async () => {
  const payload = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '{"packetId":' }, finish_reason: null }] })}\n\n`;
  const planner = new LlmProbePlanner(config(), async () => sseResponse([payload]));
  await assert.rejects(planner.plan(packet()), error => {
    assert.ok(error instanceof ProbePlannerError);
    assert.equal(error.category, "transport");
    return true;
  });
});

test("Probe Planner retries a damaged content-bearing SSE event", async () => {
  const planner = new LlmProbePlanner(config(), async () =>
    sseResponse(['data: {"choices":[{"index":0,"delta":{"content":"partial"}\n\n']));
  await assert.rejects(planner.plan(packet()), error => {
    assert.ok(error instanceof ProbePlannerError);
    assert.equal(error.category, "transport");
    assert.equal(error.retryable, true);
    return true;
  });
});

test("Planner requests honour caller cancellation as well as their local timeout", async () => {
  const controller = new AbortController();
  let requestSignal: AbortSignal | null | undefined;
  const planner = new LlmProbePlanner(config(), async (_input, init) => {
    requestSignal = init?.signal;
    return new Promise((_, reject) => {
      requestSignal!.addEventListener("abort", () => reject(requestSignal!.reason), { once: true });
    });
  });
  const cancelled = assert.rejects(planner.plan(packet(), undefined, { timeoutMs: 30_000, signal: controller.signal }), error => {
    assert.ok(error instanceof ProbePlannerError);
    assert.equal((error.cause as Error).name, "AbortError");
    return true;
  });
  controller.abort();
  await cancelled;
  assert.equal(requestSignal?.aborted, true);
});

test("An unbounded Planner call keeps its request pending without a local abort timer", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let requestSignal: AbortSignal | null | undefined;
  const planner = new LlmProbePlanner(config(), async (_input, init) => {
    requestSignal = init?.signal;
    await pending;
    return jsonResponse({ choices: [{ message: { content: JSON.stringify(validPlan()) } }] });
  });
  const plan = planner.plan(packet(), undefined, { timeoutMs: Infinity });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(requestSignal, undefined);
  release();
  assert.equal((await plan).cases.length, 2);
});

test("Probe Planner uses broadly supported JSON mode", async () => {
  const calls: Array<{ init?: RequestInit }> = [];
  const fetchFn: typeof fetch = async (_input, init) => {
    calls.push({ init });
    return jsonResponse({ choices: [{ message: { content: JSON.stringify(validPlan()) } }] });
  };
  const planner = new LlmProbePlanner(config(), fetchFn);

  await planner.plan(packet());
  await planner.plan(packet());

  for (const call of calls) {
    const payload = JSON.parse(String(call.init?.body)) as { response_format?: unknown };
    assert.deepEqual(payload.response_format, { type: "json_object" });
    assert.doesNotMatch(String(call.init?.body), /json_schema/);
    assert.equal(new Headers(call.init?.headers).get("user-agent"), "ShallowCode/1.0");
    assert.equal(new Headers(call.init?.headers).get("x-opencode-session"), null);
  }
});

test("Planner plan and review requests share product and seed prefixes across packets", async () => {
  for (const operation of ["plan", "review"] as const) {
    const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const planner = new LlmProbePlanner(config(), async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      const input = JSON.parse(body.messages[1].content);
      const response = operation === "review" ? { verdict: "sound", rationale: "Matches the requirement." }
        : { ...validPlan(), packetId: input.packetId };
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(response) } }] });
    });
    const packets = [packet([{ category: "accounts", items: ["shared account alice"] }]),
      packet([{ category: "accounts", items: ["shared account alice"] }])];
    for (const [index, input] of packets.entries()) {
      input.id = `packet-${index}`;
      input.requirements[0].text += ` Packet evidence ${index}.`;
      input.prerequisites = [{ ...input.requirements[0], id: `DEP-${index}`, text: `Dependency evidence ${index}.` }];
      if (operation === "plan") await planner.plan(input);
      else await planner.reviewPlan(input, parseProbePlan({ ...validPlan(), packetId: input.id }, input), []);
    }
    const prefix = bodies[0].messages[1].content.slice(0, bodies[0].messages[1].content.indexOf(',"prerequisites":'));
    assert.ok(prefix.includes("Root description."));
    assert.ok(prefix.includes("shared account alice"));
    assert.equal(bodies[0].messages[0].content, bodies[1].messages[0].content);
    for (const [index, body] of bodies.entries()) {
      const text = body.messages[1].content;
      assert.ok(text.startsWith(prefix));
      assert.ok(text.indexOf('"packetId":') > text.indexOf('"requirements":'));
      const payload = JSON.parse(text);
      assert.equal(payload.packetId, packets[index].id);
      assert.deepEqual(payload.seedData, packets[index].requirements[0].product.seedData);
      assert.equal(payload.requirements[0].text, packets[index].requirements[0].text);
      assert.equal(payload.prerequisites[0].text, packets[index].prerequisites![0].text);
    }
  }
});

test("Official scenario contracts retain every field represented by formatted scenario strings", async () => {
  for (const directory of ["hackathon--github", "hackathon--sheet", "hackathon--github-stage-1",
    "hackathon--github-stage-2", "hackathon--github-stage-3"]) {
    const catalog = await loadRequirementCatalog(resolve("data/official-competition", directory, "requirements.yaml"));
    for (const requirement of catalog.requirements) {
      const sourceStrings = requirement.scenarioContracts?.map(scenario => [scenario.name,
        ...scenario.steps.map(step => `${step.keyword}: ${step.content}`)].join("\n"));
      assert.deepEqual(sourceStrings, requirement.scenarios, `${directory}/${requirement.id}`);
    }
  }
});

test("Plan and review requests preserve structured scenario text and legacy scenario-only inputs", async () => {
  for (const operation of ["plan", "review"] as const) {
    for (const contractMode of ["structured", "missing", "empty"] as const) {
      const input = packet();
      const requirement = input.requirements[0];
      const contract = { id: "source-save", name: "Save the profile · 保留原文", steps: [
        { keyword: "GIVEN", content: 'The current name is "Before\nAfter".' },
        { keyword: "AND", content: "The profile is editable." },
        { keyword: "WHEN", content: 'The visitor enters "Ada" and clicks "Save".' },
        { keyword: "THEN", content: 'The status displays "Saved".' },
      ] };
      if (contractMode !== "missing") requirement.scenarioContracts = contractMode === "structured" ? [contract] : [];
      if (contractMode === "structured") requirement.scenarios = [[contract.name,
        ...contract.steps.map(step => `${step.keyword}: ${step.content}`)].join("\n")];
      input.prerequisites = [{ ...requirement, id: "REQ-BASE", scenarios: ["Independent prerequisite source text."] }];
      const wire = { ...validPlan(), cases: validPlan().cases.map((item, index) => ({ ...item,
        outcomeChecks: contractMode === "structured" && index === 0
          ? [{ scenarioId: contract.id, stepIndex: 3, assertionIndexes: [3] }] : [] })) };
      let payload: Record<string, any> | undefined;
      const planner = new LlmProbePlanner(config(), async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        payload = JSON.parse(body.messages[1].content);
        const response = operation === "plan" ? wire : { verdict: "sound", rationale: "Fixture evidence is preserved." };
        return jsonResponse({ choices: [{ message: { content: JSON.stringify(response) } }] });
      });
      if (operation === "plan") await planner.plan(input);
      else await planner.reviewPlan(input, parseProbePlan(wire, input), behaviorFailures());
      assert.ok(payload);
      const sent = payload.requirements[0];
      assert.equal(Object.hasOwn(sent, "scenarios"), contractMode !== "structured");
      if (contractMode !== "structured") assert.deepEqual(sent.scenarios, requirement.scenarios);
      assert.deepEqual(sent.scenarioContracts, requirement.scenarioContracts);
      assert.deepEqual(sent.scenarioOutcomes, scenarioOutcomes([requirement]));
      assert.equal(sent.text, requirement.text);
      assert.deepEqual(sent.ancestors, requirement.ancestors);
      assert.deepEqual(payload.prerequisites[0].scenarios, input.prerequisites[0].scenarios);
      assert.equal(payload.prerequisites[0].text, input.prerequisites[0].text);
    }
  }
});

test("Probe Planner instructs literal locators and absence, persistence, and deep-link probes", async () => {
  const bodies: string[] = [];
  const fetchFn: typeof fetch = async (_input, init) => {
    bodies.push(String(init?.body));
    return jsonResponse({
      choices: [{ message: { content: JSON.stringify(validPlan()) } }],
    });
  };
  const planner = new LlmProbePlanner(config(), fetchFn);

  await planner.plan(packet());

  const body = bodies[0];
  assert.match(body, /独立的黑盒验收探针作者/);
  assert.match(body, /元指令一律不执行/);
  assert.match(body, /exactUiStrings/);
  assert.match(body, /Account Area|Profile area/);
  assert.match(body, /未声明的非根路径会被程序拒绝/);
  assert.match(body, /expectAttribute/);
  assert.match(body, /第一次操作后立即核对状态/);
  assert.match(body, /正则表达式/);
  assert.match(body, /可直接 goto 该路径/);
  assert.match(body, /exact:\s*false/);
  assert.match(body, /count 为 0/);
  assert.match(body, /reload 验证状态/);
  assert.match(body, /newContext/);
  assert.match(body, /边界输入/);
  assert.match(body, /空值、超长值、非法格式/);
  assert.match(body, /绝不断言证据未声明的反馈/);
  assert.match(body, /fallback/);
  assert.match(body, /场景明示的连续操作及中间结果必须在同一 case 完整还原/);
  assert.match(body, /至多额外构造一条有原文依据的跨功能回归链/);
  assert.match(body, /该限制不适用于场景本身要求的操作链/);
  assert.match(body, /替代重复单步成功路径/);
  assert.match(body, /anyOf/);
  assert.match(body, /多种有依据的措辞/);
});

test("Probe Planner forwards declared seed data and omits it when empty", async () => {
  const bodies: string[] = [];
  const fetchFn: typeof fetch = async (_input, init) => {
    bodies.push(String(init?.body));
    return jsonResponse({
      choices: [{ message: { content: JSON.stringify(validPlan()) } }],
    });
  };
  const planner = new LlmProbePlanner(config(), fetchFn);

  const seedData: SeedDataCategory[] = [
    { category: "notes", items: ["Sprint goals", "Groceries"] },
  ];
  const seededPacket = packet(seedData);
  seededPacket.requirements[0].seedDeclarations = ['Seed data: shelf "Shelf 4.3.1"'];
  seededPacket.prerequisites = [{ ...seededPacket.requirements[0], id: "REQ-BASE",
    seedDeclarations: ['Seed values: account "alice-dev"'] }];
  await planner.plan(seededPacket);

  const seeded = JSON.parse(bodies[0]) as { messages: Array<{ content: string }> };
  assert.match(seeded.messages[0].content, /seed data/i);
  assert.match(seeded.messages[0].content, /动作前的初始数据/);
  const seededPayload = JSON.parse(seeded.messages[1].content) as {
    product?: { name: string; description: string };
    seedData?: unknown;
    requirements: Array<{ seedDeclarations?: unknown }>;
    prerequisites?: Array<{ seedDeclarations?: unknown }>;
  };
  assert.deepEqual(seededPayload.seedData, seedData);
  assert.equal(seededPayload.product?.name, "Demo Product");
  assert.equal(seededPayload.product?.description, "Root description.");
  assert.deepEqual(seededPayload.requirements[0].seedDeclarations, ['Seed data: shelf "Shelf 4.3.1"']);
  assert.deepEqual(seededPayload.prerequisites?.[0].seedDeclarations, ['Seed values: account "alice-dev"']);

  await planner.plan(packet());
  const plain = JSON.parse(bodies[1]) as { messages: Array<{ content: string }> };
  const plainPayload = JSON.parse(plain.messages[1].content) as {
    seedData?: unknown;
    requirements: Array<{ seedDeclarations?: unknown }>;
  };
  assert.equal("seedData" in plainPayload, false);
  assert.deepEqual(plainPayload.requirements[0].seedDeclarations, []);
});

test("Probe Planner extracts JSON from fenced and annotated responses", async () => {
  const raw = JSON.stringify(validPlan());
  const contents = [
    `\`\`\`json\n${raw}\n\`\`\``,
    `\`\`\`\n${raw}\n\`\`\``,
    `Here is the probe plan:\n${raw}\nDone.`,
    `Notes {not: "the plan"} aside. ${raw}`,
  ];

  for (const content of contents) {
    const planner = new LlmProbePlanner(config(), async () =>
      jsonResponse({ choices: [{ message: { content } }] }),
    );
    const result = await planner.plan(packet());
    assert.equal(result.packetId, "packet-profile");
    assert.equal(result.cases.length, 2);
  }
});

test("A completeness-review failure keeps the valid plan pending without regenerating it", async () => {
  const reviewedPacket = packet();
  reviewedPacket.requirements[0].scenarioContracts = [{ id: "save-profile", name: "Save the profile",
    steps: [
      { keyword: "GIVEN", content: "the profile form is open" },
      { keyword: "WHEN", content: "the user saves the profile" },
      { keyword: "THEN", content: "the profile is saved and remains after refresh" },
    ] }];
  const wire = validPlan();
  wire.cases[0].steps.splice(3, 0, { op: "reload" });
  (wire.cases[0] as Record<string, unknown>).outcomeChecks = [
    { scenarioId: "save-profile", stepIndex: 2, clauseIndex: 0, assertionIndexes: [4] },
    { scenarioId: "save-profile", stepIndex: 2, clauseIndex: 1, assertionIndexes: [4] },
  ];
  let calls = 0;
  const planner = new LlmProbePlanner(config(), async (_input, init) => {
    calls += 1;
    return calls === 1
      ? jsonResponse({ choices: [{ message: { content: JSON.stringify(wire) } }] })
      : jsonResponse({ choices: [{ message: { content: "not json" } }] });
  });

  const result = await planner.plan(reviewedPacket);

  assert.equal(calls, 2, "the failed review must not trigger a second full plan");
  assert.equal(result.coverageReview, "pending");
  assert.equal(result.cases.length, wire.cases.length);
  assert.equal(Object.hasOwn(toWireProbePlan(result) as object, "coverageReview"), false);
  assert.equal(probePlanSha256(result), probePlanSha256({ ...result, coverageReview: "verified" }));
});

test("Probe Planner reports stable transport, JSON, and schema categories", async () => {
  const cases: Array<{ response: Response; category: string }> = [
    { response: new Response("bad", { status: 503 }), category: "transport" },
    {
      response: jsonResponse({ choices: [{ message: { content: "not json" } }] }),
      category: "json",
    },
    {
      response: jsonResponse({
        choices: [{ message: { content: JSON.stringify({ packetId: "x", cases: [] }) } }],
      }),
      category: "schema",
    },
  ];

  for (const item of cases) {
    const planner = new LlmProbePlanner(config(), async () => item.response);
    await assert.rejects(
      planner.plan(packet()),
      (error: unknown) =>
        error instanceof ProbePlannerError && error.category === item.category,
    );
  }
});

test("Planner classifies gateway retryability from HTTP status, not response text", async () => {
  for (const status of [408, 429, 500, 503, 400, 401, 403, 404]) {
    const planner = new LlmProbePlanner(config(), async () => new Response("transient network timeout", { status }));
    await assert.rejects(planner.plan(packet()), (error: unknown) => {
      assert.ok(error instanceof ProbePlannerError);
      const retryable = [408, 429, 500, 503].includes(status);
      assert.equal(error.retryable, retryable);
      assert.equal(error.fatal, !retryable);
      assert.equal(error.diagnostics.httpStatus, status);
      return true;
    });
  }
});

test("Probe Planner preserves bounded, redacted validation diagnostics", async () => {
  const content = JSON.stringify({
    packetId: packet().id, cases: [], password: "private-value",
    note: `secret-key\u0001 Bearer private-bearer ${"x".repeat(2000)}`,
  });
  const planner = new LlmProbePlanner(config(), async () =>
    jsonResponse({ choices: [{ message: { content } }] }),
  );
  await assert.rejects(planner.plan(packet()), (error: unknown) => {
    assert.ok(error instanceof ProbePlannerError);
    assert.equal(error.diagnostics.category, "schema");
    assert.match(error.diagnostics.validationError ?? "", /unsupported ProbePlan field: password/);
    assert.match(error.diagnostics.contentPreview ?? "", /packet-profile/);
    assert.ok((error.diagnostics.contentPreview?.length ?? 0) <= 1500);
    assert.doesNotMatch(JSON.stringify(error.diagnostics), /private-value|secret-key|private-bearer/);
    return true;
  });
});

test("Probe Planner rejects behavior fields in locator patches and accepts retry feedback", async () => {
  const changed = { patches: [{ caseId: "save-profile", stepIndex: 1,
    locator: { by: "role", role: "textbox", name: "Profile name" }, value: "different-input" }] };
  let calls = 0;
  const planner = new LlmProbePlanner(config(), async () => {
    calls += 1;
    return jsonResponse({ choices: [{ message: { content: JSON.stringify(changed) } }] });
  });
  const original = parseProbePlan(validPlan(), packet());
  await assert.rejects(planner.refineLocators(original, locatorFailures()), (error: unknown) => {
    assert.ok(error instanceof ProbePlannerError);
    assert.equal(error.category, "refinement");
    assert.match(error.diagnostics.validationError ?? "", /unsupported ProbePlan field: value/);
    assert.match(error.diagnostics.contentPreview ?? "", /different-input/);
    return true;
  });
  await assert.rejects(planner.refineLocators(original, locatorFailures(), {
    validationError: "Preserve inputs", contentPreview: "previous response",
  }), /invalid locator refinement/);
  assert.equal(calls, 2);
});

test("Probe Planner sends per-case failed steps, all locator attempts, sanitized snapshots and feedback", async () => {
  const bodies: string[] = [];
  const fetchFn: typeof fetch = async (_input, init) => {
    bodies.push(String(init?.body));
    const refined = { patches: [
      { caseId: "save-profile", stepIndex: 1, locator: { by: "role", role: "textbox", name: "Profile name" } },
      { caseId: "refresh-profile", stepIndex: 2, locator: { by: "role", role: "textbox", name: "Profile name" } },
    ] };
    return jsonResponse({
      choices: [{ message: { content: JSON.stringify(refined) } }],
    });
  };
  const planner = new LlmProbePlanner(config(), fetchFn);
  const original = parseProbePlan(validPlan(), packet());

  const updated = await planner.refineLocators(
    original,
    [...locatorFailures(`- textbox "Profile name"\npassword: super-secret\ntoken=abc123\n${"x".repeat(10_000)}`).map(failure => ({ ...failure,
      pageUrl: "https://example.invalid/#/profile?token=page-secret",
      locatorAttempts: failure.locatorAttempts?.map(attempt => ({ ...attempt, matchCount: 2 })) })),
      { caseId: "refresh-profile", stepIndex: 2, category: "locator", message: "secret-key missing", locatorSnapshot: "- main" }],
    { validationError: "unchanged failed step secret-key", contentPreview: "password=hidden" },
  );
  assert.equal(updated.cases[0].steps[1].op, "fill");
  assert.equal(updated.cases[1].steps[2].op, "expectValue");
  assert.deepEqual(updated.cases[0].steps[1], {
    op: "fill", locator: { by: "role", role: "textbox", name: "Profile name" }, value: "Ada",
  });

  assert.equal(bodies.length, 1);
  assert.doesNotMatch(JSON.parse(bodies[0]).messages[1].content, /super-secret|abc123|secret-key|hidden|page-secret/);
  const request = JSON.parse(bodies[0]) as { messages: Array<{ content: string }> };
  assert.match(request.messages[0].content, /"patches"/);
  assert.doesNotMatch(request.messages[0].content, /"expectationBasis"/);
  const refinement = JSON.parse(request.messages[1].content);
  assert.equal(refinement.failures.length, 2);
  assert.equal(refinement.failures[0].caseId, "save-profile");
  assert.equal(refinement.failures[0].stepIndex, 1);
  assert.deepEqual(refinement.failures[0].step, original.cases[0].steps[1]);
  assert.ok(refinement.failures[0].accessibilitySnapshot.length <= 4_000);
  assert.match(refinement.failures[0].locatorAttempts[0].message, /strict mode violation/);
  assert.equal(refinement.failures[0].locatorAttempts[0].matchCount, 2);
  assert.match(refinement.failures[0].pageUrl, /#\/profile/);
  assert.equal(refinement.failures[1].accessibilitySnapshot, "- main");
  assert.match(refinement.validationError, /unchanged failed step/);
  assert.equal("anchoredRequirementNames" in refinement, false);
});

test("Probe Planner forwards requirement-grounded anchor names and omits them when empty", async () => {
  const bodies: string[] = [];
  const fetchFn: typeof fetch = async (_input, init) => {
    bodies.push(String(init?.body));
    const refined = { patches: [{ caseId: "save-profile", stepIndex: 1,
      locator: { by: "role", role: "textbox", name: "Profile name" } }] };
    return jsonResponse({ choices: [{ message: { content: JSON.stringify(refined) } }] });
  };
  const planner = new LlmProbePlanner(config(), fetchFn);
  const original = parseProbePlan(validPlan(), packet());

  await planner.refineLocators(original, locatorFailures(), undefined,
    { timeoutMs: 1_000, anchoredNames: ["Profile name", "Save"] });
  await planner.refineLocators(original, locatorFailures(), undefined, { timeoutMs: 1_000, anchoredNames: [] });

  const requests = bodies.map((body) => JSON.parse(JSON.parse(body).messages[1].content));
  assert.deepEqual(requests[0].anchoredRequirementNames, ["Profile name", "Save"]);
  assert.equal("anchoredRequirementNames" in requests[1], false);
});

test("LLM returning an unchanged failed locator stops refinement with an actionable reason", async () => {
  const original = parseProbePlan(validPlan(), packet());
  const planner = new LlmProbePlanner(config(), async () =>
    jsonResponse({ choices: [{ message: { content: JSON.stringify({ patches: [{ caseId: "save-profile", stepIndex: 1,
      locator: { by: "label", text: "Profile name", exact: true } }] }) } }] }));
  await assert.rejects(planner.refineLocators(original, locatorFailures()), (error: unknown) => {
    assert.ok(error instanceof NoLocatorProgressError);
    assert.match(error.message, /save-profile step 1/);
    return true;
  });
});

test("Locator patches reject empty, duplicate, unrelated, and full-plan output", async () => {
  const original = parseProbePlan(validPlan(), packet());
  const good = { caseId: "save-profile", stepIndex: 1,
    locator: { by: "role", role: "textbox", name: "Profile name" } };
  for (const [payload, pattern] of [
    [{ patches: [] }, /no new locator candidate/],
    [{ patches: [good, good] }, /duplicates a locator patch/],
    [{ patches: [{ ...good, caseId: "refresh-profile" }] }, /does not target a failed locator step/],
    [{ patches: [{ ...good, locator: { by: "css", selector: "#name" } }] }, /must use role, label, or text/],
    [validPlan(), /unsupported ProbePlan field: packetId/],
  ] as const) {
    const planner = new LlmProbePlanner(config(), async () =>
      jsonResponse({ choices: [{ message: { content: JSON.stringify(payload) } }] }));
    await assert.rejects(planner.refineLocators(original, locatorFailures()), (error: unknown) => {
      assert.match(error instanceof ProbePlannerError ? error.diagnostics.validationError ?? "" : String(error), pattern);
      return true;
    });
  }
});

test("A locator patch can recover one failed step while another remains unresolved", async () => {
  const original = parseProbePlan(validPlan(), packet());
  const failures: ProbeFailure[] = [...locatorFailures(), {
    caseId: "refresh-profile", stepIndex: 2, category: "locator", message: "missing input",
    locatorSnapshot: '- textbox "Profile name"',
  }];
  const improved = { caseId: "save-profile", stepIndex: 1,
    locator: { by: "role", role: "textbox", name: "Profile name", exact: true } };
  for (const patches of [[improved], [improved, { caseId: "refresh-profile", stepIndex: 2,
    locator: { by: "label", text: "Profile name" } }]]) {
    const planner = new LlmProbePlanner(config(), async () =>
      jsonResponse({ choices: [{ message: { content: JSON.stringify({ patches }) } }] }));
    const refined = await planner.refineLocators(original, failures);
    assert.deepEqual(refined.cases[0].steps[1], {
      op: "fill", locator: improved.locator, value: "Ada",
    });
    assert.deepEqual(refined.cases[1], original.cases[1]);
    assert.doesNotThrow(() => assertLocatorOnlyRefinement(original, refined, failures, packet()));
  }
});

function locatorFailures(snapshot = '- textbox "Profile name"'): ProbeFailure[] {
  return [{ caseId: "save-profile", stepIndex: 1, category: "locator", message: "strict mode violation",
    locatorSnapshot: snapshot, locatorAttempts: [
      { locator: { by: "label", text: "Profile name", exact: true }, message: "strict mode violation secret-key" },
    ] }];
}

function validPlan(): {
  packetId: string;
  cases: Array<{
    id: string;
    requirementIds: string[];
    purpose: string;
    expectationBasis?: string[];
    steps: Array<Record<string, unknown>>;
  }>;
} {
  return {
    packetId: "packet-profile",
    cases: [
      {
        id: "save-profile",
        requirementIds: ["REQ-PROFILE"],
        purpose: "happy_path",
        expectationBasis: ["Keep the profile after refresh."],
        steps: [
          { op: "goto", path: "/" },
          {
            op: "fill",
            locator: { by: "label", text: "Profile name", exact: true },
            value: "Ada",
          },
          {
            op: "click",
            locator: { by: "role", role: "button", name: "Save" },
          },
          {
            op: "expectText",
            locator: { by: "role", role: "status" },
            text: "Saved",
          },
        ],
      },
      {
        id: "refresh-profile",
        requirementIds: ["REQ-PROFILE"],
        purpose: "persistence",
        expectationBasis: ["Keep the profile after refresh."],
        steps: [
          { op: "goto", path: "/" },
          { op: "reload" },
          {
            op: "expectValue",
            locator: { by: "label", text: "Profile name" },
            value: "Ada",
          },
        ],
      },
    ],
  };
}

function packet(seedData: SeedDataCategory[] = []): WorkPacket {
  return {
    id: "packet-profile",
    requirementIds: ["REQ-PROFILE"],
    attempt: 1,
    requirements: [
      {
        id: "REQ-PROFILE",
        folderPath: ["ROOT", "PROFILE"],
        declarationIndex: 0,
        name: "Profile",
        text: "Keep the profile after refresh.",
        dependencyIds: [],
        scenarios: ["Save the profile"],
        references: ["reference/profile.png"],
        exactUiStrings: ["Profile name", "Save"],
        seedDeclarations: [],
        product: {
          kind: "generic_web",
          rootId: "ROOT",
          rootName: "Demo Product",
          description: "Root description.",
          seedData,
        },
        ancestors: [
          { id: "PROFILE", name: "Profile", description: "Profile area" },
        ],
      },
    ],
  };
}

function config() {
  return {
    baseUrl: "https://gateway.example/v1",
    apiKey: "secret-key",
    model: "provider/model",
    timeoutMs: 1_000,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === chunks.length) controller.close();
      else controller.enqueue(encoder.encode(chunks[index++]));
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}


test("Wire cases require a final assertion and parse it into the ordered execution plan", () => {
  assert.ok(PROBE_PLAN_JSON_SCHEMA.properties.cases.items.required.includes("assertion"));
  const plan = parseProbePlan({ packetId: "p", cases: [{ id: "c", requirementIds: ["r"], purpose: "happy_path",
    expectationBasis: ["requirement evidence"], steps: [{ op: "goto", path: "/" }],
    assertion: { op: "expectVisible", locator: { by: "role", role: "main" } } }] });
  assert.equal(plan.cases[0].steps.at(-1)?.op, "expectVisible");
  assert.throws(() => parseProbePlan({ packetId: "p", cases: [{ id: "c", requirementIds: ["r"], purpose: "happy_path",
    expectationBasis: ["requirement evidence"], steps: [], assertion: { op: "goto", path: "/" } }] }), /must be an assertion/);
});

test("Locator scopes are flat, bounded, and count as new localization evidence", () => {
  const original = parseProbePlan(validPlan(), packet());
  const scoped = structuredClone(original);
  const fill = scoped.cases[0].steps[1];
  if (fill.op !== "fill") assert.fail("expected fill");
  fill.locator.scope = { by: "role", role: "dialog", name: "Profile" };
  assert.doesNotThrow(() => assertLocatorOnlyRefinement(original, parseProbePlan(scoped), [{ caseId: original.cases[0].id, stepIndex: 1 }]));
  const unsafe = structuredClone(scoped) as any;
  unsafe.cases[0].steps[1].locator.scope.scope = { by: "text", text: "nested" };
  assert.throws(() => parseProbePlan(unsafe), /must be flat/);
  delete unsafe.cases[0].steps[1].locator.scope.scope;
  unsafe.cases[0].steps[1].locator.scope.hasText = "x".repeat(2001);
  assert.throws(() => parseProbePlan(unsafe), /2000 characters/);
});

test("Every case must ground its expected outcome in verbatim requirement evidence", () => {
  const missing = validPlan() as { packetId: string; cases: Array<Record<string, unknown>> };
  delete missing.cases[0].expectationBasis;
  assert.throws(() => parseProbePlan(missing, packet()), /expectationBasis/);

  const invented = validPlan();
  invented.cases[0].expectationBasis = ["A success toast appears"];
  assert.throws(() => parseProbePlan(invented, packet()), /must quote the requirement evidence verbatim/);

  const tooMany = validPlan();
  tooMany.cases[0].expectationBasis = ["Keep the profile after refresh.", "Keep", "profile", "refresh"];
  assert.throws(() => parseProbePlan(tooMany, packet()), /at most 3 expectationBasis quotes/);

  const seed = validPlan();
  seed.cases[0].expectationBasis = ["Sprint goals"];
  assert.doesNotThrow(() => parseProbePlan(seed, packet([{ category: "notes", items: ["Sprint goals"] }])));

  const scenario = validPlan();
  scenario.cases[0].expectationBasis = ["Save the profile"];
  assert.doesNotThrow(() => parseProbePlan(scenario, packet()));

  const uncleaned = validPlan();
  uncleaned.cases[0].expectationBasis = ["  keep   the PROFILE after refresh.  "];
  assert.doesNotThrow(() => parseProbePlan(uncleaned, packet()));
});

test("Refinement freezes expectationBasis like every other non-locator field", () => {
  const original = parseProbePlan(validPlan(), packet());
  const changed = structuredClone(original);
  changed.cases[0].expectationBasis = ["A success toast appears"];
  assert.throws(() => assertLocatorOnlyRefinement(original, changed), /only locator fields/);
});

test("Probe Planner semantic review returns sound or a validated corrected plan", async () => {
  const bodies: string[] = [];
  const reviews = [
    { verdict: "sound", rationale: "期望与需求原文一致" },
    { verdict: "corrected", rationale: "计划误读种子",
      corrections: [{ caseId: "save-profile", conflict: "需求写 active", basis: ["Keep the profile after refresh."],
        case: (correctedPlan() as { cases: unknown[] }).cases[0] }] },
  ];
  let call = 0;
  const fetchFn: typeof fetch = async (_input, init) => {
    bodies.push(String(init?.body));
    return jsonResponse({ choices: [{ message: { content: JSON.stringify(reviews[call++]) } }] });
  };
  const planner = new LlmProbePlanner(config(), fetchFn);
  const reviewedPacket = packet();
  reviewedPacket.requirements[0].seedDeclarations = ['Seed data: shelf "Shelf 4.3.1"'];
  reviewedPacket.prerequisites = [{ ...reviewedPacket.requirements[0], id: "REQ-BASE",
    seedDeclarations: ['Seed values: account "alice-dev"'] }];
  const original = parseProbePlan(validPlan(), reviewedPacket);

  const sound = await planner.reviewPlan(reviewedPacket, original, behaviorFailures(), undefined,
    { timeoutMs: 1_000, preparationOnlyCaseIds: ["save-profile"] });
  assert.deepEqual(sound, { status: "sound", rationale: "期望与需求原文一致" });
  const corrected = await planner.reviewPlan(reviewedPacket, original, behaviorFailures().map(failure => ({ ...failure,
    pageUrl: "https://example.invalid/#/profile?token=review-secret",
    locatorAttempts: [{ locator: { by: "role", role: "button", name: "Save" }, message: "missing", matchCount: 0 }],
  })));
  assert.equal(corrected.status, "corrected");
  if (corrected.status === "corrected") assert.equal(corrected.plan.cases[0].steps.at(-1)?.op, "expectText");

  const request = JSON.parse(bodies[0]) as { messages: Array<{ content: string }> };
  assert.match(request.messages[0].content, /复核者/);
  assert.match(request.messages[0].content, /expectationBasis/);
  const payload = JSON.parse(request.messages[1].content) as {
    originalPlan?: unknown;
    preparationOnlyCaseIds?: string[];
    failures?: unknown[];
    product?: { description: string };
    requirements?: Array<{ seedDeclarations?: unknown }>;
    prerequisites?: Array<{ seedDeclarations?: unknown }>;
  };
  assert.ok(payload.originalPlan);
  assert.deepEqual(payload.preparationOnlyCaseIds, ["save-profile"]);
  assert.equal(payload.product?.description, "Root description.");
  assert.deepEqual(payload.requirements?.[0].seedDeclarations, ['Seed data: shelf "Shelf 4.3.1"']);
  assert.deepEqual(payload.prerequisites?.[0].seedDeclarations, ['Seed values: account "alice-dev"']);
  assert.equal((payload.failures as unknown[]).length, 1);
  assert.doesNotMatch(JSON.stringify(payload), /source code|git diff|acceptedSha/);
  const secondPayload = JSON.parse(JSON.parse(bodies[1]).messages[1].content);
  assert.match(secondPayload.failures[0].pageUrl, /#\/profile/);
  assert.doesNotMatch(secondPayload.failures[0].pageUrl, /review-secret/);
  assert.equal(secondPayload.failures[0].locatorAttempts[0].matchCount, 0);
  const secondRequest = JSON.parse(bodies[1]) as { messages: Array<{ content: string }> };
  const reviewSchema = secondRequest.messages[0].content.split("仅返回符合此 schema 的 JSON：\n").at(-1)!;
  assert.match(reviewSchema, /"case"/);
  assert.doesNotMatch(reviewSchema, /"plan"/);
});

test("Review distinguishes a failed initial-state checkpoint from a later business failure", async () => {
  const payloads: Array<Record<string, any>> = [];
  const planner = new LlmProbePlanner(config(), async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    payloads.push(JSON.parse(request.messages[1].content));
    return jsonResponse({ choices: [{ message: { content: JSON.stringify({ verdict: "sound", rationale: "fixture" }) } }] });
  });
  const wire = validPlan();
  wire.cases[0].steps.splice(1, 0, { op: "expectValue", locator: { by: "label", text: "Profile name", exact: true }, value: "" });
  const original = parseProbePlan(wire, packet());
  original.cases[0].setupStepCount = 2;
  for (const stepIndex of [1, 3]) {
    await planner.reviewPlan(packet(), original, [{ caseId: "save-profile", stepIndex,
      category: stepIndex === 1 ? "precondition" : "assertion", message: "fixture failure" }]);
  }
  assert.deepEqual(payloads.map(payload => payload.failures[0].initialStateCheckpoint), [false, true].map(passed => ({
    stepIndex: 1, assertion: original.cases[0].steps[1], passed,
  })));
  assert.equal(payloads[0].failures[0].preparationCheckpointPassed, false);
  assert.equal(payloads[1].failures[0].preparationCheckpointPassed, true);
});

test("Review contract violations are review-category errors with diagnostics", async () => {
  for (const [payload, pattern] of [
    [{ verdict: "sound", rationale: "x", plan: correctedPlan() }, /unsupported field: plan|must not carry/],
    [{ verdict: "corrected", rationale: "x",
      corrections: [{ caseId: "ghost", conflict: "c", basis: ["Keep the profile after refresh."],
        case: (correctedPlan() as { cases: unknown[] }).cases[0] }] }, /reviewed plan/],
    [{ verdict: "corrected", rationale: "x",
      corrections: [{ caseId: "save-profile", conflict: "c", basis: ["invented"],
        case: (correctedPlan() as { cases: unknown[] }).cases[0] }] }, /verbatim/],
  ] as const) {
    const planner = new LlmProbePlanner(config(), async () =>
      jsonResponse({ choices: [{ message: { content: JSON.stringify(payload) } }] }));
    const original = parseProbePlan(validPlan(), packet());
    await assert.rejects(planner.reviewPlan(packet(), original, behaviorFailures()), (error: unknown) => {
      assert.ok(error instanceof ProbePlannerError);
      assert.equal(error.category, "review");
      assert.match(error.diagnostics.validationError ?? "", pattern);
      return true;
    });
  }
});

function preparedProfilePlan() {
  const original = parseProbePlan(validPlan(), packet());
  original.cases[0].steps.splice(1, 0,
    { op: "expectValue", locator: { by: "label", text: "Profile name", exact: true }, value: "Initial" });
  original.cases[0].setupStepCount = 2;
  return original;
}

function profilePreparationCorrection() {
  return { caseId: "save-profile", conflict: "The initial profile value was not established",
    basis: ["Keep the profile after refresh."], setupSteps: [
      { op: "goto", path: "/" },
      { op: "fill", locator: { by: "label", text: "Profile name", exact: true }, value: "Initial" },
      { op: "expectValue", locator: { by: "label", text: "Profile name", exact: true }, value: "Initial" },
    ] };
}

test("Planner preparation recovery returns only prefixes with complete context and the existing usage callback", async () => {
  const bodies: Array<{ messages: Array<{ content: string }> }> = [];
  const usage: unknown[] = [];
  const planner = new LlmProbePlanner(config(), async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return jsonResponse({ choices: [{ message: { content: JSON.stringify({ verdict: "corrected", rationale: "Prepare the initial value",
      corrections: [profilePreparationCorrection()] }) } }], usage: { prompt_tokens: 20, completion_tokens: 10 } });
  });
  const original = preparedProfilePlan();
  const review = await planner.reviewPlan(packet(), original, [{ caseId: "save-profile", stepIndex: 1,
    category: "precondition", message: "expected Initial" }], undefined,
    { timeoutMs: 1_000, preparationOnlyCaseIds: ["save-profile"], onUsage: item => { usage.push(item); } });
  if (review.status !== "corrected") assert.fail("missing corrected plan");
  assert.equal(bodies.length, 1);
  assert.equal(review.plan.cases[0].setupStepCount, 3);
  assert.deepEqual(review.plan.cases[0].steps.slice(3), original.cases[0].steps.slice(2));
  assert.deepEqual(review.plan.cases[1], original.cases[1]);
  assert.deepEqual(usage, [{ input: 20, output: 10, cacheRead: 0, cacheWrite: 0, total: 30 }]);
  const payload = JSON.parse(bodies[0].messages[1].content);
  assert.deepEqual(payload.preparationOnlyCaseIds, ["save-profile"]);
  assert.deepEqual(payload.caseCorrectionIds, []);
  assert.deepEqual(payload.originalPlan, toWireProbePlan(original));
  const schemaText = bodies[0].messages[0].content.split("仅返回符合此 schema 的 JSON：\n").at(-1)!;
  assert.match(schemaText, /"setupSteps"/);
  assert.doesNotMatch(schemaText, /"plan"|"case"|"expectationBasis"/);
});

test("Planner mixed recovery accepts prefix and business-case corrections in one response", async () => {
  const original = preparedProfilePlan();
  const wire = toWireProbePlan(original) as { cases: Array<Record<string, unknown>> };
  const correctedCase = { ...wire.cases[1], assertion: { op: "expectValue", locator: { by: "label", text: "Profile name" }, value: "Grace" } };
  let calls = 0;
  const planner = new LlmProbePlanner(config(), async (_input, init) => {
    calls++;
    const payload = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    assert.deepEqual(payload.caseCorrectionIds, ["refresh-profile"]);
    return jsonResponse({ choices: [{ message: { content: JSON.stringify({ verdict: "corrected", rationale: "Two independent probe issues",
      corrections: [profilePreparationCorrection(), { caseId: "refresh-profile", conflict: "The expected value was incorrect",
        basis: ["Keep the profile after refresh."], case: correctedCase }] }) } }] });
  });
  const review = await planner.reviewPlan(packet(), original, [
    { caseId: "save-profile", stepIndex: 1, category: "precondition", message: "initial value absent" },
    { caseId: "refresh-profile", stepIndex: 2, category: "assertion", message: "wrong expected value" },
  ], undefined, { timeoutMs: 1_000, preparationOnlyCaseIds: ["save-profile"] });
  if (review.status !== "corrected") assert.fail("missing corrected plan");
  assert.equal(calls, 1);
  assert.equal(review.corrections.length, 2);
  assert.deepEqual(review.plan.cases[0].steps.slice(3), original.cases[0].steps.slice(2));
  assert.deepEqual(review.plan.cases[1].steps.at(-1), correctedCase.assertion);
});

test("Planner rejects a full-case rewrite for a preparation target with feedback diagnostics", async () => {
  const planner = new LlmProbePlanner(config(), async () => jsonResponse({ choices: [{ message: {
    content: JSON.stringify({ verdict: "corrected", rationale: "rewrite the case", corrections: [{
      ...profilePreparationCorrection(), case: {}, setupStepCount: 99,
    }] }),
  } }] }));
  await assert.rejects(planner.reviewPlan(packet(), preparedProfilePlan(), [{ caseId: "save-profile", stepIndex: 1,
    category: "precondition", message: "initial state missing" }], undefined,
    { timeoutMs: 1_000, preparationOnlyCaseIds: ["save-profile"] }), (error: unknown) => {
    assert.ok(error instanceof ProbePlannerError);
    assert.equal(error.category, "review");
    assert.match(error.diagnostics.validationError ?? "", /unsupported field: case/);
    assert.match(error.diagnostics.contentPreview ?? "", /setupStepCount/);
    return true;
  });
});

test("Preparation review schemas retain their shared system prefix across different target IDs", async () => {
  for (const mixed of [false, true]) {
    const bodies: Array<{ messages: Array<{ content: string }> }> = [];
    const planner = new LlmProbePlanner(config(), async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({ verdict: "sound", rationale: "Matches the requirements" }) } }] });
    });
    for (let index = 0; index < 2; index++) {
      const input = packet();
      input.id = `packet-${index}`;
      const plan = preparedProfilePlan();
      plan.packetId = input.id;
      plan.cases[0].id = `prepare-${index}`;
      plan.cases[1].id = `business-${index}`;
      await planner.reviewPlan(input, plan, [
        { caseId: plan.cases[0].id, stepIndex: 1, category: "precondition", message: "Initial state absent" },
        ...(mixed ? [{ caseId: plan.cases[1].id, stepIndex: 2, category: "assertion" as const, message: "Incorrect result" }] : []),
      ], undefined, { timeoutMs: 1_000, preparationOnlyCaseIds: [plan.cases[0].id] });
    }
    assert.equal(bodies[0].messages[0].content, bodies[1].messages[0].content);
    for (const [index, body] of bodies.entries()) {
      const payload = JSON.parse(body.messages[1].content);
      assert.deepEqual(payload.preparationOnlyCaseIds, [`prepare-${index}`]);
      assert.deepEqual(payload.caseCorrectionIds, mixed ? [`business-${index}`] : []);
      assert.doesNotMatch(body.messages[0].content, /prepare-\d|business-\d/);
    }
  }
});

function behaviorFailures(): ProbeFailure[] {
  return [{ caseId: "save-profile", stepIndex: 3, category: "assertion", message: "expected Saved" }];
}
function correctedPlan(): unknown {
  return { packetId: "packet-profile", cases: [
    { id: "save-profile", requirementIds: ["REQ-PROFILE"], purpose: "happy_path",
      expectationBasis: ["Keep the profile after refresh."],
      steps: [{ op: "goto", path: "/" },
        { op: "click", locator: { by: "role", role: "button", name: "Save" } }],
      assertion: { op: "expectText", locator: { by: "role", role: "status" }, text: "Saved" } },
    { id: "refresh-profile", requirementIds: ["REQ-PROFILE"], purpose: "persistence",
      expectationBasis: ["Keep the profile after refresh."],
      steps: [{ op: "goto", path: "/" }, { op: "reload" }],
      assertion: { op: "expectValue", locator: { by: "label", text: "Profile name" }, value: "Ada" } },
  ] };
}
