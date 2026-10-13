import {
  getSelectListTheme,
  initTheme,
  type AgentSessionEvent,
  type AgentSessionEventListener,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Editor,
  Loader,
  Markdown,
  matchesKey,
  ProcessTerminal,
  Spacer,
  Text,
  TuiMainScreen,
  type TUI,
  type Component,
  type MarkdownTheme,
  type OverlayHandle,
  type Terminal,
} from "@earendil-works/pi-tui";
import { terminalHeader, terminalTheme } from "../../src/terminal/theme.js";
import { TextViewer } from "../../src/terminal/text-viewer.js";
import type { ConversationView } from "./cli.js";
import { serializeRequirementsYaml, summarizeTree, type RequirementNode } from "./dsl.js";
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
  readonly tui: TUI;
  private readonly theme = terminalTheme();
  private readonly chat = new Container();
  private readonly status = new Container();
  private readonly context = new Text("", 1, 0);
  private readonly footer = new Text("", 1, 0);
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
  private draft?: Extract<ConversationView, { type: "draft" }>;
  private review?: Extract<ConversationView, { type: "review" }>;
  private overlay?: OverlayHandle;

  constructor(private readonly options: RequirementsTuiOptions, terminal: Terminal = new ProcessTerminal()) {
    this.tui = new TuiMainScreen(terminal);
    initTheme();
    const t = this.theme;
    this.markdownTheme = {
      heading: text => t.accent(t.strong(text)), link: t.accent, linkUrl: t.muted,
      code: t.accent, codeBlock: text => text, codeBlockBorder: t.muted,
      quote: t.muted, quoteBorder: t.muted, hr: t.muted, listBullet: t.accent,
      bold: t.strong, italic: text => text, strikethrough: text => text, underline: t.accent,
    };
    this.queue = new InputQueue(() => { this.setBusy(false); });
    this.editor = new Editor(this.tui, { borderColor: this.theme.accent, selectList: getSelectListTheme() }, { paddingX: 1 });
    this.editor.onSubmit = (text) => { this.submit(text); };
    this.tui.addChild({ render: width => terminalHeader("Requirements Agent", width, this.theme), invalidate() {} });
    this.tui.addChild(new Spacer(1));
    this.tui.addChild(this.chat);
    this.tui.addChild(new Spacer(1));
    this.tui.addChild(this.context);
    this.tui.addChild(this.status);
    this.tui.addChild(this.editor);
    this.tui.addChild(this.footer);
    this.tui.addInputListener((data) => this.handleKey(data));
    this.updateContext();
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

  present(view: ConversationView): void {
    const t = this.theme;
    if (view.type === "intro") {
      this.append(new Text(t.strong("从一句想法开始。") + "\n" +
        "描述你想做的应用，也可以给出现有需求文档的路径。\n" +
        t.muted("需要生成时输入“生成需求文档”；我会先展示草案供你确认。"), 1, 0));
    } else if (view.type === "draft") {
      this.draft = view;
      this.review = undefined;
      const changes = view.changes;
      const lines = [t.strong(`${view.restored ? "草案恢复" : "草案更新"} ${t.muted("· r" + view.revision)}`)];
      for (const [key, label, colour] of [["added", "+ 新增", t.success], ["changed", "~ 修改", t.accent],
        ["removed", "− 删除", t.warning]] as const) {
        const refs = changes[key];
        if (refs.length) lines.push(`${colour(`${label} ${refs.length} 项`)}  ` +
          refs.slice(0, 6).map(ref => `${ref.name}${t.muted("（" + ref.id + "）")}`).join("、") + (refs.length > 6 ? "…" : ""));
      }
      if (!view.restored && !changes.added.length && !changes.changed.length && !changes.removed.length) lines.push(t.muted("本轮草案无变化"));
      this.append(new Text(lines.join("\n"), 1, 0));
    } else if (view.type === "review") {
      this.review = view;
      this.append(new Text(t.accent(t.strong(`需求审阅 · r${view.revision}`)), 1, 0));
      this.append(new Text(formatRequirementPreview(view.tree), 1, 0));
      if (view.references.length) this.append(new Text(t.muted("将交接的参考文件") + "\n" +
        view.references.map(ref => `${ref.source} → ${ref.destination}`).join("\n"), 1, 0));
      this.append(new Text(t.strong("是否生成这份需求文档？") + "\n" +
        "回复“是”生成；回复其他内容继续修改。" + t.muted("  F2 可滚动审阅或查看完整 YAML。"), 1, 0));
    } else if (view.type === "edit") {
      this.review = undefined;
    }
    this.updateContext();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.loader?.stop();
    this.overlay?.hide();
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
      this.append(new Text(this.theme.muted("需求助手"), 1, 0));
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
    this.append(new Text(`${this.theme.accent("›")} ${text}`, 1, 0));
    this.setBusy(true);
    this.queue.push(text);
  }

  private handleKey(data: string): { consume: boolean } | undefined {
    if (matchesKey(data, "f2")) {
      if (this.overlay) this.closePreview();
      else this.openPreview();
      return { consume: true };
    }
    if (this.overlay && matchesKey(data, "escape")) return undefined;
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
      const loader = this.loader ??= new Loader(this.tui, this.theme.accent, this.theme.muted, WORKING_MESSAGE);
      loader.setMessage(WORKING_MESSAGE);
      if (!this.status.children.includes(loader)) this.status.addChild(loader);
      loader.start();
    } else {
      this.loader?.stop();
      this.status.clear();
    }
    this.editor.borderColor = busy ? this.theme.muted : this.theme.accent;
    this.updateContext();
    this.tui.requestRender();
  }

  private updateContext(): void {
    const tree = this.draft?.tree;
    const summary = tree ? summarizeTree(tree) : null;
    const count = summary ? `草案 r${this.draft!.revision} · ${summary.atomics} 个功能 · ${summary.scenarios} 个场景` : "等待第一份草案";
    const next = this.review ? "等待确认 · 回复“是”生成" : this.draft?.questions.length
      ? `待确认 ${this.draft.questions.length} 个问题` : tree ? "继续补充，或输入“生成需求文档”" : "描述你的想法";
    this.context.setText(this.theme.muted(count) + "\n" + (this.review ? this.theme.warning(next) : this.theme.muted(next)));
    this.footer.setText(this.theme.muted(this.busy ? "Esc 中止本轮   F2 草案预览" :
      "Enter 发送   Shift+Enter 换行   F2 草案预览   Ctrl+C 清空/退出"));
    if (this.started && !this.stopped) this.tui.requestRender();
  }

  private openPreview(): void {
    const tree = this.review?.tree ?? this.draft?.tree;
    if (!tree) { this.notice("还没有草案；先描述你想做的应用。"); return; }
    let yaml = false;
    const title = `需求草案 · r${this.review?.revision ?? this.draft?.revision}`;
    const viewer = new TextViewer(this.tui, this.theme, title, formatRequirementPreview(tree), () => this.closePreview());
    viewer.onToggle = () => {
      yaml = !yaml;
      viewer.setText(title + (yaml ? " · YAML" : ""), yaml ? serializeRequirementsYaml(tree) : formatRequirementPreview(tree));
    };
    this.overlay = this.tui.showOverlay(viewer, { width: "100%", anchor: "top-left" });
  }

  private closePreview(): void {
    this.overlay?.hide(); this.overlay = undefined;
    this.tui.setFocus(this.editor);
  }

  private append(component: Component): void {
    if (this.chat.children.length > 0) this.chat.addChild(new Spacer(1));
    this.chat.addChild(component);
    this.tui.requestRender();
  }

  private notice(text: string): void {
    this.append(new Text(this.theme.muted(text), 1, 0));
  }
}

/** Render the same tree used for export, including every scenario clause. */
export function formatRequirementPreview(tree: RequirementNode): string {
  const lines: string[] = [];
  const visit = (node: RequirementNode, depth: number): void => {
    const indent = "  ".repeat(depth);
    lines.push(`${indent}${node.type === "ATOMIC" ? "◆" : "▸"} ${node.name} · ${node.id}`);
    if (node.description) lines.push(...node.description.split("\n").map(line => `${indent}  ${line}`));
    if (node.dependencies.length) lines.push(`${indent}  依赖：${node.dependencies.join("、")}`);
    if (node.visual_reference?.length) lines.push(`${indent}  参考：${node.visual_reference.join("、")}`);
    for (const data of node.data ?? []) lines.push(`${indent}  初始数据 · ${data.category}`,
      ...data.items.map(item => `${indent}    ${item}`));
    for (const scenario of node.scenarios) {
      lines.push(`${indent}  场景：${scenario.name} · ${scenario.id}`);
      for (const step of scenario.steps) lines.push(`${indent}    ${step.keyword.padEnd(5)} ${step.content}`);
    }
    lines.push("");
    for (const child of node.children) visit(child, depth + 1);
  };
  visit(tree, 0);
  return lines.join("\n").trimEnd();
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
