import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { formatSize, truncateHead, type TruncationResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Requirements documents are read in one turn; raise both the byte and line safety limits. */
export const READ_MAX_BYTES = 500 * 1024;
export const READ_MAX_LINES = 20_000;

const readSchema = Type.Object({
  path: Type.String({ description: "Path to the text file to read (relative or absolute)" }),
  offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".pdf",
  ".zip", ".gz", ".tar", ".7z", ".rar", ".mp3", ".mp4", ".mov", ".avi",
]);

/** Keep the path forms accepted by Pi's read / ls tools. */
function resolveDocumentPath(path: string, cwd: string): string {
  let normalized = path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (process.platform === "win32" && !normalized.includes("\\")) {
    const drivePath = normalized.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (drivePath) normalized = `${drivePath[1]}:\\${(drivePath[2] ?? "").replaceAll("/", "\\")}`;
  }
  if (normalized === "~") normalized = homedir();
  else if (normalized.startsWith("~/") ||
      (process.platform === "win32" && normalized.startsWith("~\\"))) {
    normalized = join(homedir(), normalized.slice(2));
  }
  if (normalized.startsWith("file://")) normalized = fileURLToPath(normalized);
  return resolve(cwd, normalized);
}

/**
 * Pi's built-in read tool caps text at 50KB. Requirements documents can be much larger, so this
 * tool keeps the same `read` contract while raising the limit to 500KB and 20k lines.
 */
export function createDocumentReadTool(cwd: string) {
  return {
    name: "read",
    label: "read",
    description:
      `Read the contents of a UTF-8 text file. Output is truncated to ${READ_MAX_LINES} lines or ` +
      `${READ_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. ` +
      "Images and other binary reference files are not read as text.",
    promptSnippet: "Read a user-provided text document",
    promptGuidelines: [
      "Use read to examine user-provided text documents; do not guess missing contents.",
    ],
    parameters: readSchema,
    async execute(
      _toolCallId: string,
      { path, offset, limit }: { path: string; offset?: number; limit?: number },
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: { cwd?: string } | undefined,
    ) {
      if (signal?.aborted) throw new Error("Operation aborted");

      const absolutePath = resolveDocumentPath(path, ctx?.cwd ?? cwd);
      await access(absolutePath);

      if (BINARY_EXTENSIONS.has(extname(absolutePath).toLowerCase())) {
        return {
          content: [{
            type: "text" as const,
            text: `[${path} is a binary/image reference file; its contents are not read as text.]`,
          }],
        };
      }

      const text = await readFile(absolutePath, "utf8");
      if (signal?.aborted) throw new Error("Operation aborted");

      const allLines = text.split("\n");
      const totalFileLines = allLines.length;
      const startLine = offset ? Math.max(0, offset - 1) : 0;
      const startLineDisplay = startLine + 1;
      if (startLine >= allLines.length) {
        throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
      }

      let selectedContent: string;
      let userLimitedLines: number | undefined;
      if (limit !== undefined) {
        const endLine = Math.min(startLine + limit, allLines.length);
        selectedContent = allLines.slice(startLine, endLine).join("\n");
        userLimitedLines = endLine - startLine;
      } else {
        selectedContent = allLines.slice(startLine).join("\n");
      }

      const truncation = truncateHead(selectedContent, {
        maxLines: READ_MAX_LINES,
        maxBytes: READ_MAX_BYTES,
      });
      let outputText: string;
      let details: { truncation?: TruncationResult } | undefined;

      if (truncation.firstLineExceedsLimit) {
        const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine] ?? "", "utf-8"));
        outputText =
          `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(READ_MAX_BYTES)} limit. ` +
          "Use offset/limit to read a smaller portion.]";
        details = { truncation };
      } else if (truncation.truncated) {
        const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
        const nextOffset = endLineDisplay + 1;
        outputText = truncation.content;
        outputText += truncation.truncatedBy === "lines"
          ? `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`
          : `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(READ_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
        details = { truncation };
      } else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
        const remaining = allLines.length - (startLine + userLimitedLines);
        const nextOffset = startLine + userLimitedLines + 1;
        outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
      } else {
        outputText = truncation.content;
      }

      return { content: [{ type: "text" as const, text: outputText }], details };
    },
  };
}
