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

5. AOI API sanity checks:
- `GET /api/config/aoi` returns current AOI values.
- `POST /api/config/aoi` accepts valid center/radius and returns `ok: true`.
- `GET /api/geocode/search?q=<city>` returns place candidates.

6. Copilot AOI scoping:
- `POST /api/config/aoi` to a known region.
- `POST /api/copilot/query` should reflect entities in that AOI (not global cache).

7. Historical-analysis richness:
- Run two queries with same question and different lookback (`60` vs `720` minutes).
- Longer lookback response should include trend/evidence details absent from short window.

## Success Conditions

1. `npm test` exits 0.
2. Isolation test reports `PASS`.
3. Platform smoke reports `PASS` and confirms:
- `/health` for telemetry, exec-broker, and search-proxy.
- `/tracks/live` returns GeoJSON FeatureCollection.
- `/tool/exec` runs allowed command and returns output.
- `/search/query` returns provider-tagged results.
4. OpenClaw smoke reports `PASS` with successful `OPENCLAW_OK` response marker from model turn.
5. AOI endpoints respond with valid schema and AOI updates are reflected in `/tracks/live`.
6. Copilot remains reachable through UI proxy (`/api/copilot/query`) and returns provider-tagged answer.
7. Historical mode returns evidence-style lines tied to time ranges and entities.

## Failure Conditions

1. Schema tests fail for required TrackEvent fields.
2. OpenClaw isolation baseline controls are missing.
3. Postgres/Redis unavailable to telemetry gateway.
4. API contract mismatch for `/tracks/live`, `/tool/exec`, or `/search/query`.
5. UI unreachable on port 3000.
6. OpenClaw gateway `/healthz` fails or model turn errors through LiteLLM.
7. AOI update rejects valid input or fails to change ingest/filter behavior.
8. Copilot answers remain unchanged after AOI switch (indicates stale/global context use).
9. Long lookback does not materially change trend/evidence content (indicates historical summary path failure).
