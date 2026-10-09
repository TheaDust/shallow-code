import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Directory the controller mirrors run progress (human log lines and probe
 * plans) into so the platform's product view exposes it. It is intentionally
 * NOT ignored: the platform filters gitignored paths out of the delivered
 * template, so ignoring it would hide it. Instead it is kept untracked
 * (excluded from `git add`), excluded from acceptance digests and preserved by
 * rollbacks, exactly like `.arc` — but unlike `.arc` the platform does not hide
 * it. Builder tools are blocked from reading it because it carries hidden Judge
 * plans.
 */
export const PROGRESS_DIR_NAME = "shallow-progress";

/** True when a repository-relative path is the progress directory or below it. */
export function isProgressPath(relativePath: string): boolean {
  const normalised = relativePath.replaceAll("\\", "/");
  return normalised === PROGRESS_DIR_NAME || normalised.startsWith(`${PROGRESS_DIR_NAME}/`);
}

export function progressPlansDirectory(progressDir: string): string {
  return join(progressDir, "plans");
}

/** Append-only, best-effort journal inside the packaged product directory. */
export class ProgressJournal {
  readonly directory: string;
  readonly logFile: string;

  constructor(outputDir: string) {
    this.directory = join(outputDir, PROGRESS_DIR_NAME);
    this.logFile = join(this.directory, "progress.log");
  }

  appendLine(line: string): void {
    try {
      mkdirSync(this.directory, { recursive: true });
      appendFileSync(this.logFile, `${line}\n`, "utf8");
    } catch {
      // Diagnostics must never change the decision path.
    }
  }
}
