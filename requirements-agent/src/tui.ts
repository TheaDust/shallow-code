import {
  getMarkdownTheme,
  getSelectListTheme,
  initTheme,
  type AgentSessionEvent,
  type AgentSessionEventListener,
} from "@mariozechner/pi-coding-agent";
import {
  Container,
  Editor,
  Loader,
  Markdown,
  matchesKey,
  ProcessTerminal,
  Spacer,
  Text,
  TUI,
  type Component,
  type MarkdownTheme,
} from "@mariozechner/pi-tui";

const dim = (text: string) => `\x1b[2m${text}\x1b[22m`;
const accent = (text: string) => `\x1b[36m${text}\x1b[39m`;
const WORKING_MESSAGE = "正在思考…";

export interface RequirementsTuiOptions {
  /** 中止当前回合（Esc 或处理中的 Ctrl+C）。 */
  onAbort(): void;
  /** 用户请求退出（空输入时连续两次 Ctrl+C，或 Ctrl+D）。 */
  onExit(): void;
}

/**
 * 轻量对话终端：多行编辑、流式 Markdown 与工具状态。
 * 只呈现需求整理工作流，不提供命令面板或会话管理入口。
 */
export class RequirementsTui {
  private readonly tui = new TUI(new ProcessTerminal());
  private readonly chat = new Container();
  private readonly status = new Container();
  private readonly editor: Editor;
  private loader: Loader | undefined;
  private readonly markdownTheme: MarkdownTheme;
  private readonly queue: InputQueue;
  private assistant: { component: Markdown; text: string } | undefined;
  private unsubscribe: (() => void) | undefined;
  private busy = false;
  private started = false;
  private stopped = false;
  private lastCtrlC = 0;

  constructor(private readonly options: RequirementsTuiOptions) {
    initTheme();
    this.markdownTheme = getMarkdownTheme();
    this.queue = new InputQueue(() => { this.setBusy(false); });
    this.editor = new Editor(this.tui, { borderColor: dim, selectList: getSelectListTheme() });
    this.editor.onSubmit = (text) => { this.submit(text); };
    this.tui.addChild(this.chat);
    this.tui.addChild(this.status);
    this.tui.addChild(this.editor);
    this.tui.addInputListener((data) => this.handleKey(data));
  }

  /** 用户回合队列；runConversation 按提交顺序串行消费。 */
  get input(): AsyncIterable<string> {
    return this.queue;
  }

  start(): void {
    this.started = true;
    this.tui.start();
    this.tui.setFocus(this.editor);
  }

  /** 渲染会话的助手流式回复与工具执行状态。 */
  watchSession(session: { subscribe(listener: AgentSessionEventListener): () => void }): void {
    this.unsubscribe = session.subscribe((event) => { this.render(event); });
  }

  /** 工作流消息：横幅、草案摘要、审阅内容与提示。 */
  out(text: string): void {
    const content = text.replace(/\s+$/u, "");
    if (!content.trim()) return;
    this.append(new Text(content, 1, 0));
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.loader?.stop();
    if (this.started) this.tui.stop();
  }

  close(): void {
    this.queue.close();
  }

  private render(event: AgentSessionEvent): void {
    if (event.type === "message_start" && event.message.role === "assistant") {
      this.assistant = undefined;
      return;
    }
    if (event.type === "message_update" && event.message.role === "assistant") {
      this.streamAssistant(event.message.content);
      return;
    }
    if (event.type === "message_end") {
      this.assistant = undefined;
      return;
    }
    if (event.type === "tool_execution_start") {
      const message = toolMessage(event.toolName, event.args);
      this.notice(message);
      this.loader?.setMessage(message);
      return;
    }
    if (event.type === "tool_execution_end") {
      this.loader?.setMessage(WORKING_MESSAGE);
    }
  }

  private streamAssistant(content: ReadonlyArray<{ type: string; text?: string }>): void {
    const text = content.filter((part) => part.type === "text")
      .map((part) => part.text ?? "").join("\n");
    if (!text) return;
    if (!this.assistant) {
      const component = new Markdown(text, 1, 0, this.markdownTheme);
      this.assistant = { component, text };
      this.append(component);
      return;
    }
    if (text !== this.assistant.text) {
      this.assistant.text = text;
      this.assistant.component.setText(text);
      this.tui.requestRender();
    }
  }

  private submit(raw: string): void {
    const text = raw.trim();
    if (!text) return;
    if (this.busy) {
      this.editor.setText(text);
      this.notice("请等待本轮完成，或按 Esc 中止后再提交。");
      return;
    }
    this.editor.addToHistory(text);
    this.append(new Text(`${accent("›")} ${text}`, 1, 0));
    this.setBusy(true);
    this.queue.push(text);
  }

  private handleKey(data: string): { consume: boolean } | undefined {
    if (matchesKey(data, "ctrl+c")) {
      if (this.busy) {
        this.options.onAbort();
        this.notice("正在中止当前回合…");
      } else if (this.editor.getText().length > 0) {
        this.editor.setText("");
        this.notice("已清空输入；再按一次 Ctrl+C 退出。");
        this.lastCtrlC = Date.now();
      } else if (Date.now() - this.lastCtrlC < 1_500) {
        this.options.onExit();
      } else {
        this.notice("再按一次 Ctrl+C 退出。");
        this.lastCtrlC = Date.now();
      }
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+d")) {
      if (!this.busy && this.editor.getText().length === 0) {
        this.options.onExit();
        return { consume: true };
      }
      return undefined;
    }
    if (this.busy && matchesKey(data, "escape")) {
      this.options.onAbort();
      this.notice("正在中止当前回合…");
      return { consume: true };
    }
    return undefined;
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    if (busy) {
      const loader = this.loader ??= new Loader(this.tui, accent, dim, WORKING_MESSAGE);
      loader.setMessage(WORKING_MESSAGE);
      if (!this.status.children.includes(loader)) this.status.addChild(loader);
      loader.start();
    } else {
      this.loader?.stop();
      this.status.clear();
    }
    this.tui.requestRender();
  }

  private append(component: Component): void {
    if (this.chat.children.length > 0) this.chat.addChild(new Spacer(1));
    this.chat.addChild(component);
    this.tui.requestRender();
  }

  private notice(text: string): void {
    this.append(new Text(dim(text), 1, 0));
  }
}

function toolMessage(name: string, args: unknown): string {
  if (name === "read") {
    const path = (args as { path?: unknown } | null | undefined)?.path;
    return typeof path === "string" && path ? `正在读取文件：${path}` : "正在读取文件…";
  }
  if (name === "update_requirements") return "正在更新需求草案…";
  return `正在执行 ${name}…`;
}

/** 连接 TUI 提交与工作流循环的串行队列；ready 在本回合处理完成后触发。 */
class InputQueue implements AsyncIterable<string> {
  private readonly values: string[] = [];
  private wake?: () => void;
  private closed = false;
  constructor(private readonly ready: () => void) {}

  push(value: string): void {
    this.values.push(value);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    while (!this.closed) {
      if (this.values.length) {
        yield this.values.shift()!;
        this.ready();
      } else {
        await new Promise<void>((resolve) => { this.wake = resolve; });
      }
    }
  }
}
