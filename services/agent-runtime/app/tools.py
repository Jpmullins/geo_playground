from typing import Any

from copilotkit import a2ui
from langchain_core.tools import tool

from .telemetry import compact_geojson, get_json, json_text, post_json


@tool
def get_live_tracks(bbox: str | None = None, limit: int = 250) -> str:
    """Return current ADS-B and AIS tracks as compact JSON. Optional bbox format: minLon,minLat,maxLon,maxLat."""
    params: dict[str, Any] = {}
    if bbox:
        params["bbox"] = bbox
    payload = get_json("/tracks/live", params=params)
    return json_text(compact_geojson(payload, limit=limit))


@tool
def get_trails(minutes: int = 60, max_entities: int = 250, bbox: str | None = None) -> str:
    """Return recent movement trails as GeoJSON for pattern analysis."""
    params: dict[str, Any] = {
        "minutes": max(1, min(int(minutes), 1440)),
        "max_entities": max(1, min(int(max_entities), 1000))
    }
    if bbox:
        params["bbox"] = bbox
    payload = get_json("/tracks/trails", params=params)
    features = payload.get("features") if isinstance(payload, dict) else []
    return json_text({
        "type": "trail_summary",
        "minutes": params["minutes"],
        "count": len(features) if isinstance(features, list) else 0,
        "features": features[:params["max_entities"]] if isinstance(features, list) else []
    })


@tool
def get_entity(entity_id: str) -> str:
    """Return the latest known telemetry record for an entity_id."""
    return json_text(get_json(f"/entities/{entity_id}"))


@tool
def get_entity_history(entity_id: str, start_iso: str, end_iso: str) -> str:
    """Return persisted telemetry events for one entity between ISO timestamps."""
    return json_text(get_json(f"/entities/{entity_id}/history", params={"start": start_iso, "end": end_iso}))


@tool
def set_area_of_interest(center_lat: float, center_lon: float, radius_km: float) -> str:
    """Update the platform area of interest and restart telemetry scoping."""
    payload = post_json("/config/aoi", {
        "center_lat": center_lat,
        "center_lon": center_lon,
        "radius_km": radius_km
    })
    return json_text(payload)


@tool
def make_geoint_dashboard(
    title: str,
    summary: str,
    air_count: int = 0,
    maritime_count: int = 0,
    priority_entity_id: str | None = None,
    center_lat: float | None = None,
    center_lon: float | None = None,
    radius_km: float | None = None
) -> str:
    """Render an A2UI intelligence card with counts, summary, and optional map/entity actions."""
    surface_id = "geoint-intelligence-card"
    components: list[dict[str, Any]] = [
        {"id": "root", "component": "Card", "child": "body"},
        {"id": "body", "component": "Column", "children": ["title", "summary", "divider", "metrics", "actions"], "gap": "medium"},
        {"id": "title", "component": "Text", "text": title, "style": "heading"},
        {"id": "summary", "component": "Text", "text": summary},
        {"id": "divider", "component": "Divider"},
        {"id": "metrics", "component": "Row", "children": ["air", "maritime"], "gap": "medium"},
        {"id": "air", "component": "Text", "text": f"Air tracks: {int(air_count)}"},
        {"id": "maritime", "component": "Text", "text": f"Maritime tracks: {int(maritime_count)}"},
        {"id": "actions", "component": "Row", "children": [], "gap": "small"}
    ]
    action_children: list[str] = []
    if center_lat is not None and center_lon is not None:
        action_children.append("focus-map")
        components.append({
            "id": "focus-map",
            "component": "Button",
            "label": "Focus AOI",
            "action": {
                "event": {
                    "name": "focus_map",
                    "context": {
                        "latitude": center_lat,
                        "longitude": center_lon,
                        "zoom": 7,
                        "radius_km": radius_km
                    }
                }
            }
        })
    if priority_entity_id:
        action_children.append("select-entity")
        components.append({
            "id": "select-entity",
            "component": "Button",
            "label": "Inspect Entity",
            "action": {
                "event": {
                    "name": "select_entity",
                    "context": {"entity_id": priority_entity_id}
                }
            }
        })
    action_children.append("refresh-tracks")
    components.append({
        "id": "refresh-tracks",
        "component": "Button",
        "label": "Refresh Tracks",
        "action": {"event": {"name": "refresh_tracks", "context": {}}}
    })
    for component in components:
        if component.get("id") == "actions":
            component["children"] = action_children
            break

    data = {
        "title": title,
        "summary": summary,
        "air_count": air_count,
        "maritime_count": maritime_count,
        "priority_entity_id": priority_entity_id,
        "center_lat": center_lat,
        "center_lon": center_lon,
        "radius_km": radius_km
    }
    return a2ui.render([
        a2ui.create_surface(surface_id),
        a2ui.update_components(surface_id, components),
        a2ui.update_data_model(surface_id, data)
    ])


ALL_TOOLS = [
    get_live_tracks,
    get_trails,
    get_entity,
    get_entity_history,
    set_area_of_interest,
    make_geoint_dashboard
]
