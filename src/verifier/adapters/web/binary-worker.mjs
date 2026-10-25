import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const require = createRequire(import.meta.url);
const limit = 16_777_216;
function dimensions(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > 4096 || height > 4096 || width * height > limit) throw new Error("Render dimensions exceed 4096 pixels per side or 16 million pixels");
}

function rasterSize(bytes, format) {
  if (format === "png") return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  if (format === "webp") {
    const type = bytes.subarray(12, 16).toString();
    if (type === "VP8X") return [bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1];
    if (type === "VP8 ") return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
    if (type === "VP8L") return [(bytes[21] | (bytes[22] & 63) << 8) + 1, ((bytes[22] >> 6) | bytes[23] << 2 | (bytes[24] & 15) << 10) + 1];
  } else {
    let offset = 2;
    while (offset + 8 < bytes.length && bytes[offset] === 255) {
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker >= 0xd0 && marker <= 0xd7 || marker === 0x01) continue;
      const length = bytes.readUInt16BE(offset);
      if (length < 2) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
      offset += length;
    }
  }
  throw new Error("Invalid raster image header");
}

async function render(bytes, options, languageDirectory) {
  let canvas, text = "", textItems = [], truncated = false, pageCount = 1;
  const pdf = bytes.subarray(0, 5).toString() === "%PDF-";
  const pageNumber = options.page ?? 1;
  if (pdf) {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const assets = dirname(require.resolve("pdfjs-dist/package.json"));
    const task = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useWorkerFetch: false, stopAtErrors: true,
      maxImageSize: limit, cMapUrl: join(assets, "cmaps") + "/", cMapPacked: true, standardFontDataUrl: join(assets, "standard_fonts") + "/",
      wasmUrl: join(assets, "wasm") + "/" });
    try {
      const document = await task.promise;
      pageCount = document.numPages;
      if (pageNumber > pageCount) throw new Error("Requested PDF page does not exist");
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: options.scale ?? 1.5 });
      dimensions(viewport.width, viewport.height);
      canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvas, viewport }).promise;
      const content = await page.getTextContent();
      const items = content.items.filter(item => "str" in item);
      let remaining = 64_000;
      const parts = [];
      for (const item of items) {
        const part = item.str + (item.hasEOL ? "\n" : " ");
        if (part.length > remaining) truncated = true;
        parts.push(part.slice(0, remaining)); remaining = Math.max(0, remaining - part.length);
        if (!remaining) break;
      }
      text = parts.join("").trim();
      truncated ||= items.length > 1000 || remaining === 0;
      remaining = 64_000;
      textItems = items.slice(0, 1000).map(item => {
        const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
        const text = item.str.slice(0, remaining); remaining = Math.max(0, remaining - item.str.length);
        return { text, x, y, width: item.width * viewport.scale, height: item.height * viewport.scale };
      });
      page.cleanup();
    } finally { await task.destroy(); }
  } else {
    if (pageNumber !== 1) throw new Error("Images have one page");
    // Decode raster formats only; SVG input must not introduce external resources.
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes[0] === 255 && bytes[1] === 216;
    const webp = bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
    if (!png && !jpeg && !webp) throw new Error("Render input must be PDF, PNG, JPEG or WebP");
    dimensions(...rasterSize(bytes, png ? "png" : jpeg ? "jpeg" : "webp"));
    const image = await loadImage(bytes);
    dimensions(image.width, image.height);
    const scale = options.scale ?? 1;
    dimensions(image.width * scale, image.height * scale);
    canvas = createCanvas(Math.ceil(image.width * scale), Math.ceil(image.height * scale));
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  }
  if (options.region) {
    const { x, y, width, height } = options.region;
    if (x + width > canvas.width || y + height > canvas.height) throw new Error("Render region is outside the image");
    const cropped = createCanvas(width, height);
    cropped.getContext("2d").drawImage(canvas, x, y, width, height, 0, 0, width, height);
    canvas = cropped;
    // Text extraction is page-level; regional assertions use the actual crop or OCR.
    text = ""; textItems = [];
  }
  const { width, height } = canvas;
  const rgba = canvas.getContext("2d").getImageData(0, 0, width, height).data;
  let nonWhite = 0, minX = width, minY = height, maxX = -1, maxY = -1;
  for (let index = 0; index < rgba.length; index += 4) {
    const alpha = rgba[index + 3] / 255;
    const white = 255 * (1 - alpha);
    if (Math.min(rgba[index] * alpha + white, rgba[index + 1] * alpha + white, rgba[index + 2] * alpha + white) < 245) {
      nonWhite++; const pixel = index / 4, x = pixel % width, y = Math.floor(pixel / width);
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  const samples = (options.samples ?? []).map(({ x, y }) => {
    if (x >= width || y >= height) throw new Error("Sample coordinate is outside the rendered image");
    return { x, y, rgba: Array.from(rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)) };
  });
  const png = canvas.toBuffer("image/png");
  if (png.length > 4 * 1024 * 1024) throw new Error("Rendered preview exceeds 4 MiB; select a smaller region or scale");
  let ocr;
  if (options.ocr) {
    const { createWorker } = await import("tesseract.js");
    const worker = await createWorker(options.ocr, 1, { cacheMethod: "none", langPath: languageDirectory });
    try {
      const { data } = await worker.recognize(png);
      ocr = { text: data.text.slice(0, 64_000), confidence: data.confidence };
      truncated ||= data.text.length > 64_000;
    } finally { await worker.terminate(); }
  }
  return { value: { format: pdf ? "pdf" : "image", page: pageNumber, pageCount, width, height, text, textItems, truncated,
    pixels: { sha256: createHash("sha256").update(rgba).digest("hex"), nonWhiteRatio: nonWhite / (width * height),
      bounds: maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } }, samples, ...(ocr ? { ocr } : {}) }, png };
}

process.once("message", async ({ bytes, options, languageDirectory }) => {
  let response;
  try { response = await render(Buffer.from(bytes), options, languageDirectory); }
  catch (error) { response = { error: error instanceof Error ? error.message : String(error) }; }
  process.send(response, () => process.disconnect());
});
