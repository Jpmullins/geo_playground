import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const port = Number(process.env.PORT || 3000);
const telemetryBase = process.env.TELEMETRY_API_BASE || "http://telemetry-gateway:8080";

const indexPath = path.join(__dirname, "index.html");

const server = http.createServer(async (req, res) => {
  if (req.url === "/" || req.url?.startsWith("/?")) {
    const html = fs.readFileSync(indexPath, "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (req.url?.startsWith("/api/")) {
    const upstreamUrl = new URL(req.url.replace("/api", ""), telemetryBase);

    try {
      const upstream = await fetch(upstreamUrl, {
        method: req.method,
        headers: {
          "content-type": req.headers["content-type"] || "application/json"
        },
        body: req.method === "GET" || req.method === "HEAD" ? undefined : req,
        duplex: "half"
      });

      const upstreamBody = await upstream.arrayBuffer();
      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") || "application/json",
        "cache-control": "no-store"
      });
      res.end(Buffer.from(upstreamBody));
      return;
    } catch (error) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "upstream_unreachable", detail: error.message }));
      return;
    }
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(port, () => {
  console.log(`ui listening on :${port}`);
});
