from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    default_model: str = os.getenv("DEFAULT_MODEL", "openai:gpt-4.1-mini")
    analysis_worker_url: str = os.getenv("ANALYSIS_WORKER_URL", "http://localhost:8090").rstrip("/")
    default_stac_api_url: str = os.getenv(
        "DEFAULT_STAC_API_URL",
        "https://planetarycomputer.microsoft.com/api/stac/v1",
    ).rstrip("/")
    sentinel_hub_base_url: str = os.getenv(
        "SENTINEL_HUB_BASE_URL",
        "https://services.sentinel-hub.com",
    ).rstrip("/")
    sentinel_hub_client_id: str = os.getenv("SENTINEL_HUB_CLIENT_ID", "")
    sentinel_hub_client_secret: str = os.getenv("SENTINEL_HUB_CLIENT_SECRET", "")
    ais_api_url: str = os.getenv("AIS_API_URL", "").rstrip("/")
    ais_api_key: str = os.getenv("AIS_API_KEY", "")
    adsb_api_url: str = os.getenv("ADSB_API_URL", "https://opendata.adsb.fi/api/v2").rstrip("/")


settings = Settings()
