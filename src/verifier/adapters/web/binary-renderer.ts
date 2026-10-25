import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface RenderOptions {
  page?: number;
  scale?: number;
  region?: { x: number; y: number; width: number; height: number };
  samples?: Array<{ x: number; y: number }>;
  ocr?: "eng" | "chi_sim" | "eng+chi_sim";
}
export interface RenderedContent {
  format: "pdf" | "image";
  page: number;
  pageCount: number;
  width: number;
  height: number;
  text: string;
  textItems: Array<{ text: string; x: number; y: number; width: number; height: number }>;
  truncated: boolean;
  pixels: { sha256: string; nonWhiteRatio: number; bounds: { x: number; y: number; width: number; height: number } | null };
  samples: Array<{ x: number; y: number; rgba: number[] }>;
  ocr?: { text: string; confidence: number };
}
export interface RenderResult { value: RenderedContent; png: Buffer }

export function renderOptions(raw: unknown): RenderOptions {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Render options must be an object");
  const options = raw as RenderOptions;
  if (Object.keys(options).some(key => !["page", "scale", "region", "samples", "ocr"].includes(key))) throw new Error("Unknown render option");
  if (options.page !== undefined && (!Number.isInteger(options.page) || options.page < 1 || options.page > 100)) throw new Error("Render page must be between 1 and 100");
  if (options.scale !== undefined && (!Number.isFinite(options.scale) || options.scale < 0.25 || options.scale > 3)) throw new Error("Render scale must be between 0.25 and 3");
  if (options.region !== undefined && (!options.region || Object.keys(options.region).length !== 4 ||
    ["x", "y", "width", "height"].some(key => !Number.isInteger(options.region![key as keyof typeof options.region]) || options.region![key as keyof typeof options.region]! < (key === "x" || key === "y" ? 0 : 1)))) throw new Error("Render region must contain integer x, y, width and height");
  if (options.samples !== undefined && (!Array.isArray(options.samples) || options.samples.length > 64 || options.samples.some(point => !point || Object.keys(point).length !== 2 || !Number.isInteger(point.x) || !Number.isInteger(point.y) || point.x < 0 || point.y < 0))) throw new Error("Render samples require at most 64 integer pixel coordinates");
  if (options.ocr !== undefined && !["eng", "chi_sim", "eng+chi_sim"].includes(options.ocr)) throw new Error("OCR supports eng, chi_sim or eng+chi_sim");
  return options;
}

/** Untrusted binary parsers and OCR run outside the controller, with cancellation and a hard time bound. */
export async function renderBinary(bytes: Buffer, raw: unknown, signal: AbortSignal): Promise<RenderResult> {
  signal.throwIfAborted();
  if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw new Error("Rendered file exceeds the 4 MiB limit");
  const options = renderOptions(raw);
  const require = createRequire(import.meta.url);
  const languageDirectory = options.ocr ? await mkdtemp(join(tmpdir(), "shallow-verifier-render-")) : undefined;
  const env = Object.fromEntries(["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]!]));
  const workerOptions: ForkOptions & { windowsHide: boolean } = { env, execArgv: ["--max-old-space-size=512"], serialization: "advanced", stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true };
  let child: ChildProcess | undefined;
  let closed: Promise<void> | undefined;
  let abort: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    if (languageDirectory) await Promise.all(options.ocr!.split("+").map(code => copyFile(
      join(dirname(require.resolve(`@tesseract.js-data/${code}/package.json`)), "4.0.0_best_int", `${code}.traineddata.gz`), join(languageDirectory, `${code}.traineddata.gz`))));
    signal.throwIfAborted();
    const worker = child = fork(new URL("./binary-worker.mjs", import.meta.url), [], workerOptions);
    let stderr = "";
    worker.stderr?.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
    closed = new Promise<void>(resolve => { worker.once("close", () => resolve()); worker.once("error", () => resolve()); });
    return await new Promise<RenderResult>((resolve, reject) => {
      abort = () => reject(signal.reason ?? new Error("Binary rendering cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      timer = setTimeout(() => reject(new Error("Binary rendering exceeded 30 seconds")), 30_000);
      worker.once("error", reject);
      worker.once("exit", code => reject(new Error(`Binary renderer exited (${code}): ${stderr}`)));
      worker.once("message", (message: { value?: RenderedContent; png?: Buffer; error?: string }) => {
        if (message.error) reject(new Error(message.error));
        else if (message.value && message.png) resolve({ value: message.value, png: message.png });
        else reject(new Error("Invalid binary renderer response"));
      });
      worker.send({ bytes, options, languageDirectory });
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
    child?.kill();
    await closed;
    if (languageDirectory) await rm(languageDirectory, { recursive: true, force: true });
  }
}
