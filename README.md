# GEOINT Agent Platform

React + LangChain Deep Agents GEOINT workbench built around:

- `apps/web`: React analyst console using `useStream`
- `services/agent`: Python deepagents graph served through LangGraph Agent Server
- `services/analysis-worker`: sandboxed FastAPI geospatial worker
- `postgres`, `redis`, `minio`: durable platform services for state and artifacts

## What This Repo Now Does

The old OpenClaw-era telemetry stack has been removed in favor of a new agentic platform shape:

- mission-oriented analyst chat with thread persistence
- map-centric analyst workspace with AOI context, live tracking layers, and artifact overlays
- deep-agent orchestration with specialist subagents
- tool-based STAC, Sentinel Hub, AIS, and ADS-B access
- isolated analysis jobs for imagery, change detection, feature extraction, and time-series work
- artifact-first output so each run can produce an intelligence package with evidence, provenance, and downloadable results

## Quick Start

1. Install frontend dependencies:

```bash
npm install
```

2. Create env files:

```bash
cp .env.example .env
cp services/agent/.env.example services/agent/.env
```

3. Start platform services:

```bash
docker compose up -d postgres redis minio analysis-worker agent-server
```

4. Start the React app:

```bash
npm run dev
```

5. Open:

- Web UI: <http://localhost:5173>
- Agent Server: <http://localhost:2024>
- Analysis worker: <http://localhost:8090/health>
- MinIO console: <http://localhost:9001>

If you prefer running the agent server outside Docker during development:

```bash
cd services/agent
python3 -m venv .venv
. .venv/bin/activate
pip install -e .[dev]
langgraph dev --host 0.0.0.0 --port 2024
```

## Environment

Root `.env` is used by Docker services. `services/agent/.env` is used by the local LangGraph server.

Important values:

- `DEFAULT_MODEL`
- `OPENAI_BASE_URL`
- `OPENAI_API_KEY` or equivalent provider key for your LangChain model
- `ANALYSIS_WORKER_URL`
- `VITE_ANALYSIS_API_URL` if the frontend should target a non-default worker URL
- `DEFAULT_STAC_API_URL`
- `SENTINEL_HUB_CLIENT_ID`
- `SENTINEL_HUB_CLIENT_SECRET`
- `AIS_API_URL`
- `AIS_API_KEY`
- `ADSB_API_URL`
- `CORS_ALLOW_ORIGINS`

For a LiteLLM gateway exposing an OpenAI-compatible API, set:

- `DEFAULT_MODEL=openai:<your gateway model name>`
- `OPENAI_BASE_URL=<your LiteLLM gateway URL>`
- `OPENAI_API_KEY=<your LiteLLM gateway key>`

## Intelligence Package

The agent is designed to assemble an artifact bundle per mission/run:

- imagery derivatives
- map-ready artifact manifests with raster/vector layer metadata
- vector outputs and tables
- measurements and summary statistics
- confidence and validation metadata
- methodology and provenance notes

## Notes

- The worker currently ships with deterministic synthetic analytics plus real provider adapters where practical. It is structured so real raster/model backends can replace the synthetic implementations without changing the agent or frontend contracts.
- Agent Server remains the primary runtime contract. The frontend talks to threads/runs/streaming APIs through `useStream`.
- The current implementation is local-dev oriented. Production auth, hardened secrets, stricter network policy, and cloud object storage should be layered on before external deployment.
