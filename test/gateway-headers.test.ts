import assert from "node:assert/strict";
import { test } from "node:test";

import { opencodeSessionHeaders } from "../src/gateway-headers.js";

test("opencode 网关附带 x-opencode-session，其他网关不附加", () => {
  assert.deepEqual(opencodeSessionHeaders("https://opencode.ai/zen/go/v1", "session-1"), {
    "x-opencode-session": "session-1",
  });
  assert.deepEqual(opencodeSessionHeaders("https://www.opencode.ai/zen/v1", "session-1"), {
    "x-opencode-session": "session-1",
  });
  assert.deepEqual(opencodeSessionHeaders("https://gateway.example/v1", "session-1"), {});
  assert.deepEqual(opencodeSessionHeaders("https://opencode.ai.evil.example/v1", "session-1"), {});
  assert.deepEqual(opencodeSessionHeaders("not a url", "session-1"), {});
});
