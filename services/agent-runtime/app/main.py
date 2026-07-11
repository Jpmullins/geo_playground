from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from ag_ui_langgraph import add_langgraph_fastapi_endpoint
from copilotkit import LangGraphAGUIAgent

from .agent import graph
from .observability import configure_observability
from .settings import get_settings


app = FastAPI(title="Geo Playground Agent Runtime", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"]
)

# OTEL + MLflow autolog (both best-effort; no-op unless their env vars are set).
configure_observability(app)


@app.get("/health")
def health() -> dict[str, str]:
    settings = get_settings()
    return {
        "service": "agent-runtime",
        "status": "ok",
        "telemetry_api_base": settings.telemetry_api_base,
        "model": settings.litellm_model
    }


add_langgraph_fastapi_endpoint(
    app,
    LangGraphAGUIAgent(
        name="default",
        description="Primary Deep Agents GEOINT assistant for map-aware analyst workflows.",
        graph=graph
    ),
    path="/agui"
)

