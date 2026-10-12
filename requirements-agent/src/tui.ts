import {
  CustomEditor,
  type ExtensionContext,
  type ExtensionFactory,
} from "@mariozechner/pi-coding-agent";
import { Container, Spacer, Text } from "@mariozechner/pi-tui";
import { buildDraftContext, type DraftStore } from "./cli.js";

/** Native Pi UI hooks; the requirements workflow still owns each complete turn. */
export function createRequirementsUi(store: DraftStore) {
  let processing = false;
  const input = new InputQueue(() => { processing = false; });
  let display: ((text: string) => void) | undefined;
  const extension: ExtensionFactory = (pi) => {
    display = (content) => pi.sendMessage({
      customType: "requirements-workflow",
      content,
      display: true,
    });
    pi.registerMessageRenderer("requirements-workflow", (message) => {
      const content = typeof message.content === "string" ? message.content : "";
      const component = new Container();
      component.addChild(new Spacer(1));
      // Review output contains literal YAML: preserve its indentation exactly.
      component.addChild(new Text(content.trim(), 1, 0));
      return component;
    });
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.setHeader((_tui, theme) => new Text(
        theme.bold(theme.fg("accent", "Requirements Agent — 需求整理")) + "\n" +
          "Enter 提交 · Shift+Enter 换行 · ↑/↓ 历史 · Esc 中止 · Ctrl+C 两次退出\n" +
          "Ctrl+O 展开工具 · Ctrl+T 切换思考 · Ctrl+G 外部编辑器 · /settings 设置",
        1,
        1,
      ));
      ctx.ui.setEditorComponent((tui, theme, keybindings) => new class extends CustomEditor {
        handleInput(data: string): void {
          // Follow-up is routed through the same complete-turn workflow as Enter.
          super.handleInput(keybindings.matches(data, "app.message.followUp") ? "\r" : data);
        }
      }(tui, theme, keybindings));
    });
    pi.on("input", (event, ctx) => {
      if (event.source === "extension") return { action: "continue" };
      if (processing) {
        ctx.ui.setEditorText(event.text);
        ctx.ui.notify("请等待本轮完成，或按 Esc 中止后再提交。", "info");
      } else {
        processing = true;
        input.push(event.text);
      }
      return { action: "handled" };
    });
    pi.on("before_agent_start", (event) => ({
      systemPrompt: `${event.systemPrompt}\n\n${buildDraftContext(store)}`,
    }));
    pi.on("context", (event) => ({ messages: event.messages.filter((message) =>
      message.role !== "custom" || message.customType !== "requirements-workflow") }));
    // The draft and reviewed output belong to this conversation; jumping to a
    // different Pi history would leave them unrelated to the visible session.
    const keepConversation = (_event: unknown, ctx: ExtensionContext) => {
      ctx.ui.notify("需求草案保留在当前对话；退出后重新运行 shallow req 可开始新需求。", "info");
      return { cancel: true };
    };
    pi.on("session_before_switch", keepConversation);
    pi.on("session_before_fork", keepConversation);
    pi.on("session_before_tree", keepConversation);
    pi.on("user_bash", () => ({ result: {
      output: "需求整理使用 read 与 update_requirements；请在另一个终端执行命令。",
      exitCode: 1,
      cancelled: false,
      truncated: false,
    } }));
  };
  return {
    extension,
    input,
    out(text: string): void { display?.(text); },
    close(): void { input.close(); },
  };
}

/** Connect Pi's input hook to the serial conversation iterator. */
class InputQueue implements AsyncIterable<string> {
  private readonly values: string[] = [];
  private wake?: () => void;
  private closed = false;
  constructor(private readonly ready: () => void) {}
  push(value: string): void { this.values.push(value); this.wake?.(); }
  close(): void { this.closed = true; this.wake?.(); }
  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    while (!this.closed) {
      if (this.values.length) {
        yield this.values.shift()!;
        this.ready();
      }
      else await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }
}
