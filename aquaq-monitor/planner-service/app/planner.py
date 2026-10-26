"""Sampling-level planning: value model, reasons and the exact classical solver.
Mirrors supabase/functions/_shared/planner.ts so the classical answer matches the app's mock."""

from __future__ import annotations

import numpy as np

from .jsnum import js_round
from .models import LEVELS, PlanRequest

GAIN = {"skip": 0.0, "confirm": 0.0, "standard_25m": 1.0, "dense_10m": 1.6, "hotspot_5m": 2.2}
EXACT_MAX_ZONES = 10


def level_value(level: str, r: float, t: float) -> float:
    if level == "skip":
        return 0.0
    if level == "confirm":
        return r * (1 - t) * 1.2
    return r * t * GAIN[level]


def level_reason(level: str, r: float, t: float, trust_threshold: float = 0.5) -> str:
    if level == "hotspot_5m":
        return "High risk and high trust: map the hotspot at 5 m spacing."
    if level == "dense_10m":
        return "High risk and trusted data: dense 10 m sampling."
    if level == "standard_25m":
        return "Moderate risk, trusted data: standard 25 m survey." if r < 0.5 else "Standard 25 m survey; the energy budget does not allow denser sampling."
    if level == "confirm":
        return (
            "High risk but low trust: one confirmation sample before chasing."
            if t < trust_threshold
            else "One confirmation sample; the energy budget does not allow a survey here."
        )
    return "Low risk: skip this survey to save energy." if r < 0.25 else "Skipped: the energy budget is used on higher-value zones."


def value_matrix(req: PlanRequest) -> tuple[np.ndarray, np.ndarray]:
    """values[z, l] and energy[l] in LEVELS order."""
    values = np.array([[level_value(l, z.risk_R, z.trust_T) for l in LEVELS] for z in req.zones])
    energy = np.array([req.levels[l] for l in LEVELS], dtype=float)
    return values, energy


def objective(req: PlanRequest, choice: list[str]) -> tuple[float, float]:
    v = 0.0
    e = 0.0
    for z, l in zip(req.zones, choice):
        e += req.levels[l]
        v += level_value(l, z.risk_R, z.trust_T)
    return v, e


def solve_exact(req: PlanRequest) -> list[str]:
    """Best value within budget over every combination. Same order and tie-breaking as the app's
    mock (zone 0 varies fastest; ties go to the cheaper plan, then to the first found)."""
    n = len(req.zones)
    if n > EXACT_MAX_ZONES:
        raise ValueError(f"exact search is limited to {EXACT_MAX_ZONES} zones")
    values, energy = value_matrix(req)
    k = len(LEVELS)
    idx = np.arange(k**n, dtype=np.int64)
    total_v = np.zeros(k**n)
    total_e = np.zeros(k**n)
    for i in range(n):  # sequential sums, like the JS loop
        digit = (idx // k**i) % k
        total_e += energy[digit]
        total_v += values[i][digit]
    feasible = total_e <= req.energy_budget + 1e-9
    best = -1.0
    best_e = np.inf
    best_c = 0
    # Scan in order to reproduce the JS tie-breaking exactly.
    order = np.nonzero(feasible)[0]
    v = total_v[order]
    e = total_e[order]
    for j in range(len(order)):
        if v[j] > best + 1e-9 or (abs(v[j] - best) <= 1e-9 and e[j] < best_e):
            best, best_e, best_c = v[j], e[j], order[j]
    return [LEVELS[(best_c // k**i) % k] for i in range(n)]


def solve_greedy(req: PlanRequest) -> list[str]:
    """Value per energy unit first, then single-zone upgrades while they fit (large problems)."""
    values, energy = value_matrix(req)
    choice = ["skip"] * len(req.zones)
    opts = sorted(
        ((values[i][j] / energy[j], i, j) for i in range(len(req.zones)) for j in range(1, len(LEVELS)) if energy[j] > 0),
        key=lambda x: -x[0],
    )
    used = 0.0
    for ratio, i, j in opts:
        if choice[i] != "skip" or ratio <= 0 or used + energy[j] > req.energy_budget:
            continue
        choice[i] = LEVELS[j]
        used += energy[j]
    improved = True
    while improved:
        improved = False
        for i in range(len(choice)):
            cur = LEVELS.index(choice[i])
            for j in range(len(LEVELS)):
                delta_e = energy[j] - energy[cur]
                if values[i][j] > values[i][cur] + 1e-12 and used + delta_e <= req.energy_budget + 1e-9:
                    used += delta_e
                    choice[i] = LEVELS[j]
                    cur = j
                    improved = True
    return choice


def to_response_zones(req: PlanRequest, choice: list[str]) -> list[dict]:
    return [
        {"zone_id": z.zone_id, "level": l, "energy": req.levels[l], "reason": level_reason(l, z.risk_R, z.trust_T)}
        for z, l in zip(req.zones, choice)
    ]


def rounded_objective(req: PlanRequest, choice: list[str]) -> float:
    return js_round(objective(req, choice)[0], 2)
