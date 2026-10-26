"""Zone scoring for POST /score. Identical to supabase/functions/_shared/scoring.ts (classical_v1);
tests/test_scoring.py checks both against the shared fixture."""

from __future__ import annotations

import math

from .jsnum import js_round
from .limits import compute_drivers, limit_ratio, limit_status, risk_tier, trust_gate
from .models import ScoredZone, ScoreRequest, ScoreResponse

SCORING_METHOD = "classical_v1"
NO_ANOMALY_TRUST = 0.9


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def exceedance_score(ratio: float) -> float:
    return _clamp((ratio - 0.6) / 0.8, 0, 1)


def _sum(vals: list[float]) -> float:
    total = 0.0
    for v in vals:  # left-to-right from 0, like Array.reduce((a, b) => a + b, 0)
        total += v
    return total


def _mean(vals: list[float]) -> float:
    return _sum(vals) / len(vals)


def score_zone(zone_id: str, req: ScoreRequest) -> ScoredZone:
    rs = [r for r in req.readings if r.zone_id == zone_id]
    params = [p for p in req.parameters if p.enabled and p.limit_type != "none" and p.hazard_weight > 0]
    wmax = max([p.hazard_weight for p in params] + [1e-9])
    parts: list[float] = []
    means: dict[str, float] = {}
    for p in params:
        vals = [r.value for r in rs if r.parameter_key == p.key]
        if not vals:
            continue
        mean = _mean(vals)
        means[p.key] = mean
        ratio = limit_ratio(mean, p)
        if ratio is None or not math.isfinite(ratio):
            continue
        exceed_frac = len([v for v in vals if limit_status(v, p, req.settings.near_limit_pct) == "out"]) / len(vals)
        parts.append(_clamp(0.75 * exceedance_score(ratio) + 0.25 * exceed_frac, 0, 1) * (p.hazard_weight / wmax))
    r_val = js_round(_clamp(0.7 * max(parts) + (0.3 * _sum(parts)) / len(parts), 0, 1), 2) if parts else 0
    anomalies = [r for r in rs if r.edge_anomaly_flag and r.trust_T is not None]
    t_val = js_round(_mean([r.trust_T for r in anomalies]), 2) if anomalies else NO_ANOMALY_TRUST
    for p in req.parameters:
        if p.key in means or not p.enabled:
            continue
        vals = [r.value for r in rs if r.parameter_key == p.key]
        if vals:
            means[p.key] = _mean(vals)
    gate, reason = trust_gate(r_val, t_val, req.settings.trust_threshold, req.settings.tier_cutoffs)
    return ScoredZone(
        zone_id=zone_id,
        risk_R=r_val,
        trust_T=t_val,
        risk_tier=risk_tier(r_val, req.settings.tier_cutoffs),
        top_drivers=compute_drivers(means, req.parameters),
        trust_gate=gate,
        trust_gate_reason=reason,
    )


def score_survey(req: ScoreRequest) -> ScoreResponse:
    return ScoreResponse(survey_id=req.survey_id, method=SCORING_METHOD, zone_scores=[score_zone(z, req) for z in req.zones])
