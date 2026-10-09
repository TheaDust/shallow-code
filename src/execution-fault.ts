/** Execution infrastructure failed to produce product evidence. Never a Shadow verdict. */
export class ExecutionFault extends Error {
  constructor(
    readonly source: "browser" | "builder",
    readonly code: "browser_launch" | "browser_disconnected" | "page_crashed" | "builder_start" | "builder_cleanup",
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(
      options?.cause instanceof Error && options.cause.message
        ? `${source}: ${code}: ${options.cause.message}`
        : `${source}: ${code}`,
      options,
    );
    this.name = "ExecutionFault";
  }
}
