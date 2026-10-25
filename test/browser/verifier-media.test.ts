import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { WebProgramRuntime, type WebRuntimeEvent } from "../../src/verifier/adapters/web/program-runtime.js";
import { mediaPdf, mediaPng } from "../helpers/verifier-media.js";

async function withMediaApplication(mutant: boolean, run: (url: string) => Promise<void>) {
  const server = createServer((request, response) => {
    if (request.url === "/export.pdf" || request.url === "/export.png") {
      const pdf = request.url.endsWith("pdf");
      response.writeHead(200, { "content-type": pdf ? "application/pdf" : "image/png", "content-disposition": `attachment; filename="export.${pdf ? "pdf" : "png"}"` });
      response.end(pdf ? mediaPdf(mutant ? "WRONG CONTENT" : "EXPECTED EXPORT") : mediaPng(mutant ? "WRONG CONTENT" : "EXPECTED EXPORT")); return;
    }
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><main>
      <div role="textbox" aria-label="Editor" contenteditable tabindex="0">Paste here</div><output role="status" aria-label="Paste result"></output>
      <div data-testid="drop" role="button" aria-label="Drop files">Drop here</div><output role="status" aria-label="Drop result"></output>
      <label>Directory<input type="file" webkitdirectory multiple></label><button>Read directory</button><output role="status" aria-label="Directory result"></output>
      <canvas aria-label="Rendered preview" width="800" height="120"></canvas>
      <a href="/export.pdf" download>PDF export</a><a href="/export.png" download>Image export</a></main>
      <script>
      const output=name=>document.querySelector('[aria-label="'+name+'"]');
      output('Editor').addEventListener('paste',async event=>{event.preventDefault();const file=event.clipboardData.files[0];
        if(!file){output('Paste result').textContent='no image';return;}const image=await createImageBitmap(file);
        output('Paste result').textContent=JSON.stringify({type:file.type,width:image.width,height:image.height});});
      const drop=document.querySelector('[data-testid="drop"]');drop.addEventListener('dragover',event=>event.preventDefault());
      drop.addEventListener('drop',async event=>{event.preventDefault();output('Drop result').textContent=JSON.stringify(await Promise.all([...event.dataTransfer.files].map(async file=>({name:file.name,type:file.type,text:await file.text()}))));});
      let pendingFiles=[];document.querySelector('input').addEventListener('change',event=>{pendingFiles=[...event.target.files];});
      document.querySelector('button').addEventListener('click',async()=>{output('Directory result').textContent=JSON.stringify(await Promise.all(pendingFiles.map(async file=>({path:file.webkitRelativePath,text:await file.text()}))));});
      const ctx=document.querySelector('canvas').getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,800,120);ctx.fillStyle='black';ctx.font='48px sans-serif';ctx.fillText('VISIBLE CANVAS',20,75);
      </script>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address === "object");
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test("Verifier pastes real clipboard images, drops file contents and uploads a nested isolated directory", { timeout: 45_000 }, async () => {
  await withMediaApplication(false, async url => {
    const browser = await chromium.launch({ headless: true }), events: WebRuntimeEvent[] = [];
    const runtime = new WebProgramRuntime(browser, url, async event => { events.push(event); return `receipt-${events.length}`; }, [], 5000, [
      { id: "paste", kind: "action" }, { id: "drop", kind: "action" }, { id: "directory", kind: "action" },
    ]);
    try {
      await runtime.run(`const p=await browser.actor('alice');
        await check.action('paste',()=>p.getByLabel('Editor',{exact:true}).pasteImage({name:'input.png',fixture:{kind:'png',bytes:128}}));
        await check.action('drop',()=>p.getByRole('button',{name:'Drop files',exact:true}).dropFiles([{name:'note.md',mimeType:'text/markdown',text:'# Actual dropped text'}]));
        await check.action('directory',()=>p.getByLabel('Directory',{exact:true}).uploadDirectory({name:'notes',files:[{path:'root.md',text:'root content'},{path:'nested/child.md',text:'child content'}]}));
      `, { signal: new AbortController().signal, timeoutMs: 20_000 });
      const page = browser.contexts()[0]!.pages()[0]!;
      await expect(page.getByRole("status", { name: "Paste result" })).toContainText('"width":1');
      assert.deepEqual(JSON.parse(await page.getByRole("status", { name: "Paste result" }).innerText()), { type: "image/png", width: 1, height: 1 });
      await expect(page.getByRole("status", { name: "Drop result" })).toContainText("Actual dropped text");
      assert.deepEqual(JSON.parse(await page.getByRole("status", { name: "Drop result" }).innerText()), [{ name: "note.md", type: "text/markdown", text: "# Actual dropped text" }]);
      await page.getByRole("button", { name: "Read directory" }).click();
      await expect(page.getByRole("status", { name: "Directory result" })).toContainText("child content");
      const directory = JSON.parse(await page.getByRole("status", { name: "Directory result" }).innerText()) as Array<{ path: string; text: string }>;
      assert.deepEqual(directory.sort((a,b) => a.path.localeCompare(b.path)), [{ path: "notes/nested/child.md", text: "child content" }, { path: "notes/root.md", text: "root content" }]);
      assert.deepEqual(events.filter(event => event.kind === "action").map(event => event.checkpointId), ["paste", "drop", "directory"]);
      assert(JSON.stringify(events).length < 10_000, "input contents are not repeated in action receipts");
      for (const path of ["../private", "/absolute", "C:/private", "a/../../private", "a\\private"]) await assert.rejects(runtime.run(`const p=await browser.actor('alice'); await p.getByLabel('Directory',{exact:true}).uploadDirectory({name:'notes',files:[{path:${JSON.stringify(path)},text:'denied'}]});`, { signal: new AbortController().signal, timeoutMs: 5000 }), /relative paths/);
    } finally { await runtime.close(); await browser.close(); }
  });
});

for (const mutant of [false, true]) test(`Verifier reads rendered PDF and image content and ${mutant ? "rejects wrong exports" : "accepts expected exports"}`, { timeout: 60_000 }, async () => {
  await withMediaApplication(mutant, async url => {
    const browser = await chromium.launch({ headless: true }), events: WebRuntimeEvent[] = [];
    const runtime = new WebProgramRuntime(browser, url, async event => { events.push(event); return `receipt-${events.length}`; }, [
      { clauseId: "pdf", checkpointId: "pdf-result", expected: { operator: "relation", value: "EXPECTED EXPORT" } },
      { clauseId: "image", checkpointId: "image-result", expected: { operator: "relation", value: "EXPECTED EXPORT" } },
    ]);
    try {
      const result = await runtime.run(`const p=await browser.actor('alice');const downloaded=[];
        for(const [clause,name] of [['pdf','PDF export'],['image','Image export']]){
          const filePending=p.waitForEvent('download');await p.getByRole('link',{name:name,exact:true}).click();const file=await (await filePending).read('base64'); downloaded.push(file.id);
          const rendered=await p.render(file.id,{ocr:'eng'});
          if(rendered.value.ocr.confidence<70)throw new Error('OCR confidence is insufficient to determine the result');
          await check.expect(clause,[rendered.id],'(values,expected)=>values[0].ocr.text.includes(expected)');
        }
        return downloaded;
      `, { signal: new AbortController().signal, timeoutMs: 45_000 }) as string[];
      assert.deepEqual(events.filter(event => event.kind === "assertion").map(event => event.assertion?.result), [mutant ? "violated" : "satisfied", mutant ? "violated" : "satisfied"]);
      const rendered = events.filter(event => event.payload.kind === "rendered-content");
      assert.equal(rendered.length, 2);
      for (const [index, event] of rendered.entries()) { assert.deepEqual(event.inputs, [result[index]]); assert(event.attachments![0]!.bytes.length > 100); }
      await assert.rejects(runtime.run(`const p=await browser.actor('alice');await p.render('forged',{ocr:'eng'});`, { signal: new AbortController().signal, timeoutMs: 5000 }), /binary download observation/);
      await assert.rejects(runtime.run(`const p=await browser.actor('bob');await p.render(${JSON.stringify(result[0])});`, { signal: new AbortController().signal, timeoutMs: 5000 }), /binary download observation/);
      if (!mutant) {
        const preview = await runtime.run(`const p=await browser.actor('alice');return (await p.getByLabel('Rendered preview',{exact:true}).image({ocr:'eng'})).value;`, { signal: new AbortController().signal, timeoutMs: 30_000 }) as { ocr: { text: string } };
        assert.match(preview.ocr.text, /VISIBLE CANVAS/);
      }
    } finally { await runtime.close(); await browser.close(); }
  });
});
