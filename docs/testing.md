# Testing Procedure and Quality Gates

## Continuous Checks

1. Unit tests:
- Command: `npm test`
- Validates canonical schema normalization for ADS-B and AIS records.

2. OpenClaw isolation baseline:
- Command: `npm run test:isolation`
- Validates container hardening controls via `docker inspect`.

3. Platform smoke test:
- Command: `npm run smoke`
- Validates Postgres + Redis + telemetry ingest + APIs + UI + broker services.

4. OpenClaw + LiteLLM smoke:
- Command: `npm run smoke:openclaw`
- Requires env vars from `.env.example`.
- Validates OpenClaw gateway startup and one live model turn through LiteLLM.

## Success Conditions

1. `npm test` exits 0.
2. Isolation test reports `PASS`.
3. Platform smoke reports `PASS` and confirms:
- `/health` for telemetry, exec-broker, and search-proxy.
- `/tracks/live` returns GeoJSON FeatureCollection.
- `/tool/exec` runs allowed command and returns output.
- `/search/query` returns provider-tagged results.
4. OpenClaw smoke reports `PASS` with successful `OPENCLAW_OK` response marker from model turn.

## Failure Conditions

1. Schema tests fail for required TrackEvent fields.
2. OpenClaw isolation baseline controls are missing.
3. Postgres/Redis unavailable to telemetry gateway.
4. API contract mismatch for `/tracks/live`, `/tool/exec`, or `/search/query`.
5. UI unreachable on port 3000.
6. OpenClaw gateway `/healthz` fails or model turn errors through LiteLLM.
