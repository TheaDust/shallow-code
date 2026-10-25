import { randomUUID } from "node:crypto";
import type { Page, Frame, Locator, FileChooser, Dialog, Download, ConsoleMessage } from "@playwright/test";
import { dropFiles, fileMetadata, filePayload, pasteImage, uploadDirectory } from "./file-inputs.js";
import type { WebRuntimeEvent } from "./program-runtime.js";

// This is an authority table, not an implementation of Playwright operations.
// Numbers are the position of Playwright timeout options; -1 means no timeout option.
const METHODS = {
  page: { actions: { goto: 1, reload: 0, goBack: 0, goForward: 0, setViewportSize: -1, bringToFront: -1, emulateMedia: -1, close: -1, waitForLoadState: 1, waitForURL: 1 }, reads: ["title", "url", "viewportSize", "isClosed"] },
  locator: { actions: { click: 0, dblclick: 0, fill: 1, press: 1, pressSequentially: 1, clear: 0, check: 0, uncheck: 0, setChecked: 1, selectOption: 1, selectText: 0, hover: 0, focus: 0, blur: 0, dragTo: 1, scrollIntoViewIfNeeded: 0, tap: 0, setInputFiles: 1, waitFor: 0, dropFiles: -1, pasteImage: -1, uploadDirectory: -1 },
    reads: ["innerText", "textContent", "inputValue", "getAttribute", "isChecked", "isVisible", "isHidden", "isEnabled", "isDisabled", "isEditable", "count", "allTextContents", "allInnerTexts", "boundingBox", "ariaSnapshot", "computedStyle", "image"] },
  keyboard: { actions: { down: -1, up: -1, press: 1, type: 1, insertText: -1 }, reads: [] },
  mouse: { actions: { click: 2, dblclick: 2, down: 0, up: 0, move: 2, wheel: -1 }, reads: [] },
  touchscreen: { actions: { tap: -1 }, reads: [] },
  filechooser: { actions: { setFiles: 1 }, reads: ["isMultiple"] },
  dialog: { actions: { accept: -1, dismiss: -1 }, reads: ["message", "type", "defaultValue"] },
  download: { actions: { cancel: -1 }, reads: ["suggestedFilename", "url", "failure", "read"] },
  console: { actions: {}, reads: ["type", "text", "location"] },
} as const;
const SELECTORS = ["getByRole", "getByLabel", "getByText", "getByTestId", "getByPlaceholder", "getByAltText", "getByTitle", "locator", "frameLocator", "filter", "and", "or"];
const EVENTS = ["filechooser", "download", "popup", "dialog", "close", "domcontentloaded", "load", "console", "pageerror"] as const;
const READ_OPTIONS: Record<string, number> = { innerText: 0, textContent: 0, inputValue: 0, getAttribute: 1, isChecked: 0, isVisible: 0, isHidden: 0, isEnabled: 0, isDisabled: 0, isEditable: 0, boundingBox: 0, ariaSnapshot: 0 };
export const PLAYWRIGHT_INTERFACE = { selectors: SELECTORS, methods: METHODS, events: EVENTS, actorOptions: { hasTouch: "boolean; fixed at actor creation, default false" } };
type Kind = keyof typeof METHODS;
type EventName = typeof EVENTS[number];
interface Step { method: string; args: unknown[] }
export interface PlaywrightOwner { page: Page; actor: string; window: string }
interface Handle { kind: "filechooser" | "dialog" | "download" | "console"; value: FileChooser | Dialog | Download | ConsoleMessage; owner: PlaywrightOwner; receipt: string }
interface Watch { owner: PlaywrightOwner; event: EventName; startedAt: number; durationMs: number; count: number; events: unknown[]; actions: string[]; listener: (value: unknown) => void }
interface Evidence {
  emit(event: WebRuntimeEvent): Promise<string>;
  observe(payload: Record<string, unknown>, inputs?: string[]): Promise<{ id: string; value: unknown }>;
  safeUrl(path: string): string;
  inputCleanup(dispose: () => Promise<void>): void;
  image(locator: Locator, owner: PlaywrightOwner, options: unknown, steps: unknown, signal: AbortSignal): Promise<unknown>;
  openPage(owner: PlaywrightOwner, page: Page): string;
  readDownload(download: Download, owner: PlaywrightOwner, encoding: unknown, inputs: string[]): Promise<unknown>;
}

/** Owns the authority and receipts around native Playwright objects. No objects cross IPC. */
export class PlaywrightInterface {
  private readonly handles = new Map<string, Handle>();
  private readonly watches = new Map<string, Watch>();
  constructor(private readonly evidence: Evidence, private readonly timeoutMs: number) {}

  close(): void {
    for (const watch of this.watches.values()) this.unlisten(watch);
    this.watches.clear();
    this.handles.clear();
  }

  async invoke(owner: PlaywrightOwner, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const operation = input.operation;
    if (operation === "waitForEvent") {
      const event = this.eventName(input.event);
      const value = await owner.page.waitForEvent(event as "download", { timeout: this.timeout(input.timeout) });
      signal.throwIfAborted();
      return this.eventHandle(owner, event, value);
    }
    if (operation === "watch") {
      if (this.watches.size >= 32) throw new Error("Browser event observation limit exceeded");
      const event = this.eventName(input.event);
      const watch: Watch = { owner, event, startedAt: Date.now(), durationMs: this.timeout(input.durationMs), count: 0, events: [], actions: [], listener: () => {} };
      watch.listener = value => { watch.count++; if (watch.events.length < 100) watch.events.push(this.eventValue(event, value)); };
      owner.page.on(event as "download", watch.listener);
      const id = randomUUID();
      this.watches.set(id, watch);
      return id;
    }
    if (operation === "finishWatch" || operation === "cancelWatch") {
      const id = String(input.watch);
      const watch = this.watches.get(id);
      if (!watch || !this.sameOwner(watch.owner, owner)) throw new Error("Unknown or foreign browser event observation");
      try {
        if (operation === "cancelWatch") return null;
        const actionCompletedAt = Date.now();
        await new Promise<void>((resolve) => { const timer = setTimeout(resolve, watch.durationMs); timer.unref(); });
        signal.throwIfAborted();
        if (!watch.actions.length) throw new Error("Event observation requires a completed browser action in its window");
        return this.evidence.observe({ actor: owner.actor, window: owner.window, kind: "browser-events", event: watch.event,
          value: { count: watch.count, events: watch.events, truncated: watch.count > watch.events.length, startedAt: watch.startedAt, actionCompletedAt, endedAt: Date.now(), durationMs: watch.durationMs } }, watch.actions);
      } finally { this.unlisten(watch); this.watches.delete(id); }
    }
    if (operation !== "call") throw new Error("Unknown Playwright operation");
    const kind = String(input.kind) as Kind;
    if (!Object.hasOwn(METHODS, kind)) throw new Error("Unknown Playwright object kind");
    const method = String(input.method);
    const policy = METHODS[kind];
    const action = Object.hasOwn(policy.actions, method);
    if (!action && !(policy.reads as readonly string[]).includes(method)) throw new Error(`Playwright ${kind}.${method} is outside the authorized interface`);
    if (!Array.isArray(input.args)) throw new Error("Playwright arguments must be an array");
    const args = await this.decode(input.args, owner) as unknown[];
    let receiver: unknown;
    let handle: Handle | undefined;
    if (kind === "page") receiver = owner.page;
    else if (kind === "locator") receiver = await this.locator(owner, input.steps);
    else if (kind === "keyboard" || kind === "mouse" || kind === "touchscreen") {
      receiver = owner.page[kind];
    } else {
      handle = this.handles.get(String(input.handle));
      if (!handle || handle.kind !== kind || !this.sameOwner(handle.owner, owner)) throw new Error("Unknown, expired or foreign Playwright handle");
      receiver = handle.value;
    }
    let files: ReturnType<typeof filePayload> | undefined;
    let directory: unknown;
    if (method === "setFiles" || method === "setInputFiles") {
      files = Array.isArray(args[0]) && args[0].length === 0 ? [] : filePayload(args[0]);
      args[0] = files;
    }
    if (kind === "download" && method === "read") return this.evidence.readDownload(receiver as Download, owner, args[0], [handle!.receipt]);
    if (kind === "page" && method === "goto") args[0] = this.evidence.safeUrl(String(args[0]));
    if (kind === "page" && (method === "emulateMedia" || method === "close")) {
      const keys = method === "emulateMedia" ? ["media", "colorScheme", "reducedMotion", "forcedColors", "contrast"] : ["runBeforeUnload", "reason"];
      if (args[0] !== undefined && (!args[0] || typeof args[0] !== "object" || Array.isArray(args[0]) || Object.keys(args[0]).some(key => !keys.includes(key)))) throw new Error(`Unsupported Playwright page.${method} options`);
    }
    if (kind === "page" && method === "setViewportSize") {
      const size = args[0] as { width?: number; height?: number } | undefined;
      if (!size || !Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width! < 240 || size.width! > 3840 || size.height! < 240 || size.height! > 2160) throw new Error("Viewport dimensions must be within 240–3840 by 240–2160 pixels");
    }
    if (action || kind === "locator" && Object.hasOwn(READ_OPTIONS, method)) {
      const position = action ? (policy.actions as Record<string, number>)[method]! : READ_OPTIONS[method]!;
      if (position >= 0) {
        const options = args[position];
        if (options !== undefined && (!options || typeof options !== "object" || Array.isArray(options))) throw new Error("Playwright options must be an object");
        const bounded = { ...(options as Record<string, unknown> | undefined) };
        if (bounded.force !== undefined || bounded.trial !== undefined) throw new Error("force and trial cannot establish an executed UI action");
        if (bounded.strict !== undefined) throw new Error("Playwright locator strictness cannot be overridden");
        if (bounded.checkpointId !== undefined) throw new Error("Pass checkpointId through check.action, not Playwright options");
        bounded.timeout = this.timeout(bounded.timeout);
        if (bounded.delay !== undefined) bounded.delay = bounded.delay === 0 ? 0 : this.timeout(bounded.delay);
        args[position] = bounded;
      }
    }
    // Native strictness and auto-waiting apply. No count-before-click race or first-match fallback.
    let value: unknown;
    if (kind === "locator" && method === "image") return this.evidence.image(receiver as Locator, owner, args[0] ?? {}, input.steps, signal);
    if (kind === "locator" && method === "computedStyle") {
      if (typeof args[0] !== "string" || !args[0].length || args[0].length > 255) throw new Error("CSS property must be a bounded string");
      value = await (receiver as Locator).evaluate((element, property) => getComputedStyle(element).getPropertyValue(property), args[0]);
    } else if (kind === "locator" && method === "uploadDirectory") {
      const { dispose, ...metadata } = await uploadDirectory(receiver as Locator, args[0]);
      this.evidence.inputCleanup(dispose); directory = metadata;
    } else if (kind === "locator" && (method === "dropFiles" || method === "pasteImage")) {
      files = filePayload(args[0]);
      const locator = receiver as Locator;
      // Input helpers operate on one actual element, just like native Locator actions.
      await locator.waitFor({ state: "visible", timeout: this.timeoutMs });
      if (await locator.count() !== 1) throw new Error("Input helper locator must identify exactly one element");
      if (method === "dropFiles") await dropFiles(owner.page, locator, files);
      else {
        if (files.length !== 1) throw new Error("Paste requires one image");
        await pasteImage(owner.page, locator, files[0]!);
      }
    } else value = await (receiver as Record<string, (...args: unknown[]) => unknown>)[method]!(...args);
    signal.throwIfAborted();
    this.evidence.safeUrl(owner.page.url());
    if (!action) {
      if (Buffer.byteLength(JSON.stringify(value) ?? "null") > 64_000) throw new Error("Playwright observation exceeds 64 KB; narrow the locator or read a smaller property");
      return this.evidence.observe({ actor: owner.actor, window: owner.window, kind: `playwright.${kind}.${method}`, locator: input.steps, args: input.args, value }, handle ? [handle.receipt] : []);
    }
    // Waits establish conditions, not a requirement action.
    if (["waitFor", "waitForLoadState", "waitForURL"].includes(method)) return null;
    const id = await this.evidence.emit({ kind: "action", checkpointId: input.checkpointId as string | undefined,
      inputs: handle ? [handle.receipt] : [], payload: { method: `playwright.${kind}.${method}`, actor: owner.actor, window: owner.window,
        ...(input.steps ? { locator: input.steps } : {}), ...(directory ? { directory } : files ? { files: fileMetadata(files) } : { args: input.args }) } });
    for (const watch of this.watches.values()) if (this.sameOwner(watch.owner, owner)) watch.actions.push(id);
    return { id };
  }

  private async locator(owner: PlaywrightOwner, raw: unknown): Promise<Locator> {
    if (!Array.isArray(raw) || !raw.length || raw.length > 32) throw new Error("A bounded Playwright locator chain is required");
    let target: Page | Frame | Locator = owner.page;
    for (const rawStep of raw) {
      const step = rawStep as Step;
      if (!step || !SELECTORS.includes(step.method) || !Array.isArray(step.args)) throw new Error("Unsupported Playwright locator method");
      const args = await this.decode(step.args, owner) as unknown[];
      if (step.method === "frameLocator") {
        const element = await target.locator(String(args[0])).elementHandle({ timeout: this.timeoutMs });
        try {
          const frame: Frame | null | undefined = await element?.contentFrame();
          if (!frame) throw new Error("Frame locator must identify a frame");
          this.evidence.safeUrl(frame.url());
          target = frame;
        } finally { await element?.dispose(); }
      } else {
        const operation: ((...args: unknown[]) => Locator) | undefined = (target as unknown as Record<string, (...args: unknown[]) => Locator>)[step.method];
        if (typeof operation !== "function") throw new Error(`Invalid locator chain: ${step.method}`);
        target = operation.apply(target, args);
      }
    }
    if (!("count" in target)) throw new Error("The chain must resolve to a locator");
    return target;
  }
  private async decode(raw: unknown, owner: PlaywrightOwner): Promise<unknown> {
    if (Array.isArray(raw)) return Promise.all(raw.map(value => this.decode(value, owner)));
    if (raw && typeof raw === "object") {
      const value = raw as Record<string, unknown>;
      if (value.__pwRegex !== undefined) return new RegExp(String(value.__pwRegex), String(value.flags ?? ""));
      if (value.__pwLocator !== undefined) {
        if (value.actor !== owner.actor || value.window !== owner.window) throw new Error("Locator arguments must belong to the same actor and window");
        return this.locator(owner, value.__pwLocator);
      }
      return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await this.decode(item, owner)])));
    }
    return raw;
  }
  private async eventHandle(owner: PlaywrightOwner, event: EventName, value: unknown): Promise<unknown> {
    const observation = await this.evidence.observe({ actor: owner.actor, window: owner.window, kind: "browser-event", event, value: { event, detail: this.eventValue(event, value) } });
    if (event === "close" || event === "domcontentloaded" || event === "load" || event === "pageerror") return { observation };
    if (event === "popup") {
      const page = value as Page;
      await page.waitForLoadState("domcontentloaded", { timeout: this.timeoutMs });
      this.evidence.safeUrl(page.url());
      return { __pwPage: this.evidence.openPage(owner, page), observation };
    }
    if (this.handles.size >= 64) throw new Error("Playwright event handle limit exceeded");
    const id = randomUUID();
    this.handles.set(id, { kind: event, value: value as Handle["value"], owner, receipt: observation.id });
    return { __pwHandle: id, kind: event, observation };
  }
  private eventValue(event: EventName, value: unknown): unknown {
    if (event === "close" || event === "domcontentloaded" || event === "load") return {};
    if (event === "console") {
      const message = value as ConsoleMessage, text = message.text();
      return { type: message.type(), text: text.slice(0, 4096), truncated: text.length > 4096 };
    }
    if (event === "pageerror") {
      const error = value as Error;
      return { name: error.name, message: error.message.slice(0, 4096), truncated: error.message.length > 4096 };
    }
    if (event === "download") return { filename: (value as Download).suggestedFilename(), url: (value as Download).url() };
    if (event === "dialog") return { type: (value as Dialog).type(), message: (value as Dialog).message() };
    if (event === "filechooser") return { multiple: (value as FileChooser).isMultiple() };
    return { url: (value as Page).url() };
  }
  private eventName(value: unknown): EventName {
    if (!(EVENTS as readonly unknown[]).includes(value)) throw new Error("Unsupported browser event");
    return value as EventName;
  }
  private timeout(value: unknown): number {
    if (value === undefined) return this.timeoutMs;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Timeout or delay must be a nonnegative bounded number");
    return value === 0 ? this.timeoutMs : Math.min(this.timeoutMs, value);
  }
  private sameOwner(a: PlaywrightOwner, b: PlaywrightOwner): boolean { return a.page === b.page && a.actor === b.actor && a.window === b.window; }
  private unlisten(watch: Watch): void { watch.owner.page.off(watch.event as "download", watch.listener); }
}

/** Guest-side facades carry locator descriptions and opaque event IDs, never host objects. */
export const PLAYWRIGHT_GUEST = String.raw`
  const pwMethods = ${JSON.stringify(METHODS)};
  const pwSelectors = ${JSON.stringify(SELECTORS)};
  const pwLocators = new WeakMap();
  let actionScope;
  const pwEncode = value => {
    if (value instanceof RegExp) return {__pwRegex:value.source,flags:value.flags};
    if (value && pwLocators.has(value)) return pwLocators.get(value);
    if (Array.isArray(value)) return value.map(pwEncode);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,pwEncode(item)]));
    return value;
  };
  const playwrightPage = (extensions, actor, window, eventObservation) => {
    const invoke = input => call('playwright', {actor,window,...input});
    const proxy = (kind, steps = [], handle, eventReceipt) => {
      const value = new Proxy({}, {get: (_, name) => {
        if (name === 'then') return undefined;
        if (name === 'eventObservation') return eventReceipt;
        if ((kind === 'page' || kind === 'locator') && pwSelectors.includes(name)) return (...args) => proxy('locator', [...steps,{method:name,args:pwEncode(args)}]);
        if (kind === 'page' && (name === 'keyboard' || name === 'mouse' || name === 'touchscreen')) return proxy(name);
        if (kind === 'page' && name === 'waitForEvent') return (event, options = {}) => {
          if (typeof options !== 'object' || options === null || Object.keys(options).some(key=>key!=='timeout')) throw new Error('waitForEvent only accepts the timeout option');
          const pending = invoke({operation:'waitForEvent',event,timeout:options.timeout}).then(result => result.__pwPage ? page(actor,result.__pwPage,result.observation) : result.__pwHandle ? proxy(result.kind,[],result.__pwHandle,result.observation) : result.observation);
          pending.catch(()=>{}); // A click failure can leave its pre-armed event promise unconsumed.
          return pending;
        };
        if (kind === 'page' && name === 'observeEvents') return async (event, options, action) => {
          if (typeof action !== 'function') throw new Error('observeEvents requires an action callback');
          const watch = await invoke({operation:'watch',event,durationMs:options.durationMs});
          try { await action(); }
          catch (error) { await invoke({operation:'cancelWatch',watch}); throw error; }
          return invoke({operation:'finishWatch',watch});
        };
        const policy = pwMethods[kind];
        if (Object.hasOwn(policy.actions,name) || policy.reads.includes(name)) return (...args) => {
          const promise = invoke({operation:'call',kind,steps,handle,method:name,args:pwEncode(args),checkpointId:actionScope?.checkpointId});
          if (actionScope) actionScope.pending.push(promise);
          return promise;
        };
        return kind === 'page' && Object.hasOwn(extensions,name) ? extensions[name] : undefined;
      }});
      if (kind === 'locator') pwLocators.set(value,{__pwLocator:steps,actor,window});
      return value;
    };
    return proxy('page',[],undefined,eventObservation);
  };
  const checkpointAction = async (checkpointId, action) => {
    if (actionScope) throw new Error('check.action cannot be nested or concurrent');
    if (typeof checkpointId !== 'string' || !checkpointId.length) throw new Error('check.action requires a checkpoint ID');
    if (typeof action !== 'function') throw new Error('check.action requires an action callback');
    const scope = {checkpointId,pending:[]};
    actionScope = scope;
    try { const result = await action(); await Promise.all(scope.pending); return result; }
    finally { actionScope = undefined; }
  };
`;
