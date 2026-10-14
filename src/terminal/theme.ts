import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Shared terminal palette; the terminal owns the background and body colour. */
export function terminalTheme(colour = process.env.NO_COLOR === undefined && process.env.TERM !== "dumb") {
  const paint = (code: string) => (text: string): string => colour ? `\x1b[${code}m${text}\x1b[0m` : text;
  return {
    // Bright variants stay legible on dark terminals; "muted" is intentionally subtle.
    accent: paint("96"),
    muted: paint("2"),
    strong: paint("1"),
    success: paint("92"),
    warning: paint("93"),
    error: paint("91"),
  };
}

export type TerminalTheme = ReturnType<typeof terminalTheme>;

export function fitTerminalText(text: string, width: number): string {
  const fitted = truncateToWidth(text, width, "…");
  // Pi's truncator adds a reset even to unstyled text; keep redirected text plain.
  return text.includes("\x1b") ? fitted : fitted.replaceAll("\x1b[0m", "");
}

export function terminalHeader(mode: string, width: number, theme: TerminalTheme): string[] {
  return [
    fitTerminalText(` ${theme.accent(theme.strong("Shallow Code"))} ${theme.muted("/ ")}${mode}`, width),
    theme.muted("─".repeat(Math.max(0, width))),
  ];
}

export function terminalRow(left: string, right: string, width: number): string {
  if (visibleWidth(left) + visibleWidth(right) + 2 > width) return fitTerminalText(left, width);
  return left + " ".repeat(width - visibleWidth(left) - visibleWidth(right)) + right;
}

export function elapsedTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function shellArgument(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
