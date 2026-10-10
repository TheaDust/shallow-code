import type { Static, TSchema } from "typebox";

export interface ToolImage {
  type: "image";
  data: string;
  mimeType: string;
}

export interface BuilderToolResult {
  content: Array<{ type: "text"; text: string } | ToolImage>;
  details: unknown;
}

/** Project tools need parameters, cancellation and a result, not an SDK context. */
export interface BuilderTool<TParams extends TSchema = TSchema> {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  parameters: TParams;
  executionMode?: "sequential" | "parallel";
  execute(toolCallId: string, params: Static<TParams>, signal?: AbortSignal): Promise<BuilderToolResult>;
}

/** The SDK owns shell formatting; the project owns command execution and guards. */
export type ShellExecutor = (command: string, directory: string, options: {
  onData: (data: Buffer) => void;
  signal?: AbortSignal;
  timeout?: number;
}) => Promise<{ exitCode: number | null }>;
