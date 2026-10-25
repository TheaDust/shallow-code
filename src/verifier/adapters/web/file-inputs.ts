import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { fileFixture, MAX_FIXTURE_BYTES, type WebFileFixture } from "./fixtures.js";

const MAX_INLINE_BYTES = 4 * 1024 * 1024;
export interface FilePayload { name: string; mimeType: string; buffer: Buffer; fixture?: WebFileFixture }

export function filePayload(value: unknown): FilePayload[] {
  const files = Array.isArray(value) ? value : [value];
  if (!files.length || files.length > 20) throw new Error("Upload requires between one and twenty files");
  let total = 0;
  return files.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Upload file ${index + 1} must be an object`);
    const item = raw as Record<string, unknown>;
    const name = item.name;
    if (typeof name !== "string" || !name.length || name.length > 255 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name)) throw new Error("Upload file names must be plain names");
    if ([item.text, item.base64, item.fixture].filter(value => value !== undefined).length !== 1) throw new Error("Each upload file must provide exactly one of text, base64 or fixture");
    const mimeType = item.mimeType;
    if (mimeType !== undefined && (typeof mimeType !== "string" || !mimeType.length || mimeType.length > 255)) throw new Error("Invalid file MIME type");
    let file: FilePayload;
    if (item.fixture !== undefined) {
      const generated = fileFixture(item.fixture);
      if (generated.fixture.kind === "png" && mimeType !== undefined && mimeType !== generated.mimeType) throw new Error("PNG fixture MIME type must be image/png");
      file = { name, ...generated, mimeType: mimeType ?? generated.mimeType };
    } else {
      let buffer: Buffer;
      if (item.text !== undefined) {
        if (typeof item.text !== "string" || Buffer.byteLength(item.text) > MAX_INLINE_BYTES) throw new Error(`files[${index}].text must be a bounded string`);
        buffer = Buffer.from(item.text);
      } else {
        const encoded = item.base64;
        if (typeof encoded !== "string" || !encoded.length || encoded.length > Math.ceil(MAX_INLINE_BYTES / 3) * 4 ||
          encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error("Upload base64 is invalid or exceeds read limit");
        buffer = Buffer.from(encoded, "base64");
        if (buffer.toString("base64") !== encoded || buffer.length > MAX_INLINE_BYTES) throw new Error("Upload base64 is not canonical or exceeds read limit");
      }
      file = { name, mimeType: mimeType ?? "application/octet-stream", buffer };
    }
    total += file.buffer.length;
    if (total > 2 * MAX_FIXTURE_BYTES) throw new Error("Upload exceeds 16 MiB total limit");
    return file;
  });
}

export function fileMetadata(files: FilePayload[]) {
  return files.map(({ name, mimeType, buffer, fixture }) => ({ name, mimeType, bytes: buffer.length, ...(fixture ? { fixture } : {}) }));
}

/** Only generated case inputs touch disk; callers cannot name host paths. */
export async function uploadDirectory(locator: Locator, raw: unknown) {
  const directory = raw as { name?: unknown; files?: Array<Record<string, unknown>> } | undefined;
  const name = directory?.name;
  if (typeof name !== "string" || !name.length || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name)) throw new Error("Directory name must be a plain name");
  if (!Array.isArray(directory?.files)) throw new Error("Directory requires files with relative paths");
  const paths = directory.files.map(file => {
    if (typeof file.path !== "string" || file.path.length > 512 || file.path.split("/").some(part => !part.length || /[<>:"\\|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part))) throw new Error("Directory paths must be safe relative paths");
    return file.path;
  });
  if (new Set(paths.map(path => path.toLowerCase())).size !== paths.length || paths.some(path => paths.some(other => other.startsWith(path + "/")))) throw new Error("Directory files must have distinct non-conflicting paths");
  const files = filePayload(directory.files.map((file, index) => ({ ...file, name: paths[index]!.split("/").at(-1) })));
  const root = await mkdtemp(join(tmpdir(), "shallow-verifier-directory-"));
  try {
    for (let index = 0; index < files.length; index++) {
      const parts = paths[index]!.split("/");
      await mkdir(join(root, name, ...parts.slice(0, -1)), { recursive: true });
      await writeFile(join(root, name, ...parts), files[index]!.buffer);
    }
    await locator.setInputFiles(join(root, name));
    return { name, files: fileMetadata(files).map((file, index) => ({ ...file, path: paths[index] })), dispose: () => rm(root, { recursive: true, force: true }) };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

export async function dropFiles(page: Page, locator: Locator, files: FilePayload[]): Promise<void> {
  const transfer = await page.evaluateHandle(files => {
    const data = new DataTransfer();
    for (const file of files) data.items.add(new File([Uint8Array.from(atob(file.base64), char => char.charCodeAt(0))], file.name, { type: file.mimeType }));
    return data;
  }, files.map(file => ({ name: file.name, mimeType: file.mimeType, base64: file.buffer.toString("base64") })));
  try {
    for (const event of ["dragenter", "dragover", "drop"]) await locator.dispatchEvent(event, { dataTransfer: transfer });
  } finally { await transfer.dispose(); }
}

let clipboardQueue: Promise<unknown> = Promise.resolve();
/** Keep image placement and the real browser paste keystroke together across concurrent cases. */
export async function pasteImage(page: Page, locator: Locator, file: FilePayload): Promise<void> {
  const operation = clipboardQueue.catch(() => {}).then(async () => {
    if (file.mimeType !== "image/png") throw new Error("Image clipboard accepts PNG files");
    await page.bringToFront();
    await page.evaluate(async encoded => {
      const blob = new Blob([Uint8Array.from(atob(encoded), char => char.charCodeAt(0))], { type: "image/png" });
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    }, file.buffer.toString("base64"));
    await locator.press(process.platform === "darwin" ? "Meta+v" : "Control+v");
  });
  clipboardQueue = operation;
  await operation;
}
