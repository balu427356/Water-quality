"""Port of supabase/functions/_shared/limits.ts (limit ratios, tiers, trust gate, drivers)."""

from __future__ import annotations

import math
from typing import Optional

from .jsnum import js_round, js_str, to_fixed
from .models import Driver, Parameter, TierCutoffs

BORDERLINE_MARGIN = 0.03


def limit_ratio(value: float, p: Parameter) -> Optional[float]:
    if p.limit_type == "max":
        if p.limit_high is None or p.limit_high <= 0:
            return None
        return value / p.limit_high
    if p.limit_type == "min":
        if p.limit_low is None:
            return None
        return math.inf if value <= 0 else p.limit_low / value
    if p.limit_type == "range":
        if p.limit_low is None or p.limit_high is None:
            return None
        centre = (p.limit_low + p.limit_high) / 2
        half = (p.limit_high - p.limit_low) / 2
        return None if half <= 0 else abs(value - centre) / half
    return None


def limit_status(value: float, p: Parameter, near_pct: float = 10) -> str:
    f = near_pct / 100
    if p.limit_type == "max":
        if p.limit_high is None:
            return "none"
        if value > p.limit_high:
            return "out"
        return "near" if value >= p.limit_high * (1 - f) else "ok"
    if p.limit_type == "min":
        if p.limit_low is None:
            return "none"
        if value < p.limit_low:
            return "out"
        return "near" if value <= p.limit_low * (1 + f) else "ok"
    if p.limit_type == "range":
        if p.limit_low is None or p.limit_high is None:
            return "none"
        if value < p.limit_low or value > p.limit_high:
            return "out"
        band = (p.limit_high - p.limit_low) * f
        return "near" if value - p.limit_low <= band or p.limit_high - value <= band else "ok"
    return "none"


def format_limit(p: Parameter) -> str:
    if p.limit_type == "max":
        return f"≤ {js_str(p.limit_high)} {p.unit}"
    if p.limit_type == "min":
        return f"≥ {js_str(p.limit_low)} {p.unit}"
    if p.limit_type == "range":
        return f"{js_str(p.limit_low)}–{js_str(p.limit_high)} {p.unit}"
    return "trend only"


def risk_tier(r: float, c: TierCutoffs) -> str:
    if r >= c.critical:
        return "Critical"
    if r >= c.high:
        return "High"
    if r >= c.medium:
        return "Medium"
    return "Low"


def trust_gate(r: float, t: float, trust_threshold: float, c: TierCutoffs) -> tuple[str, Optional[str]]:
    if t < trust_threshold:
        return (
            "lab_review",
            f"Low agreement: trust {to_fixed(t, 2)} is below the {js_str(trust_threshold)} threshold, so the change may be a sensor fault.",
        )
    for name, cut in (("Low/Medium", c.medium), ("Medium/High", c.high), ("High/Critical", c.critical)):
        if abs(r - cut) < BORDERLINE_MARGIN:
            return (
                "lab_review",
                f"Borderline decision: R {to_fixed(r, 2)} is within {js_str(BORDERLINE_MARGIN)} of the {name} cut-off ({js_str(cut)}).",
            )
    return "auto_accept", None


def compute_drivers(means: dict[str, float], params: list[Parameter]) -> list[Driver]:
    out: list[Driver] = []
    for p in params:
        if not p.enabled:
            continue
        v = means.get(p.key)
        if v is None:
            continue
        r = limit_ratio(v, p)
        if r is None or not math.isfinite(r):
            continue
        out.append(Driver(parameter_key=p.key, value=js_round(v, 3), limit=format_limit(p), contribution=js_round(p.hazard_weight * (r - 0.75), 3)))
    return sorted(out, key=lambda d: -d.contribution)
