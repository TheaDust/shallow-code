import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { ChatTurnResult } from "./cli.js";

export type PiTurnSession = Pick<AgentSession,
  "prompt" | "subscribe" | "messages" | "isCompacting" | "isRetrying" | "isStreaming"
> & { agent: Pick<AgentSession["agent"], "waitForIdle"> };

/** 等待当前回合及 SDK 延迟恢复完成，保留压缩前的正常终止回复。 */
export async function runPiTurn(session: PiTurnSession, text: string): Promise<ChatTurnResult> {
  let pendingRestart = false;
  let terminalResponse: Extract<(typeof session.messages)[number], { role: "assistant" }> | undefined;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "agent_start") {
      pendingRestart = false;
      terminalResponse = undefined;
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      terminalResponse = event.message.stopReason === "stop"
        && !event.message.content.some((part) => part.type === "toolCall")
        ? event.message : undefined;
    }
    if (event.type === "compaction_end") {
      const retained = session.messages.at(-1);
      pendingRestart = event.willRetry && !terminalResponse
        && (retained?.role !== "assistant" || retained.stopReason === "error");
    }
  });
  try {
    await session.prompt(text, { expandPromptTemplates: false });
    for (;;) {
      // SDK 在 compaction_end 后延迟启动 continue；不能在两者之间接收新回合。
      await new Promise((resolve) => setTimeout(resolve, 50));
      await session.agent.waitForIdle();
      if (!session.isCompacting && !session.isRetrying && !session.isStreaming && !pendingRestart) break;
    }
    const last = terminalResponse ?? session.messages.at(-1);
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
