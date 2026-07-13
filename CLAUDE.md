# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Geo Playground is a Docker-first, secure-first GEOINT analyst platform: it ingests live ADS-B (air) and AIS (maritime) telemetry, normalizes it to a canonical `TrackEvent`, and exposes it to a MapLibre analyst UI and a Deep Agents assistant reachable through CopilotKit. See `AGENTS.md` for contributor conventions (style, commits, security) — this file focuses on commands and architecture.

## Commands

All commands run from the repo root. The project is an npm workspace (`services/telemetry-gateway`, `services/copilot-runtime`, `services/ui`); `agent-runtime` is a separate Python (uv/pyproject) package.

```bash
npm ci                      # install root + workspace deps
cp .env.example .env        # then fill LiteLLM + AIS keys (Compose reads .env only)
docker compose up -d --build  # build & start full stack

npm test                    # node:test unit tests for telemetry-gateway (schema, copilot-context)
npm run typecheck:ui        # tsc --noEmit on the React UI
npm run build               # vite build of the UI bundle
npm run test:agent          # pytest for the Python agent-runtime
npm run smoke               # scripts/smoke_e2e.sh — full-stack health/contract check
```

Run a single telemetry test file: `node --test services/telemetry-gateway/test/schema.test.mjs`.
Run a single agent test: `python3 -m pytest services/agent-runtime/tests/test_tools.py::<name>`.

After editing `.env`, recreate the affected container, e.g. `docker compose up -d --force-recreate telemetry-gateway`.

The quality gates (pass/fail criteria for each command above) are defined in `docs/testing.md`; operator/troubleshooting steps are in `docs/runbook.md`.

## Service topology

Six services behind Docker Compose. Internal ports are the `8080`/`3000` series; host ports add `1` prefix (e.g. `8080 → 18080`, `3000 → 3010`). The request flow for analyst chat is **UI → copilot-runtime → agent-runtime → telemetry-gateway**.

- **telemetry-gateway** (`services/telemetry-gateway`, Node `.mjs`, host `18080`) — the data plane and the only service that talks to Postgres/Redis. Polls ADS-B providers on `POLL_INTERVAL_MS`, subscribes to the AIS websocket stream (key-gated), normalizes everything to `TrackEvent`, and serves the `/tracks`, `/entities`, `/config/aoi`, `/geocode`, and `/copilot/query` HTTP APIs.
- **agent-runtime** (`services/agent-runtime`, Python/FastAPI, host `18090`) — the Deep Agents GEOINT assistant. Exposes an AG-UI streaming endpoint at `/agui`. The agent's tools call back into telemetry-gateway over HTTP (`TELEMETRY_API_BASE`).
- **copilot-runtime** (`services/copilot-runtime`, Node `.mjs`, host `18091`) — thin CopilotKit v2 runtime that bridges the browser to the agent's AG-UI endpoint (`AGENT_AGUI_URL`) and injects the A2UI tool. Serves `/api/copilotkit`.
- **ui** (`services/ui`, React 19 + Vite + MapLibre, host `3010`) — analyst console. `server.mjs` serves the built bundle and acts as a reverse proxy: `/api/copilotkit/*` → copilot-runtime, all other `/api/*` → telemetry-gateway (stripping the `/api` prefix). The browser never calls backends directly.
- **exec-broker** (`services/exec-broker`, host `18081`) — policy-gated `POST /tool/exec` command execution with a regex deny-list and output/timeout caps. Security-sensitive: treat deny-rule and tool-scope edits with care.
- **search-proxy** (`services/search-proxy`, host `18082`) — policy-controlled `POST /search/query`.

## Key cross-cutting concepts

**Canonical TrackEvent** — `services/telemetry-gateway/src/schema.mjs` is the contract for everything downstream. `normalizeAdsbRecord` and `normalizeAisMessage` map raw provider records into a `TrackEvent` with `REQUIRED_KEYS` (entity_id, domain, source, timestamp, lat, lon, identity, quality, provenance_ref); `validateTrackEvent` gates persistence. Changing required fields breaks the schema tests and the UI/agent contract — update all three together.

**Persistence layers** — every accepted event is written to three places in `persistEvent` (`server.mjs`): an in-memory `TrackStore` (hot path for `/tracks/live`), Postgres/PostGIS (`db.mjs`, history + weekly range partitions on fresh installs, retention via `HISTORY_RETENTION_DAYS`), and Redis (`cache.mjs`). Live reads come from memory/cache; historical/`get_entity_history` reads hit Postgres.

**AOI (area of interest)** is runtime, in-memory state in telemetry-gateway (resets to Compose `CENTER_LAT`/`CENTER_LON`/`RADIUS_KM` on restart). `POST /config/aoi` updates it live and immediately re-scopes ADS-B poll center/radius and the AIS bbox subscription. The UI's AOI controls (city search, manual coords, drop-pin) drive this.

**Agent ↔ UI shared context** — the agent is map-aware via CopilotKit shared state: AOI, viewport, selected entity, visible entity IDs, counts, and lookback flow from the UI into the agent, and the agent can call frontend tools (focus map, set AOI, select entity, refresh). `services/telemetry-gateway/src/copilot-context.mjs` builds the historical-summary text and normalizes `/copilot/query` options (`lookback_minutes`, `domain`, `entity_ids`).

**Observability** — every service exports OTLP traces when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (compose defaults it to the local collector → Jaeger at `:16686`; on Nebari it's the cluster collector → S3-backed Tempo/Grafana). telemetry-gateway adds manual spans for interval/websocket work (`adsb.poll`, `ais.message`, `track.persist`); agent traces also go to MLflow. See `docs/observability.md`.

**Deep Agents structure** — `services/agent-runtime/app/agent.py` defines one primary agent with a system prompt plus scoped subagents (air-picture, maritime-picture, pattern, visualization-composer), each given a restricted tool subset. Tools live in `app/tools.py` and are thin HTTP wrappers (`app/telemetry.py`) over telemetry-gateway endpoints. Visual results are returned as A2UI cards via `make_geoint_dashboard`.

## Notes that bite

- Without an AIS key (`AIS_STREAM_API_KEY` / `AISSTREAM_API_KEY`), maritime ingest is disabled and reported in `/health` — not an error.
- On EC2, browse via `http://<public-ip>:3010` (not `localhost`) and open the security-group ports you need.
- `.env` is gitignored; keep real keys there. `/home/ubuntu/code/API_keys.txt` may be a local source for values but Compose still reads only `.env`.
