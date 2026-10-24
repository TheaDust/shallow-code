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
        const initial = await alice.getByRole('status',{name:'Order O-17',exact:true}).innerText();
        const seatsBefore = await alice.getByRole('status',{name:'Train T-6 seats',exact:true}).innerText();
        await check.precondition('initial',[initial.id]);
        await check.action('cancel',()=>alice.getByRole('button',{name:'Cancel O-17',exact:true}).click());
        await check.action('refresh',()=>bob.reload());
        for (const [clause, locator] of [['status',bob.getByRole('status',{name:'Order O-17',exact:true})], ['seats',bob.getByRole('status',{name:'Train T-6 seats',exact:true})]]) {
          const observed = await locator.innerText(); await check.expect(clause,[observed.id]);
        }
        await check.action('refresh',()=>alice.reload()); const persisted = await alice.getByRole('status',{name:'Order O-17',exact:true}).innerText();
        await check.expect('persist',[persisted.id]);
        const seatsAfter = await alice.getByRole('status',{name:'Train T-6 seats',exact:true}).innerText();
        await check.expect('relation',[seatsBefore.id,seatsAfter.id],'(observations,expected)=>Number(observations[1])===Number(observations[0])+expected.delta');
      `, { signal: new AbortController().signal, timeoutMs: 15_000 });
      assert.deepEqual(events.filter((event) => event.kind === "assertion").map((event) => event.assertion), [
        { clauseId: "status", result: "satisfied" }, { clauseId: "seats", result: mutant ? "violated" : "satisfied" }, { clauseId: "persist", result: "satisfied" },
        { clauseId: "relation", result: mutant ? "violated" : "satisfied" },
      ]);
      assert.equal(events.find((event) => event.kind === "precondition")?.payload.result, "satisfied");
      assert.equal(browser.contexts().length, 2);
      await assert.rejects(runtime.run(`const p=await browser.actor('alice'); await p.getByRole('status').click();`, { signal: new AbortController().signal, timeoutMs: 5_000 }), /strict mode violation/);
      await assert.rejects(runtime.run(`await check.expect('status',['forged-id']);`, { signal: new AbortController().signal, timeoutMs: 5_000 }), /unknown observations/);
      await assert.rejects(runtime.run(`const p=await browser.actor('alice'); await p.goto('file:///C:/private');`, { signal: new AbortController().signal, timeoutMs: 5_000 }), /authorized/);
      await assert.rejects(runtime.run(`const p=await browser.actor('alice'); await p.goto('/source.js');`, { signal: new AbortController().signal, timeoutMs: 5_000 }), /authorized/);
      await assert.rejects(runtime.run(`const p=await browser.actor('alice'); const pending=p.waitForEvent('download');await p.getByRole('link',{name:'Download source',exact:true}).click();await (await pending).read();`, { signal: new AbortController().signal, timeoutMs: 5_000 }), /authorized UTF-8 business file/);
      const assertionsBefore = events.filter((event) => event.kind === "assertion").length;
      await assert.rejects(runtime.run(`const p=await browser.actor('alice'); const o=await p.getByRole('status',{name:'Train T-6 seats',exact:true}).innerText(); await check.expect('relation',[o.id],'()=>{while(true){}}');`, { signal: new AbortController().signal, timeoutMs: 5_000 }), /interrupt|timed out/);
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
        const framed = await page.frameLocator('iframe[name=details]').getByRole('status').innerText();
        const openedPending=page.waitForEvent('popup');await page.getByRole('link',{name:'Open order',exact:true}).click();const opened=await openedPending;
        const order = await opened.getByRole('status',{name:'Order O-17',exact:true}).innerText();
        const downloadPending=page.waitForEvent('download');await page.getByRole('link',{name:'Export order',exact:true}).click();const download=await (await downloadPending).read();
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
        const order=await p.getByRole('status',{name:'Order O-17',exact:true}).innerText();
        const seats=await p.getByRole('status',{name:'Train T-6 seats',exact:true}).innerText();
        const given=await check.precondition('given',[order.id,seats.id],
          '(values,expected)=>values[0]===expected.order && Number(values[1])===expected.seats');
        const hiddenRoles=await p.getByRole('textbox',{name:'Hidden editor',exact:true}).count();
        const retainedDom=await p.getByTestId('hidden-editor').count();
        const visible=await p.getByTestId('hidden-editor').isVisible();
        const ariaHiddenRoles=await p.getByRole('textbox',{name:'Aria hidden editor',exact:true}).count();
        const ariaHiddenVisible=await p.getByTestId('aria-hidden-editor').isVisible();
        return {passed:given.passed,roleCount:hiddenRoles.value,domCount:retainedDom.value,visible:visible.value,
          ariaHiddenRoleCount:ariaHiddenRoles.value,ariaHiddenVisible:ariaHiddenVisible.value};
      `, { signal: new AbortController().signal, timeoutMs: 5_000 });
      assert.deepEqual(result, { passed: true, roleCount: 0, domCount: 1, visible: false, ariaHiddenRoleCount: 0, ariaHiddenVisible: true });
      const given = events.find(event => event.kind === "precondition")!;
      assert.deepEqual(given.payload.actual, ["unpaid", "4"]);
      assert.equal(given.payload.result, "satisfied");
      for (const checkpoint of ["scalar", "pattern"]) await assert.rejects(runtime.run(`
        const p=await browser.actor('alice');
        const order=await p.getByRole('status',{name:'Order O-17',exact:true}).innerText();
        const seats=await p.getByRole('status',{name:'Train T-6 seats',exact:true}).innerText();
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
      const count = await page.getByRole('listitem').count();
      const state = await page.getByRole('status',{name:'status',exact:true}).getAttribute('data-state');
      const color = await page.getByRole('status',{name:'status',exact:true}).computedStyle('color');
      await page.clipboard.writeText('North\\t800');
      const clipboard = await page.clipboard.readText();
      await page.getByLabel('Name',{exact:true}).focus(); await page.getByLabel('Name',{exact:true}).fill('Ada'); await page.getByLabel('Name',{exact:true}).blur();
      await page.getByLabel('Enabled',{exact:true}).setChecked(false); await page.getByLabel('Enabled',{exact:true}).setChecked(true);
      await page.getByLabel('Tags',{exact:true}).selectOption(['a','b']);
      await page.getByLabel('Import file',{exact:true}).setInputFiles([{name:'notes.txt',mimeType:'text/plain',text:'uploaded'}]);
      await page.getByRole('button',{name:'Hover target',exact:true}).hover();
      await page.getByRole('button',{name:'Double target',exact:true}).dblclick();
      await page.getByRole('button',{name:'Context target',exact:true}).click({button:"right"});
      await page.getByRole('listitem',{name:'A',exact:true}).dragTo(page.getByRole('listitem',{name:'B',exact:true}));
      await page.mouse.wheel(0, 200);
      await page.getByRole('status',{name:'status',exact:true}).waitFor({state:'visible'});
      const binaryPending=page.waitForEvent('download');await page.getByRole('link',{name:'Binary',exact:true}).click();const binary=await (await binaryPending).read('base64');
      return {url:url.value, count:count.value, state:state.value, color:color.value, clipboard:clipboard.value, binary:binary.value};
    `, { signal: new AbortController().signal, timeoutMs: 15_000 });
    assert.deepEqual(result, { url: `http://127.0.0.1:${address.port}/workspace?run=1`, count: 2, state: "ready", color: "rgb(1, 2, 3)", clipboard: "North\t800", binary: "AAEC/w==" });
    const methods = events.filter((event) => event.kind === "action").map((event) => event.payload.method);
    for (const method of ["playwright.page.goto", "clipboardWrite", "playwright.locator.focus", "playwright.locator.fill", "playwright.locator.blur", "playwright.locator.setChecked", "playwright.locator.selectOption", "playwright.locator.setInputFiles", "playwright.locator.hover", "playwright.locator.dblclick", "playwright.locator.click", "playwright.locator.dragTo", "playwright.mouse.wheel"]) assert.ok(methods.includes(method), method);
    const upload = events.find((event) => event.kind === "action" && event.payload.method === "playwright.locator.setInputFiles");
    assert.deepEqual(upload?.payload.files, [{ name: "notes.txt", bytes: 8, mimeType: "text/plain" }]);
    assert.equal(JSON.stringify(upload?.payload).includes("uploaded"), false);
  } finally {
    await runtime.close(); await browser.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("download filenames are independent observations and reject a wrong expected name", async () => {
  await application(false, async baseUrl => {
    const browser = await chromium.launch({ headless: true });
    const events: WebRuntimeEvent[] = [];
    const runtime = new WebProgramRuntime(browser, baseUrl, async event => { events.push(event); return `host-${events.length}`; }, [
      { clauseId: "filename", checkpointId: "name-result", expected: { operator: "equal", value: "orders.txt" } },
      { clauseId: "wrong-name", checkpointId: "wrong-result", expected: { operator: "equal", value: "other.txt" } },
    ]);
    try {
      const result = await runtime.run(`
        const page = await browser.actor('alice');
        const downloadPending=page.waitForEvent('download');await page.getByRole('link',{name:'Export order',exact:true}).click();const download=await (await downloadPending).read();
        await check.expect('filename',[download.filename.id]);
        await check.expect('wrong-name',[download.filename.id]);
        return {name:download.filename.value,content:download.value};
      `, { signal: new AbortController().signal, timeoutMs: 10_000 });
      assert.deepEqual(result, { name: "orders.txt", content: "Order O-17: unpaid" });
      assert.deepEqual(events.filter(event => event.kind === "assertion").map(event => event.assertion!.result), ["satisfied", "violated"]);
    } finally { await runtime.close(); await browser.close(); }
  });
});

test("host fixtures supply real oversized files, narrow viewports and isolated storage quota", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><input type="file" aria-label="Import"><output role="status"></output>
      <script>localStorage.setItem('existing','keep');document.querySelector('input').onchange=event=>{
        const file=event.target.files[0];document.querySelector('output').textContent=JSON.stringify({name:file.name,size:file.size,type:file.type});
      };</script>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address === "object");
  const browser = await chromium.launch({ headless: true });
  const events: WebRuntimeEvent[] = [];
  const runtime = new WebProgramRuntime(browser, `http://127.0.0.1:${address.port}`, async event => { events.push(event); return `host-${events.length}`; });
  try {
    const result = await runtime.run(`
      const page = await browser.actor('alice');
      await page.setViewportSize({width:375,height:700});
      const viewport = await page.viewport();
      await page.getByLabel('Import',{exact:true}).setInputFiles([{name:'oversized.png',fixture:{kind:'png',bytes:6*1024*1024}}]);
      const file = await page.getByRole('status').innerText();
      return {viewport:viewport.value,file:JSON.parse(file.value)};
    `, { signal: new AbortController().signal, timeoutMs: 10_000 });
    assert.deepEqual(result, { viewport: { width: 375, height: 700, scrollWidth: 375, scrollHeight: 700 }, file: { name: "oversized.png", size: 6 * 1024 * 1024, type: "image/png" } });
    const page = browser.contexts()[0]!.pages()[0]!;
    assert.deepEqual(await page.evaluate(async () => {
      const file = document.querySelector('input')!.files![0]!;
      const bitmap = await createImageBitmap(file);
      return { width: bitmap.width, height: bitmap.height };
    }), { width: 1, height: 1 }, "generated >5 MB input must decode as an actual image");
    await runtime.run(String.raw`const page=await browser.actor('alice'); await page.getByLabel('Import',{exact:true}).setInputFiles([{name:'large.md',mimeType:'text/markdown',fixture:{kind:'text',bytes:6*1024*1024,text:'# Test\n'}}]);`, { signal: new AbortController().signal, timeoutMs: 10_000 });
    assert.equal(await page.evaluate(async () => (await document.querySelector('input')!.files![0]!.text()).length), 6 * 1024 * 1024);
    const quota = await runtime.run(`const page=await browser.actor('alice'); return (await page.storage.fill(16*1024*1024)).value;`, { signal: new AbortController().signal, timeoutMs: 10_000 }) as { quotaExceeded: boolean; writtenBytes: number };
    assert.equal(quota.quotaExceeded, true); assert(quota.writtenBytes > 0);
    assert.equal(await page.evaluate(() => localStorage.getItem('existing')), "keep");
    await runtime.run(`await browser.actor('bob');`, { signal: new AbortController().signal, timeoutMs: 10_000 });
    assert.equal(await browser.contexts()[1]!.pages()[0]!.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('checker-fixture:'))), false);
    assert(JSON.stringify(events).length < 10_000, "large fixture contents never enter receipts or QuickJS output");
    await assert.rejects(runtime.run(`const p=await browser.actor('alice'); await p.getByLabel('Import',{exact:true}).setInputFiles([{name:'bad.png',text:'fake',fixture:{kind:'png',bytes:128}}]);`, { signal: new AbortController().signal, timeoutMs: 5_000 }), /exactly one/);
    await assert.rejects(runtime.run(`const p=await browser.actor('alice'); await p.getByLabel('Import',{exact:true}).setInputFiles([{name:'bad.png',fixture:{kind:'png',bytes:9*1024*1024}}]);`, { signal: new AbortController().signal, timeoutMs: 5_000 }), /8 MiB/);
  } finally {
    await runtime.close(); await browser.close(); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
