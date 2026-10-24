import { createHash, randomUUID } from "node:crypto";
import { fork, type ForkOptions } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, BrowserContext, Page, Locator, Download } from "@playwright/test";
import { getQuickJS } from "quickjs-emscripten";
import { renderBinary, renderOptions, type RenderResult } from "./binary-renderer.js";
import { PLAYWRIGHT_GUEST, PlaywrightInterface } from "./playwright-interface.js";

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
  ${PLAYWRIGHT_GUEST}
  const page = (actor, window = 'main', eventObservation) => {
    const auxiliary = (method, input = {}) => call(method, {actor, window, ...input, checkpointId:actionScope?.checkpointId});
    return playwrightPage(Object.freeze({
      inspect: () => auxiliary('inspect'),
      viewport: () => auxiliary('viewport'),
      clipboard: Object.freeze({writeText: value => auxiliary('clipboardWrite',{value}), readText: () => auxiliary('clipboardRead')}),
      storage: Object.freeze({fill: bytes => auxiliary('storageFill',{bytes})}),
      render: (sourceId, options = {}) => auxiliary('render',{sourceId,options}),
    }), actor, window, eventObservation);
  };
  globalThis.browser = Object.freeze({ actor: async name => {await call('actor', {actor:name}); return page(name);} });
  globalThis.check = Object.freeze({ action: checkpointAction, expect: (clauseId, observationIds, predicate) => call('expect', {clauseId, observationIds, predicate}), precondition: (checkpointId, observationIds, predicate) => call('precondition', {checkpointId, observationIds, predicate}) });
})();`;

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
  private readonly playwright: PlaywrightInterface;
  private active = true;
  constructor(
    private readonly browser: Browser,
    private readonly baseUrl: string,
    private readonly emit: (event: WebRuntimeEvent) => Promise<string>,
    private readonly expectations: readonly WebExpectation[] = [],
    private readonly timeoutMs = 5_000,
    private readonly checkpoints: readonly WebCheckpoint[] = [],
  ) {
    this.playwright = new PlaywrightInterface({
      emit: event => this.emit(event),
      observe: (payload, inputs) => this.observation(payload, inputs),
      safeUrl: path => this.safeUrl(path),
      inputCleanup: dispose => this.inputCleanup.add(dispose),
      image: (locator, owner, options, steps, signal) => this.image(locator, owner.actor, owner.window, options, steps, signal),
      openPage: (owner, page) => { const id = randomUUID(); this.actors.get(owner.actor)!.windows.set(id, page); return id; },
      readDownload: (download, owner, encoding, inputs) => this.readDownload(download, owner.actor, owner.window, encoding, inputs),
    }, timeoutMs);
  }

  async run(source: string, options: SandboxOptions): Promise<unknown> {
    return executeSandboxProgram(source, (method, input) => this.invoke(method, input, options.signal), options);
  }
  async close(): Promise<void> {
    this.active = false;
    this.playwright.close();
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
    if (method === "playwright") return this.playwright.invoke({ page, actor: actorName, window: windowName }, input, signal);
    if (method === "inspect") return this.observation({ actor: actorName, window: windowName, value: {
      url: page.url(), text: (await page.locator("body").innerText()).slice(0, 32_000), accessibility: (await page.locator("body").ariaSnapshot()).slice(0, 32_000),
    } });
    if (method === "render") {
      const sourceId = string(input.sourceId, "sourceId");
      const source = this.binaries.get(sourceId);
      if (!source || source.actor !== actorName || source.window !== windowName) throw new Error("Render requires a binary download observation from this actor and window");
      return this.renderObservation(source.bytes, actorName, windowName, input.options ?? {}, [sourceId], signal);
    }
    if (method === "viewport") return this.observation({ actor: actorName, window: windowName, kind: "viewport", value: await page.evaluate(() => ({
      width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
    })) });
    if (method === "storageFill") {
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
    if (method === "clipboardRead") return this.observation({ actor: actorName, window: windowName, kind: "clipboard", value: await page.evaluate(() => navigator.clipboard.readText()) });
    if (method === "clipboardWrite") {
      await page.evaluate(async value => navigator.clipboard.writeText(value), string(input.value, "value"));
      return { id: await this.emit({ kind: "action", checkpointId: input.checkpointId as string | undefined, inputs: [], payload: { method, actor: actorName, window: windowName, value: input.value } }) };
    }
    throw new Error(`Unknown browser method: ${method}`);
  }
  private async image(locator: Locator, actor: string, window: string, options: unknown, steps: unknown, signal: AbortSignal): Promise<unknown> {
    const box = await locator.boundingBox({ timeout: this.timeoutMs });
    if (!box || box.width > 4096 || box.height > 4096) throw new Error("Image observation requires a visible element of at most 4096 pixels per side");
    return this.renderObservation(await locator.screenshot({ timeout: this.timeoutMs }), actor, window, options, [], signal, steps);
  }
  private async renderObservation(bytes: Buffer, actor: string, window: string, rawOptions: unknown, inputs: string[], signal: AbortSignal, locator?: unknown): Promise<unknown> {
    const options = renderOptions(rawOptions);
    const key = createHash("sha256").update(bytes).update(JSON.stringify(options)).digest("hex");
    let result = this.rendered.get(key);
    if (!result) {
      result = await renderBinary(bytes, options, signal);
      if (this.rendered.size >= 16) this.rendered.delete(this.rendered.keys().next().value!);
      this.rendered.set(key, result);
    }
    return this.observation({ actor, window, kind: "rendered-content", ...(locator ? { locator } : {}), value: result.value }, inputs, [{ bytes: result.png, mediaType: "image/png" }]);
  }
  private async readDownload(download: Download, actorName: string, windowName: string, rawEncoding: unknown, inputs: string[]): Promise<unknown> {
    const encoding = rawEncoding === undefined ? "text" : string(rawEncoding, "encoding");
    if (encoding !== "text" && encoding !== "base64") throw new Error("Download encoding must be text or base64");
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
    const content = await this.observation({ actor: actorName, window: windowName, kind: "download", filename: download.suggestedFilename(), encoding, value }, inputs);
    if (encoding === "base64") {
      if ([...this.binaries.values()].reduce((total, source) => total + source.bytes.length, bytes.length) > 16 * 1024 * 1024) throw new Error("Binary downloads exceed the 16 MiB case limit");
      this.binaries.set(content.id, { bytes, actor: actorName, window: windowName });
    }
    const filename = await this.observation({ actor: actorName, window: windowName, kind: "download-filename", value: download.suggestedFilename() });
    return { ...content, filename };
  }
  private safeUrl(path: string): string {
    const url = new URL(path, this.baseUrl);
    if (url.origin !== new URL(this.baseUrl).origin || !/^https?:$/.test(url.protocol) || /\.(?:js|mjs|cjs|map|ts|tsx)(?:$|[?#])/i.test(decodeURIComponent(url.pathname)) || /(?:^|\/)(?:\.(?:git|env)|__debug|@fs|@vite)(?:\/|$)/.test(decodeURIComponent(url.pathname))) throw new Error("Navigation is outside the authorized application surface");
    return url.href;
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

function finiteNumber(value: unknown, field: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > maximum) throw new Error(`${field} must be a bounded number`);
  return value;
}
