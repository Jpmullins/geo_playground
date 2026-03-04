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

## Quick Start

```bash
npm test
npm run test:isolation
npm run smoke
npm run smoke:openclaw
docker compose up -d --build
```

Open:

- Telemetry health: <http://localhost:8080/health>
- Live tracks: <http://localhost:8080/tracks/live>
- Exec broker: <http://localhost:8081/health>
- Search proxy: <http://localhost:8082/health>
- OpenClaw gateway health: <http://localhost:18789/healthz>
- Map UI: <http://localhost:3000>

## Core Endpoints

- `GET /health`
- `GET /tracks/live?bbox=minLon,minLat,maxLon,maxLat`
- `GET /tracks/trails?minutes=45&max_entities=350`
- `GET /entities/:id`
- `GET /entities/:id/history?start=ISO&end=ISO`
- `POST /copilot/query`
- `POST /tool/exec`
- `POST /search/query`

## Notes

- AIS stream is key-gated: set `AISSTREAM_API_KEY` in `docker-compose.yml` env for telemetry-gateway.
- Without AIS key, maritime ingestion is disabled and reported in `/health`.
- OpenClaw runtime state is stored in Docker named volume `openclaw_state` (not repo files).
