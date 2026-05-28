# Operations Runbook

## Fresh Deployment

1. Clone repo and enter directory.
2. Run `npm ci`.
3. Create `.env` from `.env.example`.
4. Set:
- `LITELLM_BASE_URL` or default Insights gateway URL
- `INSIGHTS_LITELLM_API_KEY` or `LITELLM_API_KEY`
- `LITELLM_MODEL`
- `AIS_STREAM_API_KEY` or `AISSTREAM_API_KEY` (required for maritime ingest)
 - Optional: `HISTORY_RETENTION_DAYS` (default `30`)
5. Start stack: `docker compose up -d --build`.
6. Validate:
- `npm test`
- `npm run typecheck:ui`
- `npm run build`
- `npm run test:agent`
- `npm run smoke`

## Runtime Checks

- Telemetry: `GET /health` on port `18080`
- UI: port `3010`
- Agent runtime: `GET /health` on port `18090`
- CopilotKit runtime: `GET /health` on port `18091`
- Search proxy: port `18082`
- Exec broker: port `18081`

## AOI Operations

Use the AOI controls in the UI:

1. City lookup and select result.
2. Manual lat/lon + radius km + `Apply AOI`.
3. `Drop Pin` and click map.

Backend AOI APIs:

- `GET /config/aoi`
- `POST /config/aoi`
- `GET /geocode/search?q=...`

Copilot historical options:

- `lookback_minutes` (default `180`)
- `domain` (`air` or `maritime`)
- `entity_ids` (array, optional)

CopilotKit/Deep Agents path:

- UI proxy: `/api/copilotkit`
- Copilot runtime: `http://localhost:18091`
- Agent runtime AG-UI endpoint: `http://localhost:18090/agui`

Example:

```bash
curl -sS -X POST http://localhost:18080/copilot/query \
  -H 'content-type: application/json' \
  -d '{"query":"Summarize trend with evidence","lookback_minutes":720,"domain":"air"}'
```

Example:

```bash
curl -sS -X POST http://localhost:18080/config/aoi \
  -H 'content-type: application/json' \
  -d '{"center_lat":36.8508,"center_lon":-76.2859,"radius_km":150}'
```

## EC2 Access

1. Open security-group inbound ports that you need (at minimum `3010`; optionally `18080`, `18081`, `18082`, `18090`, `18091`).
2. Access UI using `http://<EC2_PUBLIC_IP>:3010`.
3. Do not use `localhost` from your laptop browser for EC2-hosted services.

## AISStream Key Setup

1. Sign in or create account: <https://aisstream.io/authenticate>
2. Create/copy API key from customer page: <https://aisstream.io/customer.html>
3. Set it in local `.env`:

```bash
AIS_STREAM_API_KEY=your_aisstream_key
```

4. Apply config:

```bash
docker compose up -d --force-recreate telemetry-gateway
```

## Common Issues

1. `Copilot error: HTTP 400`
- Usually request body not reaching `/api/copilot/query` or empty query.
- Verify UI proxy and telemetry health.

2. No maritime contacts
- Check `AIS_STREAM_API_KEY` or `AISSTREAM_API_KEY` is set in local env/key config and telemetry is recreated.
- Verify `GET http://localhost:18080/health` and inspect `ais` status message.

3. Historical analysis seems shallow
- Increase `lookback_minutes` (e.g. `720` or `1440`).
- Confirm telemetry DB has older rows and retention window is not too small.
