import { open, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, win32 } from "node:path";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 30 * 1024 * 1024;

export interface ReferenceImage {
  reference: string;
  mime: string;
  dataUrl: string;
}

export interface ReferenceImageSet {
  images: ReferenceImage[];
  skipped: Array<{ reference: string; reason: string }>;
}

export async function loadReferenceImages(
  requirementsDir: string,
  references: string[],
): Promise<ReferenceImageSet> {
  const images: ReferenceImage[] = [];
  const skipped: ReferenceImageSet["skipped"] = [];
  const root = await realpath(requirementsDir).catch(() => undefined);
  let totalBytes = 0;
  const loadedPaths = new Set<string>();
  for (const reference of new Set(references)) {
    try {
      if (!root) throw new Error("requirements_unavailable");
      const path = decodeURIComponent(reference);
      if (/^[a-z][a-z0-9+.-]*:|[\x00-\x1f\x7f]/i.test(path) || isAbsolute(path) || win32.isAbsolute(path)) {
        throw new Error("outside_requirements");
      }
      const resolved = resolve(root, path.replaceAll("\\", "/"));
      assertContained(root, resolved);
      if (!/\.(png|jpe?g|webp|gif)$/i.test(extname(resolved))) throw new Error("unsupported_format");
      const canonical = await realpath(resolved);
      assertContained(root, canonical);
      if (loadedPaths.has(canonical)) continue;
      const file = await open(canonical, "r");
      try {
        const info = await file.stat();
        if (!info.isFile()) throw new Error("not_a_file");
        if (info.size > MAX_IMAGE_BYTES) throw new Error("image_too_large");
        if (totalBytes + info.size > MAX_TOTAL_BYTES) throw new Error("packet_images_too_large");
        // Bound the read even if the input file grows after stat().
        const buffer = Buffer.alloc(Math.min(info.size + 1, MAX_IMAGE_BYTES + 1));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead !== info.size) throw new Error("image_changed");
        const content = buffer.subarray(0, bytesRead);
        const mime = imageMime(content);
        if (!mime) throw new Error("invalid_image");
        images.push({ reference, mime, dataUrl: `data:${mime};base64,${content.toString("base64")}` });
        loadedPaths.add(canonical);
        totalBytes += bytesRead;
      } finally {
        await file.close();
      }
    } catch (error) {
      const reason = error instanceof Error && /^[a-z_]+$/.test(error.message)
        ? error.message : "unreadable_image";
      skipped.push({ reference, reason });
    }
  }
  return { images, skipped };
}

function assertContained(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) {
    throw new Error("outside_requirements");
  }
}

function imageMime(content: Buffer): string | undefined {
  if (content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (content[0] === 255 && content[1] === 216 && content[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a$/.test(content.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (content.subarray(0, 4).toString("ascii") === "RIFF" && content.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}
