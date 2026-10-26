import numpy as np
import pytest

from app.models import PlanRequest
from app.planner import objective, solve_exact, solve_greedy
from app.qubo import build_qubo, decode, encode, energies
from app.solve import classical, plan, qaoa


@pytest.fixture
def demo(plan_fixture):
    return PlanRequest(**plan_fixture["request"])


def test_exact_matches_app_mock(demo, plan_fixture):
    exp = plan_fixture["expected"]
    res = classical(demo)
    assert res.solver == "classical_fallback"
    assert [z.model_dump() for z in res.zones] == [{**z, "energy": float(z["energy"])} for z in exp["zones"]]
    assert res.energy_planned == exp["energy_planned"]
    assert res.objective == exp["objective"] == 2.69


def test_qubo_ground_state_is_the_optimal_plan(demo):
    q = build_qubo(demo)
    assert q.n_vars == 16
    e = energies(q)
    assert decode(int(np.argmin(e)), 4) == solve_exact(demo)


def test_qubo_penalises_every_infeasible_assignment(demo):
    q = build_qubo(demo)
    e = energies(q)
    best = e[encode(solve_exact(demo))]
    for idx in range(len(e)):
        ch = decode(idx, 4)
        if ch is None or objective(demo, ch)[1] > demo.energy_budget:
            assert e[idx] > best


def test_qaoa_returns_labelled_feasible_optimal_plan(demo):
    res = qaoa(demo, max_qubits=20, p=2)
    assert res.solver == "quantum_qaoa"
    assert res.energy_planned <= demo.energy_budget
    assert "not quantum hardware" in res.note
    assert res.objective == 2.69  # after the disclosed classical refinement


def test_falls_back_when_qubo_exceeds_simulator(demo, monkeypatch):
    monkeypatch.setenv("QAOA_MAX_QUBITS", "12")
    res = plan(demo)
    assert res.solver == "classical_fallback"
    assert "above the simulator limit" in res.note
    assert res.objective == 2.69


def test_classical_mode_and_greedy_for_many_zones(demo):
    assert plan(demo.model_copy(update={"solver": "classical"})).solver == "classical_fallback"
    zones = [{"zone_id": f"Z{i}", "risk_R": round(0.08 * (i + 1), 2), "trust_T": 0.9 if i % 2 else 0.3} for i in range(12)]
    big = demo.model_copy(update={"zones": [type(demo.zones[0])(**z) for z in zones], "energy_budget": 20})
    ch = solve_greedy(big)
    assert objective(big, ch)[1] <= 20
    res = classical(big)
    assert "greedy" in res.note and res.energy_planned <= 20
