import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { PlaywrightProbeRunner } from "../../src/judge/playwright-probe-runner.js";

test("Download probes verify CSV results and filename while bounding unreadable or ambiguous downloads", async () => {
  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    const mode = path.split("/").at(-1);
    if (path.startsWith("/download/")) {
      response.setHeader("content-type", "text/csv; charset=utf-8");
      response.setHeader("content-disposition", `attachment; filename="result.${mode === "filename" ? "txt" : "csv"}"`);
      if (mode === "slow") {
        response.write("2,");
        const timer = setTimeout(() => response.end("4"), 4_000);
        response.once("close", () => clearTimeout(timer));
        return;
      }
      response.end(mode === "formula" ? "2,=A1*2" : mode === "large" ? "x".repeat(100_000)
        : mode === "utf8" ? Buffer.from([0xff]) : mode === "bom" ? "\uFEFF2,4"
        : mode === "crlf" ? "Region,Sales\r\nEast,4\r\n" : mode === "empty" ? "" : "2,4");
      return;
    }
    response.setHeader("content-type", "text/html");
    const link = `<a href="/download/${mode}" download>Export CSV</a>`;
    response.end(`<main>${mode === "none" ? '<a href="#">Export CSV</a>' : link}${mode === "ambiguous" ? link : ""}</main>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    for (const [mode, verdict, category] of [
      ["correct", "pass", undefined], ["bom", "pass", undefined], ["crlf", "pass", undefined], ["empty", "pass", undefined],
      ["formula", "fail", "assertion"], ["filename", "fail", "assertion"], ["utf8", "fail", "assertion"],
      ["large", "inconclusive", "runner"], ["slow", "inconclusive", "runner"],
      ["none", "fail", "assertion"], ["ambiguous", "inconclusive", "locator"],
    ] as const) {
      const report = await new PlaywrightProbeRunner().run({ packetId: "csv", cases: [{
        id: mode, requirementIds: ["export"], purpose: "happy_path", expectationBasis: ["fixture"], steps: [
          { op: "goto", path: `/${mode}` },
          { op: "expectDownload", locator: { by: "role", role: "link", name: "Export CSV", exact: true },
            fileNameSuffix: ".csv", text: mode === "crlf" ? "Region,Sales\nEast,4\n" : mode === "empty" ? "" : "2,4" },
        ],
      }] }, { baseUrl: `http://127.0.0.1:${address.port}`, stepTimeoutMs: 1_000, caseTimeoutMs: 5_000 });
      assert.equal(report.verdict, verdict, `${mode}: ${JSON.stringify(report.failures)}`);
      assert.equal(report.failures[0]?.category, category, mode);
      if (mode === "formula") assert.doesNotMatch(report.failures[0].message, /A1\*2/);
      if (mode === "slow") assert.match(report.failures[0].message, /probe timeout/);
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
