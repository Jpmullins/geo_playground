from __future__ import annotations

import time

from fastapi.testclient import TestClient

from geoint_worker.app import app


client = TestClient(app)


def test_health() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["service"] == "analysis-worker"
    assert "tracking_sources" in response.json()


def test_create_and_complete_job() -> None:
    response = client.post(
        "/jobs",
        json={
            "operation": "spectral_index",
            "title": "Port mission",
            "bbox": [-122.4, 37.7, -122.2, 37.9],
            "time_range": "2024-01-01/2024-02-01",
            "parameters": {},
        },
    )
    assert response.status_code == 200
    job_id = response.json()["job_id"]

    for _ in range(80):
        status = client.get(f"/jobs/{job_id}")
        assert status.status_code == 200
        body = status.json()
        if body["status"] == "completed":
            assert body["bundle"]["bundle_id"] == job_id
            assert body["bundle"]["preview_urls"]
            assert body["bundle"]["artifacts"]
            assert all("uri" in artifact for artifact in body["bundle"]["artifacts"])
            return
        time.sleep(0.05)

    raise AssertionError("job did not complete")


def test_tracking_endpoint_returns_geojson() -> None:
    response = client.get("/tracking/fused", params={"bbox": "-122.4,37.7,-122.2,37.9", "limit": 12})
    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "fused"
    assert body["geojson"]["type"] == "FeatureCollection"
    assert body["summary"]["features"] >= 1
