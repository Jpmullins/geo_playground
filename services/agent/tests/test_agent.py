from __future__ import annotations

import asyncio
import importlib
import json
import sys

from geoint_agent.tools import ALL_TOOLS, build_mission_brief


def test_all_tools_are_registered() -> None:
    assert [tool.name for tool in ALL_TOOLS] == [
        "build_mission_brief",
        "search_stac_catalog",
        "inspect_sentinel_hub_support",
        "query_adsb_tracks",
        "query_ais_tracks",
        "submit_analysis_job",
        "fetch_artifact_bundle",
    ]


def test_build_mission_brief_emits_artifact_bundle_contract() -> None:
    payload = asyncio.run(
        build_mission_brief.ainvoke(
            {
                "objective": "Assess harbor expansion activity",
                "aoi_name": "Port AOI",
                "bbox": "-122.4,37.7,-122.2,37.9",
                "time_range": "2024-01-01/2024-02-01",
                "domains": ["imagery", "maritime"],
            }
        )
    )

    brief = json.loads(payload)
    assert brief["deliverable"] == "artifact_bundle"
    assert brief["bbox"] == [-122.4, 37.7, -122.2, 37.9]
    assert brief["domains"] == ["imagery", "maritime"]


def test_agent_graph_imports_with_provider_env(monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    sys.modules.pop("geoint_agent.app", None)

    app_module = importlib.import_module("geoint_agent.app")

    assert app_module.agent.__class__.__name__ == "CompiledStateGraph"
