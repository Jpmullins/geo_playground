// OTEL bootstrap. Loaded via `node --import ./src/otel.mjs` so auto-instrumentation
// is installed before any app module. No-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set.
// Auto-instruments node:http (the gateway server + outbound fetch), pg, redis, ws —
// and propagates W3C traceparent so a harness can stitch cross-service traces.
import { NodeSDK } from "@opentelemetry/sdk-node"
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME || "geo-node-service",
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false }
      })
    ]
  })
  sdk.start()
  const shutdown = () =>
    sdk
      .shutdown()
      .catch(() => {})
      .finally(() => process.exit(0))
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)
  console.log(`[otel] enabled -> ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}`)
} else {
  console.log("[otel] disabled (no OTEL_EXPORTER_OTLP_ENDPOINT)")
}
