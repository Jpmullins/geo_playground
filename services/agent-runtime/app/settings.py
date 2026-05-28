from functools import lru_cache
import os

from pydantic import BaseModel, Field


class Settings(BaseModel):
    telemetry_api_base: str = Field(default_factory=lambda: os.getenv("TELEMETRY_API_BASE", "http://localhost:8080").rstrip("/"))
    litellm_base_url: str = Field(
        default_factory=lambda: os.getenv("LITELLM_BASE_URL")
        or os.getenv("INSIGHTS_LITELLM_BASE_URL")
        or "https://gateway.insights.arlis.umd.edu/v1"
    )
    litellm_api_key: str = Field(
        default_factory=lambda: os.getenv("INSIGHTS_LITELLM_API_KEY")
        or os.getenv("LITELLM_API_KEY")
        or os.getenv("OPENAI_API_KEY")
        or ""
    )
    litellm_model: str = Field(
        default_factory=lambda: os.getenv("INSIGHTS_LITELLM_MODEL")
        or os.getenv("LITELLM_MODEL")
        or "gpt-4.1"
    )
    request_timeout_seconds: float = Field(default_factory=lambda: float(os.getenv("AGENT_REQUEST_TIMEOUT_SECONDS", "12")))


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
