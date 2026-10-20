import { createHash, randomUUID } from "node:crypto";
import { fork, type ForkOptions } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, BrowserContext, Page, Frame, Locator } from "@playwright/test";
import { getQuickJS } from "quickjs-emscripten";
import type { WebFileFixture } from "./fixtures.js";
import { dropFiles, fileMetadata, filePayload, pasteImage, uploadDirectory } from "./file-inputs.js";
import { renderBinary, renderOptions, type RenderResult } from "./binary-renderer.js";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface SandboxOptions { signal: AbortSignal; timeoutMs: number; memoryLimitBytes?: number }

/** A disposable OS process contains interpreter failures; only serialized capability calls cross IPC. */
export async function executeSandboxProgram(
  source: string, invoke: (method: string, input: Record<string, unknown>) => Promise<unknown>, options: SandboxOptions,
): Promise<unknown> {
  options.signal.throwIfAborted();
  const workerEnv = Object.fromEntries(["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA"]
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]!]));
  const workerOptions: ForkOptions & { windowsHide: boolean } = { stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "json", windowsHide: true, env: workerEnv };
  const worker = fork(new URL("./sandbox-worker.mjs", import.meta.url), [], workerOptions);
  let stderr = "";
  worker.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2_000); });
  let finished = false;
  const exited = new Promise<void>((resolve) => { worker.once("close", () => resolve()); worker.once("error", () => resolve()); });
  let timeout: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const fail = (error: unknown) => { if (!finished) { finished = true; reject(error); } };
      abort = () => fail(options.signal.reason ?? new Error("Checker program cancelled"));
      options.signal.addEventListener("abort", abort, { once: true });
      if (options.signal.aborted) abort();
      timeout = setTimeout(() => fail(new Error("Checker program execution timed out")), options.timeoutMs + 1_000);
      worker.once("error", fail);
      worker.once("exit", (code) => { if (!finished) fail(new Error(`Checker interpreter exited (${code}): ${stderr}`)); });
      worker.on("message", (raw: unknown) => {
        if (finished || !raw || typeof raw !== "object") return;
        const message = raw as { type: string; id?: number; method?: string; input?: Record<string, unknown>; value?: unknown; error?: string };
        if (message.type === "result") { finished = true; resolve(message.value); }
        else if (message.type === "error") fail(new Error(message.error));
        else if (message.type === "invoke" && typeof message.id === "number" && typeof message.method === "string" && message.input && typeof message.input === "object") {
          void Promise.resolve().then(() => { options.signal.throwIfAborted(); return invoke(message.method!, message.input!); }).then((value) => {
            if (!finished && worker.connected) worker.send({ type: "response", id: message.id, value: value ?? null });
          }, (error: unknown) => { if (!finished && worker.connected) worker.send({ type: "response", id: message.id, error: error instanceof Error ? error.message : String(error) }); });
        }
      });
      worker.send({ type: "execute", source, timeoutMs: options.timeoutMs, memoryLimitBytes: options.memoryLimitBytes ?? 32 * 1024 * 1024 });
    });
  } finally {
    finished = true;
    if (timeout) clearTimeout(timeout);
    if (abort) options.signal.removeEventListener("abort", abort);
    worker.kill();
    await exited;
  }
}

/** The guest receives JSON and one asynchronous bridge, never Node or Playwright handles. */
export async function executeSandboxRealm(
  source: string, invoke: (method: string, input: Record<string, unknown>) => Promise<unknown>, options: SandboxOptions,
): Promise<unknown> {
  options.signal.throwIfAborted();
  const quickjs = await getQuickJS();
  const runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(options.memoryLimitBytes ?? 32 * 1024 * 1024);
  const deadline = Date.now() + options.timeoutMs;
  runtime.setInterruptHandler(() => options.signal.aborted || Date.now() >= deadline);
  const context = runtime.newContext();
  let closed = false;
  const hosts = new Set<Promise<void>>();
  const deferreds = new Set<ReturnType<typeof context.newPromise>>();
  const bridge = context.newFunction("bridge", (methodHandle, inputHandle) => {
    const method = context.getString(methodHandle);
    const input = JSON.parse(context.getString(inputHandle)) as Record<string, unknown>;
    const deferred = context.newPromise();
    deferreds.add(deferred);
    const work = Promise.resolve().then(() => invoke(method, input)).then((value) => {
      if (closed) return;
      const result = context.newString(JSON.stringify(value ?? null));
      deferred.resolve(result);
      result.dispose();
    }, (error: unknown) => {
      if (closed) return;
      const result = context.newError(error instanceof Error ? error.message : String(error));
      deferred.reject(result);
      result.dispose();
    }).finally(() => { if (!closed) deferred.dispose(); deferreds.delete(deferred); hosts.delete(work); });
    hosts.add(work);
    return deferred.handle;
  });
  context.setProp(context.global, "__bridge", bridge);
  bridge.dispose();
  let resultHandle: ReturnType<typeof context.evalCode> | undefined;
  try {
    const bootstrap = context.evalCode(PRELUDE);
    context.unwrapResult(bootstrap).dispose();
    resultHandle = context.evalCode(`(async () => {\n${source}\n})()`, "checker-program.js");
    const result = context.unwrapResult(resultHandle);
    let settled = false;
    let answer: unknown;
    let failure: unknown;
    const resolved = context.resolvePromise(result).then((outcome) => {
      if (closed) return;
      if (outcome.error) { failure = new Error(String(context.dump(outcome.error)?.message ?? context.dump(outcome.error))); outcome.error.dispose(); }
      else { answer = context.dump(outcome.value); outcome.value.dispose(); }
      settled = true;
    });
    while (!settled) {
      options.signal.throwIfAborted();
      if (Date.now() >= deadline) throw new Error("Checker program execution timed out");
      const jobs = runtime.executePendingJobs();
      if (jobs.error) { const error = context.dump(jobs.error); jobs.error.dispose(); throw new Error(String(error?.message ?? error)); }
      if (!settled) await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    await resolved;
    if (failure) throw failure;
    return answer;
  } finally {
    closed = true;
    // Host operations use bounded Playwright timeouts. Their late completions cannot touch this realm.
    if (resultHandle && "value" in resultHandle) resultHandle.value?.dispose();
    for (const deferred of deferreds) deferred.dispose();
    context.dispose();
    runtime.dispose();
  }
}

const PRELUDE = String.raw`
(() => {
  const host = __bridge;
  delete globalThis.__bridge;
  const call = async (method, input) => JSON.parse(await host(method, JSON.stringify(input)));
  const page = (actor, window = 'main', frame) => Object.freeze({
    goto: (path, checkpointId) => call('goto', {actor, window, frame, path, checkpointId}),
    reload: checkpointId => call('reload', {actor, window, frame, checkpointId}),
    inspect: () => call('inspect', {actor, window, frame}),
    url: () => call('url', {actor, window, frame}),
    setViewport: (size, checkpointId) => call('setViewport', {actor, window, frame, size, checkpointId}),
    viewport: () => call('viewport', {actor, window, frame}),
    read: (locator, kind = 'text') => call('read', {actor, window, frame, locator, kind}),
    attribute: (locator, name) => call('attribute', {actor, window, frame, locator, name}),
    style: (locator, name) => call('style', {actor, window, frame, locator, name}),
    count: locator => call('count', {actor, window, frame, locator}),
    waitFor: (locator, state = 'visible', timeoutMs) => call('waitFor', {actor, window, frame, locator, state, timeoutMs}),
    click: (locator, checkpointId) => call('click', {actor, window, frame, locator, checkpointId}),
    fill: (locator, value, checkpointId) => call('fill', {actor, window, frame, locator, value, checkpointId}),
    press: (locator, value, checkpointId) => call('press', {actor, window, frame, locator, value, checkpointId}),
    check: (locator, checkpointId) => call('check', {actor, window, frame, locator, checkpointId}),
    setChecked: (locator, checked, checkpointId) => call('setChecked', {actor, window, frame, locator, checked, checkpointId}),
    select: (locator, value, checkpointId) => call('select', {actor, window, frame, locator, value, checkpointId}),
    hover: (locator, checkpointId) => call('hover', {actor, window, frame, locator, checkpointId}),
    doubleClick: (locator, checkpointId) => call('doubleClick', {actor, window, frame, locator, checkpointId}),
    rightClick: (locator, checkpointId) => call('rightClick', {actor, window, frame, locator, checkpointId}),
    dragTo: (from, to, checkpointId) => call('dragTo', {actor, window, frame, from, to, checkpointId}),
    upload: (locator, files, checkpointId) => call('upload', {actor, window, frame, locator, files, checkpointId}),
    dropFiles: (locator, files, checkpointId) => call('dropFiles', {actor, window, frame, locator, files, checkpointId}),
    uploadDirectory: (locator, directory, checkpointId) => call('uploadDirectory', {actor, window, frame, locator, directory, checkpointId}),
    pasteImage: (locator, file, checkpointId) => call('pasteImage', {actor, window, frame, locator, file, checkpointId}),
    focus: (locator, checkpointId) => call('focus', {actor, window, frame, locator, checkpointId}),
    blur: (locator, checkpointId) => call('blur', {actor, window, frame, locator, checkpointId}),
    scroll: (deltaX = 0, deltaY = 0, checkpointId) => call('scroll', {actor, window, frame, deltaX, deltaY, checkpointId}),
    dialog: (accept = true, promptText) => call('dialog', {actor, window, accept, promptText}),
    clipboard: Object.freeze({
      writeText: (value, checkpointId) => call('clipboardWrite', {actor, window, value, checkpointId}),
      readText: () => call('clipboardRead', {actor, window}),
    }),
    storage: Object.freeze({ fill: (bytes, checkpointId) => call('storageFill', {actor, window, frame, bytes, checkpointId}) }),
    download: (locator, checkpointId, encoding = 'text') => call('download', {actor, window, frame, locator, checkpointId, encoding}),
    render: (sourceId, options = {}) => call('render', {actor, window, sourceId, options}),
    image: (locator, options = {}) => call('image', {actor, window, frame, locator, options}),
    popup: async (locator, checkpointId) => {const opened = await call('popup', {actor, window, frame, locator, checkpointId}); return page(actor, opened.window);},
    frame: name => page(actor, window, name),
  });
  globalThis.browser = Object.freeze({ actor: async name => {await call('actor', {actor:name}); return page(name);} });
  globalThis.check = Object.freeze({ expect: (clauseId, observationIds, predicate) => call('expect', {clauseId, observationIds, predicate}), precondition: (checkpointId, observationIds, predicate) => call('precondition', {checkpointId, observationIds, predicate}) });
})();`;

export interface WebLocator { role?: string; name?: string; label?: string; text?: string; testId?: string; within?: WebLocator }
export type WebFile = { name: string; mimeType?: string; text?: string; base64?: string; fixture?: WebFileFixture };
export interface WebExpectation {
  clauseId: string;
  checkpointId: string;
  expected: { operator: "equal" | "contains" | "greaterThan" | "lessThan" | "match" | "relation"; value: unknown };
}
export interface WebCheckpoint { id: string; kind: "precondition" | "action" | "condition" | "assertion"; expected?: WebExpectation["expected"] }
export interface WebRuntimeEvent {
  kind: "action" | "observation" | "assertion" | "precondition";
  checkpointId?: string;
  assertion?: { clauseId: string; result: "satisfied" | "violated" };
  inputs: string[];
  payload: Record<string, unknown>;
  attachments?: Array<{ bytes: Buffer; mediaType: string }>;
}
interface Actor { context: BrowserContext; windows: Map<string, Page> }
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const DOWNLOAD_TEXT_EXTENSIONS = /\.(?:txt|csv|tsv|json|xml|html|md)$/i;

/** Enforces browser ownership and records actual observations before the guest can consume them. */
export class WebProgramRuntime {
  private readonly actors = new Map<string, Actor>();
  private readonly openingActors = new Set<string>();
  private readonly observations = new Map<string, unknown>();
  private readonly binaries = new Map<string, { bytes: Buffer; actor: string; window: string }>();
  private readonly rendered = new Map<string, RenderResult>();
  private readonly inputCleanup = new Set<() => Promise<void>>();
  private readonly pending = new Set<Promise<unknown>>();
  private active = true;
  constructor(
    private readonly browser: Browser,
    private readonly baseUrl: string,
    private readonly emit: (event: WebRuntimeEvent) => Promise<string>,
    private readonly expectations: readonly WebExpectation[] = [],
    private readonly timeoutMs = 5_000,
    private readonly checkpoints: readonly WebCheckpoint[] = [],
  ) {}

  async run(source: string, options: SandboxOptions): Promise<unknown> {
    return executeSandboxProgram(source, (method, input) => this.invoke(method, input, options.signal), options);
  }
  async close(): Promise<void> {
    this.active = false;
    const contexts = await Promise.allSettled([...this.actors.values()].map(actor => actor.context.close()));
    await Promise.allSettled([...this.pending]);
    const cleanup = await Promise.allSettled([...this.inputCleanup].map(async dispose => { await dispose(); this.inputCleanup.delete(dispose); }));
    this.actors.clear();
    this.observations.clear();
    this.binaries.clear();
    this.rendered.clear();
    const failure = [...contexts, ...cleanup].find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
  async captureEvidence(directory: string): Promise<Array<{ bytes: Buffer; mediaType: string }>> {
    const attachments: Array<{ bytes: Buffer; mediaType: string }> = [];
    await mkdir(directory, { recursive: true });
    for (const actor of this.actors.values()) {
      for (const page of actor.windows.values()) if (!page.isClosed()) attachments.push({ bytes: await page.screenshot({ timeout: this.timeoutMs }), mediaType: "image/png" });
      const path = join(directory, "trace-" + randomUUID() + ".zip");
      try {
        await actor.context.tracing.stop({ path });
        attachments.push({ bytes: await readFile(path), mediaType: "application/zip" });
      } finally { await rm(path, { force: true }); }
      await actor.context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    }
    return attachments;
  }
  private async observation(payload: Record<string, unknown>, inputs: string[] = [], attachments?: WebRuntimeEvent["attachments"]): Promise<{ id: string; value: unknown }> {
    if (!this.active) throw new Error("Web case closed before observation completed");
    const id = await this.emit({ kind: "observation", inputs, payload, ...(attachments ? { attachments } : {}) });
    this.observations.set(id, payload.value);
    return { id, value: payload.value };
  }
  async invoke(method: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const operation = this.doInvoke(method, input, signal);
    this.pending.add(operation);
    try { return await operation; } finally { this.pending.delete(operation); }
  }
  private async doInvoke(method: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (!this.active) throw new Error("Web case is closed; handles have expired");
    if (method === "actor") {
      const name = string(input.actor, "actor");
      if (!this.actors.has(name)) {
        if (this.actors.size + this.openingActors.size >= 8) throw new Error("Web case actor limit exceeded");
        if (this.openingActors.has(name)) throw new Error("Actor creation is already pending");
        this.openingActors.add(name);
        const context = await this.browser.newContext({ acceptDownloads: true, serviceWorkers: "block" });
        if (!this.active) { await context.close(); throw new Error("Web case closed during actor creation"); }
        await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(this.baseUrl).origin });
        this.actors.set(name, { context, windows: new Map() });
        this.openingActors.delete(name);
        await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
        context.setDefaultTimeout(this.timeoutMs);
        await context.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (url.origin !== new URL(this.baseUrl).origin) { await route.abort("blockedbyclient"); return; }
          if (route.request().isNavigationRequest()) {
            try { this.safeUrl(url.href); } catch { await route.abort("blockedbyclient"); return; }
          }
          await route.continue();
        });
        const page = await context.newPage();
        if (!this.active) { await context.close(); throw new Error("Web case closed during actor creation"); }
        this.actors.get(name)!.windows.set("main", page);
        await page.goto(this.baseUrl, { waitUntil: "load", timeout: this.timeoutMs });
        await this.emit({ kind: "observation", inputs: [], payload: { method, actor: name, value: "actor-created" } });
      }
      return { actor: name };
    }
    if (method === "expect" || method === "precondition") return this.assert(input, signal, method === "precondition");
    if (input.checkpointId !== undefined && !this.checkpoints.some((point) => point.id === input.checkpointId && point.kind === "action")) throw new Error("Action references an unknown contract checkpoint");
    const actorName = string(input.actor, "actor");
    const actor = this.actors.get(actorName);
    if (!actor) throw new Error("Unknown actor; create it through browser.actor first");
    const windowName = input.window === undefined ? "main" : string(input.window, "window");
    const page = actor.windows.get(windowName);
    if (!page) throw new Error("Unknown or expired window");
    this.safeUrl(page.url());
    let target: Page | Frame = page;
    if (input.frame !== undefined) {
      const frames = page.frames().filter((frame) => frame !== page.mainFrame() && frame.name() === input.frame);
      if (frames.length !== 1) throw new Error(`Frame must identify exactly one named frame (${String(input.frame)}; available ${page.frames().map((frame) => frame.name()).join(",")})`);
      target = frames[0]!;
      this.safeUrl(target.url());
    }
    if (method === "inspect") return this.observation({ actor: actorName, window: windowName, value: {
      url: target.url(), text: (await target.locator("body").innerText()).slice(0, 32_000), accessibility: (await target.locator("body").ariaSnapshot()).slice(0, 32_000),
    } });
    if (method === "url") return this.observation({ actor: actorName, window: windowName, frame: input.frame, kind: "url", value: target.url() });
    if (method === "render" || method === "image") {
      const options = renderOptions(input.options ?? {});
      let bytes: Buffer;
      const inputs: string[] = [];
      if (method === "render") {
        const sourceId = string(input.sourceId, "sourceId");
        const source = this.binaries.get(sourceId);
        if (!source || source.actor !== actorName || source.window !== windowName) throw new Error("Render requires a binary download observation from this actor and window");
        bytes = source.bytes; inputs.push(sourceId);
      } else {
        const locator = this.locate(target, input.locator, false);
        if (await locator.count() !== 1) throw new Error("Image locator must identify exactly one element");
        const box = await locator.boundingBox();
        if (!box || box.width > 4096 || box.height > 4096) throw new Error("Image observation requires a visible element of at most 4096 pixels per side");
        bytes = await locator.screenshot({ timeout: this.timeoutMs });
      }
      const key = createHash("sha256").update(bytes).update(JSON.stringify(options)).digest("hex");
      let result = this.rendered.get(key);
      if (!result) {
        result = await renderBinary(bytes, options, signal);
        if (this.rendered.size >= 16) this.rendered.delete(this.rendered.keys().next().value!);
        this.rendered.set(key, result);
      }
      return this.observation({ actor: actorName, window: windowName, frame: input.frame, locator: input.locator, kind: "rendered-content", value: result.value }, inputs, [{ bytes: result.png, mediaType: "image/png" }]);
    }
    if (method === "viewport" || method === "setViewport") {
      if (input.frame !== undefined) throw new Error("Viewport belongs to the owning window");
      if (method === "setViewport") {
        const size = input.size as { width?: unknown; height?: unknown } | undefined;
        const width = finiteNumber(size?.width, "width", 3840), height = finiteNumber(size?.height, "height", 2160);
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 240 || height < 240) throw new Error("Viewport dimensions must be integers of at least 240 pixels");
        await page.setViewportSize({ width, height });
        await this.emit({ kind: "action", checkpointId: input.checkpointId as string | undefined, inputs: [], payload: { method, actor: actorName, window: windowName, width, height } });
      }
      return this.observation({ actor: actorName, window: windowName, kind: "viewport", value: await page.evaluate(() => ({
        width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
      })) });
    }
    if (method === "storageFill") {
      if (input.frame !== undefined) throw new Error("Storage fixture belongs to the owning window");
      const bytes = finiteNumber(input.bytes, "bytes", 16 * 1024 * 1024);
      if (!Number.isInteger(bytes) || bytes < 2) throw new Error("Storage fixture bytes must be an integer between 2 and 16 MiB");
      const result = await page.evaluate(({ bytes, prefix }) => {
        let writtenBytes = 0, index = 0, chunk = 32_768, quotaExceeded = false;
        while (writtenBytes + 2 <= bytes) {
          const length = Math.min(chunk, Math.floor((bytes - writtenBytes) / 2));
          try { localStorage.setItem(prefix + index, "A".repeat(length)); writtenBytes += length * 2; index++; }
          catch (error) {
            if (!(error instanceof DOMException) || error.name !== "QuotaExceededError") throw error;
            quotaExceeded = true;
            if (length === 1) break;
            chunk = Math.floor(length / 2);
          }
        }
        return { writtenBytes, quotaExceeded };
      }, { bytes, prefix: `checker-fixture:${randomUUID()}:` });
      await this.emit({ kind: "action", checkpointId: input.checkpointId as string | undefined, inputs: [], payload: { method, actor: actorName, window: windowName, bytes } });
      return this.observation({ actor: actorName, window: windowName, kind: "storage-fixture", value: result });
    }
    let uploadedFiles: ReturnType<typeof filePayload> | undefined;
    if (method === "clipboardWrite" || method === "clipboardRead") {
      if (input.frame !== undefined) throw new Error("Clipboard belongs to the owning window, not a frame");
      if (method === "clipboardWrite") await page.evaluate(async (value) => navigator.clipboard.writeText(value as string), string(input.value, "value"));
      else return this.observation({ actor: actorName, window: windowName, kind: "clipboard", value: await page.evaluate(() => navigator.clipboard.readText()) });
    } else if (method === "scroll") {
      if (input.frame !== undefined) throw new Error("Scroll the owning window, not a frame");
      const deltaX = finiteNumber(input.deltaX, "deltaX", 1_000_000);
      const deltaY = finiteNumber(input.deltaY, "deltaY", 1_000_000);
      if (deltaX === 0 && deltaY === 0) throw new Error("Scroll requires a nonzero delta");
      await page.mouse.wheel(deltaX, deltaY);
    } else if (method === "dragTo") {
      const from = this.locate(target, input.from, true);
      const to = this.locate(target, input.to, true);
      if (await from.count() !== 1 || await to.count() !== 1) throw new Error("Drag locators must identify exactly one element");
      await from.dragTo(to, { timeout: this.timeoutMs });
    } else if (method === "count") {
      const locator = this.locate(target, input.locator, false);
      return this.observation({ actor: actorName, window: windowName, frame: input.frame, locator: input.locator, kind: "count", value: await locator.count() });
    } else if (method === "waitFor") {
      const locator = this.locate(target, input.locator, false);
      const state = input.state === undefined ? "visible" : string(input.state, "state");
      if (!["attached", "detached", "visible", "hidden"].includes(state)) throw new Error("Unsupported wait state");
      const count = await locator.count();
      if (count > 1 || (count === 0 && state !== "detached" && state !== "hidden")) throw new Error("Wait locator must identify exactly one element");
      const timeoutMs = Math.min(this.timeoutMs, Math.max(1, input.timeoutMs === undefined ? this.timeoutMs : finiteNumber(input.timeoutMs, "timeoutMs", this.timeoutMs)));
      await locator.waitFor({ state: state as "attached" | "detached" | "visible" | "hidden", timeout: timeoutMs });
    } else if (method === "attribute" || method === "style" || method === "read" || method === "click" || method === "fill" ||
      method === "press" || method === "check" || method === "setChecked" || method === "select" || method === "hover" ||
      method === "doubleClick" || method === "rightClick" || method === "upload" || method === "focus" || method === "blur" ||
      method === "download" || method === "popup" || method === "dropFiles" || method === "uploadDirectory" || method === "pasteImage") {
      const locator = this.locate(target, input.locator, !["read", "attribute", "style"].includes(method));
      if (await locator.count() !== 1) throw new Error("Locator must identify exactly one element");
      if (method === "attribute") {
        const name = string(input.name, "name");
        return this.observation({ actor: actorName, window: windowName, frame: input.frame, locator: input.locator, kind: "attribute", name, value: await locator.getAttribute(name) });
      }
      if (method === "style") {
        const name = string(input.name, "name");
        return this.observation({ actor: actorName, window: windowName, frame: input.frame, locator: input.locator, kind: "style", name, value: await locator.evaluate((element, property) => getComputedStyle(element).getPropertyValue(property as string), name) });
      }
      if (method === "read") {
        const kind = input.kind === undefined ? "text" : string(input.kind, "kind");
        let value: unknown;
        if (kind === "text") value = (await locator.innerText()).slice(0, 64_000);
        else if (kind === "value") value = await locator.inputValue();
        else if (kind === "checked") value = await locator.isChecked();
        else if (kind === "visible") value = await locator.isVisible();
        else if (kind === "enabled") value = await locator.isEnabled();
        else throw new Error("Unsupported observation kind");
        return this.observation({ actor: actorName, window: windowName, frame: input.frame, locator: input.locator, kind, value });
      }
      if (method === "click") await locator.click();
      else if (method === "fill") await locator.fill(string(input.value, "value"));
      else if (method === "press") await locator.press(string(input.value, "value"));
      else if (method === "check") await locator.check();
      else if (method === "setChecked") await locator.setChecked(boolean(input.checked, "checked"));
      else if (method === "select") {
        const value = input.value;
        if (!(typeof value === "string" || Array.isArray(value) || (value && typeof value === "object"))) throw new Error("Select value must be a string, array or option object");
        await locator.selectOption(value as string | string[] | { value?: string; label?: string; index?: number } | Array<{ value?: string; label?: string; index?: number }>);
      } else if (method === "hover") await locator.hover();
      else if (method === "doubleClick") await locator.dblclick();
      else if (method === "rightClick") await locator.click({ button: "right" });
      else if (method === "upload") { uploadedFiles = filePayload(input.files); await locator.setInputFiles(uploadedFiles); }
      else if (method === "dropFiles") { uploadedFiles = filePayload(input.files); await dropFiles(page, locator, uploadedFiles); }
      else if (method === "uploadDirectory") {
        const { dispose, ...directory } = await uploadDirectory(locator, input.directory);
        this.inputCleanup.add(dispose);
        return { id: await this.emit({ kind: "action", checkpointId: input.checkpointId as string | undefined, inputs: [],
          payload: { method, actor: actorName, window: windowName, frame: input.frame, locator: input.locator, directory } }) };
      }
      else if (method === "pasteImage") {
        uploadedFiles = filePayload(input.file);
        if (uploadedFiles.length !== 1) throw new Error("Paste requires one image");
        await pasteImage(page, locator, uploadedFiles[0]!);
      }
      else if (method === "focus") await locator.focus();
      else if (method === "blur") await locator.blur();
      else if (method === "popup") {
        const [opened] = await Promise.all([page.waitForEvent("popup", { timeout: this.timeoutMs }), locator.click()]);
        await opened.waitForLoadState("domcontentloaded", { timeout: this.timeoutMs });
        this.safeUrl(opened.url());
        const window = randomUUID();
        actor.windows.set(window, opened);
        await this.emit({ kind: "action", checkpointId: input.checkpointId as string | undefined, inputs: [], payload: { method, actor: actorName, window: windowName, locator: input.locator, openedWindow: window } });
        return { window };
      } else if (method === "download") {
        const encoding = input.encoding === undefined ? "text" : string(input.encoding, "encoding");
        if (encoding !== "text" && encoding !== "base64") throw new Error("Download encoding must be text or base64");
        const [download] = await Promise.all([page.waitForEvent("download", { timeout: this.timeoutMs }), locator.click()]);
        if (encoding === "text" && !DOWNLOAD_TEXT_EXTENSIONS.test(download.suggestedFilename())) { await download.delete(); throw new Error("Download format is not an authorized UTF-8 business file"); }
        const downloadUrl = new URL(download.url());
        if (!(downloadUrl.protocol === "blob:" && downloadUrl.origin === new URL(this.baseUrl).origin)) this.safeUrl(download.url());
        const stream = await download.createReadStream();
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of stream) {
          const bytes = Buffer.from(chunk);
          size += bytes.length;
          if (size > MAX_FILE_BYTES) { stream.destroy(); await download.delete(); throw new Error("Download exceeds read limit"); }
          chunks.push(bytes);
        }
        const bytes = Buffer.concat(chunks);
        const value = encoding === "text" ? new TextDecoder("utf-8", { fatal: true }).decode(bytes) : bytes.toString("base64");
        await download.delete();
        await this.emit({ kind: "action", checkpointId: input.checkpointId as string | undefined, inputs: [], payload: { method, actor: actorName, locator: input.locator, encoding, filename: download.suggestedFilename(), bytes: size } });
        const content = await this.observation({ actor: actorName, kind: "download", filename: download.suggestedFilename(), encoding, value });
        if (encoding === "base64") {
          if ([...this.binaries.values()].reduce((total, source) => total + source.bytes.length, bytes.length) > 16 * 1024 * 1024) throw new Error("Binary downloads exceed the 16 MiB case limit");
          this.binaries.set(content.id, { bytes, actor: actorName, window: windowName });
        }
        const filename = await this.observation({ actor: actorName, kind: "download-filename", value: download.suggestedFilename() });
        return { ...content, filename };
      }
    } else if (method === "goto") {
      if (input.frame !== undefined) throw new Error("Navigate frames through application controls");
      await page.goto(this.safeUrl(string(input.path, "path")), { waitUntil: "domcontentloaded", timeout: this.timeoutMs });
    } else if (method === "reload") {
      if (input.frame !== undefined) throw new Error("Reload the owning window");
      await page.reload({ waitUntil: "domcontentloaded", timeout: this.timeoutMs });
    } else if (method === "dialog") {
      if (input.checkpointId !== undefined) throw new Error("Arming a dialog handler is not an executed requirement action");
      page.once("dialog", (dialog) => { void (input.accept === false ? dialog.dismiss() : dialog.accept(typeof input.promptText === "string" ? input.promptText : undefined)).catch(() => {}); });
    } else {
      throw new Error(`Unknown browser method: ${method}`);
    }
    this.safeUrl(page.url());
    return { id: await this.emit({ kind: "action", checkpointId: input.checkpointId as string | undefined, inputs: [], payload: {
      method, actor: actorName, window: windowName, frame: input.frame, locator: input.locator,
      ...(uploadedFiles ? { files: fileMetadata(uploadedFiles) } : { value: input.value }),
    } }) };
  }
  private safeUrl(path: string): string {
    const url = new URL(path, this.baseUrl);
    if (url.origin !== new URL(this.baseUrl).origin || !/^https?:$/.test(url.protocol) || /\.(?:js|mjs|cjs|map|ts|tsx)(?:$|[?#])/i.test(decodeURIComponent(url.pathname)) || /(?:^|\/)(?:\.(?:git|env)|__debug|@fs|@vite)(?:\/|$)/.test(decodeURIComponent(url.pathname))) throw new Error("Navigation is outside the authorized application surface");
    return url.href;
  }
  private locate(target: Page | Frame | Locator, raw: unknown, interaction: boolean): Locator {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Locator must be an object");
    const locator = raw as WebLocator;
    const strategies = [locator.role, locator.label, locator.text, locator.testId].filter((value) => value !== undefined);
    if (strategies.length !== 1) throw new Error("Choose exactly one role, label, text or testId locator");
    const strategy = locator.role !== undefined ? "role" : locator.label !== undefined ? "label" : locator.text !== undefined ? "text" : "testId";
    const allowed = strategy === "role" ? ["role", "name", "within"] : [strategy, "within"];
    for (const key of Object.keys(locator)) if (!allowed.includes(key)) throw new Error(`Locator field is not allowed for ${strategy}: ${key}`);
    if (locator.within) target = this.locate(target, locator.within, false);
    if (interaction && !locator.role && !locator.label) throw new Error("Interactions require role or label semantics");
    if (locator.role) return target.getByRole(locator.role as Parameters<Page["getByRole"]>[0], { ...(locator.name === undefined ? {} : { name: locator.name, exact: true }) });
    if (locator.label) return target.getByLabel(locator.label, { exact: true });
    if (locator.text) return target.getByText(locator.text, { exact: true });
    return target.getByTestId(locator.testId!);
  }
  private async assert(input: Record<string, unknown>, signal: AbortSignal, precondition = false): Promise<unknown> {
    const clauseId = string(precondition ? input.checkpointId : input.clauseId, precondition ? "checkpointId" : "clauseId");
    const point = precondition ? this.checkpoints.find((point) => point.id === clauseId && point.kind === "precondition") : undefined;
    const expectation = precondition && point?.expected ? { clauseId, checkpointId: point.id, expected: point.expected } : this.expectations.find((clause) => clause.clauseId === clauseId);
    if (!expectation) throw new Error("Assertion must identify a contract clause with a requirement-derived expectation");
    if (!Array.isArray(input.observationIds) || input.observationIds.length === 0 || input.observationIds.some((id) => typeof id !== "string" || !this.observations.has(id))) throw new Error("Assertion references unknown observations or a different case");
    const ids = input.observationIds as string[];
    const values = ids.map((id) => this.observations.get(id));
    const expected = expectation.expected.value;
    let passed: boolean;
    const actual = values.length === 1 ? values[0] : values;
    const operator = expectation.expected.operator;
    if (values.length > 1 && (operator === "match" || operator === "greaterThan" || operator === "lessThan"
      || operator === "equal" && !Array.isArray(expected))) {
      throw new Error(`${operator} with a scalar expectation requires one observation; received ${values.length}. Use a relation predicate for multiple values. Predicates receive raw values, not {id,value} objects.`);
    }
    if (operator === "equal") passed = JSON.stringify(actual) === JSON.stringify(expected);
    else if (operator === "contains") passed = typeof actual === "string" && typeof expected === "string" ? actual.includes(expected) : Array.isArray(actual) && actual.some((value) => JSON.stringify(value) === JSON.stringify(expected));
    else if (operator === "greaterThan") passed = Number(actual) > Number(expected);
    else if (operator === "lessThan") passed = Number(actual) < Number(expected);
    else if (operator === "match") passed = typeof actual === "string" && typeof expected === "string" && await executeSandboxProgram(`return new RegExp(${JSON.stringify(expected)}).test(${JSON.stringify(actual)});`, async () => { throw new Error("No host capabilities"); }, { signal, timeoutMs: 100 }) === true;
    else {
      const predicate = string(input.predicate, "predicate");
      const result = await executeSandboxProgram(`const observations=${JSON.stringify(values)}; const expected=${JSON.stringify(expected)}; return (${predicate})(observations, expected);`, async () => { throw new Error("Pure predicates cannot call host capabilities"); }, { signal, timeoutMs: 100 });
      if (typeof result !== "boolean") throw new Error("Relation predicate must return a boolean");
      passed = result;
    }
    const id = await this.emit({ kind: precondition ? "precondition" : "assertion", checkpointId: expectation.checkpointId,
      ...(precondition ? {} : { assertion: { clauseId, result: passed ? "satisfied" as const : "violated" as const } }), inputs: ids,
      payload: { clauseId, operator, expected, actual, ...(input.predicate === undefined ? {} : { predicate: input.predicate }), passed, result: passed ? "satisfied" : "violated" } });
    return { id, passed };
  }
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64_000) throw new Error(`${field} must be a nonempty bounded string`);
  return value;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be boolean`);
  return value;
}

function finiteNumber(value: unknown, field: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > maximum) throw new Error(`${field} must be a bounded number`);
  return value;
}
