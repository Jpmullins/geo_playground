"""Observability wiring for the agent runtime.

Two independent, best-effort concerns (each a no-op unless its env var is set):

- **OTEL** — distributed traces for the FastAPI app and outbound httpx calls,
  exported over OTLP/HTTP. Enabled by ``OTEL_EXPORTER_OTLP_ENDPOINT``. This is
  what lets an external harness stitch UI -> copilot-runtime -> agent-runtime ->
  telemetry-gateway into one trace via the W3C ``traceparent`` header.
- **MLflow autolog** — captures the LangGraph / DeepAgents agent internals
  (chains, tool calls, token usage) as MLflow traces. Enabled by
  ``MLFLOW_TRACKING_URI``. LangChain autolog covers the LangGraph agent (it is
  built on LangChain); OpenAI autolog covers the ChatOpenAI/LiteLLM calls.

Everything is guarded so a missing/incompatible optional dependency degrades to a
logged warning rather than breaking startup.
"""

from __future__ import annotations

import logging
import os

logger = logging.getLogger("agent_runtime.observability")


def configure_otel(app) -> bool:
    """Instrument the FastAPI app + httpx with OTEL. No-op unless an OTLP
    endpoint is configured. Returns True if instrumentation was installed."""
    endpoint = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT") or os.getenv(
        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"
    )
    if not endpoint:
        logger.info("OTEL disabled (no OTEL_EXPORTER_OTLP_ENDPOINT)")
        return False

    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
            OTLPSpanExporter,
        )
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor

        resource = Resource.create(
            {
                "service.name": os.getenv("OTEL_SERVICE_NAME", "geo-agent-runtime"),
                "service.version": os.getenv("OTEL_SERVICE_VERSION", "0.1.0"),
                "deployment.environment": os.getenv("OTEL_ENVIRONMENT", "dev"),
            }
        )
        provider = TracerProvider(resource=resource)
        provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
        trace.set_tracer_provider(provider)

        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

        FastAPIInstrumentor.instrument_app(app)

        from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor

        HTTPXClientInstrumentor().instrument()

        logger.info("OTEL enabled -> %s", endpoint)
        return True
    except Exception as exc:  # noqa: BLE001 - never break startup on observability
        logger.warning("OTEL setup failed, continuing without it: %s", exc)
        return False


def configure_mlflow() -> bool:
    """Enable MLflow autolog for the LangGraph/OpenAI agent internals. No-op
    unless MLFLOW_TRACKING_URI is set. Returns True if any autolog was enabled."""
    uri = os.getenv("MLFLOW_TRACKING_URI")
    if not uri:
        logger.info("MLflow disabled (no MLFLOW_TRACKING_URI)")
        return False

    try:
        import mlflow

        mlflow.set_tracking_uri(uri)
        mlflow.set_experiment(os.getenv("MLFLOW_EXPERIMENT", "geo-playground-agent"))
    except Exception as exc:  # noqa: BLE001
        logger.warning("MLflow setup failed, continuing without it: %s", exc)
        return False

    enabled = False
    for name in ("langchain", "openai"):
        try:
            getattr(mlflow, name).autolog()
            enabled = True
        except Exception as exc:  # noqa: BLE001
            logger.warning("mlflow.%s.autolog() unavailable: %s", name, exc)
    if enabled:
        logger.info("MLflow autolog enabled -> %s", uri)
    return enabled


def configure_observability(app) -> None:
    configure_otel(app)
    configure_mlflow()
