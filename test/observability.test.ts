import assert from "node:assert/strict";
import { mkdir, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { assertPrivateRunDirectory } from "../index.js";
import { sanitizeDiagnosticText } from "../src/diagnostics.js";
import { RunStateStore } from "../src/run-state.js";
import { HumanRunFormatter } from "../src/human-log.js";
import { withTempDir } from "./helpers/temp-dir.js";
import type { RunEvent } from "../src/types.js";

test("Diagnostics redact known secrets, embedded headers, quoted values and URL credentials before truncation", () => {
  const raw = ['opaque-gateway-credential', 'Authorization: Bearer header-value',
    'Cookie: sid=cookie-value; other=second-value', 'password="two word value"',
    '{"apiKey":"json-secret"}', 'https://alice:pwd@example.com?token=query-value',
    '\u001b[31mred\u001b[0m\u202eevil'].join("\n");
  const safe = sanitizeDiagnosticText(raw, ["opaque-gateway-credential"]);
  for (const secret of ["opaque-gateway-credential", "header-value", "cookie-value", "second-value", "two word value", "json-secret", "pwd", "query-value", "\u001b", "\u202e"]) {
    assert.ok(!safe.includes(secret), secret);
  }
  assert.equal(sanitizeDiagnosticText("x".repeat(1490) + "opaque-gateway-credential", ["opaque-gateway-credential"]).includes("opaque"), false);
});

test("Gateway wait transport reasons are redacted in both machine and human logs", async () => {
  await withTempDir("shallow-gateway-log-", async directory => {
    const chunks: string[] = [];
    const store = new RunStateStore({ statusByRequirementId: {}, acceptedSha: "sha", startedAtMs: 0, totalBudgetMs: 0 },
      join(directory, "ledger.jsonl"), { write: chunk => { chunks.push(chunk); } }, ["opaque-credential"]);
    await store.record({ at: "2026-09-07T00:00:00Z", type: "gateway_wait", packetId: "p", detail: {
      source: "planning", retry: 1, delayMs: 30_000, failure: { kind: "unavailable", retryable: true },
      reason: "TypeError: fetch failed → Error: token=opaque-credential [ECONNRESET]",
    } });
    const ledger = await readFile(join(directory, "ledger.jsonl"), "utf8");
    const human = new HumanRunFormatter().format(chunks[0]) ?? "";
    assert.doesNotMatch(ledger + human, /opaque-credential/);
    assert.match(human, /底层原因：.*ECONNRESET/);
  });
});

test("Checker progress redacts rejection reasons and remains separate from requirement outcomes", async () => {
  await withTempDir("shallow-checker-progress-", async directory => {
    const chunks: string[] = [];
    const store = new RunStateStore({ statusByRequirementId: { R: "todo" }, acceptedSha: "sha", startedAtMs: 0, totalBudgetMs: 0 },
      join(directory, "ledger.jsonl"), { write: chunk => { chunks.push(chunk); } }, ["opaque-credential"]);
    await store.record({ at: "2026-10-18T00:00:00Z", type: "check_progress", packetId: "p", detail: {
      jobId: "j", snapshotId: "s", checkedSourceSha: "sha", moduleEpoch: 1, attempt: 1, mode: "replay", requirementIds: ["R"],
      stage: "review_rejected", cached: true, reason: "opaque-credential\nFORGED", clauseIds: ["R:result"],
    } });
    const human = new HumanRunFormatter().format(chunks[0]!)!;
    assert.match(human, /跳过已被拒绝的程序/);
    assert.doesNotMatch(human, /\n|opaque-credential/);
    assert.doesNotMatch(await readFile(join(directory, "ledger.jsonl"), "utf8"), /opaque-credential/);
    assert.equal(store.snapshot.statusByRequirementId.R, "todo");
    assert.equal(store.snapshot.ledger[0]!.phase, "checker");
  });
});

test("Internal events are correlated; private previews stay out of public logs and usage numbers survive", async () => {
  await withTempDir("shallow-observe-", async (directory) => {
    const chunks: string[] = [];
    const store = new RunStateStore({ statusByRequirementId: { R: "todo" }, acceptedSha: "sha1", startedAtMs: 0, totalBudgetMs: 0 },
      join(directory, "ledger.jsonl"), { write: (chunk) => { chunks.push(chunk); } }, ["opaque-credential"]);
    store.setPacketAttempt("p", 2);
    await store.record({ at: "2026-09-07T00:00:00Z", type: "builder_finished", packetId: "p",
      detail: { summary: "opaque-credential", contentPreview: "PRIVATE-PLAN", inputTokens: 123, apiKey: "hidden", probePlan: "NEVER-LOG" } } as unknown as RunEvent);
    store.setAcceptedSha("sha2");
    await store.record({ at: "2026-09-07T00:00:02Z", type: "checkpoint_saved", packetId: "p" });
    const [first, second] = store.snapshot.ledger;
    assert.equal(first.runId, second.runId);
    assert.notEqual(first.eventId, second.eventId);
    assert.equal(first.sequence, 1);
    assert.equal(second.sequence, 2);
    assert.equal(second.elapsedMs, 2000);
    assert.equal(second.acceptedSha, "sha2");
    assert.equal(second.attempt, 2);
    assert.equal((first.detail as Record<string, unknown>).inputTokens, 123);
    assert.match(await readFile(join(directory, "ledger.jsonl"), "utf8"), /PRIVATE-PLAN/);
    assert.doesNotMatch(chunks.join(""), /PRIVATE-PLAN|opaque-credential|NEVER-LOG|hidden/);
  });
});


test("Private diagnostics reject candidate nesting and directory-link aliases", async () => {
  await withTempDir("shallow-private-", async (directory) => {
    const output = join(directory, "output");
    await mkdir(output);
    await assert.rejects(assertPrivateRunDirectory(output, join(output, "logs")), /outside/);
    const alias = join(directory, "alias");
    await symlink(output, alias, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(assertPrivateRunDirectory(output, join(alias, "logs")), /resolves inside/);
    await assertPrivateRunDirectory(output, join(directory, "private"));
  });
});

test("Human logs show decisions, timings, evidence, receipts and final coverage without forged lines", () => {
  const formatter = new HumanRunFormatter();
  const line = formatter.format(JSON.stringify({ at: "2026-09-07T00:00:00Z", sequence: 9, attempt: 2,
    type: "builder_finished", packetId: "p", detail: { outcome: "completed", durationMs: 2300, summary: "Checked\nFORGED" } }))!;
  assert.match(line, /自述回执（非验收）/);
  assert.match(line, /本阶段耗时 2s/);
  assert.match(line, /#9 尝试 2/);
  assert.equal(line.includes("\n"), false);
  const summary = formatter.format(JSON.stringify({ type: "pipeline_finished", detail: {
    status: "partial", verifiedRequirementIds: ["a"], blockedRequirementIds: ["b"], pendingRequirementIds: ["c"], acceptedSha: "sha",
  } }))!;
  assert.match(summary, /已验证 1，业务失败 0，无法判断 0，阻塞 1，待处理 1/);
  assert.match(summary, /阻塞 ID：b；待处理 ID：c/);
});
