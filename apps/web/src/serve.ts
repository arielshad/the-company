import { createServer } from "node:http";
import { route } from "./index.js";

/** Minimal HTTP host for the web BFF (port 3000; probes /healthz, /readyz). */
const port = Number(process.env.PORT ?? 3000);

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let body: unknown;
    if (chunks.length) {
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        body = undefined;
      }
    }
    const url = (req.url ?? "/").split("?")[0]!;
    const result = route(req.method ?? "GET", url, body);
    res.writeHead(result.status, { "content-type": "application/json" });
    res.end(JSON.stringify(result.body));
  });
}).listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ svc: "web", msg: "listening", port }));
});
