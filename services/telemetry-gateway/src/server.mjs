import http from "node:http";
import { URL } from "node:url";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { normalizeAdsbRecord, normalizeAisMessage, validateTrackEvent } from "./schema.mjs";
import { fetchAdsbFi, fetchAirplanesLive, startAisStream } from "./providers.mjs";
import { TrackStore } from "./store.mjs";
import { createDb } from "./db.mjs";
import { createCache } from "./cache.mjs";
import { buildHistoricalSummaryText, normalizeCopilotOptions } from "./copilot-context.mjs";

const port = Number(process.env.PORT || 8080);
const initialCenterLat = Number(process.env.CENTER_LAT || 37.7749);
const initialCenterLon = Number(process.env.CENTER_LON || -122.4194);
const initialRadiusKm = Number(process.env.RADIUS_KM || 80);
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS || 5000);
const provider = process.env.ADSB_PROVIDER || "adsbfi";
const databaseUrl = process.env.DATABASE_URL || "postgres://geouser:geopass@localhost:5432/geodb";
const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const aisApiKey = process.env.AISSTREAM_API_KEY || process.env.AIS_STREAM_API_KEY || "";
const historyRetentionDays = Number(process.env.HISTORY_RETENTION_DAYS || 30);

const store = new TrackStore();
const db = createDb(databaseUrl);
const cache = createCache(redisUrl);

// No-op tracer unless otel.mjs started an SDK. Manual spans cover the paths
// auto-instrumentation cannot see: interval-driven polls, websocket messages,
// and the persist fan-out (which otherwise emit parentless pg/redis spans).
const tracer = trace.getTracer("telemetry-gateway");

let adsbPollStatus = { ok: true, message: "init", at: new Date().toISOString() };
let aisStatus = { ok: false, message: "not started", at: new Date().toISOString() };
let aoi = {
  centerLat: initialCenterLat,
  centerLon: initialCenterLon,
  radiusKm: initialRadiusKm,
  updatedAt: new Date().toISOString()
};

await db.init({ retentionDays: historyRetentionDays });
await cache.init();

async function persistEvent(event) {
  return tracer.startActiveSpan("track.persist", {
    attributes: {
      "track.entity_id": event.entity_id,
      "track.domain": event.domain,
      "track.source": event.source
    }
  }, async (span) => {
    try {
      store.upsert(event);
      await Promise.all([
        db.insertEvent(event),
        cache.upsertEvent(event)
      ]);
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(error.message || error) });
      throw error;
    } finally {
      span.end();
    }
  });
}

async function pollAdsb() {
  return tracer.startActiveSpan("adsb.poll", {
    attributes: {
      "adsb.provider": provider,
      "aoi.center_lat": aoi.centerLat,
      "aoi.center_lon": aoi.centerLon,
      "aoi.radius_km": aoi.radiusKm
    }
  }, async (span) => {
    try {
      const records = provider === "airplaneslive"
        ? await fetchAirplanesLive(aoi.centerLat, aoi.centerLon, aoi.radiusKm)
        : await fetchAdsbFi(aoi.centerLat, aoi.centerLon, aoi.radiusKm);

      let ingested = 0;
      for (const record of records) {
        const normalized = normalizeAdsbRecord(record, provider);
        if (!normalized || !validateTrackEvent(normalized)) {
          continue;
        }
        await persistEvent(normalized);
        ingested += 1;
      }

      span.setAttributes({
        "adsb.records_fetched": records.length,
        "adsb.records_ingested": ingested
      });
      adsbPollStatus = {
        ok: true,
        message: `ingested ${ingested} air records`,
        at: new Date().toISOString()
      };
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(error.message || error) });
      adsbPollStatus = {
        ok: false,
        message: String(error.message || error),
        at: new Date().toISOString()
      };
    } finally {
      span.end();
    }
  });
}

let aisController = { stop: () => {} };
startOrRestartAisStream();

setInterval(() => {
  pollAdsb();
}, pollIntervalMs);

setInterval(() => {
  tracer.startActiveSpan("db.retention_sweep", async (span) => {
    await db.enforceRetention(historyRetentionDays).catch(() => {});
    span.end();
  });
}, 60 * 60 * 1000);

setInterval(() => {
  tracer.startActiveSpan("db.ensure_partitions", async (span) => {
    await db.ensureFuturePartitions({ weeksAhead: 4, weeksBack: 1 }).catch(() => {});
    span.end();
  });
}, 12 * 60 * 60 * 1000);

pollAdsb().catch((error) => {
  adsbPollStatus = {
    ok: false,
    message: String(error.message || error),
    at: new Date().toISOString()
  };
});

const server = http.createServer(async (req, res) => {
  withCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/config/aoi") {
    json(res, 200, {
      center_lat: aoi.centerLat,
      center_lon: aoi.centerLon,
      radius_km: aoi.radiusKm,
      updated_at: aoi.updatedAt
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/config/aoi") {
    const body = await readJson(req);
    const centerLat = Number(body?.center_lat);
    const centerLon = Number(body?.center_lon);
    const radiusKm = Number(body?.radius_km);
    const validation = validateAoi(centerLat, centerLon, radiusKm);
    if (!validation.ok) {
      json(res, 400, { error: "invalid_aoi", detail: validation.error });
      return;
    }

    aoi = {
      centerLat,
      centerLon,
      radiusKm,
      updatedAt: new Date().toISOString()
    };

    // Stamp the new AOI on the request span so a location change is queryable
    // from traces, not just visible as an anonymous POST.
    trace.getActiveSpan()?.setAttributes({
      "aoi.center_lat": centerLat,
      "aoi.center_lon": centerLon,
      "aoi.radius_km": radiusKm
    });

    startOrRestartAisStream();
    await pollAdsb();

    json(res, 200, {
      ok: true,
      center_lat: aoi.centerLat,
      center_lon: aoi.centerLon,
      radius_km: aoi.radiusKm,
      updated_at: aoi.updatedAt
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/geocode/search") {
    const query = String(url.searchParams.get("q") || "").trim();
    if (!query) {
      json(res, 400, { error: "query_required" });
      return;
    }

    const places = await geocodeCity(query);
    json(res, 200, { query, places });
    return;
  }

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

    const options = normalizeCopilotOptions(body);
    const bbox = computeAisBbox(aoi.centerLat, aoi.centerLon, aoi.radiusKm);
    const live = await cache.listLive(bbox);
    const fallback = live.length === 0 ? await db.listLive(bbox) : live;
    const filteredLive = filterEvents(fallback, options);
    const historical = await db.getCopilotHistorySummary({
      minutes: options.lookbackMinutes,
      bbox,
      domain: options.domain,
      entityIds: options.entityIds
    });
    const historicalText = buildHistoricalSummaryText(historical);
    const answer = buildCopilotReply(query, filteredLive, historicalText);
    json(res, 200, {
      query,
      answer,
      provider: "local-fallback",
      lookback_minutes: options.lookbackMinutes,
      generated_at: new Date().toISOString()
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/copilot/stream") {
    const body = await readJson(req);
    const query = String(body?.query || "").trim();
    if (!query) {
      json(res, 400, { error: "query_required" });
      return;
    }

    const options = normalizeCopilotOptions(body);
    const bbox = computeAisBbox(aoi.centerLat, aoi.centerLon, aoi.radiusKm);
    const live = await cache.listLive(bbox);
    const fallback = live.length === 0 ? await db.listLive(bbox) : live;
    const filteredLive = filterEvents(fallback, options);
    const historical = await db.getCopilotHistorySummary({
      minutes: options.lookbackMinutes,
      bbox,
      domain: options.domain,
      entityIds: options.entityIds
    });
    const historicalText = buildHistoricalSummaryText(historical);
    await streamCopilotReply({ query, events: filteredLive, historicalText, res });
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

function startOrRestartAisStream() {
  const span = tracer.startSpan("ais.subscribe", {
    attributes: {
      "aoi.center_lat": aoi.centerLat,
      "aoi.center_lon": aoi.centerLon,
      "aoi.radius_km": aoi.radiusKm
    }
  });
  try {
    aisController.stop();
  } catch {
    // no-op
  }

  const aisBounds = computeAisBbox(aoi.centerLat, aoi.centerLon, aoi.radiusKm);
  span.setAttribute("ais.bbox", aisBounds.join(","));
  aisController = startAisStream({
    apiKey: aisApiKey,
    bbox: aisBounds,
    onStatus: (status) => { aisStatus = status; },
    onMessage: async (message) => {
      const normalized = normalizeAisMessage(message, "aisstream");
      if (!normalized || !validateTrackEvent(normalized)) {
        return;
      }

      // Websocket messages have no auto-instrumentation and no parent span —
      // this is the trace root for each accepted AIS report.
      await tracer.startActiveSpan("ais.message", {
        attributes: {
          "track.entity_id": normalized.entity_id,
          "track.domain": normalized.domain
        }
      }, async (msgSpan) => {
        try {
          await persistEvent(normalized);
        } catch (error) {
          msgSpan.recordException(error);
          msgSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(error.message || error) });
          aisStatus = { ok: false, message: `AIS persist error: ${error.message}`, at: new Date().toISOString() };
        } finally {
          msgSpan.end();
        }
      });
    }
  });
  span.end();
}

function computeAisBbox(centerLat, centerLon, radiusKm) {
  const latDelta = radiusKm / 111.32;
  const lonDelta = radiusKm / Math.max(111.32 * Math.cos((centerLat * Math.PI) / 180), 0.2);
  return [centerLon - lonDelta, centerLat - latDelta, centerLon + lonDelta, centerLat + latDelta];
}

function validateAoi(centerLat, centerLon, radiusKm) {
  if (!Number.isFinite(centerLat) || centerLat < -90 || centerLat > 90) {
    return { ok: false, error: "center_lat must be in [-90, 90]" };
  }
  if (!Number.isFinite(centerLon) || centerLon < -180 || centerLon > 180) {
    return { ok: false, error: "center_lon must be in [-180, 180]" };
  }
  if (!Number.isFinite(radiusKm) || radiusKm < 5 || radiusKm > 1500) {
    return { ok: false, error: "radius_km must be in [5, 1500]" };
  }
  return { ok: true };
}

async function geocodeCity(query) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "5");

  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": "geo-playground/0.2 (geoint-assistant)"
      }
    });
    if (!response.ok) {
      return [];
    }
    const payload = await response.json();
    if (!Array.isArray(payload)) {
      return [];
    }
    return payload.map((item) => ({
      name: item.display_name,
      lat: Number(item.lat),
      lon: Number(item.lon)
    })).filter((item) => Number.isFinite(item.lat) && Number.isFinite(item.lon));
  } catch {
    return [];
  }
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

function buildCopilotReply(query, events, historicalText = "") {
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
    "- Note: This copilot response is grounded on current live cache + historical summary window.",
    historicalText ? `- Historical: ${historicalText.split("\n")[0]}` : "- Historical: unavailable"
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

async function streamCopilotReply({ query, events, historicalText, res }) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  if (res.socket) {
    res.socket.setNoDelay(true);
  }
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  const answer = buildCopilotReply(query, events, historicalText);
  res.write(`data: ${JSON.stringify({ delta: answer })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function filterEvents(events, options) {
  let next = events;
  if (options.domain) {
    next = next.filter((event) => event.domain === options.domain);
  }
  if (options.entityIds.length > 0) {
    const ids = new Set(options.entityIds);
    next = next.filter((event) => ids.has(event.entity_id));
  }
  return next;
}
