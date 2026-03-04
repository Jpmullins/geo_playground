import http from "node:http";
import { URL } from "node:url";
import { normalizeAdsbRecord, normalizeAisMessage, validateTrackEvent } from "./schema.mjs";
import { fetchAdsbFi, fetchAirplanesLive, startAisStream } from "./providers.mjs";
import { TrackStore } from "./store.mjs";
import { createDb } from "./db.mjs";
import { createCache } from "./cache.mjs";

const port = Number(process.env.PORT || 8080);
const centerLat = Number(process.env.CENTER_LAT || 37.7749);
const centerLon = Number(process.env.CENTER_LON || -122.4194);
const radiusKm = Number(process.env.RADIUS_KM || 80);
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS || 5000);
const provider = process.env.ADSB_PROVIDER || "adsbfi";
const databaseUrl = process.env.DATABASE_URL || "postgres://geouser:geopass@localhost:5432/geodb";
const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const aisApiKey = process.env.AISSTREAM_API_KEY || "";
const openclawGatewayUrl = process.env.OPENCLAW_GATEWAY_URL || "";
const openclawGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || "";

const store = new TrackStore();
const db = createDb(databaseUrl);
const cache = createCache(redisUrl);

let adsbPollStatus = { ok: true, message: "init", at: new Date().toISOString() };
let aisStatus = { ok: false, message: "not started", at: new Date().toISOString() };

await db.init();
await cache.init();

async function persistEvent(event) {
  store.upsert(event);
  await Promise.all([
    db.insertEvent(event),
    cache.upsertEvent(event)
  ]);
}

async function pollAdsb() {
  try {
    const records = provider === "airplaneslive"
      ? await fetchAirplanesLive(centerLat, centerLon, radiusKm)
      : await fetchAdsbFi(centerLat, centerLon, radiusKm);

    let ingested = 0;
    for (const record of records) {
      const normalized = normalizeAdsbRecord(record, provider);
      if (!normalized || !validateTrackEvent(normalized)) {
        continue;
      }
      await persistEvent(normalized);
      ingested += 1;
    }

    adsbPollStatus = {
      ok: true,
      message: `ingested ${ingested} air records`,
      at: new Date().toISOString()
    };
  } catch (error) {
    adsbPollStatus = {
      ok: false,
      message: String(error.message || error),
      at: new Date().toISOString()
    };
  }
}

const aisBounds = [centerLon - 2.0, centerLat - 2.0, centerLon + 2.0, centerLat + 2.0];
const aisController = startAisStream({
  apiKey: aisApiKey,
  bbox: aisBounds,
  onStatus: (status) => { aisStatus = status; },
  onMessage: async (message) => {
    const normalized = normalizeAisMessage(message, "aisstream");
    if (!normalized || !validateTrackEvent(normalized)) {
      return;
    }

    try {
      await persistEvent(normalized);
    } catch (error) {
      aisStatus = { ok: false, message: `AIS persist error: ${error.message}`, at: new Date().toISOString() };
    }
  }
});

setInterval(() => {
  pollAdsb();
}, pollIntervalMs);

await pollAdsb();

const server = http.createServer(async (req, res) => {
  withCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, {
      service: "telemetry-gateway",
      status: adsbPollStatus.ok ? "ok" : "degraded",
      adsb: adsbPollStatus,
      ais: aisStatus
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/tracks/live") {
    const bbox = parseBbox(url.searchParams.get("bbox"));
    const events = await cache.listLive(bbox);
    const fallback = events.length === 0 ? await db.listLive(bbox) : events;

    const geojson = {
      type: "FeatureCollection",
      features: fallback.map((event) => ({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [event.lon, event.lat]
        },
        properties: event
      }))
    };
    json(res, 200, geojson);
    return;
  }

  if (req.method === "GET" && url.pathname === "/tracks/trails") {
    const bbox = parseBbox(url.searchParams.get("bbox"));
    const minutes = Number(url.searchParams.get("minutes") || 30);
    const maxEntities = Number(url.searchParams.get("max_entities") || 300);
    const rows = await db.getTrails({ minutes, maxEntities, bbox });
    const grouped = groupTrailRows(rows);

    const geojson = {
      type: "FeatureCollection",
      features: grouped
    };
    json(res, 200, geojson);
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/entities/")) {
    if (url.pathname.endsWith("/history")) {
      const historyId = url.pathname.split("/")[2];
      const start = url.searchParams.get("start");
      const end = url.searchParams.get("end");
      const events = await db.getHistory(historyId, start, end);
      json(res, 200, {
        entity_id: historyId,
        events
      });
      return;
    }

    const entityId = url.pathname.split("/")[2];
    const fromCache = await cache.getEntity(entityId);
    if (fromCache) {
      json(res, 200, fromCache);
      return;
    }

    const entity = await db.getEntity(entityId);
    if (!entity) {
      json(res, 404, { error: "entity_not_found" });
      return;
    }

    json(res, 200, entity);
    return;
  }

  if (req.method === "POST" && url.pathname === "/copilot/query") {
    const body = await readJson(req);
    const query = String(body?.query || "").trim();
    if (!query) {
      json(res, 400, { error: "query_required" });
      return;
    }

    const live = await cache.listLive(null);
    const fallback = live.length === 0 ? await db.listLive(null) : live;
    const openclawAnswer = await tryOpenclawCopilot(query, fallback);
    const answer = openclawAnswer || buildCopilotReply(query, fallback);
    json(res, 200, {
      query,
      answer,
      provider: openclawAnswer ? "openclaw" : "local-fallback",
      generated_at: new Date().toISOString()
    });
    return;
  }

  json(res, 404, { error: "not_found" });
});

server.listen(port, () => {
  console.log(`telemetry-gateway listening on :${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    aisController.stop();
    await Promise.all([db.close(), cache.close()]);
    process.exit(0);
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

function parseBbox(raw) {
  if (!raw) {
    return null;
  }
  const parts = raw.split(",").map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    return null;
  }
  return parts;
}

function groupTrailRows(rows) {
  const byEntity = new Map();
  for (const row of rows) {
    const entry = byEntity.get(row.entity_id) || { domain: row.domain, coords: [] };
    entry.coords.push([row.lon, row.lat]);
    byEntity.set(row.entity_id, entry);
  }

  const features = [];
  for (const [entityId, entry] of byEntity.entries()) {
    if (entry.coords.length < 2) {
      continue;
    }
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: entry.coords },
      properties: { entity_id: entityId, domain: entry.domain, points: entry.coords.length }
    });
  }
  return features;
}

function buildCopilotReply(query, events) {
  const air = events.filter((event) => event.domain === "air");
  const maritime = events.filter((event) => event.domain === "maritime");
  const topFast = [...events]
    .filter((event) => typeof event.speed === "number")
    .sort((a, b) => (b.speed || 0) - (a.speed || 0))
    .slice(0, 5);

  const queryLc = query.toLowerCase();
  if (queryLc.includes("fast") || queryLc.includes("speed")) {
    if (topFast.length === 0) {
      return "No speed-tagged entities are currently available.";
    }
    const lines = topFast.map((event) => {
      const id = event.identity?.callsign || event.identity?.icao || event.identity?.mmsi || event.entity_id;
      return `${id}: ${Math.round(event.speed)} kts at (${event.lat.toFixed(3)}, ${event.lon.toFixed(3)})`;
    });
    return `Fastest observed entities right now:\n${lines.join("\n")}`;
  }

  return [
    `Live picture summary for query: "${query}"`,
    `- Total entities: ${events.length}`,
    `- Air: ${air.length}`,
    `- Maritime: ${maritime.length}`,
    topFast.length > 0 ? `- Fastest: ${Math.round(topFast[0].speed)} kts (${topFast[0].entity_id})` : "- Fastest: no speed data",
    "- Note: This copilot response is grounded on current live cache only."
  ].join("\n");
}

function readJson(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 2_000_000) {
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
  });
}

async function tryOpenclawCopilot(query, events) {
  if (!openclawGatewayUrl || !openclawGatewayToken) {
    return null;
  }

  const context = buildTelemetryContext(events);
  const prompt = [
    "You are a GEOINT analyst copilot.",
    "Ground all claims only in the telemetry context below.",
    "If unknown, say unknown.",
    "",
    "Telemetry context:",
    context,
    "",
    `User question: ${query}`
  ].join("\n");

  try {
    const response = await fetch(`${openclawGatewayUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${openclawGatewayToken}`
      },
      body: JSON.stringify({
        model: "openclaw:main",
        messages: [{ role: "user", content: prompt }],
        stream: false
      })
    });

    if (!response.ok) {
      return null;
    }

    const payload = await response.json();
    const text = payload?.choices?.[0]?.message?.content;
    return typeof text === "string" && text.trim() ? text.trim() : null;
  } catch {
    return null;
  }
}

function buildTelemetryContext(events) {
  const air = events.filter((event) => event.domain === "air");
  const maritime = events.filter((event) => event.domain === "maritime");
  const fastest = [...events]
    .filter((event) => typeof event.speed === "number")
    .sort((a, b) => (b.speed || 0) - (a.speed || 0))
    .slice(0, 8);

  const lines = [
    `total_entities=${events.length}`,
    `air_entities=${air.length}`,
    `maritime_entities=${maritime.length}`,
    "fastest_entities:"
  ];

  for (const event of fastest) {
    const id = event.identity?.callsign || event.identity?.icao || event.identity?.mmsi || event.entity_id;
    lines.push(
      `- ${id} speed=${Math.round(event.speed || 0)}kts lat=${event.lat.toFixed(4)} lon=${event.lon.toFixed(4)} source=${event.source} ts=${event.timestamp}`
    );
  }

  return lines.join("\n");
}
