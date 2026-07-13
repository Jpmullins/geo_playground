# Observability

How traces flow, what is instrumented, and where to look.

## Architecture

Every service exports OTLP/HTTP traces to a collector when
`OTEL_EXPORTER_OTLP_ENDPOINT` is set (unset → all instrumentation is a no-op).

- **Local (docker-compose)**: all services → `otel-collector:4318` →
  Jaeger all-in-one (in-memory, restart-lossy — fine for dev). UI at
  http://localhost:16686.
- **Nebari (prod)**: all services → NIC's cluster collector
  (`opentelemetry-collector.monitoring.svc:4318`) → S3-backed Tempo
  (lgtm-pack). View in Grafana at https://grafana.nebari.insights.arlis.umd.edu.
  benchmesh reads the Jaeger-compatible query API at
  `lgtm-pack-tempo.monitoring.svc:16686`.

Agent (LLM) traces additionally go to MLflow via `mlflow.langchain.autolog()`;
`MLFLOW_TRACE_ENABLE_OTLP_DUAL_EXPORT=true` fans the same traces out to the
OTLP endpoint so agent internals land next to the HTTP spans. Locally MLflow
writes to sqlite on the `mlruns` volume (no UI service); on Nebari it is the
mlflow-pack (RDS + S3).

## Per-service instrumentation

| Service | Bootstrap | Coverage |
| --- | --- | --- |
| telemetry-gateway | `src/otel.mjs` (full auto-instrumentations) + manual spans in `server.mjs` | HTTP server/client, pg, redis; manual: `adsb.poll`, `ais.subscribe`, `ais.message`, `track.persist`, `db.retention_sweep`, `db.ensure_partitions` |
| agent-runtime | `app/observability.py` | FastAPI + httpx auto-spans (propagates traceparent to the gateway); MLflow langchain/openai autolog |
| copilot-runtime | `otel.mjs` (full auto-instrumentations) | HTTP server + outbound AG-UI call |
| ui | `otel.mjs` (minimal: http + undici) | proxy hop originates spans and propagates traceparent to both backends |
| exec-broker / search-proxy | `otel.mjs` (minimal: http + undici) | inbound request spans; search-proxy outbound fetch |

There is no websocket auto-instrumentation anywhere: the AIS ingest path is
covered by the manual `ais.message` root spans, not by the SDK.

## Semantics worth knowing

- **AOI changes are queryable**: `POST /config/aoi` stamps
  `aoi.center_lat`/`aoi.center_lon`/`aoi.radius_km` on the request span, and
  the triggered `ais.subscribe` + `adsb.poll` (with the same attributes) are
  children of that request — so a location change shows the full re-scope.
- **Interval work is rooted**: each ADS-B poll cycle is one `adsb.poll` trace
  (records fetched/ingested as attributes) with `track.persist` children
  grouping the pg + redis writes. Without these, background writes appear as
  parentless pg/redis spans.
- The gateway's manual spans use `@opentelemetry/api` only — they no-op when
  the SDK isn't started, so tests and bare `node` runs need no OTEL setup.

## Gotchas

- agent-runtime installs only the proto-http exporter; keep
  `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` (nebari) or the default HTTP
  endpoint — a gRPC endpoint silently drops spans.
- The lean services' `otel.mjs` degrades to a logged no-op if the
  `@opentelemetry/*` packages aren't installed (they're installed in the
  Docker images; local `node server.mjs` without install still works).
