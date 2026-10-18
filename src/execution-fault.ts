/** Execution infrastructure failed to produce product evidence. Never a Shadow verdict. */
export class ExecutionFault extends Error {
  constructor(
    readonly source: "application" | "builder",
    readonly code: "application_start" | "application_cleanup" | "builder_start" | "builder_cleanup",
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
