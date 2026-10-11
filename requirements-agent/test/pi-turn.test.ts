import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentSessionEvent, AgentSessionEventListener } from "@mariozechner/pi-coding-agent";
import { runPiTurn, type PiTurnSession } from "../src/pi-turn.js";

type Assistant = Extract<PiTurnSession["messages"][number], { role: "assistant" }>;

function reply(stopReason: Assistant["stopReason"], text = "需求已整理。", toolCall = false): Assistant {
  return {
    role: "assistant", api: "openai-completions", provider: "fake", model: "fake",
    content: toolCall ? [{ type: "toolCall", id: "call-1", name: "update_requirements", arguments: {} }]
      : [{ type: "text", text }],
    stopReason, timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

class FakeSession implements PiTurnSession {
  messages: PiTurnSession["messages"] = [];
  isCompacting = false;
  isRetrying = false;
  isStreaming = false;
  readonly agent = { waitForIdle: async () => {} };
  readonly listeners = new Set<AgentSessionEventListener>();
  constructor(private readonly onPrompt: (session: FakeSession) => void | Promise<void>) {}
  subscribe(listener: AgentSessionEventListener) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  async prompt() { await this.onPrompt(this); }
  emit(event: AgentSessionEvent) { for (const listener of this.listeners) listener(event); }
  finish(message: Assistant) {
    this.messages.push(message);
    this.emit({ type: "message_end", message });
  }
}

test("截断、取消、空回复及未完成工具调用都不视为成功回合", async () => {
  for (const message of [reply("length"), reply("aborted"), reply("error"), reply("stop", ""), reply("stop", "", true)]) {
    const session = new FakeSession((current) => current.finish(message));
    const result = await runPiTurn(session, "生成需求文档");
    assert.equal(result.ok, false, `${message.stopReason} 应阻止进入审阅`);
    assert.equal(session.listeners.size, 0);
  }
});

test("阈值压缩改写消息历史后仍保留当前正常终止回复", async () => {
  const session = new FakeSession((current) => {
    current.finish(reply("stop"));
    current.messages = [];
  });
  assert.deepEqual(await runPiTurn(session, "整理需求"), { ok: true });
});

test("等待压缩后的延迟恢复，恢复尚未开始时不能提前结束回合", { timeout: 2_000 }, async () => {
  let resumed = false;
  const session = new FakeSession((current) => {
    current.emit({ type: "compaction_end", reason: "overflow", result: undefined, aborted: false, willRetry: true });
    setTimeout(() => {
      resumed = true;
      current.emit({ type: "agent_start" });
      current.finish(reply("stop"));
    }, 120);
  });
  assert.deepEqual(await runPiTurn(session, "继续补充需求"), { ok: true });
  assert.equal(resumed, true);
  assert.equal(session.listeners.size, 0);
});
