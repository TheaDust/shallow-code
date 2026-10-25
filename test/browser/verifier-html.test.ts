import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { WebProgramRuntime, type WebRuntimeEvent } from "../../src/verifier/adapters/web/program-runtime.js";
import { renderHtml } from "../../src/verifier/adapters/web/html-renderer.js";
import { renderOptions } from "../../src/verifier/adapters/web/binary-renderer.js";

for (const mutant of [false, true]) test(`Downloaded HTML renders actual styles and ${mutant ? "rejects a style mutant" : "accepts expected content"} without application authority`, { timeout: 30_000 }, async () => {
  let forbiddenRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === "/receipt") {
      response.writeHead(200, { "content-type": "text/html", "content-disposition": 'attachment; filename="receipt.htm"' });
      response.end(`<!doctype html><style>body{margin:0;background:rgb(230,240,250)}h1{color:${mutant ? "rgb(200,0,0)" : "rgb(12,34,56)"}}</style>
        <link rel="stylesheet" href="/private-style"><h1>Receipt 42</h1><p>Approved</p>
        <img src="${origin}/private-image"><iframe src="${origin}/private-frame"></iframe>
        <script>document.querySelector('h1').textContent='SCRIPT RAN';fetch('${origin}/private-write');</script>`);
      return;
    }
    if (request.url?.startsWith("/private")) forbiddenRequests++;
    response.setHeader("content-type", "text/html");
    response.end('<style>body{background:black;color:white}</style><a download href="/receipt">Download receipt</a>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true });
  const events: WebRuntimeEvent[] = [];
  const runtime = new WebProgramRuntime(browser, origin, async event => { events.push(event); return `host-${events.length}`; }, [
    { clauseId: "content", checkpointId: "result", expected: { operator: "relation", value: "Receipt 42" } },
  ]);
  try {
    const sourceId = await runtime.run(`const p=await browser.actor('reader');
      const pending=p.waitForEvent('download');await p.getByRole('link',{name:'Download receipt',exact:true}).click();
      const file=await(await pending).read('base64');
      const result=await p.render(file.id,{selectors:['body','h1'],samples:[{x:0,y:0}]});
      await check.expect('content',[result.id], '(values,expected)=>values[0].format==="html" && values[0].text.includes(expected) && values[0].elements[1].visible && values[0].elements[1].color==="rgb(12, 34, 56)" && values[0].samples[0].rgba[0]===230');
      return file.id;`, { signal: new AbortController().signal, timeoutMs: 15_000 }) as string;
    assert.equal(events.find(event => event.kind === "assertion")?.assertion?.result, mutant ? "violated" : "satisfied");
    const rendered = events.find(event => event.payload.kind === "rendered-content")!;
    assert.deepEqual(rendered.inputs, [sourceId]);
    assert(rendered.attachments![0]!.bytes.length > 100);
    const value = rendered.payload.value as { text: string; restrictions: string[]; elements: Array<{ text: string; backgroundColor: string }> };
    assert(!value.text.includes("SCRIPT RAN"));
    assert.equal(value.elements[0]!.backgroundColor, "rgb(230, 240, 250)");
    assert.deepEqual(value.restrictions, ["scripts-disabled", "external-resources-blocked"]);
    assert.equal(forbiddenRequests, 0);
    assert.equal(browser.contexts().length, 1, "render context is disposed before returning evidence");
    await assert.rejects(runtime.run(`const p=await browser.actor('other');await p.render(${JSON.stringify(sourceId)});`, { signal: new AbortController().signal, timeoutMs: 5000 }), /this actor and window/);
    await assert.rejects(runtime.run(`const p=await browser.actor('reader');await p.goto('data:text/html,forged');`, { signal: new AbortController().signal, timeoutMs: 5000 }), /authorized application surface/);
    await assert.rejects(runtime.run(`const p=await browser.actor('reader');await p.render(${JSON.stringify(sourceId)},{selectors:['p, h1']});`, { signal: new AbortController().signal, timeoutMs: 5000 }), /exactly one/);
    assert.equal(browser.contexts().length, 2, "failed render also disposes its context");
  } finally {
    await runtime.close(); await browser.close(); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("HTML rendering bounds selectors and dimensions, supports embedded images, and closes on cancellation", { timeout: 30_000 }, async () => {
  for (const selectors of [[""], Array(33).fill("body"), ["x".repeat(513)]]) assert.throws(() => renderOptions({ selectors }), /selectors/);
  const browser = await chromium.launch({ headless: true });
  try {
    const html = Buffer.from('<style>body{margin:0}</style><img width="20" height="20" src="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'20\' height=\'20\'%3E%3Cpath fill=\'red\' d=\'M0 0h20v20H0z\'/%3E%3C/svg%3E">');
    const image = await renderHtml(browser, html, { samples: [{ x: 1, y: 1 }] }, new AbortController().signal);
    assert.deepEqual(image.value.samples[0]!.rgba, [255, 0, 0, 255]);
    await assert.rejects(renderHtml(browser, Buffer.from('<div style="height:5000px">long</div>'), {}, new AbortController().signal), /dimensions/);
    assert.equal(browser.contexts().length, 0);
    const controller = new AbortController();
    const pending = renderHtml(browser, html, {}, controller.signal);
    controller.abort(new Error("stop-render"));
    await assert.rejects(pending);
    assert.equal(browser.contexts().length, 0);
  } finally { await browser.close(); }
});
