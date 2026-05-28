from app.tools import make_geoint_dashboard


def test_make_geoint_dashboard_returns_a2ui_operations():
    rendered = make_geoint_dashboard.invoke({
        "title": "Current Picture",
        "summary": "Mixed air and maritime activity inside AOI.",
        "air_count": 3,
        "maritime_count": 2,
        "priority_entity_id": "abc123",
        "center_lat": 37.7,
        "center_lon": -122.4,
        "radius_km": 80
    })

    assert "geoint-intelligence-card" in rendered
    assert "Focus AOI" in rendered
    assert "Inspect Entity" in rendered

