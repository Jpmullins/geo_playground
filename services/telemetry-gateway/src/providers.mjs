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

  let ws = null;
  let stopped = false;
  let reconnectTimer = null;
  let authFailed = false;

  const connect = () => {
    onStatus({ ok: false, message: "AISStream connecting...", at: new Date().toISOString() });
    const socket = new WebSocket("wss://stream.aisstream.io/v0/stream");
    ws = socket;

    socket.on("open", () => {
      const boundingBoxes = toAisBoundingBoxes(bbox);
      socket.send(JSON.stringify({
        APIKey: apiKey,
        BoundingBoxes: boundingBoxes,
        FilterMessageTypes: ["PositionReport"]
      }));

      onStatus({
        ok: true,
        message: `AISStream connected (${boundingBoxes.length} bbox)`,
        at: new Date().toISOString()
      });
    });

    socket.on("message", (raw) => {
      try {
        const parsed = JSON.parse(String(raw));
        if (parsed && typeof parsed.error === "string" && parsed.error.trim()) {
          const message = parsed.error.trim();
          onStatus({ ok: false, message: `AISStream auth/provider error: ${message}`, at: new Date().toISOString() });
          if (/api key/i.test(message) || /auth/i.test(message)) {
            authFailed = true;
            try {
              socket.close();
            } catch {
              // no-op
            }
          }
          return;
        }
        onMessage(parsed);
      } catch {
        // Ignore malformed provider payloads.
      }
    });

    socket.on("error", (error) => {
      if (stopped) {
        return;
      }
      onStatus({ ok: false, message: `AISStream error: ${error.message}`, at: new Date().toISOString() });
    });

    socket.on("close", (code, reasonBuffer) => {
      if (stopped) {
        return;
      }
      const reason = typeof reasonBuffer === "string" ? reasonBuffer : Buffer.from(reasonBuffer || []).toString("utf8");
      onStatus({
        ok: false,
        message: `AISStream closed (code=${code}${reason ? `, reason=${reason}` : ""})`,
        at: new Date().toISOString()
      });
      if (!stopped && !authFailed) {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          onStatus({ ok: false, message: "AISStream reconnecting...", at: new Date().toISOString() });
          connect();
        }, 3000);
      }
    });
  };

  connect();

  return {
    stop: () => {
      stopped = true;
      clearTimeout(reconnectTimer);
      try {
        if (!ws) {
          return;
        }
        if (ws.readyState === WebSocket.CONNECTING) {
          ws.terminate();
          return;
        }
        ws.close();
      } catch {
        // no-op
      }
    }
  };
}

function toAisBoundingBoxes(bbox) {
  const [rawMinLon, rawMinLat, rawMaxLon, rawMaxLat] = bbox;
  const minLat = clamp(rawMinLat, -89.9, 89.9);
  const maxLat = clamp(rawMaxLat, -89.9, 89.9);
  const lonSpan = Math.max(0, rawMaxLon - rawMinLon);

  if (lonSpan >= 360) {
    return [[[-89.9, -180], [89.9, 180]]];
  }

  const minLon = normalizeLon(rawMinLon);
  const maxLon = normalizeLon(rawMaxLon);

  if (minLon <= maxLon) {
    return [[[minLat, minLon], [maxLat, maxLon]]];
  }

  // AOI crosses the antimeridian: split into two legal boxes.
  return [
    [[minLat, minLon], [maxLat, 180]],
    [[minLat, -180], [maxLat, maxLon]]
  ];
}

function normalizeLon(value) {
  return ((((value + 180) % 360) + 360) % 360) - 180;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
