import type { Browser } from "@playwright/test";
import { renderBinary, type RenderOptions, type RenderResult } from "./binary-renderer.js";

/** Render only host-held download bytes, in a disposable context with no application authority. */
export async function renderHtml(browser: Browser, bytes: Buffer, options: RenderOptions, signal: AbortSignal): Promise<RenderResult> {
  signal.throwIfAborted();
  if (options.page !== undefined && options.page !== 1) throw new Error("HTML has one rendered page");
  const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const context = await browser.newContext({ javaScriptEnabled: false, acceptDownloads: false, serviceWorkers: "block",
    viewport: { width: 1280, height: 720 } });
  const abort = () => { void context.close().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const entry = "https://shallow-download.invalid/document.html";
    let served = false;
    await context.route("**/*", async route => {
      if (!served && route.request().url() === entry && route.request().isNavigationRequest() && route.request().frame() === page.mainFrame()) {
        served = true;
        await route.fulfill({ contentType: "text/html; charset=utf-8", body: html, headers: {
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline' data:; img-src data:; font-src data:; sandbox",
        } });
      } else await route.abort("blockedbyclient");
    });
    await page.goto(entry, { waitUntil: "load", timeout: 5000 });
    const size = await page.evaluate(() => ({ width: Math.max(innerWidth, document.documentElement.scrollWidth),
      height: Math.max(innerHeight, document.documentElement.scrollHeight) }));
    if (size.width > 4096 || size.height > 4096 || size.width * size.height > 16_777_216) throw new Error("HTML render dimensions exceed 4096 pixels per side or 16 million pixels");
    const elements = [];
    for (const selector of options.selectors ?? []) {
      const element = page.locator(selector);
      if (await element.count() !== 1) throw new Error(`HTML render selector must resolve to exactly one element: ${selector}`);
      elements.push({ selector, text: (await element.innerText()).slice(0, 16_000), visible: await element.isVisible(),
        ...await element.evaluate(node => ({ color: getComputedStyle(node).color, backgroundColor: getComputedStyle(node).backgroundColor })),
        box: await element.boundingBox() });
    }
    const text = await page.locator("body").innerText();
    const { selectors: _selectors, ...rasterOptions } = options;
    const result = await renderBinary(await page.screenshot({ fullPage: true, timeout: 5000, animations: "disabled" }), rasterOptions, signal);
    return { png: result.png, value: { ...result.value, format: "html", text: options.region ? "" : text.slice(0, 64_000),
      truncated: result.value.truncated || text.length > 64_000, elements,
      restrictions: ["scripts-disabled", "external-resources-blocked"] } };
  } finally {
    signal.removeEventListener("abort", abort);
    await context.close();
  }
}
