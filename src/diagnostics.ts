/** Redact before truncation so a limit cannot expose a credential prefix. */
export function sanitizeDiagnosticText(text: string, secrets: readonly string[] = [], limit = 1_500): string {
  let value = text;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    value = value.replaceAll(secret, "[redacted]");
  }
  value = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/("(?:password|token|access_token|refresh_token|api[_-]?key|secret|cookie|authorization)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[redacted]"')
    .replace(/\b(?:set-cookie|cookie|authorization)\s*:\s*[^\r\n]+/gi, (header) => `${header.split(":", 1)[0]}: [redacted]`)
    .replace(/\b(Bearer|Basic)\s+[^\s"',}]+/gi, "$1 [redacted]")
    .replace(/\b(password|(?:access_|refresh_)?token|api[_-]?key|secret|cookie|authorization)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"',;&}]+)/gi, "$1=[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, " ")
    .replace(/[ \t]{2,}/g, " ");
  return value.slice(0, limit);
}
