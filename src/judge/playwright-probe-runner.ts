import {
  chromium,
  expect,
  type Browser,
  type BrowserContext,
  type Download,
  type Locator,
  type Page,
} from "@playwright/test";
import type { Readable } from "node:stream";

import { locatorCandidates, type ProbeCase, type ProbeLocator, type ProbePlan, type ProbeStep } from "./probe-schema.js";
import type { ProbeFailure, ShadowReport } from "../types.js";
import { ExecutionFault } from "../execution-fault.js";
import { sharedMemoryGate, type MemoryGate } from "../memory-gate.js";
import { sanitizeDiagnosticText } from "../diagnostics.js";

/** Headroom reserved before launching a probe browser (browser + renderer + page). */
const PROBE_BROWSER_HEADROOM_BYTES = 400 * 1_048_576;
const MAX_DOWNLOAD_BYTES = 64 * 1_024;

export interface ProbeRunOptions {
  baseUrl: string;
  stepTimeoutMs: number;
  caseTimeoutMs: number;
  /** Controller-owned fresh application data, preserving one browser launch per plan. */
  prepareCase?: () => Promise<string>;
}

interface BrowserSession {
  context: BrowserContext;
  page: Page;
  crashed: boolean;
  homeRoute?: string;
}

class ProbeExecutionError extends Error {
  constructor(
    readonly category: ProbeFailure["category"],
    message: string,
    readonly locatorSnapshot?: string,
    readonly locatorAttempts?: ProbeFailure["locatorAttempts"],
  ) {
    super(message);
    this.name = "ProbeExecutionError";
  }
}

export function deriveProbeVerdict(
  failures: ProbeFailure[],
): ShadowReport["verdict"] {
  if (failures.length === 0) return "pass";
  if (failures.some(failure => ["assertion", "navigation", "timeout"].includes(failure.category))) return "fail";
  if (failures.some(failure => failure.category === "precondition")) return "inconclusive";
  if (failures.some(failure => failure.category === "runner")) return "inconclusive";
  const locatorOnly = failures.every((failure) => failure.category === "locator");
  const hasSnapshot = failures.some(
    (failure) => failure.locatorSnapshot !== undefined,
  );
  return locatorOnly && hasSnapshot ? "inconclusive" : "fail";
}

export class PlaywrightProbeRunner {
  constructor(
    private readonly launchBrowser: () => Promise<Browser> = () => chromium.launch({ headless: true }),
    private readonly memoryGate: MemoryGate = sharedMemoryGate(),
  ) {}

  async run(plan: ProbePlan, options: ProbeRunOptions): Promise<ShadowReport> {
    let browser: Browser | undefined;
    const passedCases: string[] = [];
    const failures: ProbeFailure[] = [];

    try {
      try {
        await this.memoryGate.waitForHeadroom(PROBE_BROWSER_HEADROOM_BYTES);
        browser = await this.launchBrowser();
      } catch (error) {
        throw new ExecutionFault("browser", "browser_launch", false, { cause: error });
      }
      for (const probeCase of plan.cases) {
        const baseUrl = await options.prepareCase?.() ?? options.baseUrl;
        const failure = await this.runCase(browser, probeCase, { ...options, baseUrl });
        if (failure) failures.push(failure);
        else passedCases.push(probeCase.id);
      }
    } catch (error) {
      const fault = error instanceof ExecutionFault ? error
        : browser && !browser.isConnected()
        ? new ExecutionFault("browser", "browser_disconnected", true, { cause: error }) : undefined;
      // Earlier deterministic product failures must not be erased by a later crash/retry.
      if (fault && !failures.some((failure) =>
        ["assertion", "navigation", "timeout"].includes(failure.category))) throw fault;
      failures.push({
        caseId: "<runner>",
        stepIndex: -1,
        category: "runner",
        message: compactError(error),
      });
    } finally {
      await browser?.close().catch(() => undefined);
    }

    return {
      packetId: plan.packetId,
      verdict: deriveProbeVerdict(failures),
      passedCases,
      failures,
    };
  }

  private async runCase(
    browser: Browser,
    probeCase: ProbeCase,
    options: ProbeRunOptions,
  ): Promise<ProbeFailure | undefined> {
    let session = await createSession(browser);
    const namedSessions = new Map<string, BrowserSession>([["default", session]]);
    const deadline = Date.now() + options.caseTimeoutMs;
    try {
      for (let stepIndex = 0; stepIndex < probeCase.steps.length; stepIndex += 1) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          return {
            caseId: probeCase.id,
            stepIndex,
            category: stepIndex < (probeCase.setupStepCount ?? 0) ? "precondition" : "timeout",
            message: `Case exceeded ${options.caseTimeoutMs}ms`,
            pageUrl: sanitizeDiagnosticText(session.page.url(), [], 1_000),
          };
        }
        const timeoutMs = Math.min(options.stepTimeoutMs, remainingMs);
        try {
          session = await executeStep(
            browser,
            session,
            probeCase.steps[stepIndex],
            options.baseUrl,
            timeoutMs,
            namedSessions,
          );
        } catch (error) {
          if (session.crashed || !browser.isConnected()) {
            throw new ExecutionFault("browser", session.crashed ? "page_crashed" : "browser_disconnected", true, { cause: error });
          }
          const executionError =
            error instanceof ProbeExecutionError
              ? error
              : new ProbeExecutionError("runner", compactError(error));
          return {
            caseId: probeCase.id,
            stepIndex,
            category: stepIndex < (probeCase.setupStepCount ?? 0) && executionError.category !== "runner"
              ? "precondition" : executionError.category,
            message: compactError(executionError),
            pageUrl: sanitizeDiagnosticText(session.page.url(), [], 1_000),
            ...fileInputSummary(probeCase.steps.slice(0, stepIndex)),
            ...(executionError.locatorAttempts ? { locatorAttempts: executionError.locatorAttempts } : {}),
            ...(executionError.locatorSnapshot
              ? { locatorSnapshot: executionError.locatorSnapshot }
              : {}),
          };
        }
      }
      return undefined;
    } finally {
      await Promise.all([...new Set([...namedSessions.values(), session])]
        .map(item => item.context.close().catch(() => undefined)));
    }
  }
}

/** Input shape only: no uploaded content or hidden step sequence reaches Builder. */
function fileInputSummary(completedSteps: ProbeStep[]): { inputSummary?: string } {
  const file = completedSteps.reverse().find(step => step.op === "uploadFile");
  if (file?.op !== "uploadFile") return {};
  return { inputSummary: `最近成功上传的文件：UTF-8 ${Buffer.byteLength(file.content, "utf8")} 字节；` +
    `换行符 ${(file.content.match(/\r\n|\r|\n/g) ?? []).length} 个；文件末尾${/[\r\n]$/.test(file.content) ? "有" : "无"}换行。` };
}

async function executeStep(
  browser: Browser,
  session: BrowserSession,
  step: ProbeStep,
  baseUrl: string,
  timeoutMs: number,
  namedSessions: Map<string, BrowserSession>,
): Promise<BrowserSession> {
  if (step.op === "newContext") {
    // Keep named sessions available for switchContext; an unnamed session that
    // was itself replaced has no reachable handle and can be released now.
    if (![...namedSessions.values()].includes(session)) await session.context.close();
    const next = await createSession(browser);
    if (step.actor) namedSessions.set(step.actor, next);
    return next;
  }
  if (step.op === "switchContext") {
    const selected = namedSessions.get(step.actor);
    if (!selected) throw new ProbeExecutionError("runner", `Unknown browser context actor: ${step.actor}`);
    return selected;
  }
  if (step.op === "goto") {
    const base = new URL(baseUrl);
    if (!step.path.startsWith("/") || step.path.startsWith("//")) {
      throw new ProbeExecutionError("navigation", "Navigation path must be relative to app origin");
    }
    const target = new URL(step.path, base);
    if (target.origin !== base.origin) {
      throw new ProbeExecutionError("navigation", "Navigation target changed app origin");
    }
    try {
      await session.page.goto(target.href, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      if (step.path === "/") session.homeRoute = routeIdentity(session.page.url());
      return session;
    } catch (error) {
      throw new ProbeExecutionError("navigation", compactError(error));
    }
  }
  if (step.op === "expectAwayFromHome") {
    if (!session.homeRoute || routeIdentity(session.page.url()) === session.homeRoute) {
      throw new ProbeExecutionError("runner", "Compatibility preparation did not reach a route beyond the home page");
    }
    return session;
  }
  if (step.op === "expectFormContext") {
    const field = await resolveLocator(session, { op: "expectValue", locator: step.locator, value: step.value }, timeoutMs);
    const form = field.locator("xpath=ancestor::form[1]");
    if (await form.count() !== 1) throw new ProbeExecutionError("runner", "The submitted field has no established native form context");
    try {
      // The submitted field identifies the existing native form. A list or a
      // hidden template elsewhere cannot satisfy a failed-form convention.
      await expect(form).toBeVisible({ timeout: timeoutMs });
      const identifier = form.getByText(step.value, { exact: true }).filter({ visible: true });
      await expect(identifier).toHaveCount(1, { timeout: timeoutMs });
      return session;
    } catch (error) {
      throw new ProbeExecutionError("assertion", `The failed form must visibly retain one submitted identifier ${JSON.stringify(step.value)}: ${compactError(error)}`);
    }
  }
  if (step.op === "reload") {
    try {
      await session.page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
      return session;
    } catch (error) {
      throw new ProbeExecutionError("navigation", compactError(error));
    }
  }
  if (step.op === "expectUrlContains") {
    try {
      await expect.poll(() => session.page.url(), { timeout: timeoutMs,
        message: `Expected page URL to contain ${JSON.stringify(step.value)}` })
        .toContain(step.value);
      return session;
    } catch (error) {
      throw new ProbeExecutionError("assertion", compactError(error));
    }
  }
  if (step.op === "expectAccessibleCount") {
    let observed: string[] = [];
    let target: Locator | undefined;
    try {
      const noun = escapeRegex(step.noun.replace(/s$/i, ""));
      const pattern = new RegExp(`^(\\d+)\\s+${noun}(?:s)?$`, "i");
      let root: Page | Locator = session.page;
      if (step.scope) {
        root = locate(session.page, step.scope as ProbeLocator);
        if (step.scope.hasText !== undefined) root = root.filter({ hasText: step.scope.hasText });
        await expect(root).toBeVisible({ timeout: timeoutMs });
      }
      target = root.getByText(pattern, { exact: true }).filter({ visible: true });
      await expect.poll(async () => {
        observed = await target!.allTextContents();
        if (observed.length !== 1) return false;
        const count = Number(pattern.exec(observed[0].trim())?.[1]);
        return step.exact !== undefined ? count === step.exact : count >= step.minimum;
      }, { timeout: timeoutMs, message: `Expected an aggregate accessible ${step.noun} count` })
        .toBe(true);
      return session;
    } catch (error) {
      const expected = step.exact !== undefined ? `exactly ${step.exact}` : `at least ${step.minimum}`;
      throw new ProbeExecutionError(observed.length > 1 ? "locator" : "assertion",
        `Expected one visible ${step.noun} count, ${expected}; observed ${JSON.stringify(observed.slice(0, 3))}. ${compactError(error)}`,
        await ariaSnapshot(session.page, timeoutMs, target, step.scope));
    }
  }
  if (step.op === "expectClosedOverlaysEmpty") {
    try {
      await expect.poll(() => session.page.locator('dialog,[role="dialog"],[role="alertdialog"],[role="menu"]')
        .evaluateAll(elements => elements.flatMap(element => {
          const style = getComputedStyle(element);
          const closed = element instanceof HTMLDialogElement && !element.open || element.hasAttribute("hidden") ||
            element.getAttribute("aria-hidden") === "true" || element.getAttribute("data-state") === "closed" ||
            style.display === "none" || style.visibility === "hidden";
          if (!closed) return [];
          const content = element.querySelector('h1,h2,h3,h4,h5,h6,p,form,input,textarea,select,button,a,[role="button"],[role="link"],[role="menuitem"]');
          if (!content) return [];
          const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
          return [{ tag: element.tagName.toLowerCase(), role: element.getAttribute("role") ?? "",
            text: text.slice(0, 160), controls: element.querySelectorAll('input,textarea,select,button,a,[role="button"],[role="link"],[role="menuitem"]').length }];
        })), { timeout: timeoutMs, message: "Closed dialog/menu content must leave the user query surface" })
        .toEqual([]);
      return session;
    } catch (error) {
      throw new ProbeExecutionError("assertion", compactError(error));
    }
  }
  if (step.op === "setClipboardText") {
    try {
      await session.context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await session.page.evaluate(value => navigator.clipboard.writeText(value), step.text);
      return session;
    } catch (error) {
      throw new ProbeExecutionError("runner", `Clipboard setup failed: ${compactError(error)}`);
    }
  }
  if (step.op === "drag") {
    const from = await resolveLocator(session, { op: "click", locator: step.from }, timeoutMs);
    const to = await resolveLocator(session, { op: "click", locator: step.to }, timeoutMs);
    try {
      await from.dragTo(to, { timeout: timeoutMs });
      return session;
    } catch (error) {
      throw new ProbeExecutionError("timeout", compactError(error));
    }
  }

  const locator = await resolveLocator(session, step, timeoutMs);

  try {
    switch (step.op) {
      case "click":
        await locator.click({ timeout: timeoutMs });
        break;
      case "rightClick":
        await locator.click({ button: "right", timeout: timeoutMs });
        break;
      case "doubleClick":
        await locator.dblclick({ timeout: timeoutMs });
        break;
      case "hover":
        await locator.hover({ timeout: timeoutMs });
        break;
      case "press":
        await locator.press(step.key, { timeout: timeoutMs });
        break;
      case "fill":
        await locator.fill(step.value, { timeout: timeoutMs });
        break;
      case "uploadFile":
        await locator.setInputFiles({ name: step.fileName,
          mimeType: step.fileName.toLowerCase().endsWith(".csv") ? "text/csv" : "text/plain",
          buffer: Buffer.from(step.content, "utf8") }, { timeout: timeoutMs });
        break;
      case "select":
        if (await locator.evaluate(element => element.tagName === "SELECT", undefined, { timeout: timeoutMs })) {
          await locator.selectOption(step.value, { timeout: timeoutMs });
        } else {
          // Select-only ARIA comboboxes expose their choices only after the
          // control opens. Keep `select` portable across native selects and
          // visible listbox implementations without reaching into app DOM.
          await locator.click({ timeout: timeoutMs });
          const controlledIds = (await locator.getAttribute("aria-controls", { timeout: timeoutMs }))?.trim().split(/\s+/).filter(Boolean) ?? [];
          if (!controlledIds.length) {
            throw new ProbeExecutionError("locator", "Cannot associate the combobox with a listbox without aria-controls");
          }
          // The popup may be portalled outside the control's declared scope.
          // Follow its public ARIA relation instead of choosing an unrelated option.
          const selector = await session.page.evaluate(ids => ids.map(id => `#${CSS.escape(id)}`).join(","), controlledIds);
          const listbox = session.page.getByRole("listbox").and(session.page.locator(selector)).filter({ visible: true });
          await listbox.waitFor({ state: "visible", timeout: timeoutMs });
          const option = listbox.getByRole("option", { name: step.value, exact: true }).filter({ visible: true });
          await option.click({ timeout: timeoutMs });
        }
        break;
      case "setChecked":
        await locator.setChecked(step.checked, { timeout: timeoutMs });
        break;
      case "expectVisible":
        await expect(locator).toBeVisible({ timeout: timeoutMs });
        break;
      case "expectDisabled":
        await expect(locator).toBeDisabled({ timeout: timeoutMs });
        break;
      case "expectEnabled":
        await expect(locator).toBeEnabled({ timeout: timeoutMs });
        break;
      case "expectHidden":
        // Every alternative must be hidden: a missing primary must not hide a
        // still-visible fallback from a negative assertion.
        for (const candidate of locatorCandidates(step.locator)) {
          await expect(locate(session.page, candidate)).toBeHidden({ timeout: timeoutMs });
        }
        break;
      case "expectAttribute":
        if (step.attribute === "aria-checked" &&
          await locator.evaluate(element => element instanceof HTMLInputElement &&
            ["checkbox", "radio"].includes(element.type), undefined, { timeout: timeoutMs })) {
          if (step.value === "mixed") {
            await expect(locator).toHaveJSProperty("indeterminate", true, { timeout: timeoutMs });
          } else {
            await expect(locator).toHaveJSProperty("checked", step.value === "true", { timeout: timeoutMs });
            await expect(locator).toHaveJSProperty("indeterminate", false, { timeout: timeoutMs });
          }
        } else if (step.attribute === "aria-selected" && step.value !== "mixed" &&
          await locator.evaluate(element => element.tagName === "OPTION", undefined, { timeout: timeoutMs })) {
          await expect(locator).toHaveJSProperty("selected", step.value === "true", { timeout: timeoutMs });
        } else {
          await expect(locator).toHaveAttribute(step.attribute, step.value, { timeout: timeoutMs });
        }
        break;
      case "expectCss":
        if (step.differentFrom) {
          const other = await resolveLocator(session, { op: "expectVisible", locator: step.differentFrom }, timeoutMs);
          await expect(locator).toBeVisible({ timeout: timeoutMs });
          const different = async () => {
            const [color, otherColor] = await Promise.all([
              locator.evaluate((element, property) => getComputedStyle(element).getPropertyValue(property), step.property, { timeout: timeoutMs }),
              other.evaluate((element, property) => getComputedStyle(element).getPropertyValue(property), step.property, { timeout: timeoutMs }),
            ]);
            return color !== otherColor;
          };
          if (step.immediate) {
            expect(await different(), `Expected different computed ${step.property} immediately`).toBe(true);
          } else {
            await expect.poll(different, { timeout: timeoutMs,
              message: `Expected different computed ${step.property}` }).toBe(true);
          }
        } else {
          await expect(locator).toBeVisible({ timeout: timeoutMs });
          if (step.immediate) {
            const actual = await locator.evaluate((element, property) => getComputedStyle(element).getPropertyValue(property),
              step.property, { timeout: timeoutMs });
            if (step.notValue !== undefined) expect(actual).not.toBe(step.notValue);
            else expect(actual, `Expected computed ${step.property} immediately`).toBe(step.value);
          } else {
            if (step.notValue !== undefined) await expect(locator).not.toHaveCSS(step.property, step.notValue, { timeout: timeoutMs });
            else await expect(locator).toHaveCSS(step.property, step.value, { timeout: timeoutMs });
          }
        }
        break;
      case "expectText":
        await expectAnyText(locator, step, timeoutMs);
        break;
      case "expectDownload": {
        const deadline = Date.now() + timeoutMs;
        const [download] = await Promise.all([
          session.page.waitForEvent("download", { timeout: timeoutMs }),
          locator.click({ timeout: timeoutMs }),
        ]);
        if (!download.suggestedFilename().endsWith(step.fileNameSuffix)) {
          throw new Error("Downloaded filename does not have the required suffix");
        }
        const text = await downloadedUtf8Text(download, Math.max(1, deadline - Date.now()));
        const normalize = (value: string) => value.replace(/\r\n/g, "\n");
        if (normalize(text) !== normalize(step.text)) {
          throw new Error(`Downloaded UTF-8 text differs from expected content (expected ${Buffer.byteLength(step.text)} bytes, received ${Buffer.byteLength(text)} bytes)`);
        }
        break;
      }
      case "expectValue":
        await expect(locator).toHaveValue(step.value, { timeout: timeoutMs });
        break;
      case "expectCount":
        await expect(locator).toHaveCount(step.count, { timeout: timeoutMs });
        break;
    }
  } catch (error) {
    const assertion = step.op.startsWith("expect");
    const message = step.op === "expectCss"
      ? `Computed ${step.property}${step.immediate ? " immediately" : ""}: ${compactError(error)}`
      : compactError(error);
    const invalidProbeOperation = step.op === "fill" && /input of type ["']?file["']? cannot be filled/i.test(message);
    const ambiguousSelection = (step.op === "select" || step.op === "expectDownload") && message.includes("strict mode violation");
    throw new ProbeExecutionError(error instanceof ProbeExecutionError ? error.category
      : invalidProbeOperation ? "runner" : ambiguousSelection ? "locator" : assertion ? "assertion" : "timeout",
      message, await ariaSnapshot(session.page, timeoutMs, locator, step.locator.scope));
  }
  return session;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function routeIdentity(value: string): string {
  const url = new URL(value);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const hash = url.hash.slice(1).split("?")[0].replace(/\/+$/, "");
  return `${url.origin}${path}${hash ? `#${hash}` : ""}`;
}

/**
 * Try candidates in order; non-final candidates get a short probe so a wrong
 * guess does not consume the step budget, the final one keeps the full timeout.
 * A missing assertion target is an observed unmet expectation. Ambiguous
 * assertion targets and missing action targets still need locator recovery.
 */
async function resolveLocator(
  session: BrowserSession,
  step: Extract<ProbeStep, { locator: ProbeLocator }>,
  timeoutMs: number,
): Promise<Locator> {
  // Selection/value operations cannot target a same-named aria-label region.
  // Retain only controls on which the operation is meaningful while allowing
  // both native selects and custom ARIA comboboxes.
  const nativeControl = step.op === "select" ? 'select, [role="combobox"]'
    : step.op === "expectValue" ? "input, textarea, select" : undefined;
  const candidateLocator = (locator: ProbeLocator) => {
    const target = nativeControl ? locate(session.page, locator).and(session.page.locator(nativeControl)) : locate(session.page, locator);
    return locator.firstMatch ? target.filter({ visible: true }).first() : target;
  };
  const primary = candidateLocator(step.locator);
  if (step.op === "expectCount" || step.op === "expectHidden") return primary;
  const candidates = locatorCandidates(step.locator);
  // Actions must reach a visible candidate. Uploads can target a hidden native
  // file input, and state/value assertions need only an attached target.
  const needsVisible = ["click", "rightClick", "doubleClick", "hover", "press", "fill", "select", "setChecked", "expectVisible", "expectDownload"].includes(step.op);
  const attempts: NonNullable<ProbeFailure["locatorAttempts"]> = [];
  let lastMiss: unknown;
  let observedTarget: Locator | undefined;
  for (let index = 0; index < candidates.length; index += 1) {
    const isFinal = index === candidates.length - 1;
    const candidate = candidateLocator(candidates[index]);
    try {
      await candidate.waitFor({
        state: needsVisible ? "visible" : "attached",
        timeout: isFinal ? timeoutMs : Math.min(LOCATOR_PROBE_TIMEOUT_MS, timeoutMs),
      });
      return candidate;
    } catch (error) {
      lastMiss = error;
      const matchCount = await candidate.count().catch(() => undefined);
      if (matchCount) observedTarget ??= candidate;
      attempts.push({ locator: candidates[index], message: compactError(error),
        ...(matchCount === undefined ? {} : { matchCount }) });
    }
  }
  throw new ProbeExecutionError(
    step.op.startsWith("expect") && !attempts.some(attempt => attempt.message.includes("strict mode violation"))
      ? "assertion" : "locator",
    compactError(lastMiss),
    await ariaSnapshot(session.page, timeoutMs, observedTarget, step.locator.scope),
    attempts,
  );
}

/** expectText anyOf tries candidates in order; Playwright array form is multi-element, not any-of. */
async function expectAnyText(
  locator: Locator,
  step: Extract<ProbeStep, { op: "expectText" }>,
  timeoutMs: number,
): Promise<void> {
  const candidates = [step.text, ...(step.anyOf ?? [])];
  let lastError: unknown;
  for (let index = 0; index < candidates.length; index += 1) {
    const isFinal = index === candidates.length - 1;
    const timeout = isFinal ? timeoutMs : Math.min(LOCATOR_PROBE_TIMEOUT_MS, timeoutMs);
    try {
      if (step.exact === false) {
        await expect(locator).toContainText(candidates[index], { timeout });
      } else {
        await expect(locator).toHaveText(candidates[index], { timeout });
      }
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

const LOCATOR_PROBE_TIMEOUT_MS = 500;

/** Read only the browser-owned download, with bounded memory and completion time. */
async function downloadedUtf8Text(download: Download, timeoutMs: number): Promise<string> {
  let stream: Readable | null = null;
  const closeStream = () => stream?.destroy();
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reading = (async () => {
    stream = await download.createReadStream();
    if (expired) { stream?.destroy(); return ""; }
    if (!stream) throw new ProbeExecutionError("runner", "Browser download stream is unavailable");
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_DOWNLOAD_BYTES) throw new ProbeExecutionError("runner", "Download exceeds the 64 KiB probe limit");
      chunks.push(buffer);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  })();
  try {
    return await Promise.race([reading, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        expired = true;
        stream?.destroy();
        void download.cancel().catch(() => {});
        reject(new ProbeExecutionError("runner", "Browser download did not complete within the probe timeout"));
      }, timeoutMs);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    closeStream();
  }
}

async function createSession(browser: Browser): Promise<BrowserSession> {
  const context = await browser.newContext();
  try {
    const session: BrowserSession = { context, page: await context.newPage(), crashed: false };
    session.page.on("crash", () => { session.crashed = true; });
    return session;
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
}

function locate(page: Page | Locator, locator: ProbeLocator): Locator {
  if (locator.scope) {
    let scope = locate(page, locator.scope as ProbeLocator);
    if (locator.scope.hasText !== undefined) scope = scope.filter({ hasText: locator.scope.hasText });
    const { scope: _scope, ...target } = locator;
    return locate(scope, target);
  }
  if (locator.by === "label") {
    return page.getByLabel(locator.text, { exact: locator.exact });
  }
  if (locator.by === "text") {
    return page.getByText(locator.text, { exact: locator.exact });
  }
  type AriaRole = Parameters<Page["getByRole"]>[0];
  return page.getByRole(locator.role as AriaRole, {
    name: locator.name,
    exact: locator.exact,
  });
}

async function ariaSnapshot(page: Page, timeoutMs: number, target?: Locator, scope?: ProbeLocator["scope"]): Promise<string | undefined> {
  try {
    const options = { timeout: Math.min(timeoutMs, 500) };
    const excerpts: string[] = [];
    const seen = new Set<string>();
    const add = async (locator: Locator, limit: number): Promise<void> => {
      if (await locator.count() !== 1) return;
      const snapshot = await locator.ariaSnapshot(options).catch(() => undefined);
      if (snapshot && !seen.has(snapshot)) {
        seen.add(snapshot);
        excerpts.push(snapshot.slice(0, limit));
      }
    };
    if (target) {
      const count = await target.count();
      if (count === 1) await add(target, 700);
      else for (let index = 0; index < Math.min(3, count); index++) {
        const match = target.nth(index);
        await add(match, 500);
        const container = await match.evaluate(element => {
          const parent = element.closest('dialog, [role="dialog"], [role="region"], [role="row"], [role="article"], [role="listitem"], nav, header, main, form, article, li, tr');
          return parent ? { tag: parent.tagName.toLowerCase(), role: parent.getAttribute("role"),
            name: parent.getAttribute("aria-label") ?? "",
            text: ((parent as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 400) } : undefined;
        }).catch(() => undefined);
        if (container) excerpts.push(`匹配目标 ${index + 1} 的容器：${JSON.stringify(container)}`);
      }
    }
    if (scope) {
      let container = locate(page, scope as ProbeLocator);
      if (scope.hasText !== undefined) container = container.filter({ hasText: scope.hasText });
      await add(container, 1_600);
    }
    for (const role of ["dialog", "alertdialog", "menu"] as const) {
      const overlays = page.getByRole(role);
      for (let index = 0; index < Math.min(2, await overlays.count()); index++) {
        await add(overlays.nth(index), 1_600);
      }
    }
    const pageSnapshot = await page.locator("body").ariaSnapshot(options);
    let snapshot = [...excerpts, pageSnapshot].join("\n")
      .replace(/\b(password|token|api[_-]?key|cookie)\s*[:=]\s*\S+/gi, "$1=[redacted]");
    const passwords = await page.locator('input[type="password"]').evaluateAll(inputs =>
      inputs.map(input => (input as HTMLInputElement).value).filter(Boolean));
    for (const password of passwords) snapshot = snapshot.split(password).join("[redacted]");
    return snapshot.slice(0, 4_000);
  } catch {
    return undefined;
  }
}

function compactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 1_000);
}
