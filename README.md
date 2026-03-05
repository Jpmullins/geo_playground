# Geo Playground

Secure-first GEOINT assistant scaffold with:

- `telemetry-gateway`: ADS-B + AIS ingest and canonical `TrackEvent` API
- `exec-broker`: controlled command execution API for agent tooling
- `search-proxy`: policy-controlled web search API
- `ui`: map-first live track visualization (MapLibre + deck.gl)
- `ui`: analyst console with live entities, trails, entity card, and copilot panel
- `openclaw-gateway`: real OpenClaw runtime wired to LiteLLM
- `openclaw-runtime`: isolated container baseline for agent runtime policy checks
- `postgres/postgis` + `redis`: persistence and hot-cache layers

## Prerequisites

- Docker Engine + `docker compose` plugin
- Node.js 20+ and npm
- Network access from host to ADS-B provider APIs and LiteLLM endpoint

## Fresh Start (New Clone)

1. Clone and enter:

```bash
git clone <repo-url> geo_playground
cd geo_playground
```

2. Install Node dependencies:

```bash
npm ci
```

3. Create env file:

```bash
cp .env.example .env
```

4. Edit `.env` and set all required values:
- `OPENCLAW_GATEWAY_TOKEN` (long random secret)
- `LITELLM_BASE_URL`
- `LITELLM_API_KEY`
- `LITELLM_MODEL`
- `AISSTREAM_API_KEY` (required for maritime/AIS ingest)
- Optional: `HISTORY_RETENTION_DAYS` (default: `30`)

5. Build and start:

```bash
docker compose up -d --build
```

6. Validate stack:

```bash
npm test
npm run test:isolation
npm run smoke
npm run smoke:openclaw
```

## Environment

Create a local `.env` (or export variables) for OpenClaw + LiteLLM:

```bash
cp .env.example .env
```

Required vars for OpenClaw smoke/integration:

- `OPENCLAW_GATEWAY_TOKEN`
- `LITELLM_BASE_URL`
- `LITELLM_API_KEY`
- `LITELLM_MODEL`

Generate a strong OpenClaw token (example):

```bash
openssl rand -hex 32
```

## AISStream API Key

Maritime ingest requires `AISSTREAM_API_KEY`.

1. Sign in or create an account: <https://aisstream.io/authenticate>
2. Open your customer API keys page and create/copy a key: <https://aisstream.io/customer.html>
3. Put it in local `.env`:

```bash
AISSTREAM_API_KEY=your_aisstream_key
```

Notes:
- `.env` is gitignored in this repo; keep real keys there, not in committed files.
- After changing `.env`, recreate telemetry: `docker compose up -d --force-recreate telemetry-gateway`

## Run + Access

After `docker compose up -d --build`, open:

- Telemetry health: <http://localhost:8080/health>
- Live tracks: <http://localhost:8080/tracks/live>
- Exec broker: <http://localhost:8081/health>
- Search proxy: <http://localhost:8082/health>
- OpenClaw gateway health: <http://localhost:18789/healthz>
- Map UI: <http://localhost:3000>

If hosted on EC2, access using `http://<public-ip>:3000` and open required security-group ports.

## AOI Controls (UI)

The UI supports live area-of-interest updates without redeploying:

1. City search: enter city/place and click `Find`, then choose a result.
2. Manual coordinates: set lat/lon + radius km, then click `Apply AOI`.
3. Drop pin: click `Drop Pin`, then click map to set AOI center.

Effects:
- Live tracks and trails are filtered to AOI bbox.
- ADS-B ingest center/radius updates immediately.
- AIS bbox subscription is recalculated from AOI radius.
- Copilot analysis is scoped to the current AOI.
- Copilot lookback window can be changed from the chat panel (`1h/3h/12h/24h`).

## Core Endpoints

- `GET /health`
- `GET /tracks/live?bbox=minLon,minLat,maxLon,maxLat`
- `GET /tracks/trails?minutes=45&max_entities=350`
- `GET /entities/:id`
- `GET /entities/:id/history?start=ISO&end=ISO`
- `POST /copilot/query`
- Request body options:
  - `query` (required)
  - `lookback_minutes` (optional, default `180`)
  - `domain` (optional: `air` or `maritime`)
  - `entity_ids` (optional array of entity IDs)
- `GET /config/aoi`
- `POST /config/aoi` with `{ "center_lat": number, "center_lon": number, "radius_km": number }`
- `GET /geocode/search?q=city`
- `POST /tool/exec`
- `POST /search/query`

## Notes

- AIS stream is key-gated: set `AISSTREAM_API_KEY` in local `.env` (loaded by `docker compose`).
- Without AIS key, maritime ingestion is disabled and reported in `/health`.
- OpenClaw runtime state is stored in Docker named volume `openclaw_state` (not repo files).
- Runtime AOI is in-memory (resets to compose defaults when telemetry container restarts/rebuilds).
- `track_events` storage:
  - Fresh installs create range-partitioned weekly storage.
  - Existing non-partitioned deployments are preserved in place.
  - Retention cleanup runs periodically using `HISTORY_RETENTION_DAYS`.

## Documentation

- Testing gates and pass/fail criteria: `docs/testing.md`
- Operator steps and troubleshooting: `docs/runbook.md`
