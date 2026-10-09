import type { GitOps } from "../../src/git-ops.js";

export class FakeGitOps implements GitOps {
  readonly captureMessages: string[] = [];
  readonly restoredShas: string[] = [];
  applicationChanged = true;

  async hasApplicationChanges(_sinceSha: string): Promise<boolean> { return this.applicationChanged; }

  constructor(private readonly shas = ["baseline", "accepted"]) {}

  async captureAccepted(message: string): Promise<string> {
    this.captureMessages.push(message);
    return this.shas[this.captureMessages.length - 1] ?? this.shas.at(-1) ?? "accepted";
  }

  async restoreAccepted(sha: string): Promise<void> {
    this.restoredShas.push(sha);
  }
}
