import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sendJson } from "./lib/http.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const staticRoot = resolve(here, "../../frontend/dist");
const extraPorts = JSON.parse(await readFile(join(here, "platform-ports.json"), "utf8"));
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

async function handler(request, response) {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/api/health")) {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method !== "GET") {
      sendJson(response, 404, { error: "Not found" });
      return;
    }
    const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (!relative || relative.includes("..") || relative.startsWith("api/")) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }
    try {
      const content = await readFile(join(staticRoot, relative));
      response.writeHead(200, {
        "content-type": contentTypes.get(extname(relative)) ?? "application/octet-stream",
      });
      response.end(content);
    } catch (error) {
      if (error?.code === "ENOENT") {
        sendJson(response, 404, { error: "Not found" });
        return;
      }
      throw error;
    }
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const primaryPort = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(primaryPort) || primaryPort <= 0 || primaryPort > 65535) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`);
}
const ports = [
  primaryPort,
  ...(process.env.ARC_EXTRA_PORTS === "0" ? [] : extraPorts),
].filter((port, index, all) => Number.isInteger(port) && port > 0 && port <= 65535 && all.indexOf(port) === index);

const servers = ports.map((port) => createServer((request, response) => {
  void handler(request, response);
}).listen(port, "0.0.0.0", () => {
  console.log(`application listening on ${port}`);
}));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    for (const server of servers) server.close();
  });
}
