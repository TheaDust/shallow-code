import type { Browser, BrowserContext, Page } from "@playwright/test";
import { Type } from "typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

const SCRIPT_TIMEOUT_MS = 60_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const MAX_CONSOLE_ERRORS = 20;
const MAX_PAGE_TEXT = 3_000;
const MAX_RESULT_TEXT = 2_000;

// One lazy Chromium per worker call; each tool call gets an isolated context.
// The worker's owned process tree is killed after the call regardless, so a
// leaked browser cannot outlive the Builder turn.
let sharedBrowser: Browser | undefined;
type PlaywrightRuntime = Pick<typeof import("@playwright/test"), "chromium" | "expect">;
let playwrightModule: Promise<PlaywrightRuntime> | undefined;

function loadPlaywright(): Promise<PlaywrightRuntime> {
  const loaded = playwrightModule ?? import("@playwright/test").then(({ chromium, expect }) => ({ chromium, expect }));
  playwrightModule = loaded;
  return loaded;
}

async function sharedBrowserInstance(): Promise<Browser> {
  if (!sharedBrowser || !sharedBrowser.isConnected()) {
    const { chromium } = await loadPlaywright();
    sharedBrowser = await chromium.launch({ headless: true });
  }
  return sharedBrowser;
}

/** Best-effort cleanup when the worker finishes normally. */
export async function closeSharedBrowser(): Promise<void> {
  const current = sharedBrowser;
  sharedBrowser = undefined;
  await current?.close().catch(() => undefined);
}

const parameters = Type.Object({
  url: Type.String({ description: "URL of the locally started application page to open first" }),
  screenshot: Type.Optional(Type.Boolean({ description: "Include a viewport screenshot when visual inspection is needed (requires image-capable model)" })),
  code: Type.String({ description: "Async JavaScript function body executed with (page, context) after the URL opens; use await for actions and return a JSON-serializable observation; Playwright expect is also injected" }),
});

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (page: Page, context: BrowserContext, assertion: PlaywrightRuntime["expect"]) => Promise<unknown>;

export function createBrowserTool(): ToolDefinition<typeof parameters> {
  return {
    name: "browser",
    label: "Browser (expensive)",
    description:
      "EXPENSIVE: drive a real Chromium page (Playwright) against a locally running app. " +
      "Use only when builds, type checks and traditional tests cannot answer a real-browser behavior question; " +
      "keep it to the one or two most critical flows per task. Start the app per the platform contract first and wait for its health check.",
    promptSnippet: "browser: expensive real-browser check against the locally started app; use sparingly",
    parameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      const { expect } = await loadPlaywright();
      const instance = await sharedBrowserInstance();
      const context = await instance.newContext();
      const page = await context.newPage();
      const consoleErrors: string[] = [];
      page.on("console", message => {
        if (message.type() === "error" && consoleErrors.length < MAX_CONSOLE_ERRORS) consoleErrors.push(message.text());
      });
      page.on("pageerror", error => {
        if (consoleErrors.length < MAX_CONSOLE_ERRORS) consoleErrors.push(String(error));
      });
      let timer: NodeJS.Timeout | undefined;
      let onAbort: (() => void) | undefined;
      try {
        signal?.throwIfAborted();
        let value: unknown;
        let error: string | undefined;
        try {
          const script = (async () => {
            await page.goto(params.url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
            page.setDefaultTimeout(5_000);
            return new AsyncFunction("page", "context", "expect", params.code)(page, context, expect);
          })();
          const interrupted = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`browser script exceeded ${SCRIPT_TIMEOUT_MS / 1_000}s`)), SCRIPT_TIMEOUT_MS);
            onAbort = () => reject(new Error("browser tool aborted"));
            signal?.addEventListener("abort", onAbort, { once: true });
          });
          value = await Promise.race([script, interrupted]);
        } catch (failure) {
          error = String(failure).slice(0, MAX_RESULT_TEXT);
        } finally {
          if (timer) clearTimeout(timer);
          if (onAbort) signal?.removeEventListener("abort", onAbort);
        }
        signal?.throwIfAborted();
        const pageText = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
        const accessibility = await page.locator("body").ariaSnapshot({ timeout: 2_000 }).catch(() => "");
        const title = await page.title().catch(() => "");
        const payload = {
          ok: !error, error, url: page.url(), title, consoleErrors,
          result: serialize(value),
          ...(!error && value === undefined ? { warning: "Script returned no observation. Use an explicit return or awaited expect assertions; this is not proof of requirement completion." } : {}),
          pageText: pageText.slice(0, MAX_PAGE_TEXT), accessibility: accessibility.slice(0, 4_000),
        };
        if (error) throw new Error(JSON.stringify(payload));
        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
          { type: "text", text: JSON.stringify(payload, null, 1) },
        ];
        if (params.screenshot) {
          const screenshot = await page.screenshot({ type: "jpeg", quality: 60, timeout: 2_000 }).catch(() => undefined);
          if (screenshot) content.push({ type: "image", data: screenshot.toString("base64"), mimeType: "image/jpeg" });
        }
        return { content, details: { ok: true, url: payload.url, title, consoleErrorCount: consoleErrors.length } };
      } finally {
        await context.close().catch(() => undefined);
      }
    },
  };
}

function serialize(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value)?.slice(0, MAX_RESULT_TEXT) ?? null;
  } catch {
    return String(value).slice(0, MAX_RESULT_TEXT);
  }
}
