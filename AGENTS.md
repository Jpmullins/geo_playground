# Repository Guidelines

## Project Structure & Module Organization

This repository is a Docker-first agentic GEOINT platform scaffold. Service code lives in `services/`: `telemetry-gateway` provides ADS-B/AIS ingest, persistence, and APIs; `agent-runtime` hosts the Deep Agents AG-UI assistant; `copilot-runtime` bridges CopilotKit to the agent; `ui` is the MapLibre analyst workspace; `exec-broker` and `search-proxy` expose controlled tools. Tests live under `services/telemetry-gateway/test` and `services/agent-runtime/tests`. Operational docs are in `docs/`, and smoke/integration checks are in `scripts/`.

## Build, Test, and Development Commands

- `npm ci`: install root dependencies and the configured workspace dependencies.
- `cp .env.example .env`: create local configuration; fill in real LiteLLM and AIS keys before integration runs.
- `docker compose up -d --build`: build and start Postgres/PostGIS, Redis, service containers, and the UI.
- `npm test`: run Node's native test runner for `services/telemetry-gateway`.
- `npm run typecheck:ui`: type-check the React/CopilotKit analyst UI.
- `npm run build`: build the Vite UI bundle.
- `npm run test:agent`: run Python tests for the Deep Agents runtime.
- `npm run smoke`: run the platform smoke test across telemetry, agent runtime, CopilotKit runtime, UI, broker, search, Postgres, and Redis.

## Coding Style & Naming Conventions

Use Node.js 20+ ES modules and `.mjs` files for service code; React UI code is TypeScript/TSX. Match the existing style: two-space indentation, double quotes, semicolons omitted, `camelCase` functions/variables, and uppercase names only for true constants such as `REQUIRED_KEYS`. Python agent code uses typed functions and small modules under `services/agent-runtime/app`. Keep service directories kebab-cased, for example `telemetry-gateway`.

## Testing Guidelines

Use Node's built-in `node:test` plus `node:assert/strict` for telemetry tests. Name test files `*.test.mjs` and place them beside the service they exercise, as in `services/telemetry-gateway/test/schema.test.mjs`. Use `pytest` for `agent-runtime` tests. For API, container, AOI, or CopilotKit changes, run the relevant smoke command from `docs/testing.md` in addition to unit tests.

## Commit & Pull Request Guidelines

Recent history uses short, direct commit subjects such as `Added historical analysis capability for copilot` and `fixed AIS tracking`; keep subjects concise and focused on user-visible behavior. Pull requests should describe the changed service, list verification commands and results, note any new environment variables, and include screenshots or endpoint examples for UI/API changes.

## Security & Configuration Tips

Never commit `.env` or real provider keys. Keep secrets in local environment files, `/home/ubuntu/code/API_keys.txt`, or deployment configuration. Treat `exec-broker` and agent tool-scope changes as security-sensitive.
