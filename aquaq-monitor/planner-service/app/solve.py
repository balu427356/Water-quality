"""Solver selection: QAOA when the QUBO fits the simulator, otherwise the classical fallback."""

from __future__ import annotations

import os

import numpy as np

from .models import PlanRequest, PlanResponse
from .planner import EXACT_MAX_ZONES, objective, rounded_objective, solve_exact, solve_greedy, to_response_zones
from .qaoa import DEFAULT_MAX_QUBITS, run_qaoa
from .qubo import build_qubo, decode

SHOTS = 2048


def _feasible(req: PlanRequest, choice: list[str]) -> bool:
    return objective(req, choice)[1] <= req.energy_budget + 1e-9


def classical(req: PlanRequest, why: str | None = None) -> PlanResponse:
    if len(req.zones) <= EXACT_MAX_ZONES:
        choice, how = solve_exact(req), "exhaustive search over every level combination"
    else:
        choice, how = solve_greedy(req), "greedy value-per-energy with single-zone upgrades (may not be optimal)"
    note = f"Classical solver: {how}." + (f" {why}" if why else "")
    return _response(req, "classical_fallback", choice, note)


def improve(req: PlanRequest, choice: list[str]) -> list[str]:
    """Classical post-processing: apply single-zone level changes while they raise value and fit the budget."""
    from .models import LEVELS

    cur = list(choice)
    improved = True
    while improved:
        improved = False
        v0, _ = objective(req, cur)
        best_move = None
        for i in range(len(cur)):
            for l in LEVELS:
                if l == cur[i]:
                    continue
                trial = cur[:i] + [l] + cur[i + 1 :]
                v, e = objective(req, trial)
                if e <= req.energy_budget + 1e-9 and v > v0 + 1e-12 and (best_move is None or v > best_move[0]):
                    best_move = (v, trial)
        if best_move:
            cur = best_move[1]
            improved = True
    return cur


def qaoa(req: PlanRequest, max_qubits: int, p: int, shots: int = SHOTS, seed: int = 11) -> PlanResponse:
    q = build_qubo(req)
    if q.n_vars > max_qubits:
        return classical(req, f"QAOA not used: the QUBO needs {q.n_vars} qubits, above the simulator limit of {max_qubits}.")
    res = run_qaoa(q, p=p)
    rng = np.random.default_rng(seed)
    samples = np.unique(rng.choice(len(res.probabilities), size=shots, p=res.probabilities))
    feasible = []
    for idx in samples:
        choice = decode(int(idx), len(req.zones))
        if choice is not None and _feasible(req, choice):
            feasible.append(choice)
    if not feasible:
        return classical(req, f"QAOA fallback: none of {shots} QAOA shots met the constraints.")
    feasible.sort(key=lambda ch: -objective(req, ch)[0])
    raw = feasible[0]
    # Refine the best few shots classically and keep the best result.
    refined = max((improve(req, ch) for ch in feasible[:5]), key=lambda ch: objective(req, ch)[0])
    raw_v = objective(req, raw)[0]
    fin_v = objective(req, refined)[0]
    note = (
        f"QAOA (p={res.p}, {res.n_qubits} qubits, CVaR objective) simulated on a CPU statevector simulator, not quantum hardware. "
        f"Best feasible of {shots} shots had value {raw_v:.2f}"
        + (f"; classical single-zone refinement raised it to {fin_v:.2f}." if fin_v > raw_v + 1e-9 else "; classical refinement found no better neighbour.")
    )
    if len(req.zones) <= EXACT_MAX_ZONES:
        opt = objective(req, solve_exact(req))[0]
        note += " Matches the exact classical optimum." if fin_v >= opt - 1e-9 else f" {opt - fin_v:.2f} below the exact classical optimum ({opt:.2f})."
    return _response(req, "quantum_qaoa", refined, note)


def plan(req: PlanRequest) -> PlanResponse:
    mode = req.solver if req.solver != "auto" else os.environ.get("PLANNER_SOLVER", "auto")
    max_qubits = int(os.environ.get("QAOA_MAX_QUBITS", DEFAULT_MAX_QUBITS))
    p = int(os.environ.get("QAOA_LAYERS", 2))
    if mode == "classical":
        return classical(req)
    return qaoa(req, max_qubits, p)


def _response(req: PlanRequest, solver: str, choice: list[str], note: str) -> PlanResponse:
    zones = to_response_zones(req, choice)
    return PlanResponse(
        solver=solver,
        energy_planned=sum(z["energy"] for z in zones),
        objective=rounded_objective(req, choice),
        zones=zones,
        waypoints=[],
        note=note,
    )
