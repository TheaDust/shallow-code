import assert from "node:assert/strict";
import { test } from "node:test";

import { closeSharedBrowser, createBrowserTool } from "../../src/builder/pi-browser-tool.js";

test("browser tool opens a page, runs the script, and captures console errors", { timeout: 90_000 }, async () => {
  const tool = createBrowserTool();
  try {
    const result = await tool.execute(
      "call-1",
      {
        url: "data:text/html,<title>probe-page</title><body><h1>Hello browser</h1><script>console.error('boom')</script></body>",
        code: "return await page.title();",
      },
      undefined,
      undefined,
      {} as never,
    );
    const text = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
    const payload = JSON.parse(text) as { title: string; consoleErrors: string[]; result: string; pageText: string };
    assert.equal(payload.title, "probe-page");
    assert.equal(payload.result, '"probe-page"');
    assert.ok(payload.pageText.includes("Hello browser"));
    assert.ok(payload.consoleErrors.some(error => error.includes("boom")));
    assert.equal((result.details as { consoleErrorCount: number }).consoleErrorCount, 1);
  } finally {
    await closeSharedBrowser();
  }
});

test("browser tool surfaces script failures", { timeout: 90_000 }, async () => {
  const tool = createBrowserTool();
  try {
    await assert.rejects(tool.execute("call-2", { url: "data:text/html,<button>Save</button>", code: "throw new Error('script boom');" }, undefined, undefined, {} as never), (error: Error) => {
      const payload = JSON.parse(error.message);
      assert.equal(payload.ok, false);
      assert.match(payload.error, /script boom/);
      assert.match(payload.accessibility, /button "Save"/);
      return true;
    });
  } finally {
    await closeSharedBrowser();
  }
});

test("browser returns explicit observations, assertions and optional images without lingering timers", async () => {
  const tool = createBrowserTool();
  try {
    const timers = process.getActiveResourcesInfo().filter(r => r === "Timeout").length;
    const result = await tool.execute("observations", {
      url: "data:text/html,<button onclick=\"this.textContent='Saved'\">Save</button>", screenshot: true,
      code: "await page.getByRole('button', {name:'Save', exact:true}).click(); await expect(page.getByRole('button')).toHaveText('Saved'); return 'checked';",
    }, undefined, undefined, {} as never);
    const payload = JSON.parse(result.content.filter(p => p.type === "text").map(p => p.text).join(""));
    assert.equal(payload.ok, true);
    assert.equal(payload.result, '"checked"');
    assert.match(payload.accessibility, /Saved/);
    assert.ok(result.content.some(p => p.type === "image" && p.mimeType === "image/jpeg"));
    const empty = await tool.execute("empty", { url: "about:blank", code: "async () => { return 'never executed'; }" }, undefined, undefined, {} as never);
    assert.match(empty.content.filter(p => p.type === "text").map(p => p.text).join(""), /returned no observation/);
    await closeSharedBrowser();
    assert.ok(process.getActiveResourcesInfo().filter(r => r === "Timeout").length <= timers);
  } finally { await closeSharedBrowser(); }
});
