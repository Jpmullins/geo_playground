# Geo Playground

Secure-first GEOINT assistant scaffold with:

- `telemetry-gateway`: ADS-B + AIS ingest and canonical `TrackEvent` API
- `agent-runtime`: Deep Agents primary GEOINT assistant exposed through AG-UI
- `copilot-runtime`: CopilotKit runtime bridge with A2UI middleware enabled
- `exec-broker`: controlled command execution API for agent tooling
- `search-proxy`: policy-controlled web search API
- `ui`: React/MapLibre analyst console with live entities, trails, entity card, CopilotKit chat, and frontend tools
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
- `LITELLM_BASE_URL` or default Insights gateway URL
- `INSIGHTS_LITELLM_API_KEY` or `LITELLM_API_KEY`
- `LITELLM_MODEL`
- `AIS_STREAM_API_KEY` or `AISSTREAM_API_KEY` (required for maritime/AIS ingest)
- Optional: `HISTORY_RETENTION_DAYS` (default: `30`)

5. Build and start:

```bash
docker compose up -d --build
```

6. Validate stack:

```bash
npm test
npm run typecheck:ui
npm run build
npm run test:agent
npm run smoke
```

## Environment

Create a local `.env` (or export variables) for LiteLLM and telemetry. On this workstation, `/home/ubuntu/code/API_keys.txt` can be used as the source for generating `.env`, but Compose reads `.env` only.

```bash
cp .env.example .env
```

Required vars for agent integration:

- `LITELLM_BASE_URL`
- `INSIGHTS_LITELLM_API_KEY` or `LITELLM_API_KEY`
- `LITELLM_MODEL`

## AISStream API Key

Maritime ingest requires `AIS_STREAM_API_KEY` or `AISSTREAM_API_KEY`.

1. Sign in or create an account: <https://aisstream.io/authenticate>
2. Open your customer API keys page and create/copy a key: <https://aisstream.io/customer.html>
3. Put it in local `.env`:

```bash
AIS_STREAM_API_KEY=your_aisstream_key
```

Notes:
- `.env` is gitignored in this repo; keep real keys there, not in committed files.
- After changing `.env`, recreate telemetry: `docker compose up -d --force-recreate telemetry-gateway`

## Run + Access

After `docker compose up -d --build`, open:

- Telemetry health: <http://localhost:18080/health>
- Live tracks: <http://localhost:18080/tracks/live>
- Exec broker: <http://localhost:18081/health>
- Search proxy: <http://localhost:18082/health>
- Agent runtime health: <http://localhost:18090/health>
- CopilotKit runtime health: <http://localhost:18091/health>
- Map UI: <http://localhost:3010>

If hosted on EC2, access using `http://<public-ip>:3010` and open required security-group ports.

## AOI Controls (UI)

The UI supports live area-of-interest updates without redeploying:

1. City search: enter city/place and click `Find`, then choose a result.
2. Manual coordinates: set lat/lon + radius km, then click `Apply AOI`.
3. Drop pin: click `Drop Pin`, then click map to set AOI center.

Effects:
- Live tracks and trails are filtered to AOI bbox.
- ADS-B ingest center/radius updates immediately.
- AIS bbox subscription is recalculated from AOI radius.
- CopilotKit context sends AOI, viewport, selected entity, visible entity IDs, counts, and lookback to the Deep Agent.
- Frontend tools let the assistant focus the map, set AOI, select an entity, and refresh tracks.

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
- `POST /agui` on `agent-runtime` for AG-UI agent streaming
- `GET /api/copilotkit/info` through `copilot-runtime`/UI proxy

## Notes

- AIS stream is key-gated: set `AIS_STREAM_API_KEY` or `AISSTREAM_API_KEY` in local env/key config.
- Without AIS key, maritime ingestion is disabled and reported in `/health`.
- Runtime AOI is in-memory (resets to compose defaults when telemetry container restarts/rebuilds).
- `track_events` storage:
  - Fresh installs create range-partitioned weekly storage.
  - Existing non-partitioned deployments are preserved in place.
  - Retention cleanup runs periodically using `HISTORY_RETENTION_DAYS`.

## Documentation

- Testing gates and pass/fail criteria: `docs/testing.md`
- Operator steps and troubleshooting: `docs/runbook.md`
