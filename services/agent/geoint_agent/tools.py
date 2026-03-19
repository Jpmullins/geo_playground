from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
from langchain.tools import ToolRuntime, tool

from .config import settings


def _json(data: Any) -> str:
    return json.dumps(data, indent=2, sort_keys=True)


def _parse_bbox(bbox: str) -> list[float]:
    values = [float(part.strip()) for part in bbox.split(",")]
    if len(values) != 4:
        raise ValueError("bbox must contain four comma-separated numeric values")
    return values


@tool
async def build_mission_brief(
    objective: str,
    aoi_name: str,
    bbox: str,
    time_range: str,
    domains: list[str] | None = None,
) -> str:
    """Create a structured mission brief for a GEOINT investigation."""

    return _json(
        {
            "objective": objective,
            "aoi_name": aoi_name,
            "bbox": _parse_bbox(bbox),
            "time_range": time_range,
            "domains": domains or ["imagery"],
            "deliverable": "artifact_bundle",
            "required_sections": [
                "imagery_products",
                "measurements",
                "confidence",
                "methodology",
                "evidence",
            ],
        }
    )


@tool
async def search_stac_catalog(
    bbox: str,
    time_range: str,
    collections: list[str] | None = None,
    limit: int = 5,
    catalog_url: str | None = None,
) -> str:
    """Search a STAC API for imagery matching the mission AOI and time range."""

    api_url = (catalog_url or settings.default_stac_api_url).rstrip("/")
    body = {
        "bbox": _parse_bbox(bbox),
        "datetime": time_range,
        "limit": max(1, min(limit, 25)),
    }
    if collections:
        body["collections"] = collections

    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.post(f"{api_url}/search", json=body)
        response.raise_for_status()
        payload = response.json()

    features = payload.get("features", [])[: limit]
    return _json(
        {
            "catalog_url": api_url,
            "count": len(features),
            "items": [
                {
                    "id": item.get("id"),
                    "collection": item.get("collection"),
                    "datetime": item.get("properties", {}).get("datetime"),
                    "assets": sorted((item.get("assets") or {}).keys()),
                    "bbox": item.get("bbox"),
                }
                for item in features
            ],
        }
    )


@tool
async def inspect_sentinel_hub_support(
    bbox: str,
    time_range: str,
    layer_type: str = "ndvi",
) -> str:
    """Describe Sentinel Hub request capability and credential readiness for the mission."""

    ready = bool(settings.sentinel_hub_client_id and settings.sentinel_hub_client_secret)
    return _json(
        {
            "provider": "sentinel-hub",
            "ready": ready,
            "bbox": _parse_bbox(bbox),
            "time_range": time_range,
            "layer_type": layer_type,
            "base_url": settings.sentinel_hub_base_url,
            "supported_products": ["true-color", "ndvi", "ndwi", "ndmi", "nbr", "statistics"],
            "note": (
                "Credentials present and Processing/Statistics API calls can be wired."
                if ready
                else "Set SENTINEL_HUB_CLIENT_ID and SENTINEL_HUB_CLIENT_SECRET to enable live requests."
            ),
        }
    )


@tool
async def query_adsb_tracks(center_lat: float, center_lon: float, radius_km: float = 120.0) -> str:
    """Query an ADS-B provider for recent aircraft tracks near an AOI center."""

    url = f"{settings.adsb_api_url}/lat/{center_lat}/lon/{center_lon}/dist/{radius_km}"
    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.get(url, headers={"user-agent": "geoint-agent/0.1"})
        response.raise_for_status()
        payload = response.json()

    records = payload.get("ac") or payload.get("aircraft") or []
    top = []
    for record in records[:20]:
        top.append(
            {
                "icao": record.get("hex"),
                "callsign": (record.get("flight") or "").strip() or None,
                "lat": record.get("lat"),
                "lon": record.get("lon"),
                "speed": record.get("gs"),
                "altitude": record.get("alt_baro"),
            }
        )

    return _json({"count": len(records), "tracks": top})


@tool
async def query_ais_tracks(bbox: str, limit: int = 25) -> str:
    """Query a configured AIS HTTP API for vessel activity inside a bbox."""

    if not settings.ais_api_url:
        return _json(
            {
                "ready": False,
                "note": "AIS_API_URL is not configured. Add a provider endpoint to enable live AIS pulls.",
                "bbox": _parse_bbox(bbox),
            }
        )

    headers: dict[str, str] = {}
    if settings.ais_api_key:
        headers["authorization"] = f"Bearer {settings.ais_api_key}"

    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.get(
            settings.ais_api_url,
            params={"bbox": bbox, "limit": max(1, min(limit, 100))},
            headers=headers,
        )
        response.raise_for_status()
        payload = response.json()

    records = payload.get("records") or payload.get("results") or payload
    if not isinstance(records, list):
        records = []

    return _json({"count": len(records), "records": records[:limit]})


@tool
async def submit_analysis_job(
    operation: str,
    title: str,
    bbox: str,
    time_range: str,
    parameters: dict[str, Any] | None = None,
    runtime: ToolRuntime | None = None,
) -> str:
    """Submit a long-running GEOINT analysis job to the isolated worker and stream progress."""

    payload = {
        "operation": operation,
        "title": title,
        "bbox": _parse_bbox(bbox),
        "time_range": time_range,
        "parameters": parameters or {},
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        create_response = await client.post(f"{settings.analysis_worker_url}/jobs", json=payload)
        create_response.raise_for_status()
        created = create_response.json()
        job_id = created["job_id"]
        writer = None
        if runtime:
            writer = getattr(runtime, "writer", None) or getattr(runtime, "stream_writer", None)

        if writer:
            writer(
                {
                    "type": "progress",
                    "id": job_id,
                    "operation": operation,
                    "message": "Job accepted by analysis worker",
                    "progress": 5,
                }
            )

        for _ in range(120):
            await asyncio.sleep(0.5)
            status_response = await client.get(f"{settings.analysis_worker_url}/jobs/{job_id}")
            status_response.raise_for_status()
            status = status_response.json()
            progress = float(status.get("progress", 0))
            message = status.get("message", "Running")

            if writer:
                writer(
                    {
                        "type": "progress",
                        "id": job_id,
                        "operation": operation,
                        "message": message,
                        "progress": progress,
                    }
                )

            if status.get("status") == "completed":
                bundle = status["bundle"]
                if writer:
                    writer(
                        {
                            "type": "artifact_bundle",
                            "bundle_id": bundle["bundle_id"],
                            "title": bundle["title"],
                            "summary": bundle["summary"],
                            "preview_urls": bundle["preview_urls"],
                            "metrics": bundle["metrics"],
                        }
                    )
                return _json(bundle)

            if status.get("status") == "error":
                raise RuntimeError(status.get("message", "analysis job failed"))

    raise TimeoutError("analysis worker did not finish within the polling window")


@tool
async def fetch_artifact_bundle(bundle_id: str) -> str:
    """Fetch a previously generated artifact bundle from the worker."""

    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.get(f"{settings.analysis_worker_url}/bundles/{bundle_id}")
        response.raise_for_status()
        return _json(response.json())


ALL_TOOLS = [
    build_mission_brief,
    search_stac_catalog,
    inspect_sentinel_hub_support,
    query_adsb_tracks,
    query_ais_tracks,
    submit_analysis_job,
    fetch_artifact_bundle,
]
