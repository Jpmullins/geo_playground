import importlib


def test_settings_prefers_insights_litellm_key(monkeypatch):
    monkeypatch.setenv("INSIGHTS_LITELLM_API_KEY", "insights-key")
    monkeypatch.setenv("LITELLM_API_KEY", "fallback-key")
    module = importlib.import_module("app.settings")
    module.get_settings.cache_clear()

    settings = module.get_settings()

    assert settings.litellm_api_key == "insights-key"


def test_settings_uses_gateway_v1_default(monkeypatch):
    monkeypatch.delenv("LITELLM_BASE_URL", raising=False)
    monkeypatch.delenv("INSIGHTS_LITELLM_BASE_URL", raising=False)
    module = importlib.import_module("app.settings")
    module.get_settings.cache_clear()

    settings = module.get_settings()

    assert settings.litellm_base_url == "https://gateway.insights.arlis.umd.edu/v1"

