"""AquaQ planner service: POST /plan (sampling-level QUBO; QAOA simulator or classical fallback)
and POST /score (zone risk/trust scoring). Contract: section 9 of the brief."""

from __future__ import annotations

import os
import secrets

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .models import LEVELS, PlanRequest, PlanResponse, ScoreRequest, ScoreResponse
from .scoring import score_survey
from .solve import plan

app = FastAPI(title="AquaQ planner service", version="1.0.0")

origins = [o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()]
if origins:
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["POST", "GET"], allow_headers=["Authorization", "Content-Type"])


def require_key(authorization: str | None = Header(default=None)) -> None:
    key = os.environ.get("PLANNER_API_KEY")
    if not key:
        return  # open service (local development)
    if not authorization or not secrets.compare_digest(authorization, f"Bearer {key}"):
        raise HTTPException(status_code=401, detail="Missing or wrong API key")


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/plan", response_model=PlanResponse, dependencies=[Depends(require_key)])
def post_plan(req: PlanRequest) -> PlanResponse:
    missing = [l for l in LEVELS if l not in req.levels]
    if missing:
        raise HTTPException(status_code=422, detail=f"levels is missing {', '.join(missing)}")
    if len({z.zone_id for z in req.zones}) != len(req.zones):
        raise HTTPException(status_code=422, detail="zone ids must be unique")
    return plan(req)


@app.post("/score", response_model=ScoreResponse, dependencies=[Depends(require_key)])
def post_score(req: ScoreRequest) -> ScoreResponse:
    return score_survey(req)
