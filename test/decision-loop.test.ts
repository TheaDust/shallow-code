import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
  RunStateStore,
  sanitizeDiagnosticText,
} from "../src/run-state.js";
import type { RunEvent } from "../src/types.js";
import { withTempDir } from "./helpers/temp-dir.js";

test("RunState records unverified checkpoints independently from feature verdicts", () => {
  const state = new RunStateStore({ statusByRequirementId: { REQ: "todo" }, acceptedSha: "initial", startedAtMs: 0, totalBudgetMs: 0 });
  state.setAcceptedSha("runnable");
  assert.equal(state.snapshot.statusByRequirementId.REQ, "todo");
  state.markRequirements(["REQ"], "inconclusive");
  assert.equal(state.snapshot.acceptedSha, "runnable");
  state.markRequirements(["REQ"], "failed");
  assert.equal(state.snapshot.acceptedSha, "runnable");
});

test("RunState records global transitions and writes a redacted JSONL ledger", async () => {
  await withTempDir("shallow-ledger-", async (directory) => {
    const ledgerFile = join(directory, "run-ledger.jsonl");
    const state = new RunStateStore(
      {
        statusByRequirementId: { REQ: "todo" },
        acceptedSha: "initial",
        startedAtMs: 0,
        totalBudgetMs: 10_000,
      },
      ledgerFile,
    );

    state.markRequirements(["REQ"], "verified");
    state.setAcceptedSha("accepted");
    state.setPacketAttempt("packet-req", 2);
    await state.record({
      at: "2026-09-04T00:00:00.000Z",
      type: "builder_finished",
      packetId: "packet-req",
      detail: {
        apiKey: "secret-value",
        message: "x".repeat(3_000),
      },
    } as unknown as RunEvent);

    assert.equal(state.snapshot.statusByRequirementId.REQ, "verified");
    assert.equal(state.snapshot.acceptedSha, "accepted");
    assert.equal(state.snapshot.attemptsByPacketId["packet-req"], 2);
    const ledger = await readFile(ledgerFile, "utf8");
    assert.doesNotMatch(ledger, /secret-value/);
    assert.match(ledger, /\[redacted\]/);
    assert.ok(ledger.length < 2_500);
  });
});

test("RunState keeps decisions intact when diagnostic sinks fail", async () => {
  await withTempDir("shallow-ledger-", async (directory) => {
    const blocker = join(directory, "blocker.txt");
    await writeFile(blocker, "not a directory");
    const blockedLedgerPath = join(blocker, "run-ledger.jsonl");
    const store = new RunStateStore(
      {
        statusByRequirementId: { REQ: "todo" },
        acceptedSha: "initial",
        startedAtMs: 0,
        totalBudgetMs: 10_000,
      },
      blockedLedgerPath,
      {
        write() {
          throw new Error("log unavailable");
        },
      },
    );

    await assert.doesNotReject(
      store.record({ at: "2026-09-04T00:00:00.000Z", type: "builder_finished" }),
    );
    assert.equal(store.snapshot.ledger.length, 1);
  });
});

test("Diagnostic text is sanitized and capped for logs", () => {
  assert.equal(sanitizeDiagnosticText("结果\u0000：完成"), "结果 ：完成");
  assert.equal(sanitizeDiagnosticText("x".repeat(2_000)).length, 1_500);
});
