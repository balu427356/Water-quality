"""Request/response models for the planner service (section 9 of the brief)."""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

Level = Literal["skip", "confirm", "standard_25m", "dense_10m", "hotspot_5m"]
LEVELS: list[str] = ["skip", "confirm", "standard_25m", "dense_10m", "hotspot_5m"]


class ZoneRT(BaseModel):
    zone_id: str
    risk_R: float = Field(ge=0, le=1)
    trust_T: float = Field(ge=0, le=1)


class PlanRequest(BaseModel):
    water_body_id: str
    boat_id: str
    energy_budget: float = Field(ge=0)
    zones: list[ZoneRT] = Field(min_length=1)
    levels: dict[Level, float]
    # Extension: "auto" (QAOA when it fits the simulator, else classical), "qaoa" or "classical".
    solver: Literal["auto", "qaoa", "classical"] = "auto"


class PlannedZone(BaseModel):
    zone_id: str
    level: Level
    energy: float
    reason: str


class PlanResponse(BaseModel):
    solver: Literal["quantum_qaoa", "quantum_annealer", "classical_fallback", "mock"]
    energy_planned: float
    objective: float
    zones: list[PlannedZone]
    # The app builds the route from the chosen levels and the zone geometry, so none is returned.
    waypoints: list[dict] = []
    note: Optional[str] = None


class Parameter(BaseModel):
    id: str
    key: str
    name: str
    unit: str
    limit_type: Literal["max", "min", "range", "none"]
    limit_low: Optional[float] = None
    limit_high: Optional[float] = None
    hazard_weight: float
    enabled: bool = True


class TierCutoffs(BaseModel):
    medium: float
    high: float
    critical: float


class ScoreSettings(BaseModel):
    trust_threshold: float
    tier_cutoffs: TierCutoffs
    near_limit_pct: float = 10


class ScoreReading(BaseModel):
    zone_id: Optional[str]
    parameter_key: str
    value: float
    edge_anomaly_flag: bool
    trust_T: Optional[float] = None


class ScoreRequest(BaseModel):
    survey_id: str
    zones: list[str]
    readings: list[ScoreReading]
    parameters: list[Parameter]
    settings: ScoreSettings


class Driver(BaseModel):
    parameter_key: str
    value: float
    limit: str
    contribution: float


class ScoredZone(BaseModel):
    zone_id: str
    risk_R: float
    trust_T: float
    risk_tier: str
    top_drivers: list[Driver]
    trust_gate: Literal["auto_accept", "lab_review"]
    trust_gate_reason: Optional[str]


class ScoreResponse(BaseModel):
    survey_id: str
    method: str
    zone_scores: list[ScoredZone]
