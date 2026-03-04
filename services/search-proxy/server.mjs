import http from "node:http";
import { URL } from "node:url";

const port = Number(process.env.PORT || 8082);

const server = http.createServer(async (req, res) => {
  withCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, { service: "search-proxy", status: "ok" });
  }

  if (req.method === "POST" && url.pathname === "/search/query") {
    const body = await readJson(req);
    const query = String(body?.query || "").trim();

    if (!query) {
      return json(res, 400, { error: "query_required" });
    }

    const providerUrl = new URL("https://api.duckduckgo.com/");
    providerUrl.searchParams.set("q", query);
    providerUrl.searchParams.set("format", "json");
    providerUrl.searchParams.set("no_redirect", "1");
    providerUrl.searchParams.set("no_html", "1");
    providerUrl.searchParams.set("skip_disambig", "1");

    try {
      const resp = await fetch(providerUrl, {
        headers: { "user-agent": "geo-playground-search-proxy/0.1" }
      });

      if (!resp.ok) {
        return json(res, 502, { error: "provider_error", status: resp.status });
      }

      const data = await resp.json();
      const related = Array.isArray(data.RelatedTopics) ? data.RelatedTopics : [];
      const results = related
        .flatMap((item) => item.Topics ? item.Topics : [item])
        .filter((item) => item && item.Text && item.FirstURL)
        .slice(0, 8)
        .map((item) => ({
          title: String(item.Text).split(" - ")[0],
          snippet: item.Text,
          url: item.FirstURL,
          source_ts: new Date().toISOString()
        }));

      return json(res, 200, {
        query,
        provider: "duckduckgo",
        results
      });
    } catch (error) {
      return json(res, 502, { error: "search_failed", detail: error.message });
    }
  }

  return json(res, 404, { error: "not_found" });
});

server.listen(port, () => {
  console.log(`search-proxy listening on :${port}`);
});

function readJson(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      if (!data) {
        return resolve({});
      }
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
  });
}

function withCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}
