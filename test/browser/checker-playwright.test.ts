import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { WebProgramRuntime, type WebRuntimeEvent } from "../../src/checker/adapters/web/program-runtime.js";

async function application(mutant: boolean, run: (runtime: WebProgramRuntime, events: WebRuntimeEvent[], browser: Awaited<ReturnType<typeof chromium.launch>>) => Promise<void>) {
  const server = createServer((request, response) => {
    if (request.url === "/export") {
      response.writeHead(200, { "content-type": "text/plain", "content-disposition": 'attachment; filename="export.txt"' });
      response.end("actual exported content"); return;
    }
    if (request.url === "/frame") { response.setHeader("content-type", "text/html"); response.end('<output role="status">frame ready</output>'); return; }
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><main>
      <button onclick="document.querySelector('input').click()">Import</button><input type="file" hidden multiple>
      <output role="status" aria-label="Import result">empty</output>
      <button onclick="${mutant ? "setTimeout(()=>document.querySelector('#export').click(),80)" : "void 0"}">Empty export</button>
      <a id="export" href="/export" download>Export</a><a href="/" target="_blank">Open page</a>
      <button onclick="document.querySelector('#dialog-result').textContent=prompt('Your name','initial')">Prompt</button>
      <output id="dialog-result" aria-label="Dialog result" role="status"></output>
      <section aria-label="First"><button>Duplicate</button></section><section aria-label="Second"><button>Duplicate</button></section>
      <canvas data-testid="drawing" width="100" height="100" style="display:block"></canvas>
      <textarea placeholder="Write here"></textarea><iframe title="Details" src="/frame"></iframe>
      <script>document.querySelector('input').onchange=async e=>{
        const f=e.target.files[0];if(!f)return;document.querySelector('[aria-label="Import result"]').textContent='ready: '+${mutant ? "'ignored'" : "f.name+':'+f.size+':'+await f.text()"};
      };document.querySelector('canvas').onpointerdown=e=>{const c=e.target.getContext('2d');c.fillStyle='rgb(255,0,0)';c.fillRect(0,0,100,100)};</script>
    </main>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const browser = await chromium.launch({ headless: true });
  const events: WebRuntimeEvent[] = [];
  const runtime = new WebProgramRuntime(browser, `http://127.0.0.1:${address.port}`, async event => { events.push(event); return `host-${events.length}`; }, [
    { clauseId: "chooser-opened", checkpointId: "chooser-result", expected: { operator: "relation", value: "filechooser" } },
    { clauseId: "imported", checkpointId: "import-result", expected: { operator: "contains", value: "sample.md:48:# hello" } },
    { clauseId: "no-download", checkpointId: "export-result", expected: { operator: "relation", value: 0 } },
  ], 2_000, [{ id: "import", kind: "action" }, { id: "empty-export", kind: "action" }, { id: "draw", kind: "action" }]);
  try { await run(runtime, events, browser); }
  finally {
    await runtime.close(); assert.equal(browser.contexts().length, 0); await browser.close();
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

const options = () => ({ signal: new AbortController().signal, timeoutMs: 15_000 });

for (const mutant of [false, true]) test(`Native Playwright filechooser and bounded absence evidence detect ${mutant ? "mutant" : "correct app"}`, async () => {
  await application(mutant, async (runtime, events) => {
    const result = await runtime.run(`
      const page=await browser.actor('alice');
      const chooserPromise=page.waitForEvent('filechooser');
      await check.action('import', async()=>{
        await page.getByRole('button',{name:'Import',exact:true}).click();
        const chooser=await chooserPromise;
        await check.expect('chooser-opened',[chooser.eventObservation.id],'(values,expected)=>values[0].event===expected');
        await chooser.setFiles({name:'sample.md',mimeType:'text/markdown',fixture:{kind:'text',bytes:48,text:'# hello'}});
      });
      await page.getByRole('status',{name:'Import result'}).filter({hasText:/ready:/}).waitFor();
      const imported=await page.getByRole('status',{name:'Import result'}).innerText();
      const importCheck=await check.expect('imported',[imported.id]);
      const observed=await page.observeEvents('download',{durationMs:200},()=>
        check.action('empty-export',()=>page.getByRole('button',{name:'Empty export'}).click()));
      const noDownload=await check.expect('no-download',[observed.id],'(values,expected)=>values[0].count===expected');
      return {imported:importCheck.passed,noDownload:noDownload.passed,count:observed.value.count};
    `, options());
    assert.deepEqual(result, { imported: !mutant, noDownload: !mutant, count: mutant ? 1 : 0 });
    const chooser = events.findIndex(e => e.payload.kind === "browser-event" && e.payload.event === "filechooser");
    const uploaded = events.find(e => e.payload.method === "playwright.filechooser.setFiles")!;
    assert.equal(uploaded.checkpointId, "import");
    assert.deepEqual(uploaded.inputs, [`host-${chooser + 1}`]);
    assert.deepEqual(uploaded.payload.files, [{ name: "sample.md", mimeType: "text/markdown", bytes: 48, fixture: { kind: "text", bytes: 48, text: "# hello" } }]);
    const absence = events.find(e => e.payload.kind === "browser-events")!;
    assert.equal(absence.inputs.length, 1);
    assert.equal(events[Number(absence.inputs[0]!.slice(5)) - 1]!.checkpointId, "empty-export");
    const window = absence.payload.value as { startedAt: number; actionCompletedAt: number; endedAt: number; durationMs: number };
    assert(window.endedAt - window.actionCompletedAt >= window.durationMs);
  });
});

test("Native locator composition, pointer, keyboard and event objects use actual Playwright", async () => {
  await application(false, async (runtime, events, browser) => {
    const result = await runtime.run(`
      const page=await browser.actor('alice');
      await page.getByRole('region',{name:'Second'}).getByRole('button',{name:'Duplicate'}).click();
      await page.locator('section').filter({has:page.getByRole('button',{name:'Duplicate'})}).filter({hasText:'Duplicate'}).count();
      await page.getByPlaceholder('Write here').fill('initial');
      await page.getByPlaceholder('Write here').press('End');
      await page.keyboard.insertText(' edited');
      const typed=await page.getByPlaceholder('Write here').inputValue();
      const box=await page.getByTestId('drawing').boundingBox();
      await check.action('draw',()=>page.mouse.click(box.value.x+10,box.value.y+10));
      const image=await page.getByTestId('drawing').image({samples:[{x:10,y:10}]});
      const pending=page.waitForEvent('download');await page.getByRole('link',{name:'Export',exact:true}).click();
      const download=await pending;const filename=await download.suggestedFilename();const content=await download.read();
      const popupPromise=page.waitForEvent('popup');await page.getByRole('link',{name:'Open page'}).click();
      const popup=await popupPromise;const popupText=await popup.getByRole('button',{name:'Import',exact:true}).innerText();
      const dialogPromise=page.waitForEvent('dialog');const clickPromise=page.getByRole('button',{name:'Prompt'}).click();
      const dialog=await dialogPromise;const message=await dialog.message();await dialog.accept('Alice');await clickPromise;
      const dialogResult=await page.getByRole('status',{name:'Dialog result'}).innerText();
      const framed=await page.frameLocator('iframe[title="Details"]').getByRole('status').innerText();
      const chooserPromise=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import',exact:true}).click();
      const chooser=await chooserPromise;await chooser.setFiles({name:'clear.txt',text:'before'});await chooser.setFiles([]);
      const uploadCount=await page.locator('input[type=file]').getAttribute('type');
      return {typed:typed.value,filename:filename.value,content:content.value,popup:popupText.value,dialog:message.value,answer:dialogResult.value,frame:framed.value,pixel:image.value.samples[0].rgba,event:chooser.eventObservation.value.event,fileInput:uploadCount.value};
    `, options());
    assert.deepEqual(result, { typed: "initial edited", filename: "export.txt", content: "actual exported content", popup: "Import", dialog: "Your name", answer: "Alice", frame: "frame ready", pixel: [255, 0, 0, 255], event: "filechooser", fileInput: "file" });
    assert(events.some(e => e.checkpointId === "draw" && e.payload.method === "playwright.mouse.click"));
    assert.equal(await browser.contexts()[0]!.pages()[0]!.locator('input[type=file]').evaluate((input: HTMLInputElement) => input.files!.length), 0);
  });
});

test("Native interface keeps strict locators, owned handles, file authority and host-only receipts", async () => {
  await application(false, async (runtime, events) => {
    const deny = async (source: string, pattern: RegExp) => assert.rejects(runtime.run(`const page=await browser.actor('alice');${source}`, options()), pattern);
    await deny("await page.getByRole('button',{name:'Duplicate'}).click();", /strict mode violation/);
    await deny("await page.getByRole('button',{name:'Duplicate'}).click({strict:false});", /strictness cannot be overridden/);
    await deny("await page.getByRole('button',{name:'Import'}).click({force:true});", /force and trial/);
    await deny("await page.getByRole('button',{name:'Import'}).click({trial:true});", /force and trial/);
    await deny("await check.action('unknown',()=>page.getByRole('button',{name:'Import'}).click());", /unknown contract checkpoint/);
    await deny("await page.goto('file:///private');", /authorized/);
    await deny("await page.goto('/source.js');", /authorized/);
    await deny("await page.getByRole('button').evaluate('()=>true');", /not a function/);
    await deny("await page.getByRole('button').first().click();", /not a function/);
    await deny("await page.waitForEvent('download',{predicate:()=>true});", /only accepts the timeout option/);
    await deny("await page.getByRole('button').filter({has:(await browser.actor('bob')).getByRole('button')}).count();", /same actor/);
    await deny("const pending=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import',exact:true}).click();await (await pending).setFiles('C:/private.txt');", /must be an object/);
    await deny("await page.observeEvents('download',{durationMs:10},async()=>{});", /requires a completed browser action/);
    await deny("await check.expect('imported',['forged']);", /unknown observations/);
    assert.equal(events.filter(e => e.kind === "assertion").length, 0);
    const result = await runtime.run(`const page=await browser.actor('alice');return [typeof page.evaluate,typeof page.context,typeof page.route,typeof page.getByRole('button').dispatchEvent,typeof page.read,typeof page.click,typeof page.frame,typeof page.download];`, options());
    assert.deepEqual(result, Array(8).fill("undefined"));
  });
});

test("The same interface verifies an inventory form workflow without application-specific actions", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><form>
      <label>SKU<input name="sku" required></label><label>Quantity<input name="quantity" type="number"></label>
      <label for="warehouse">Warehouse</label><select id="warehouse" name="warehouse"><option>South</option><option>North</option></select>
      <label>Active<input name="active" type="checkbox" checked></label><button>Save item</button></form>
      <ul aria-label="Inventory"></ul><script>
      const form=document.querySelector('form');
      function render(){const item=JSON.parse(localStorage.getItem('item')||'null');
        document.querySelector('ul').textContent='';if(!item)return;
        const row=document.createElement('li');row.textContent=[item.sku,item.warehouse,item.quantity,item.active?'active':'inactive'].join('|');
        const edit=document.createElement('button');edit.textContent='Edit '+item.sku;
        edit.onclick=()=>{form.elements.sku.value=item.sku;form.elements.quantity.value=item.quantity;form.elements.warehouse.value=item.warehouse;form.elements.active.checked=item.active};
        row.append(edit);document.querySelector('ul').append(row)}
      form.onsubmit=e=>{e.preventDefault();localStorage.setItem('item',JSON.stringify({sku:form.elements.sku.value,quantity:form.elements.quantity.value,warehouse:form.elements.warehouse.value,active:form.elements.active.checked}));render()};render();
      </script>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address === "object");
  const browser = await chromium.launch({ headless: true });
  const events: WebRuntimeEvent[] = [];
  const runtime = new WebProgramRuntime(browser, `http://127.0.0.1:${address.port}`, async event => { events.push(event); return `inventory-${events.length}`; }, [
    { clauseId: "persisted", checkpointId: "result", expected: { operator: "contains", value: "SKU-42|North|7|inactive" } },
  ], 2_000, [{ id: "create", kind: "action" }, { id: "edit", kind: "action" }]);
  try {
    const result = await runtime.run(`const page=await browser.actor('operator');
      await check.action('create',async()=>{
        await page.getByLabel('SKU',{exact:true}).fill('SKU-42');
        await page.getByLabel('Quantity',{exact:true}).fill('3');
        await page.getByLabel('Warehouse',{exact:true}).selectOption({label:'North'});
        await page.getByLabel('Active',{exact:true}).uncheck();
        await page.getByRole('button',{name:'Save item',exact:true}).click();
      });
      await check.action('edit',async()=>{
        await page.getByRole('button',{name:'Edit SKU-42',exact:true}).click();
        await page.getByLabel('Quantity',{exact:true}).fill('7');
        await page.getByRole('button',{name:'Save item',exact:true}).click();
      });
      await page.reload();
      const row=await page.getByRole('list',{name:'Inventory'}).getByRole('listitem').innerText();
      const count=await page.getByRole('listitem').count();
      const checked=await check.expect('persisted',[row.id]);return {passed:checked.passed,count:count.value};`, options());
    assert.deepEqual(result, { passed: true, count: 1 });
    assert(events.some(event => event.checkpointId === "create" && event.payload.method === "playwright.locator.selectOption"));
  } finally {
    await runtime.close(); await browser.close(); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
