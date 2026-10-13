import { matchesKey, Text, type Component, type TUI } from "@earendil-works/pi-tui";
import { terminalRow, type TerminalTheme } from "./theme.js";

/** Read-only, scrollable document used for requirements and run details. */
export class TextViewer implements Component {
  private readonly body = new Text("", 1, 0);
  private offset = 0;
  private pageSize = 1;
  private lineCount = 0;
  onToggle?: () => void;

  constructor(
    private readonly tui: TUI,
    private readonly theme: TerminalTheme,
    private title: string,
    text: string,
    private readonly close: () => void,
  ) {
    this.body.setText(text);
  }

  setText(title: string, text: string, resetPosition = true): void {
    const atEnd = this.offset + this.pageSize >= this.lineCount;
    this.title = title;
    this.body.setText(text);
    if (resetPosition) this.offset = 0;
    else if (atEnd) this.scrollToEnd();
    this.tui.requestRender();
  }

  scrollToEnd(): void { this.offset = Number.MAX_SAFE_INTEGER; }

  invalidate(): void { this.body.invalidate(); }

  render(width: number): string[] {
    const lines = this.body.render(width);
    this.lineCount = lines.length;
    // Fill the terminal height so an overlay hides the base UI instead of leaving a second hint row behind it.
    this.pageSize = Math.max(1, this.tui.terminal.rows - 4);
    this.offset = Math.min(this.offset, Math.max(0, lines.length - this.pageSize));
    const position = `${this.offset + 1}–${Math.min(lines.length, this.offset + this.pageSize)} / ${lines.length}`;
    const hint = this.onToggle ? "Enter 返回 · v YAML · ↑↓ 滚动" : "Esc 返回 · ↑↓ 滚动 · PgUp/Dn 翻页";
    return [
      new Text(this.theme.accent(this.theme.strong(this.title)), 1, 0).render(width)[0],
      this.theme.muted("─".repeat(width)),
      ...lines.slice(this.offset, this.offset + this.pageSize),
      ...Array<string>(Math.max(0, this.pageSize - lines.length)).fill(""),
      this.theme.muted("─".repeat(width)),
      terminalRow(new Text(this.theme.muted(hint), 1, 0).render(width)[0], this.theme.muted(position), width),
    ];
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "enter")) { this.close(); return; }
    if (this.onToggle && data === "v") { this.onToggle(); return; }
    if (matchesKey(data, "up")) this.offset--;
    else if (matchesKey(data, "down")) this.offset++;
    else if (matchesKey(data, "pageUp")) this.offset -= this.pageSize;
    else if (matchesKey(data, "pageDown")) this.offset += this.pageSize;
    else if (matchesKey(data, "home")) this.offset = 0;
    else if (matchesKey(data, "end")) this.offset = this.lineCount;
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, this.lineCount - this.pageSize)));
    this.tui.requestRender();
  }
}
