# Testing Procedure and Quality Gates

## Continuous Checks

1. Unit tests:
- Command: `npm test`
- Validates canonical schema normalization for ADS-B and AIS records.

2. UI type/build checks:
- Commands: `npm run typecheck:ui`, `npm run build`
- Validates the React/MapLibre/CopilotKit analyst workspace compiles.

3. Agent runtime tests:
- Command: `npm run test:agent`
- Validates Deep Agents settings and A2UI tool output without live provider calls.

4. Platform smoke test:
- Command: `npm run smoke`
- Validates Postgres + Redis + telemetry ingest + APIs + agent runtime + CopilotKit runtime + UI + broker services.

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
4. AOI endpoints respond with valid schema and AOI updates are reflected in `/tracks/live`.
5. Copilot remains reachable through UI proxy and returns agent-backed answers.
6. Agent runtime health responds on `8090`, CopilotKit runtime health responds on `8091`, and UI serves the built analyst workspace.
7. Historical mode returns evidence-style lines tied to time ranges and entities.

## Failure Conditions

1. Schema tests fail for required TrackEvent fields.
2. Postgres/Redis unavailable to telemetry gateway.
3. API contract mismatch for `/tracks/live`, `/tool/exec`, or `/search/query`.
4. UI unreachable on port 3000.
5. Agent runtime or CopilotKit runtime health fails.
6. AOI update rejects valid input or fails to change ingest/filter behavior.
7. Copilot answers remain unchanged after AOI switch (indicates stale/global context use).
8. Long lookback does not materially change trend/evidence content (indicates historical summary path failure).
