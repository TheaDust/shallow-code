import type { Terminal } from "@earendil-works/pi-tui";

export class MemoryTerminal implements Terminal {
  columns = 80;
  rows = 24;
  kittyProtocolActive = false;
  readonly writes: string[] = [];
  starts = 0;
  stops = 0;
  private onInput?: (data: string) => void;

  start(onInput: (data: string) => void): void { this.starts++; this.onInput = onInput; }
  stop(): void { this.stops++; this.onInput = undefined; }
  input(data: string): void { this.onInput?.(data); }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.writes.push(data); }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(): void {}
}
