import test from "node:test";
import assert from "node:assert/strict";
import { VisionCapability, PROBE_IMAGE_BASE64 } from "../src/builder/vision-probe.js";

const gateway = { baseUrl: "https://gateway.test/v1", model: "model-a", apiKey: "secret" };

function jsonResponse(status: number, error?: string): Response {
  return new Response(JSON.stringify(error ? { error: { message: error } } : { choices: [{ message: { content: "ok" } }] }), {
    status, headers: { "content-type": "application/json" },
  });
}

test("An accepted image request reports vision support", async () => {
  const bodies: string[] = [];
  const probe = new VisionCapability(gateway, async (_url, init) => {
    bodies.push(String(init?.body));
    return jsonResponse(200);
  });
  assert.equal(await probe.supports(), "supported");
  const body = JSON.parse(bodies[0]);
  assert.equal(body.model, "model-a");
  assert.deepEqual(body.messages[0].content.map((part: { type: string }) => part.type), ["text", "image_url"]);
  assert.equal(body.messages[0].content[1].image_url.url, `data:image/png;base64,${PROBE_IMAGE_BASE64}`);
  assert.equal(body.stream, false);
});

test("Only an explicit image rejection reports no vision", async () => {
  let calls = 0;
  const probe = new VisionCapability(gateway, async () => { calls += 1; return jsonResponse(400, "This model does not support image input"); });
  assert.equal(await probe.supports(), "unsupported");
  assert.equal(calls, 1);
  for (const status of [400, 401, 408, 429, 503]) {
    const uncertain = new VisionCapability(gateway, async () => jsonResponse(status, "request rejected"));
    assert.equal(await uncertain.supports(), "unknown", String(status));
  }
});

test("A transient gateway failure stays unknown and does not add probe retries", async () => {
  let calls = 0;
  const probe = new VisionCapability(gateway, async () => { calls += 1; return jsonResponse(503); });
  assert.equal(await probe.supports(), "unknown");
  assert.equal(await probe.supports(), "unknown");
  assert.equal(calls, 1);
});

test("A transport failure stays unknown and never escapes as an exception", async () => {
  let calls = 0;
  const probe = new VisionCapability(gateway, async () => {
    calls += 1;
    throw new Error("ECONNRESET");
  });
  assert.equal(await probe.supports(), "unknown");
  assert.equal(calls, 1);
});

test("One probe decides every later call in the run", async () => {
  let calls = 0;
  const probe = new VisionCapability(gateway, async () => { calls += 1; return jsonResponse(200); });
  await Promise.all([probe.supports(), probe.supports(), probe.supports()]);
  assert.equal(await probe.supports(), "supported");
  assert.equal(calls, 1);
});

test("The gateway credential never appears in a thrown probe error", async () => {
  const probe = new VisionCapability(gateway, async () => { throw new Error("boom"); });
  assert.equal(await probe.supports(), "unknown");
});

test("The probe respects a shorter Builder call window", async () => {
  let requests = 0;
  const probe = new VisionCapability(gateway, async (_url, init) => {
    requests += 1;
    await new Promise<void>(resolve => init?.signal?.addEventListener("abort", () => resolve(), { once: true }));
    throw new Error("aborted");
  }, 1_000);
  const started = Date.now();
  assert.equal(await probe.supports(20), "unknown");
  assert.equal(requests, 1);
  assert.ok(Date.now() - started < 500);
});
