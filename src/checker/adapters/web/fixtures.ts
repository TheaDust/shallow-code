import { deflateSync } from "node:zlib";

export const MAX_FIXTURE_BYTES = 8 * 1024 * 1024;
export type WebFileFixture = { kind: "text" | "png"; bytes: number; text?: string };

/** Generate bounded test inputs in the host, without copying megabytes through QuickJS. */
export function fileFixture(value: unknown): { buffer: Buffer; mimeType: string; fixture: WebFileFixture } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("File fixture must be an object");
  const fixture = value as WebFileFixture;
  if (!Number.isInteger(fixture.bytes) || fixture.bytes < 1 || fixture.bytes > MAX_FIXTURE_BYTES) throw new Error("Fixture bytes must be between 1 and 8 MiB");
  if (Object.keys(value).some(key => !["kind", "bytes", "text"].includes(key))) throw new Error("Unknown file fixture field");
  if (fixture.kind === "text") {
    const text = fixture.text ?? "A";
    if (typeof text !== "string" || !text.length || text.length > 64_000 || !/^[\x09-\x0d\x20-\x7e]+$/.test(text)) throw new Error("Text fixture pattern must be nonempty bounded ASCII");
    return { buffer: Buffer.alloc(fixture.bytes, text), mimeType: "text/plain", fixture };
  }
  if (fixture.kind !== "png" || fixture.text !== undefined || fixture.bytes < 128) throw new Error("PNG fixtures require at least 128 bytes and no text pattern");
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  const prefix = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 51, 102, 153, 255])))]);
  const end = pngChunk("IEND", Buffer.alloc(0));
  // Valid ancillary text makes file size independent of image dimensions and compression.
  const padding = Buffer.alloc(fixture.bytes - prefix.length - end.length - 12, 65);
  padding.write("Fixture\0", "ascii");
  return { buffer: Buffer.concat([prefix, pngChunk("tEXt", padding), end]), mimeType: "image/png", fixture };
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length); chunk.write(type, 4, "ascii"); data.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
}
