// Minimal OTEL bootstrap for the lean edge services (no pg/redis/framework deps).
// Loaded via `node --import ./otel.mjs`. No-op unless OTEL_EXPORTER_OTLP_ENDPOINT
// is set, and degrades to a logged no-op if the @opentelemetry packages are not
// installed, so bare `node server.mjs` keeps working without an npm install.
// Instruments inbound node:http and outbound fetch (undici) only — enough to
// originate spans at this hop and propagate W3C traceparent upstream.
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  try {
    const [{ NodeSDK }, { HttpInstrumentation }, { UndiciInstrumentation }, { OTLPTraceExporter }] = await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@opentelemetry/instrumentation-http"),
      import("@opentelemetry/instrumentation-undici"),
      import("@opentelemetry/exporter-trace-otlp-http")
    ])
    const sdk = new NodeSDK({
      serviceName: process.env.OTEL_SERVICE_NAME || "geo-node-service",
      traceExporter: new OTLPTraceExporter(),
      instrumentations: [new HttpInstrumentation(), new UndiciInstrumentation()]
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
  } catch (error) {
    console.log(`[otel] disabled (packages unavailable: ${error.message})`)
  }
} else {
  console.log("[otel] disabled (no OTEL_EXPORTER_OTLP_ENDPOINT)")
}
