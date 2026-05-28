import json
from typing import Any

import httpx

from .settings import get_settings


def get_json(path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    settings = get_settings()
    url = f"{settings.telemetry_api_base}{path}"
    with httpx.Client(timeout=settings.request_timeout_seconds) as client:
        response = client.get(url, params=params)
        response.raise_for_status()
        return response.json()


def post_json(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    settings = get_settings()
    url = f"{settings.telemetry_api_base}{path}"
    with httpx.Client(timeout=settings.request_timeout_seconds) as client:
        response = client.post(url, json=payload)
        response.raise_for_status()
        return response.json()


def compact_feature(feature: dict[str, Any]) -> dict[str, Any]:
    properties = feature.get("properties") or {}
    geometry = feature.get("geometry") or {}
    coordinates = geometry.get("coordinates") or [properties.get("lon"), properties.get("lat")]
    lon = coordinates[0] if len(coordinates) > 0 else properties.get("lon")
    lat = coordinates[1] if len(coordinates) > 1 else properties.get("lat")
    identity = properties.get("identity") or {}
    label = identity.get("callsign") or identity.get("name") or identity.get("icao") or identity.get("mmsi") or properties.get("entity_id")
    return {
        "entity_id": properties.get("entity_id"),
        "label": label,
        "domain": properties.get("domain"),
        "source": properties.get("source"),
        "timestamp": properties.get("timestamp"),
        "lat": lat,
        "lon": lon,
        "speed": properties.get("speed"),
        "course": properties.get("course"),
        "heading": properties.get("heading"),
        "altitude": properties.get("altitude"),
        "identity": identity,
        "quality": properties.get("quality") or {}
    }


def compact_geojson(payload: dict[str, Any], limit: int = 250) -> dict[str, Any]:
    features = payload.get("features") if isinstance(payload, dict) else []
    if not isinstance(features, list):
        features = []
    compact = [compact_feature(feature) for feature in features[:limit]]
    return {
        "type": "track_summary",
        "count": len(features),
        "returned": len(compact),
        "tracks": compact
    }


def json_text(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=True, separators=(",", ":"), default=str)

