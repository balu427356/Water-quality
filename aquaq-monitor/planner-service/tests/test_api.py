from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_plan_and_score(plan_fixture, score_fixture, monkeypatch):
    monkeypatch.delenv("PLANNER_API_KEY", raising=False)
    r = client.post("/plan", json={**plan_fixture["request"], "solver": "classical"})
    assert r.status_code == 200
    body = r.json()
    assert body["solver"] == "classical_fallback" and body["objective"] == 2.69 and body["waypoints"] == []
    s = client.post("/score", json=score_fixture[0]["request"])
    assert s.status_code == 200 and s.json() == score_fixture[0]["expected"]


def test_api_key_is_required_when_configured(plan_fixture, monkeypatch):
    monkeypatch.setenv("PLANNER_API_KEY", "s3cret")
    req = {**plan_fixture["request"], "solver": "classical"}
    assert client.post("/plan", json=req).status_code == 401
    assert client.post("/plan", json=req, headers={"Authorization": "Bearer nope"}).status_code == 401
    assert client.post("/plan", json=req, headers={"Authorization": "Bearer s3cret"}).status_code == 200


def test_rejects_bad_requests(plan_fixture, monkeypatch):
    monkeypatch.delenv("PLANNER_API_KEY", raising=False)
    req = {**plan_fixture["request"], "levels": {"skip": 0, "confirm": 1}}
    assert client.post("/plan", json=req).status_code == 422
    bad = {**plan_fixture["request"], "zones": [{"zone_id": "A", "risk_R": 1.5, "trust_T": 0.5}]}
    assert client.post("/plan", json=bad).status_code == 422
