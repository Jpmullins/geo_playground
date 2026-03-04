import WebSocket from "ws";

export async function fetchAdsbFi(centerLat, centerLon, radiusKm) {
  const url = `https://opendata.adsb.fi/api/v2/lat/${centerLat}/lon/${centerLon}/dist/${radiusKm}`;
  const response = await fetch(url, {
    headers: {
      "user-agent": "geo-playground/0.2"
    }
  });

  if (!response.ok) {
    throw new Error(`adsb.fi request failed: ${response.status}`);
  }

  const body = await response.json();
  if (Array.isArray(body.ac)) {
    return body.ac;
  }
  if (Array.isArray(body.aircraft)) {
    return body.aircraft;
  }
  return [];
}

export async function fetchAirplanesLive(centerLat, centerLon, radiusKm) {
  const url = `https://api.airplanes.live/v2/point/${centerLat}/${centerLon}/${radiusKm}`;
  const response = await fetch(url, {
    headers: {
      "user-agent": "geo-playground/0.2"
    }
  });

  if (!response.ok) {
    throw new Error(`airplanes.live request failed: ${response.status}`);
  }

  const body = await response.json();
  return Array.isArray(body.ac) ? body.ac : [];
}

export function startAisStream({ apiKey, bbox, onMessage, onStatus }) {
  if (!apiKey) {
    onStatus({ ok: false, message: "AISStream disabled: missing AISSTREAM_API_KEY", at: new Date().toISOString() });
    return { stop: () => {} };
  }

  const ws = new WebSocket("wss://stream.aisstream.io/v0/stream");

  ws.on("open", () => {
    const [minLon, minLat, maxLon, maxLat] = bbox;
    ws.send(JSON.stringify({
      APIKey: apiKey,
      BoundingBoxes: [[[minLat, minLon], [maxLat, maxLon]]],
      FilterMessageTypes: ["PositionReport"]
    }));

    onStatus({ ok: true, message: "AISStream connected", at: new Date().toISOString() });
  });

  ws.on("message", (raw) => {
    try {
      const parsed = JSON.parse(String(raw));
      onMessage(parsed);
    } catch {
      // Ignore malformed provider payloads.
    }
  });

  ws.on("error", (error) => {
    onStatus({ ok: false, message: `AISStream error: ${error.message}`, at: new Date().toISOString() });
  });

  ws.on("close", () => {
    onStatus({ ok: false, message: "AISStream closed", at: new Date().toISOString() });
  });

  return {
    stop: () => {
      try {
        ws.close();
      } catch {
        // no-op
      }
    }
  };
}
