/**
 * 主屏 TUI 的滚轮支持：终端上报滚轮事件（SGR 1006 编码），组件按行滚动。
 * 平时保持终端原生文本选择，只在可滚动审阅层显示期间开启上报。
 */

/** 按下/释放与滚轮上报（1000）+ SGR 扩展编码（1006）。 */
const MOUSE_TRACKING_ON = "\x1b[?1000h\x1b[?1006h";
const MOUSE_TRACKING_OFF = "\x1b[?1000l\x1b[?1006l";

/** 单个滚轮档的滚动行数。 */
export const WHEEL_LINES_PER_NOTCH = 3;

export function setMouseTracking(terminal: { write(data: string): void }, enabled: boolean): void {
  terminal.write(enabled ? MOUSE_TRACKING_ON : MOUSE_TRACKING_OFF);
}

/**
 * 把 SGR 滚轮事件解析为滚动方向：-1 上滚，1 下滚。
 * 其他鼠标事件（点击、拖动、横向滚轮）与键盘输入返回 undefined。
 */
export function wheelDirection(data: string): -1 | 1 | undefined {
  const match = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(data);
  if (!match) return undefined;
  const button = Number(match[1]);
  // 64 表示滚轮；低位区分上下，第 2 位为横向滚轮。
  if ((button & 64) !== 64 || (button & 2) !== 0) return undefined;
  return (button & 1) === 0 ? -1 : 1;
}
