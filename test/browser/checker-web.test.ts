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
      <iframe name="details" src="/frame"></iframe>
      <textarea aria-label="Hidden editor" data-testid="hidden-editor" hidden>draft</textarea>
      <textarea aria-label="Aria hidden editor" data-testid="aria-hidden-editor" aria-hidden="true">draft</textarea></main>`);
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
      await assert.rejects(runtime.run(`const p=await browser.actor('alice'); await p.read({role:'status',name:'Order O-17',exact:true});`, { signal: new AbortController().signal, timeoutMs: 5_000 }), /Locator field is not allowed/);
      await assert.rejects(runtime.run(`const p=await browser.actor('alice'); await p.read({label:'Order O-17',name:'ignored'});`, { signal: new AbortController().signal, timeoutMs: 5_000 }), /Locator field is not allowed/);
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

test("Checker supports relational GIVEN checks and role counts that exclude retained hidden DOM", async () => {
  await application(false, async baseUrl => {
    const browser = await chromium.launch({ headless: true });
    const events: WebRuntimeEvent[] = [];
    const runtime = new WebProgramRuntime(browser, baseUrl, async event => { events.push(event); return `host-${events.length}`; }, [], 5_000, [
      { id: "given", kind: "precondition", expected: { operator: "relation", value: { order: "unpaid", seats: 4 } } },
      { id: "scalar", kind: "precondition", expected: { operator: "equal", value: "unpaid" } },
      { id: "pattern", kind: "precondition", expected: { operator: "match", value: "unpaid" } },
    ]);
    try {
      const result = await runtime.run(`
        const p=await browser.actor('alice');
        const order=await p.read({role:'status',name:'Order O-17'});
        const seats=await p.read({role:'status',name:'Train T-6 seats'});
        const given=await check.precondition('given',[order.id,seats.id],
          '(values,expected)=>values[0]===expected.order && Number(values[1])===expected.seats');
        const hiddenRoles=await p.count({role:'textbox',name:'Hidden editor'});
        const retainedDom=await p.count({testId:'hidden-editor'});
        const visible=await p.read({testId:'hidden-editor'},'visible');
        const ariaHiddenRoles=await p.count({role:'textbox',name:'Aria hidden editor'});
        const ariaHiddenVisible=await p.read({testId:'aria-hidden-editor'},'visible');
        return {passed:given.passed,roleCount:hiddenRoles.value,domCount:retainedDom.value,visible:visible.value,
          ariaHiddenRoleCount:ariaHiddenRoles.value,ariaHiddenVisible:ariaHiddenVisible.value};
      `, { signal: new AbortController().signal, timeoutMs: 5_000 });
      assert.deepEqual(result, { passed: true, roleCount: 0, domCount: 1, visible: false, ariaHiddenRoleCount: 0, ariaHiddenVisible: true });
      const given = events.find(event => event.kind === "precondition")!;
      assert.deepEqual(given.payload.actual, ["unpaid", "4"]);
      assert.equal(given.payload.result, "satisfied");
      for (const checkpoint of ["scalar", "pattern"]) await assert.rejects(runtime.run(`
        const p=await browser.actor('alice');
        const order=await p.read({role:'status',name:'Order O-17'});
        const seats=await p.read({role:'status',name:'Train T-6 seats'});
        await check.precondition('${checkpoint}',[order.id,seats.id]);
      `, { signal: new AbortController().signal, timeoutMs: 5_000 }), /requires one observation/);
      assert.equal(events.filter(event => event.kind === "precondition").length, 1, "invalid test wiring does not emit a business violation");
    } finally { await runtime.close(); await browser.close(); }
  });
});

test("Checker Web runtime covers common input, pointer and observation operations", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/binary") {
      response.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="blob.bin"' });
      response.end(Buffer.from([0, 1, 2, 255]));
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><style>#status { color: rgb(1, 2, 3); }</style>
      <main><output id="status" role="status" aria-label="status" data-state="ready">ready</output>
      <label>Name<input aria-label="Name"></label>
      <label>Enabled<input type="checkbox" aria-label="Enabled" checked></label>
      <label>Tags<select aria-label="Tags" multiple><option value="a">A</option><option value="b">B</option></select></label>
      <label>Import file<input type="file" aria-label="Import file"></label>
      <button id="hover">Hover target</button><button id="double">Double target</button><button id="context">Context target</button>
      <ul><li role="listitem" aria-label="A" draggable="true">A</li><li role="listitem" aria-label="B" draggable="true">B</li></ul>
      <a href="/binary" download>Binary</a></main>
      <script>
        const status=document.querySelector('#status');
        document.querySelector('#hover').addEventListener('mouseenter',()=>status.textContent='hovered');
        document.querySelector('#double').addEventListener('dblclick',()=>status.textContent='double');
        document.querySelector('#context').addEventListener('contextmenu',event=>{event.preventDefault();status.textContent='context';});
        document.querySelector('[aria-label="Name"]').addEventListener('blur',()=>status.textContent='blurred');
        document.querySelector('[aria-label="Import file"]').addEventListener('change',event=>event.target.files[0]?.text().then(text=>status.textContent=text));
        for (const item of document.querySelectorAll('[role="listitem"]')) item.addEventListener('dragend',()=>status.textContent='dragged');
      </script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const browser = await chromium.launch({ headless: true });
  const events: WebRuntimeEvent[] = [];
  const runtime = new WebProgramRuntime(browser, `http://127.0.0.1:${address.port}`, async (event) => { events.push(event); return `host-${events.length}`; });
  try {
    const result = await runtime.run(`
      const page = await browser.actor('alice');
      await page.goto('/workspace?run=1');
      const url = await page.url();
      const count = await page.count({role:'listitem'});
      const state = await page.attribute({role:'status',name:'status'}, 'data-state');
      const color = await page.style({role:'status',name:'status'}, 'color');
      await page.clipboard.writeText('North\\t800');
      const clipboard = await page.clipboard.readText();
      await page.focus({label:'Name'}); await page.fill({label:'Name'}, 'Ada'); await page.blur({label:'Name'});
      await page.setChecked({label:'Enabled'}, false); await page.setChecked({label:'Enabled'}, true);
      await page.select({label:'Tags'}, ['a','b']);
      await page.upload({label:'Import file'}, [{name:'notes.txt',mimeType:'text/plain',text:'uploaded'}]);
      await page.hover({role:'button',name:'Hover target'});
      await page.doubleClick({role:'button',name:'Double target'});
      await page.rightClick({role:'button',name:'Context target'});
      await page.dragTo({role:'listitem',name:'A'}, {role:'listitem',name:'B'});
      await page.scroll(0, 200);
      await page.waitFor({role:'status',name:'status'}, 'visible');
      const binary = await page.download({role:'link',name:'Binary'}, undefined, 'base64');
      return {url:url.value, count:count.value, state:state.value, color:color.value, clipboard:clipboard.value, binary:binary.value};
    `, { signal: new AbortController().signal, timeoutMs: 15_000 });
    assert.deepEqual(result, { url: `http://127.0.0.1:${address.port}/workspace?run=1`, count: 2, state: "ready", color: "rgb(1, 2, 3)", clipboard: "North\t800", binary: "AAEC/w==" });
    const methods = events.filter((event) => event.kind === "action").map((event) => event.payload.method);
    for (const method of ["goto", "clipboardWrite", "focus", "fill", "blur", "setChecked", "select", "upload", "hover", "doubleClick", "rightClick", "dragTo", "scroll", "waitFor", "download"]) assert.ok(methods.includes(method), method);
    const upload = events.find((event) => event.kind === "action" && event.payload.method === "upload");
    assert.deepEqual(upload?.payload.files, [{ name: "notes.txt", bytes: 8, mimeType: "text/plain" }]);
    assert.equal(JSON.stringify(upload?.payload).includes("uploaded"), false);
  } finally {
    await runtime.close(); await browser.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
