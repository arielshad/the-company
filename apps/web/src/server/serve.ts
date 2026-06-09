import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { route } from "../index.js";

/**
 * Production host for the web app: serves the built Vite SPA from dist/ and
 * handles /api/* + health probes via the BFF (src/index.ts). Port 3000 to match
 * the Kubernetes Deployment (infra/base/web).
 */
const port = Number(process.env.PORT ?? 3000);
const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist");

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

async function serveStatic(path: string): Promise<{ status: number; body: Buffer; type: string }> {
  const rel = path === "/" ? "/index.html" : path;
  try {
    const file = await readFile(join(dist, rel));
    return { status: 200, body: file, type: MIME[extname(rel)] ?? "application/octet-stream" };
  } catch {
    // SPA fallback
    try {
      const index = await readFile(join(dist, "index.html"));
      return { status: 200, body: index, type: "text/html" };
    } catch {
      return { status: 404, body: Buffer.from("dist not built — run `pnpm --filter @companyos/web build`"), type: "text/plain" };
    }
  }
}

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const url = (req.url ?? "/").split("?")[0]!;
    const method = req.method ?? "GET";

    if (url.startsWith("/api") || url === "/healthz" || url === "/readyz") {
      let body: unknown;
      if (chunks.length) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          body = undefined;
        }
      }
      const result = route(method, url, body);
      res.writeHead(result.status, { "content-type": "application/json" });
      res.end(JSON.stringify(result.body));
      return;
    }

    const file = await serveStatic(url);
    res.writeHead(file.status, { "content-type": file.type });
    res.end(file.body);
  });
}).listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ svc: "web", msg: "listening", port }));
});
