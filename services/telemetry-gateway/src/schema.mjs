const REQUIRED_KEYS = [
  "entity_id",
  "domain",
  "source",
  "timestamp",
  "lat",
  "lon",
  "identity",
  "quality",
  "provenance_ref"
];

export function normalizeAdsbRecord(record, source = "adsbfi") {
  const entityId = (record.hex || "").toLowerCase();
  if (!entityId || typeof record.lat !== "number" || typeof record.lon !== "number") {
    return null;
  }

  const timestampMs = typeof record.seen_pos === "number"
    ? Date.now() - Math.max(0, record.seen_pos * 1000)
    : Date.now();

  return {
    entity_id: entityId,
    domain: "air",
    source,
    timestamp: new Date(timestampMs).toISOString(),
    lat: record.lat,
    lon: record.lon,
    speed: numberOrNull(record.gs),
    course: numberOrNull(record.track),
    heading: numberOrNull(record.true_heading ?? record.mag_heading),
    altitude: numberOrNull(record.alt_baro),
    identity: {
      icao: entityId,
      callsign: trimOrNull(record.flight),
      registration: trimOrNull(record.r),
      type: trimOrNull(record.t)
    },
    quality: {
      source_confidence: 0.8,
      position_confidence: 0.85,
      stale_seconds: typeof record.seen_pos === "number" ? record.seen_pos : 0
    },
    provenance_ref: `${source}:${entityId}:${timestampMs}`
  };
}

export function normalizeAisMessage(message, source = "aisstream") {
  const msg = message?.Message;
  if (!msg) {
    return null;
  }

  const pr = msg.PositionReport;
  if (!pr || typeof pr.Latitude !== "number" || typeof pr.Longitude !== "number") {
    return null;
  }

  const mmsi = String(message?.MetaData?.MMSI ?? pr.UserID ?? "").trim();
  if (!mmsi) {
    return null;
  }

  return {
    entity_id: `mmsi:${mmsi}`,
    domain: "maritime",
    source,
    timestamp: new Date().toISOString(),
    lat: pr.Latitude,
    lon: pr.Longitude,
    speed: numberOrNull(pr.Sog),
    course: numberOrNull(pr.Cog),
    heading: numberOrNull(pr.TrueHeading),
    altitude: null,
    identity: {
      mmsi,
      callsign: trimOrNull(message?.MetaData?.CallSign),
      name: trimOrNull(message?.MetaData?.ShipName),
      nav_status: pr.NavigationalStatus ?? null
    },
    quality: {
      source_confidence: 0.75,
      position_confidence: 0.8,
      stale_seconds: 0
    },
    provenance_ref: `${source}:${mmsi}:${Date.now()}`
  };
}

export function validateTrackEvent(event) {
  return REQUIRED_KEYS.every((key) => Object.prototype.hasOwnProperty.call(event, key));
}

function trimOrNull(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
