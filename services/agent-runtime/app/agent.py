from copilotkit import CopilotKitMiddleware
from deepagents import create_deep_agent
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.memory import MemorySaver

from .settings import get_settings
from .tools import (
    ALL_TOOLS,
    get_entity,
    get_entity_history,
    get_live_tracks,
    get_trails,
    make_geoint_dashboard,
    set_area_of_interest
)


SYSTEM_PROMPT = """
You are the primary GEOINT assistant for analysts using Geo Playground.

Use the platform telemetry tools before making claims about the current air or maritime picture. Distinguish observed evidence from inference, include entity IDs when available, and keep answers concise unless the analyst asks for a deeper product.

You can see analyst UI context through CopilotKit shared state, including AOI, selected entity, visible map viewport, visible entity IDs, and current counts. Use that context to scope requests. When the analyst asks to move the map, inspect an entity, set AOI, or refresh data, call the available frontend action if exposed by the UI.

Use scoped subagents for specialized work:
- air-picture-analyst for ADS-B air track assessment.
- maritime-picture-analyst for AIS/vessel assessment.
- pattern-analyst for history, trails, and behavior over time.
- visualization-composer for A2UI cards and interactive analyst surfaces.

When a visual surface will help, return an A2UI card using make_geoint_dashboard or the render_a2ui tool. Do not invent telemetry. If the data source is unavailable, say so plainly and recommend the next operational check.
""".strip()


SUBAGENTS = [
    {
        "name": "air-picture-analyst",
        "description": "Analyze ADS-B aircraft tracks, altitude, speed, heading, and air-domain anomalies within the analyst AOI.",
        "system_prompt": "You are an air-domain GEOINT analyst. Use telemetry tools, cite entity IDs, and return concise evidence-backed findings.",
        "tools": [get_live_tracks, get_entity, get_entity_history]
    },
    {
        "name": "maritime-picture-analyst",
        "description": "Analyze AIS maritime tracks, vessel motion, slow movers, and vessel identity fields within the analyst AOI.",
        "system_prompt": "You are a maritime GEOINT analyst. Use AIS evidence, separate observed vessel behavior from inference, and cite MMSI/entity IDs.",
        "tools": [get_live_tracks, get_entity, get_entity_history, set_area_of_interest]
    },
    {
        "name": "pattern-analyst",
        "description": "Analyze trails, historical movement, persistence, revisits, and activity change over configurable time windows.",
        "system_prompt": "You specialize in movement pattern analysis. Use trails/history tools and report time windows, counts, and entities.",
        "tools": [get_live_tracks, get_trails, get_entity_history]
    },
    {
        "name": "visualization-composer",
        "description": "Create A2UI cards and interactive intelligence summaries that can drive map focus, entity selection, and refresh actions.",
        "system_prompt": "You compose compact A2UI analyst cards. Use make_geoint_dashboard when a map-aware visual summary helps.",
        "tools": [get_live_tracks, get_trails, make_geoint_dashboard]
    }
]


def create_model() -> ChatOpenAI:
    settings = get_settings()
    return ChatOpenAI(
        model=settings.litellm_model,
        api_key=settings.litellm_api_key or "missing-key",
        base_url=settings.litellm_base_url,
        temperature=0.1
    )


graph = create_deep_agent(
    name="geoint-primary-assistant",
    model=create_model(),
    tools=ALL_TOOLS,
    system_prompt=SYSTEM_PROMPT,
    middleware=[CopilotKitMiddleware(expose_state=True)],
    subagents=SUBAGENTS,
    checkpointer=MemorySaver()
)
