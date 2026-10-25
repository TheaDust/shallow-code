import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createCanvas } from "@napi-rs/canvas";
import { filePayload } from "../src/verifier/adapters/web/file-inputs.js";
import { renderBinary, renderOptions } from "../src/verifier/adapters/web/binary-renderer.js";
import { mediaPdf, mediaPng } from "./helpers/verifier-media.js";

const signal = new AbortController().signal;

test("media parsers reject host paths, invalid files and unbounded render requests", async () => {
  for (const name of ["../secret", "C:\\secret", "folder/a", ".", "..", "a\0b", "trailing."]) assert.throws(() => filePayload({ name, text: "input" }));
  assert.throws(() => filePayload({ name: "a.png", base64: "not base64" }));
  assert.throws(() => filePayload({ name: "a.png", fixture: { kind: "png", bytes: 128 }, text: "duplicate" }));
  for (const options of [null, { path: "secret" }, { page: 0 }, { page: 101 }, { scale: Infinity }, { scale: 4 }, { samples: [{ x: -1, y: 0 }] }, { region: { x: 0, y: 0, width: -1, height: 2 } }, { ocr: "remote" }]) assert.throws(() => renderOptions(options));
  await assert.rejects(renderBinary(Buffer.alloc(4 * 1024 * 1024 + 1), {}, signal), /4 MiB/);
  await assert.rejects(renderBinary(Buffer.from("not an image"), {}, signal), /PDF, PNG, JPEG or WebP/);
});

test("PDF parsing preserves actual text positions, page identity and rendered pixel content", async () => {
  const result = await renderBinary(mediaPdf("EXPECTED EXPORT"), { scale: 1, samples: [{ x: 30, y: 150 }] }, signal);
  assert.equal(result.value.format, "pdf"); assert.equal(result.value.pageCount, 1);
  assert.deepEqual([result.value.width, result.value.height], [400, 180]);
  assert.match(result.value.text, /EXPECTED EXPORT/);
  assert(result.value.textItems.some(item => item.text === "EXPECTED EXPORT" && item.width > 200 && item.y === 80));
  assert.deepEqual(result.value.samples[0]!.rgba, [255, 0, 0, 255]);
  assert(result.value.pixels.nonWhiteRatio > 0.01);
  assert.deepEqual(result.png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const blank = await renderBinary(mediaPdf(""), {}, signal);
  assert.equal(blank.value.text, ""); assert.equal(blank.value.pixels.nonWhiteRatio, 0); assert.equal(blank.value.pixels.bounds, null);
  await assert.rejects(renderBinary(mediaPdf("EXPECTED"), { page: 2 }, signal), /does not exist/);
});

test("JPEG and WebP decode actual pixels and oversized raster headers are rejected before decoding", async () => {
  const canvas = createCanvas(40, 20), context = canvas.getContext("2d");
  context.fillStyle = "red"; context.fillRect(0, 0, 40, 20);
  for (const bytes of [canvas.toBuffer("image/jpeg"), canvas.toBuffer("image/webp")]) {
    const image = await renderBinary(bytes, { samples: [{ x: 10, y: 10 }] }, signal);
    assert.deepEqual([image.value.width, image.value.height], [40, 20]);
    const [red, green, blue] = image.value.samples[0]!.rgba;
    assert(red! > 240 && green! < 20 && blue! < 20);
  }
  const oversized = Buffer.alloc(32);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(oversized);
  oversized.writeUInt32BE(65535, 16); oversized.writeUInt32BE(65535, 20);
  await assert.rejects(renderBinary(oversized, {}, signal), /dimensions exceed/);
});

test("raster regions observe exact pixels and OCR reads bundled English and Chinese data offline", { timeout: 60_000 }, async () => {
  const image = mediaPng("EXPECTED EXPORT");
  const crop = await renderBinary(image, { region: { x: 20, y: 125, width: 40, height: 20 }, samples: [{ x: 0, y: 0 }] }, signal);
  assert.deepEqual([crop.value.width, crop.value.height], [40, 20]);
  assert.deepEqual(crop.value.samples[0]!.rgba, [255, 0, 0, 255]);
  assert.equal(crop.value.pixels.nonWhiteRatio, 1);
  const recognized = await renderBinary(image, { ocr: "eng+chi_sim" }, signal);
  assert.match(recognized.value.ocr!.text, /EXPECTED EXPORT/);
  assert(recognized.value.ocr!.confidence > 70);
  const chinese = await renderBinary(await readFile(new URL("./fixtures/verifier-ocr-chinese.png", import.meta.url)), { ocr: "eng+chi_sim" }, signal);
  assert.match(chinese.value.ocr!.text.replace(/\s/g, ""), /中文测试/);
  await assert.rejects(renderBinary(image, { region: { x: 999, y: 0, width: 20, height: 20 } }, signal), /outside/);
  const controller = new AbortController();
  const cancelled = renderBinary(image, { ocr: "eng" }, controller.signal);
  setTimeout(() => controller.abort(new Error("cancelled-render")), 150);
  await assert.rejects(cancelled, /cancelled-render/);
  assert.equal((await renderBinary(image, {}, signal)).value.width, 1000, "cancellation leaves subsequent decoding usable");
});
