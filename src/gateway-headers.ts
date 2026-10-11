/**
 * opencode.ai 的 Zen / Go 网关要求第三方客户端为每个会话发送稳定的
 * x-opencode-session，否则请求被 400 拒绝；其他网关不附加该头。
 */
export function opencodeSessionHeaders(baseUrl: string, sessionId: string): Record<string, string> {
  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    return {};
  }
  if (host !== "opencode.ai" && !host.endsWith(".opencode.ai")) return {};
  return { "x-opencode-session": sessionId };
}
