import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { WebProgramRuntime, type WebRuntimeEvent } from "../../src/checker/adapters/web/program-runtime.js";

async function application(mutant: boolean, run: (url: string) => Promise<void>): Promise<void> {
  let cancelled = false;
  let seats = 4;
  const server = createServer((request, response) => {
    if (request.url === "/source.js") { response.setHeader("content-type", "text/plain"); response.end("PRIVATE APPLICATION SOURCE"); return; }
    if (request.url === "/source-download") { response.writeHead(200, { "content-type": "text/plain", "content-disposition": 'attachment; filename="source.js"' }); response.end("PRIVATE APPLICATION SOURCE"); return; }
    if (request.url?.startsWith("/cancel")) { cancelled = true; if (!mutant) seats = 5; response.writeHead(302, { location: "/" }); response.end(); return; }
    if (request.url === "/download") { response.writeHead(200, { "content-type": "text/plain", "content-disposition": 'attachment; filename="orders.txt"' }); response.end(`Order O-17: ${cancelled ? "cancelled" : "unpaid"}`); return; }
    response.setHeader("content-type", "text/html");
    if (request.url === "/frame") { response.end('<output role="status">frame-ready</output>'); return; }
    response.end(`<main><output role="status" aria-label="Order O-17">${cancelled ? "cancelled" : "unpaid"}</output>
      <output role="status" aria-label="Train T-6 seats">${seats}</output>
      <form action="/cancel"><button>Cancel O-17</button></form>
      <a href="/" target="_blank">Open order</a><a href="/download" download>Export order</a>
      <a href="/source.js">Source</a><a href="/source-download" download>Download source</a>
      <iframe name="details" src="/frame"></iframe></main>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

for (const mutant of [false, true]) test(`Checker executes two actors, linked results and refresh against ${mutant ? "seat mutant" : "correct application"}`, async () => {
  await application(mutant, async (baseUrl) => {
    const browser = await chromium.launch({ headless: true });
    const events: WebRuntimeEvent[] = [];
    const runtime = new WebProgramRuntime(browser, baseUrl, async (event) => { events.push(event); return `host-${events.length}`; }, [
      { clauseId: "status", checkpointId: "status-result", expected: { operator: "equal", value: "cancelled" } },
      { clauseId: "seats", checkpointId: "seats-result", expected: { operator: "equal", value: "5" } },
      { clauseId: "persist", checkpointId: "persist-result", expected: { operator: "equal", value: "cancelled" } },
      { clauseId: "relation", checkpointId: "relation-result", expected: { operator: "relation", value: { delta: 1 } } },
    ], 5_000, [
      { id: "initial", kind: "precondition", expected: { operator: "equal", value: "unpaid" } },
      { id: "cancel", kind: "action" }, { id: "refresh", kind: "action" },
    ]);
    try {
      await runtime.run(`
        const alice = await browser.actor('alice'); const bob = await browser.actor('bob');
        const initial = await alice.read({role:'status',name:'Order O-17'});
        const seatsBefore = await alice.read({role:'status',name:'Train T-6 seats'});
        await check.precondition('initial',[initial.id]);
        await alice.click({role:'button',name:'Cancel O-17'},'cancel');
        await bob.reload('refresh');
        for (const [clause, locator] of [['status',{role:'status',name:'Order O-17'}], ['seats',{role:'status',name:'Train T-6 seats'}]]) {
          const observed = await bob.read(locator); await check.expect(clause,[observed.id]);
        }
        await alice.reload('refresh'); const persisted = await alice.read({role:'status',name:'Order O-17'});
        await check.expect('persist',[persisted.id]);
        const seatsAfter = await alice.read({role:'status',name:'Train T-6 seats'});
        await check.expect('relation',[seatsBefore.id,seatsAfter.id],'(observations,expected)=>Number(observations[1])===Number(observations[0])+expected.delta');
      `, { signal: new AbortController().signal, timeoutMs: 15_000 });
      assert.deepEqual(events.filter((event) => event.kind === "assertion").map((event) => event.assertion), [
        { clauseId: "status", result: "satisfied" }, { clauseId: "seats", result: mutant ? "violated" : "satisfied" }, { clauseId: "persist", result: "satisfied" },
        { clauseId: "relation", result: mutant ? "violated" : "satisfied" },
      ]);
      assert.equal(events.find((event) => event.kind === "precondition")?.payload.result, "satisfied");
      assert.equal(browser.contexts().length, 2);
      await assert.rejects(runtime.run(`const p=await browser.actor('alice'); await p.click({role:'status'});`, { signal: new AbortController().signal, timeoutMs: 5_000 }), /exactly one/);
      await assert.rejects(runtime.run(`await check.expect('status',['forged-id']);`, { signal: new AbortController().signal, timeoutMs: 5_000 }), /unknown observations/);
      await assert.rejects(runtime.run(`const p=await browser.actor('alice'); await p.goto('file:///C:/private');`, { signal: new AbortController().signal, timeoutMs: 5_000 }), /authorized/);
      await assert.rejects(runtime.run(`const p=await browser.actor('alice'); await p.goto('/source.js');`, { signal: new AbortController().signal, timeoutMs: 5_000 }), /authorized/);
      await assert.rejects(runtime.run(`const p=await browser.actor('alice'); await p.download({role:'link',name:'Download source'});`, { signal: new AbortController().signal, timeoutMs: 5_000 }), /authorized UTF-8 business file/);
      const assertionsBefore = events.filter((event) => event.kind === "assertion").length;
      await assert.rejects(runtime.run(`const p=await browser.actor('alice'); const o=await p.read({role:'status',name:'Train T-6 seats'}); await check.expect('relation',[o.id],'()=>{while(true){}}');`, { signal: new AbortController().signal, timeoutMs: 5_000 }), /interrupt|timed out/);
      assert.equal(events.filter((event) => event.kind === "assertion").length, assertionsBefore);
    } finally { await runtime.close(); assert.equal(browser.contexts().length, 0); await browser.close(); }
  });
});

test("Checker proxy reads named frames, new windows and actual download content", async () => {
  await application(false, async (baseUrl) => {
    const browser = await chromium.launch({ headless: true });
    const events: WebRuntimeEvent[] = [];
    const runtime = new WebProgramRuntime(browser, baseUrl, async (event) => { events.push(event); return `host-${events.length}`; });
    try {
      const result = await runtime.run(`
        const page = await browser.actor('alice');
        const framed = await page.frame('details').read({role:'status'});
        const opened = await page.popup({role:'link',name:'Open order'});
        const order = await opened.read({role:'status',name:'Order O-17'});
        const download = await page.download({role:'link',name:'Export order'});
        return [framed.value,order.value,download.value];
      `, { signal: new AbortController().signal, timeoutMs: 15_000 });
      assert.deepEqual(result, ["frame-ready", "unpaid", "Order O-17: unpaid"]);
      assert.ok(events.some((event) => event.kind === "observation" && event.payload.kind === "download"));
    } finally { await runtime.close(); await browser.close(); }
  });
});
