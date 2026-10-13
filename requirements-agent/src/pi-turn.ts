import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ChatTurnResult } from "./cli.js";

export type PiTurnSession = Pick<AgentSession,
  "prompt" | "subscribe" | "messages" | "waitForIdle"
>;

/** 等待当前回合及 SDK 延迟恢复完成，保留压缩前的正常终止回复。 */
export async function runPiTurn(session: PiTurnSession, text: string): Promise<ChatTurnResult> {
  let lastAssistantResponse: Extract<(typeof session.messages)[number], { role: "assistant" }> | undefined;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "agent_start") {
      lastAssistantResponse = undefined;
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      // SDK 可能从投影历史中移除失败回复；message_end 保留实际终止原因。
      lastAssistantResponse = event.message;
    }
  });
  try {
    await session.prompt(text, { expandPromptTemplates: false });
    // 会话级 idle 包含 SDK 自动压缩、重试和延迟恢复。
    await session.waitForIdle();
    const last = lastAssistantResponse ?? session.messages.at(-1);
    if (!last || last.role !== "assistant") return { ok: false, error: "模型没有返回结果" };
    if (last.stopReason !== "stop") {
      return { ok: false, error: last.errorMessage ?? `模型回复未正常完成（${last.stopReason}）` };
    }
    const reply = last.content.filter((part) => part.type === "text")
      .map((part) => part.text).join("").trim();
    if (!reply || last.content.some((part) => part.type === "toolCall")) {
      return { ok: false, error: "模型没有返回完整的终止回复" };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error) };
  } finally {
    unsubscribe();
  }
}
