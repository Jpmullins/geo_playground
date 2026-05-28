import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const port = Number(process.env.PORT || 3000);
const telemetryBase = process.env.TELEMETRY_API_BASE || "http://telemetry-gateway:8080";
const copilotRuntimeBase = process.env.COPILOT_RUNTIME_BASE || "http://copilot-runtime:8091";

const distPath = path.join(__dirname, "dist");
const indexPath = path.join(distPath, "index.html");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (url.pathname.startsWith("/api/copilotkit")) {
    await proxyRequest(req, res, new URL(req.url || "/", copilotRuntimeBase), true);
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    const upstreamPath = `${url.pathname.replace(/^\/api/, "")}${url.search}`;
    await proxyRequest(req, res, new URL(upstreamPath, telemetryBase), url.pathname.includes("/copilot/stream"));
    return;
  }

  if (url.pathname !== "/" && serveStatic(url.pathname, res)) {
    return;
  }

  if (fs.existsSync(indexPath)) {
    const html = fs.readFileSync(indexPath, "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(port, () => {
  console.log(`ui listening on :${port}`);
});

function readRequestBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function proxyRequest(req, res, upstreamUrl, forceStream = false) {
  try {
    const requestBody = await readRequestBody(req);
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: {
        "content-type": req.headers["content-type"] || "application/json",
        accept: req.headers.accept || "*/*"
      },
      body: req.method === "GET" || req.method === "HEAD" ? undefined : requestBody
    });

    const contentType = upstream.headers.get("content-type") || "application/json";
    if ((forceStream || contentType.includes("text/event-stream")) && upstream.body) {
      res.writeHead(upstream.status, {
        "content-type": contentType,
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      });
      Readable.fromWeb(upstream.body).pipe(res);
      return;
    }

    const upstreamBody = await upstream.arrayBuffer();
    res.writeHead(upstream.status, {
      "content-type": contentType,
      "cache-control": "no-store"
    });
    res.end(Buffer.from(upstreamBody));
  } catch (error) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: "upstream_unreachable",
      detail: error instanceof Error ? error.message : String(error)
    }));
  }
}

function serveStatic(urlPath, res) {
  const normalized = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(distPath, normalized);
  if (!filePath.startsWith(distPath) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return false;
  }
  res.writeHead(200, {
    "content-type": contentTypeFor(filePath),
    "cache-control": "public, max-age=31536000, immutable"
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

function contentTypeFor(filePath) {
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}
