from __future__ import annotations

import hashlib
import json
import math
import os
import threading
import uuid
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageDraw
from pydantic import BaseModel, Field


PORT = int(os.getenv("PORT", "8090"))
ARTIFACT_ROOT = Path(os.getenv("ARTIFACT_ROOT", "./data/artifacts"))
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", f"http://localhost:{PORT}").rstrip("/")
AIS_API_URL = os.getenv("AIS_API_URL", "").rstrip("/")
AIS_API_KEY = os.getenv("AIS_API_KEY", "")
ADSB_API_URL = os.getenv("ADSB_API_URL", "https://opendata.adsb.fi/api/v2").rstrip("/")
CORS_ALLOW_ORIGINS = [
    origin.strip()
    for origin in os.getenv("CORS_ALLOW_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")
    if origin.strip()
]

ARTIFACT_ROOT.mkdir(parents=True, exist_ok=True)


class JobCreate(BaseModel):
    operation: str
    title: str
    bbox: list[float] = Field(min_length=4, max_length=4)
    time_range: str
    parameters: dict[str, Any] = Field(default_factory=dict)


@dataclass
class JobState:
    job_id: str
    status: str
    progress: float
    message: str
    request: dict[str, Any]
    bundle: dict[str, Any] | None = None


JOBS: dict[str, JobState] = {}

app = FastAPI(title="GEOINT Analysis Worker", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOW_ORIGINS or ["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/artifacts", StaticFiles(directory=ARTIFACT_ROOT), name="artifacts")


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "service": "analysis-worker",
        "status": "ok",
        "artifact_root": str(ARTIFACT_ROOT),
        "tracking_sources": {
            "ais_configured": bool(AIS_API_URL),
            "adsb_api_url": ADSB_API_URL,
        },
    }


@app.post("/jobs")
async def create_job(request: JobCreate) -> dict[str, Any]:
    job_id = uuid.uuid4().hex
    state = JobState(
        job_id=job_id,
        status="queued",
        progress=0,
        message="Job queued",
        request=request.model_dump(),
    )
    JOBS[job_id] = state
    threading.Thread(target=_run_job, args=(job_id,), daemon=True).start()
    return {"job_id": job_id, "status": state.status}


@app.get("/jobs/{job_id}")
async def get_job(job_id: str) -> dict[str, Any]:
    state = JOBS.get(job_id)
    if not state:
        raise HTTPException(status_code=404, detail="job_not_found")
    return asdict(state)


@app.get("/bundles/{bundle_id}")
async def get_bundle(bundle_id: str) -> dict[str, Any]:
    manifest_path = ARTIFACT_ROOT / "bundles" / f"{bundle_id}.json"
    if not manifest_path.exists():
        raise HTTPException(status_code=404, detail="bundle_not_found")
    return json.loads(manifest_path.read_text())


@app.get("/tracking/adsb")
async def tracking_adsb(bbox: str = Query(...), limit: int = Query(40, ge=1, le=200)) -> dict[str, Any]:
    parsed_bbox = _parse_bbox_query(bbox)
    return await _adsb_tracking_payload(parsed_bbox, limit)


@app.get("/tracking/ais")
async def tracking_ais(bbox: str = Query(...), limit: int = Query(40, ge=1, le=200)) -> dict[str, Any]:
    parsed_bbox = _parse_bbox_query(bbox)
    return await _ais_tracking_payload(parsed_bbox, limit)


@app.get("/tracking/fused")
async def tracking_fused(bbox: str = Query(...), limit: int = Query(40, ge=1, le=200)) -> dict[str, Any]:
    parsed_bbox = _parse_bbox_query(bbox)
    adsb = await _adsb_tracking_payload(parsed_bbox, limit)
    ais = await _ais_tracking_payload(parsed_bbox, limit)
    features = adsb["geojson"]["features"] + ais["geojson"]["features"]
    return {
        "source": "fused",
        "mode": "mixed" if adsb["mode"] != ais["mode"] else adsb["mode"],
        "bbox": parsed_bbox,
        "refreshed_at": _timestamp(),
        "summary": {
            "aircraft": adsb["summary"]["entities"],
            "vessels": ais["summary"]["entities"],
            "features": len(features),
        },
        "geojson": {
            "type": "FeatureCollection",
            "features": features,
        },
    }


def _run_job(job_id: str) -> None:
    state = JOBS[job_id]
    state.status = "running"
    state.progress = 5
    state.message = "Preparing analysis inputs"
    try:
        bundle = _dispatch_operation(state.request, job_id, state)
        state.status = "completed"
        state.progress = 100
        state.message = "Completed"
        state.bundle = bundle
    except Exception as exc:  # noqa: BLE001
        state.status = "error"
        state.progress = 100
        state.message = str(exc)


def _dispatch_operation(request: dict[str, Any], job_id: str, state: JobState) -> dict[str, Any]:
    operation = request["operation"]
    if operation == "spectral_index":
        return _run_spectral_index(request, job_id, state)
    if operation == "feature_extraction":
        return _run_feature_extraction(request, job_id, state)
    if operation == "change_detection":
        return _run_change_detection(request, job_id, state)
    if operation == "temporal_decomposition":
        return _run_temporal_decomposition(request, job_id, state)
    if operation == "tracking_fusion":
        return _run_tracking_fusion(request, job_id, state)
    if operation == "python_postprocess":
        return _run_python_postprocess(request, job_id, state)
    raise RuntimeError(f"unsupported operation: {operation}")


def _parse_bbox_query(raw: str) -> list[float]:
    values = [float(part.strip()) for part in raw.split(",")]
    if len(values) != 4:
        raise HTTPException(status_code=400, detail="bbox_must_have_four_values")
    min_lon, min_lat, max_lon, max_lat = values
    if min_lon >= max_lon or min_lat >= max_lat:
        raise HTTPException(status_code=400, detail="bbox_bounds_invalid")
    return values


def _rng_for(request: dict[str, Any]) -> np.random.Generator:
    raw = json.dumps(request, sort_keys=True).encode()
    seed = int(hashlib.sha256(raw).hexdigest()[:16], 16)
    return np.random.default_rng(seed)


def _rng_for_key(key: str) -> np.random.Generator:
    seed = int(hashlib.sha256(key.encode()).hexdigest()[:16], 16)
    return np.random.default_rng(seed)


def _job_dir(job_id: str) -> Path:
    path = ARTIFACT_ROOT / "jobs" / job_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def _write_bundle(bundle: dict[str, Any]) -> None:
    bundle_dir = ARTIFACT_ROOT / "bundles"
    bundle_dir.mkdir(parents=True, exist_ok=True)
    (bundle_dir / f"{bundle['bundle_id']}.json").write_text(json.dumps(bundle, indent=2))


def _artifact_url(path: Path) -> str:
    relative = path.relative_to(ARTIFACT_ROOT).as_posix()
    return f"{PUBLIC_BASE_URL}/artifacts/{relative}"


def _artifact_record(
    path: Path,
    kind: str,
    label: str,
    *,
    bbox: list[float] | None = None,
    media_type: str | None = None,
    default_visible: bool = True,
    opacity: float = 0.88,
    color: str | None = None,
) -> dict[str, Any]:
    suffix_media = {
        ".png": "image/png",
        ".json": "application/json",
        ".geojson": "application/geo+json",
    }
    return {
        "artifact_id": path.stem,
        "kind": kind,
        "label": label,
        "uri": _artifact_url(path),
        "bbox": bbox,
        "media_type": media_type or suffix_media.get(path.suffix, "application/octet-stream"),
        "default_visible": default_visible,
        "opacity": opacity,
        "color": color,
    }


def _normalize(array: np.ndarray) -> np.ndarray:
    low = float(array.min())
    high = float(array.max())
    if high - low < 1e-9:
        return np.zeros_like(array)
    return (array - low) / (high - low)


def _save_heatmap(path: Path, array: np.ndarray, tint: str = "blue") -> str:
    normalized = _normalize(array)
    if tint == "green":
        rgb = np.stack([normalized * 40, normalized * 220, normalized * 120], axis=-1)
    elif tint == "orange":
        rgb = np.stack([normalized * 255, normalized * 160, normalized * 40], axis=-1)
    else:
        rgb = np.stack([normalized * 120, normalized * 170, normalized * 255], axis=-1)
    image = Image.fromarray(rgb.clip(0, 255).astype(np.uint8), "RGB").resize((384, 384))
    image.save(path)
    return _artifact_url(path)


def _pixel_box_to_polygon(pixel_bbox: list[int], bbox: list[float], image_size: tuple[int, int]) -> list[list[list[float]]]:
    min_x, min_y, max_x, max_y = pixel_bbox
    min_lon, min_lat, max_lon, max_lat = bbox
    width, height = image_size

    def to_lon(px: int) -> float:
        return min_lon + (px / width) * (max_lon - min_lon)

    def to_lat(py: int) -> float:
        return max_lat - (py / height) * (max_lat - min_lat)

    ring = [
        [round(to_lon(min_x), 6), round(to_lat(max_y), 6)],
        [round(to_lon(max_x), 6), round(to_lat(max_y), 6)],
        [round(to_lon(max_x), 6), round(to_lat(min_y), 6)],
        [round(to_lon(min_x), 6), round(to_lat(min_y), 6)],
        [round(to_lon(min_x), 6), round(to_lat(max_y), 6)],
    ]
    return [ring]


def _draw_series(path: Path, values: np.ndarray) -> str:
    width, height = 640, 240
    image = Image.new("RGB", (width, height), "#08111b")
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, width - 1, height - 1), outline="#2c3d52")
    normalized = _normalize(values)
    coords = []
    for idx, value in enumerate(normalized):
        x = 24 + idx * ((width - 48) / max(1, len(normalized) - 1))
        y = height - 24 - value * (height - 48)
        coords.append((x, y))
    if len(coords) > 1:
        draw.line(coords, fill="#7dd3fc", width=3)
    image.save(path)
    return _artifact_url(path)


def _connected_components(mask: np.ndarray) -> int:
    visited = np.zeros_like(mask, dtype=bool)
    count = 0
    rows, cols = mask.shape
    for row in range(rows):
        for col in range(cols):
            if not mask[row, col] or visited[row, col]:
                continue
            count += 1
            stack = [(row, col)]
            visited[row, col] = True
            while stack:
                current_row, current_col = stack.pop()
                for dr in (-1, 0, 1):
                    for dc in (-1, 0, 1):
                        if dr == dc == 0:
                            continue
                        nr = current_row + dr
                        nc = current_col + dc
                        if nr < 0 or nc < 0 or nr >= rows or nc >= cols:
                            continue
                        if visited[nr, nc] or not mask[nr, nc]:
                            continue
                        visited[nr, nc] = True
                        stack.append((nr, nc))
    return count


def _timestamp() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _bbox_center_radius_km(bbox: list[float]) -> tuple[float, float, float]:
    min_lon, min_lat, max_lon, max_lat = bbox
    center_lat = (min_lat + max_lat) / 2
    center_lon = (min_lon + max_lon) / 2
    lat_km = (max_lat - min_lat) * 111.0
    lon_km = (max_lon - min_lon) * 111.0 * max(0.2, math.cos(math.radians(center_lat)))
    radius_km = max(5.0, math.sqrt(lat_km**2 + lon_km**2) / 2)
    return center_lat, center_lon, min(radius_km, 400.0)


def _point_in_bbox(rng: np.random.Generator, bbox: list[float]) -> list[float]:
    min_lon, min_lat, max_lon, max_lat = bbox
    return [round(float(rng.uniform(min_lon, max_lon)), 6), round(float(rng.uniform(min_lat, max_lat)), 6)]


def _synthetic_tracking_points(bbox: list[float], count: int, source: str) -> dict[str, Any]:
    rng = _rng_for_key(f"{source}:{bbox}:{count}")
    features = []
    prefix = "AIR" if source == "adsb" else "SEA"
    for idx in range(count):
        lon, lat = _point_in_bbox(rng, bbox)
        entity_id = f"{prefix}-{idx + 1:03d}"
        props: dict[str, Any] = {
            "entity_id": entity_id,
            "source": source,
            "label": entity_id,
            "last_seen": _timestamp(),
        }
        if source == "adsb":
            props.update(
                {
                    "callsign": f"{prefix}{100 + idx}",
                    "speed_kts": int(rng.integers(180, 470)),
                    "course_deg": int(rng.integers(0, 359)),
                    "altitude_ft": int(rng.integers(4000, 37000)),
                }
            )
        else:
            props.update(
                {
                    "mmsi": f"366{idx + 1:06d}",
                    "speed_kts": round(float(rng.uniform(4, 22)), 1),
                    "course_deg": int(rng.integers(0, 359)),
                    "nav_status": "under_way",
                }
            )
        features.append(
            {
                "type": "Feature",
                "properties": props,
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
            }
        )
    return {
        "source": source,
        "mode": "synthetic",
        "bbox": bbox,
        "refreshed_at": _timestamp(),
        "summary": {"entities": len(features), "features": len(features)},
        "geojson": {"type": "FeatureCollection", "features": features},
    }


def _synthetic_track_collection(
    bbox: list[float],
    *,
    aircraft_count: int,
    vessel_count: int,
    rng: np.random.Generator,
) -> dict[str, Any]:
    min_lon, min_lat, max_lon, max_lat = bbox

    def clamp(value: float, low: float, high: float) -> float:
        return round(min(high, max(low, value)), 6)

    features: list[dict[str, Any]] = []
    for source, count in (("adsb", aircraft_count), ("ais", vessel_count)):
        for idx in range(count):
            entity_id = f"{source.upper()}-{idx + 1:03d}"
            start_lon, start_lat = _point_in_bbox(rng, bbox)
            coords = [[start_lon, start_lat]]
            current_lon = start_lon
            current_lat = start_lat
            for _ in range(3):
                current_lon = clamp(current_lon + float(rng.uniform(-0.06, 0.06)), min_lon, max_lon)
                current_lat = clamp(current_lat + float(rng.uniform(-0.04, 0.04)), min_lat, max_lat)
                coords.append([current_lon, current_lat])

            features.append(
                {
                    "type": "Feature",
                    "properties": {
                        "entity_id": entity_id,
                        "source": source,
                        "label": entity_id,
                        "geometry_role": "trail",
                    },
                    "geometry": {"type": "LineString", "coordinates": coords},
                }
            )
            features.append(
                {
                    "type": "Feature",
                    "properties": {
                        "entity_id": entity_id,
                        "source": source,
                        "label": entity_id,
                        "geometry_role": "latest_position",
                    },
                    "geometry": {"type": "Point", "coordinates": coords[-1]},
                }
            )
    return {"type": "FeatureCollection", "features": features}


async def _adsb_tracking_payload(bbox: list[float], limit: int) -> dict[str, Any]:
    center_lat, center_lon, radius_km = _bbox_center_radius_km(bbox)
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(
                f"{ADSB_API_URL}/lat/{center_lat}/lon/{center_lon}/dist/{radius_km}",
                headers={"user-agent": "geoint-analysis-worker/0.2"},
            )
            response.raise_for_status()
            payload = response.json()
        records = payload.get("ac") or payload.get("aircraft") or []
        features = []
        for record in records[:limit]:
            lon = record.get("lon")
            lat = record.get("lat")
            if lon is None or lat is None:
                continue
            features.append(
                {
                    "type": "Feature",
                    "properties": {
                        "entity_id": record.get("hex") or f"AIR-{len(features) + 1:03d}",
                        "source": "adsb",
                        "label": (record.get("flight") or "").strip() or record.get("hex") or "aircraft",
                        "callsign": (record.get("flight") or "").strip() or None,
                        "speed_kts": record.get("gs"),
                        "course_deg": record.get("track"),
                        "altitude_ft": record.get("alt_baro"),
                        "last_seen": _timestamp(),
                    },
                    "geometry": {"type": "Point", "coordinates": [lon, lat]},
                }
            )
        return {
            "source": "adsb",
            "mode": "live",
            "bbox": bbox,
            "refreshed_at": _timestamp(),
            "summary": {"entities": len(features), "features": len(features)},
            "geojson": {"type": "FeatureCollection", "features": features},
        }
    except Exception:  # noqa: BLE001
        return _synthetic_tracking_points(bbox, min(limit, 18), "adsb")


async def _ais_tracking_payload(bbox: list[float], limit: int) -> dict[str, Any]:
    if not AIS_API_URL:
        return _synthetic_tracking_points(bbox, min(limit, 12), "ais")

    headers: dict[str, str] = {}
    if AIS_API_KEY:
        headers["authorization"] = f"Bearer {AIS_API_KEY}"

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(
                AIS_API_URL,
                params={"bbox": ",".join(str(part) for part in bbox), "limit": limit},
                headers=headers,
            )
            response.raise_for_status()
            payload = response.json()
        records = payload.get("records") or payload.get("results") or payload
        if not isinstance(records, list):
            records = []
        features = []
        for idx, record in enumerate(records[:limit]):
            lon = record.get("lon") or record.get("longitude")
            lat = record.get("lat") or record.get("latitude")
            if lon is None or lat is None:
                continue
            features.append(
                {
                    "type": "Feature",
                    "properties": {
                        "entity_id": record.get("mmsi") or f"SEA-{idx + 1:03d}",
                        "source": "ais",
                        "label": record.get("name") or record.get("mmsi") or f"vessel-{idx + 1}",
                        "mmsi": record.get("mmsi"),
                        "speed_kts": record.get("speed") or record.get("sog"),
                        "course_deg": record.get("course") or record.get("cog"),
                        "nav_status": record.get("nav_status"),
                        "last_seen": record.get("timestamp") or _timestamp(),
                    },
                    "geometry": {"type": "Point", "coordinates": [lon, lat]},
                }
            )
        return {
            "source": "ais",
            "mode": "live",
            "bbox": bbox,
            "refreshed_at": _timestamp(),
            "summary": {"entities": len(features), "features": len(features)},
            "geojson": {"type": "FeatureCollection", "features": features},
        }
    except Exception:  # noqa: BLE001
        return _synthetic_tracking_points(bbox, min(limit, 12), "ais")


def _base_bundle(
    request: dict[str, Any],
    job_id: str,
    summary: str,
    metrics: dict[str, Any],
    artifacts: list[dict[str, Any]],
) -> dict[str, Any]:
    score = round(0.78 + (sum(ord(c) for c in request["operation"]) % 18) / 100, 2)
    interval = [round(max(0.5, score - 0.08), 2), round(min(0.99, score + 0.03), 2)]
    preview_urls = [artifact["uri"] for artifact in artifacts if artifact["kind"] in {"raster_preview", "image"}]
    bundle = {
        "bundle_id": job_id,
        "title": request["title"],
        "operation": request["operation"],
        "summary": summary,
        "bbox": request["bbox"],
        "time_range": request["time_range"],
        "metrics": metrics,
        "preview_urls": preview_urls,
        "artifacts": artifacts,
        "provenance": {
            "generator": "synthetic-dev-worker",
            "request": request,
        },
        "methodology": {
            "mode": "deterministic-synthetic",
            "steps": [
                "Seed the synthetic generator from the normalized request payload.",
                "Run the requested geospatial operation in the isolated analysis worker.",
                "Persist previews and structured outputs as artifact files.",
                "Return bundle metadata with metrics, provenance, and confidence scaffolding.",
            ],
        },
        "confidence": {
            "score": score,
            "interval": interval,
            "note": "Synthetic deterministic baseline for local development.",
        },
    }
    _write_bundle(bundle)
    return bundle


def _run_spectral_index(request: dict[str, Any], job_id: str, state: JobState) -> dict[str, Any]:
    state.progress = 20
    state.message = "Generating spectral bands"
    rng = _rng_for(request)
    job_dir = _job_dir(job_id)
    size = (96, 96)
    nir = rng.uniform(0.2, 0.9, size=size)
    red = rng.uniform(0.1, 0.8, size=size)
    green = rng.uniform(0.1, 0.7, size=size)
    swir = rng.uniform(0.15, 0.85, size=size)
    swir2 = rng.uniform(0.18, 0.92, size=size)

    state.progress = 55
    state.message = "Computing indices"
    ndvi = (nir - red) / (nir + red + 1e-6)
    ndwi = (green - nir) / (green + nir + 1e-6)
    ndmi = (nir - swir) / (nir + swir + 1e-6)
    nbr = (nir - swir2) / (nir + swir2 + 1e-6)

    _save_heatmap(job_dir / "ndvi.png", ndvi, "green")
    _save_heatmap(job_dir / "ndwi.png", ndwi, "blue")
    _save_heatmap(job_dir / "ndmi.png", ndmi, "orange")
    _save_heatmap(job_dir / "nbr.png", nbr, "orange")

    artifacts = [
        _artifact_record(job_dir / "ndvi.png", "raster_preview", "NDVI", bbox=request["bbox"], color="#34d399"),
        _artifact_record(job_dir / "ndwi.png", "raster_preview", "NDWI", bbox=request["bbox"], default_visible=False),
        _artifact_record(job_dir / "ndmi.png", "raster_preview", "NDMI", bbox=request["bbox"], default_visible=False),
        _artifact_record(job_dir / "nbr.png", "raster_preview", "NBR", bbox=request["bbox"], default_visible=False, color="#fb923c"),
    ]
    metrics = {
        "ndvi_mean": round(float(ndvi.mean()), 4),
        "ndwi_mean": round(float(ndwi.mean()), 4),
        "ndmi_mean": round(float(ndmi.mean()), 4),
        "nbr_mean": round(float(nbr.mean()), 4),
    }
    return _base_bundle(
        request,
        job_id,
        "Computed deterministic spectral surfaces for NDVI, NDWI, NDMI, and NBR across the mission AOI.",
        metrics,
        artifacts,
    )


def _run_feature_extraction(request: dict[str, Any], job_id: str, state: JobState) -> dict[str, Any]:
    state.progress = 25
    state.message = "Segmenting synthetic built environment features"
    rng = _rng_for(request)
    job_dir = _job_dir(job_id)
    image_size = (512, 512)
    image = Image.new("RGB", image_size, "#0b1724")
    draw = ImageDraw.Draw(image)
    buildings = []
    for idx in range(12):
        x = int(rng.integers(24, 420))
        y = int(rng.integers(24, 420))
        w = int(rng.integers(20, 64))
        h = int(rng.integers(20, 72))
        draw.rectangle((x, y, x + w, y + h), outline="#7dd3fc", width=2)
        buildings.append({"id": idx + 1, "pixel_bbox": [x, y, x + w, y + h]})
    for _ in range(6):
        coords = [
            (int(rng.integers(0, 512)), int(rng.integers(0, 512))),
            (int(rng.integers(0, 512)), int(rng.integers(0, 512))),
        ]
        draw.line(coords, fill="#fde68a", width=3)

    preview_path = job_dir / "feature_extraction.png"
    image.save(preview_path)
    geojson_path = job_dir / "features.geojson"
    geojson_path.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "properties": {
                            "kind": "building",
                            "id": building["id"],
                            "pixel_bbox": building["pixel_bbox"],
                        },
                        "geometry": {
                            "type": "Polygon",
                            "coordinates": _pixel_box_to_polygon(
                                building["pixel_bbox"],
                                request["bbox"],
                                image_size,
                            ),
                        },
                    }
                    for building in buildings
                ],
            },
            indent=2,
        )
    )
    artifacts = [
        _artifact_record(preview_path, "raster_preview", "Feature extraction preview", bbox=request["bbox"], default_visible=False),
        _artifact_record(geojson_path, "geojson", "Extracted building footprints", bbox=request["bbox"], color="#7dd3fc"),
    ]
    metrics = {
        "buildings_detected": len(buildings),
        "road_segments": 6,
        "land_cover_classes": 3,
    }
    return _base_bundle(
        request,
        job_id,
        "Generated building, road, and land-cover proxy outputs for the mission AOI.",
        metrics,
        artifacts,
    )


def _run_change_detection(request: dict[str, Any], job_id: str, state: JobState) -> dict[str, Any]:
    state.progress = 20
    state.message = "Generating before/after scenes"
    rng = _rng_for(request)
    job_dir = _job_dir(job_id)
    before = rng.uniform(0.1, 0.9, size=(96, 96))
    after = before.copy()
    for _ in range(8):
        x = int(rng.integers(4, 76))
        y = int(rng.integers(4, 76))
        after[y : y + 16, x : x + 16] += rng.uniform(0.18, 0.45)

    state.progress = 60
    state.message = "Computing change mask"
    delta = np.abs(after - before)
    mask = delta > 0.18
    component_count = _connected_components(mask)
    _save_heatmap(job_dir / "before.png", before, "blue")
    _save_heatmap(job_dir / "after.png", after, "orange")
    _save_heatmap(job_dir / "mask.png", mask.astype(float), "green")
    artifacts = [
        _artifact_record(job_dir / "before.png", "raster_preview", "Before scene", bbox=request["bbox"], default_visible=False),
        _artifact_record(job_dir / "after.png", "raster_preview", "After scene", bbox=request["bbox"], default_visible=False),
        _artifact_record(job_dir / "mask.png", "raster_preview", "Change mask", bbox=request["bbox"], color="#34d399"),
    ]
    metrics = {
        "changed_pixels": int(mask.sum()),
        "changed_objects": component_count,
        "max_delta": round(float(delta.max()), 4),
    }
    return _base_bundle(
        request,
        job_id,
        "Detected localized structural change candidates between synthetic before and after scenes.",
        metrics,
        artifacts,
    )


def _run_temporal_decomposition(request: dict[str, Any], job_id: str, state: JobState) -> dict[str, Any]:
    state.progress = 30
    state.message = "Building mission time series"
    rng = _rng_for(request)
    job_dir = _job_dir(job_id)
    points = 36
    x = np.arange(points)
    trend = 0.2 + x * 0.015
    seasonal = 0.18 * np.sin((x / 12) * np.pi * 2)
    noise = rng.normal(0, 0.04, size=points)
    values = trend + seasonal + noise
    anomaly_idx = int(rng.integers(4, points - 4))
    values[anomaly_idx] += 0.35
    anomalies = np.where(np.abs(values - values.mean()) > values.std() * 1.2)[0].tolist()
    _draw_series(job_dir / "temporal.png", values)
    series_path = job_dir / "series.json"
    series_path.write_text(json.dumps({"values": values.tolist(), "anomalies": anomalies}, indent=2))
    artifacts = [
        _artifact_record(job_dir / "temporal.png", "image", "Temporal decomposition chart", default_visible=False, opacity=1.0),
        _artifact_record(series_path, "json", "Temporal decomposition series", default_visible=False, opacity=1.0),
    ]
    metrics = {
        "samples": points,
        "anomaly_count": len(anomalies),
        "strongest_anomaly_index": anomaly_idx,
        "mean_value": round(float(values.mean()), 4),
    }
    return _base_bundle(
        request,
        job_id,
        "Produced a trend + seasonality + anomaly decomposition for mission-linked temporal behavior.",
        metrics,
        artifacts,
    )


def _run_tracking_fusion(request: dict[str, Any], job_id: str, state: JobState) -> dict[str, Any]:
    state.progress = 35
    state.message = "Synthesizing fused AIS/ADS-B activity picture"
    rng = _rng_for(request)
    job_dir = _job_dir(job_id)
    image = Image.new("RGB", (512, 512), "#09111b")
    draw = ImageDraw.Draw(image)
    aircraft = int(rng.integers(6, 22))
    vessels = int(rng.integers(3, 16))
    for _ in range(aircraft):
        x = int(rng.integers(24, 488))
        y = int(rng.integers(24, 488))
        draw.ellipse((x - 3, y - 3, x + 3, y + 3), fill="#7dd3fc")
    for _ in range(vessels):
        x = int(rng.integers(24, 488))
        y = int(rng.integers(24, 488))
        draw.rectangle((x - 4, y - 4, x + 4, y + 4), fill="#fde68a")
    preview_path = job_dir / "tracking.png"
    image.save(preview_path)
    tracking_geojson = _synthetic_track_collection(
        request["bbox"],
        aircraft_count=aircraft,
        vessel_count=vessels,
        rng=rng,
    )
    geojson_path = job_dir / "tracking.geojson"
    geojson_path.write_text(json.dumps(tracking_geojson, indent=2))
    artifacts = [
        _artifact_record(preview_path, "raster_preview", "Tracking density preview", bbox=request["bbox"], default_visible=False),
        _artifact_record(geojson_path, "track_geojson", "Fused tracking layer", bbox=request["bbox"], color="#7dd3fc"),
    ]
    metrics = {
        "aircraft_contacts": aircraft,
        "vessel_contacts": vessels,
        "co_activity_score": round(float(rng.uniform(0.41, 0.93)), 3),
    }
    return _base_bundle(
        request,
        job_id,
        "Created a fused contact-density view summarizing synthetic air and maritime activity over the AOI.",
        metrics,
        artifacts,
    )


def _run_python_postprocess(request: dict[str, Any], job_id: str, state: JobState) -> dict[str, Any]:
    state.progress = 50
    state.message = "Executing constrained post-process recipe"
    rng = _rng_for(request)
    job_dir = _job_dir(job_id)
    image = Image.new("RGB", (384, 384), "#101826")
    draw = ImageDraw.Draw(image)
    objects = int(rng.integers(4, 14))
    for _ in range(objects):
        x = int(rng.integers(30, 320))
        y = int(rng.integers(30, 320))
        draw.rectangle((x, y, x + 24, y + 24), outline="#34d399", width=3)
    preview_path = job_dir / "postprocess.png"
    image.save(preview_path)
    artifacts = [
        _artifact_record(preview_path, "raster_preview", "Post-process overlay", bbox=request["bbox"], color="#34d399"),
    ]
    metrics = {
        "postprocessed_objects": objects,
        "overlay_color": "green",
    }
    return _base_bundle(
        request,
        job_id,
        "Applied a constrained post-processing step suitable for analyst-directed follow-up requests.",
        metrics,
        artifacts,
    )
