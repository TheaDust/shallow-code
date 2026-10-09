import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_CONTEXT_WINDOW, piProviderModel } from "../src/builder/pi-model-config.js";

test("gateway provider model keeps the default window unless a run overrides it", () => {
  assert.equal(DEFAULT_CONTEXT_WINDOW, 256_000);
  const fallback = piProviderModel("provider/model");
  assert.equal(fallback.id, "provider/model");
  assert.equal(fallback.contextWindow, 256_000);
  assert.equal(fallback.maxTokens, 65_536);
  assert.deepEqual(fallback.input, ["text", "image"]);
  assert.equal(piProviderModel("provider/model", 256_000).contextWindow, 256_000);
});
