# Operations Runbook

## Fresh Deployment

1. Clone repo and enter directory.
2. Run `npm ci`.
3. Create `.env` from `.env.example`.
4. Set:
- `OPENCLAW_GATEWAY_TOKEN`
- `LITELLM_BASE_URL`
- `LITELLM_API_KEY`
- `LITELLM_MODEL`
 - Optional: `HISTORY_RETENTION_DAYS` (default `30`)
5. Start stack: `docker compose up -d --build`.
6. Validate:
- `npm test`
- `npm run test:isolation`
- `npm run smoke`
- `npm run smoke:openclaw`

## Runtime Checks

- Telemetry: `GET /health` on port `8080`
- OpenClaw: `GET /healthz` on port `18789`
- UI: port `3000`
- Search proxy: port `8082`
- Exec broker: port `8081`

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

Example:

```bash
curl -sS -X POST http://localhost:8080/copilot/query \
  -H 'content-type: application/json' \
  -d '{"query":"Summarize trend with evidence","lookback_minutes":720,"domain":"air"}'
```

Example:

```bash
curl -sS -X POST http://localhost:8080/config/aoi \
  -H 'content-type: application/json' \
  -d '{"center_lat":36.8508,"center_lon":-76.2859,"radius_km":150}'
```

## EC2 Access

1. Open security-group inbound ports that you need (at minimum `3000`; optionally `8080`, `8081`, `8082`, `18789`).
2. Access UI using `http://<EC2_PUBLIC_IP>:3000`.
3. Do not use `localhost` from your laptop browser for EC2-hosted services.

## Common Issues

1. `Copilot error: HTTP 400`
- Usually request body not reaching `/api/copilot/query` or empty query.
- Verify UI proxy and telemetry health.

2. OpenClaw fallback instead of provider `openclaw`
- Check `.env` LiteLLM values and `OPENCLAW_GATEWAY_TOKEN`.
- Check `GET http://localhost:18789/healthz`.

3. No maritime contacts
- Expected without `AISSTREAM_API_KEY`.

4. Historical analysis seems shallow
- Increase `lookback_minutes` (e.g. `720` or `1440`).
- Confirm telemetry DB has older rows and retention window is not too small.
