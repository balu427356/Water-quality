"""QAOA for the planning QUBO, run on a NumPy statevector simulator (no quantum hardware).

The cost Hamiltonian is diagonal in the computational basis, so its phase is a pointwise
multiplication; the X mixer is applied qubit by qubit. Angles are optimised with COBYLA on the
CVaR of the cost (the mean of the best alpha fraction of outcomes; Barkoutsos et al., 2020),
which concentrates probability on low-cost bitstrings better than the plain expectation for
penalty-heavy QUBOs. This is a faithful QAOA simulation; it is not faster than solving classically.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.optimize import minimize

from .qubo import Qubo, energies

DEFAULT_MAX_QUBITS = 20


@dataclass
class QaoaResult:
    probabilities: np.ndarray
    angles: np.ndarray
    expected_cost: float
    evaluations: int
    p: int
    n_qubits: int


def _mixer(state: np.ndarray, beta: float, n: int) -> np.ndarray:
    c, s = np.cos(beta), -1j * np.sin(beta)
    for k in range(n):
        v = state.reshape(-1, 2, 2**k)
        a0 = v[:, 0, :].copy()
        a1 = v[:, 1, :]
        v[:, 0, :] = c * a0 + s * a1
        v[:, 1, :] = s * a0 + c * a1
    return state


def run_qaoa(q: Qubo, p: int = 2, alpha: float = 0.05, seed: int = 7, restarts: int = 3, maxiter: int = 120) -> QaoaResult:
    n = q.n_vars
    cost = energies(q)
    # Normalise by the spread so the angle ranges are comparable across problem sizes.
    scale = float(cost.std()) or 1.0
    c = (cost - cost.mean()) / scale
    order = np.argsort(c)
    c_sorted = c[order]
    psi0 = np.full(2**n, 1 / np.sqrt(2**n), dtype=np.complex128)
    evals = 0

    def state(angles: np.ndarray) -> np.ndarray:
        psi = psi0.copy()
        for layer in range(p):
            psi *= np.exp(-1j * angles[layer] * c)
            psi = _mixer(psi, angles[p + layer], n)
        return psi

    def cvar(angles: np.ndarray) -> float:
        nonlocal evals
        evals += 1
        probs = np.abs(state(angles)) ** 2
        ps = probs[order]
        cum = np.cumsum(ps)
        k = int(np.searchsorted(cum, alpha))
        w = ps[: k + 1].copy()
        w[-1] -= cum[k] - alpha
        return float(w @ c_sorted[: k + 1]) / alpha

    rng = np.random.default_rng(seed)
    best = None
    for r in range(restarts):
        # Small linear-ramp start (annealing-like) first, then random starts.
        x0 = np.concatenate([np.linspace(0.1, 0.5, p), np.linspace(0.5, 0.1, p)]) if r == 0 else rng.uniform(0, np.pi / 2, 2 * p)
        res = minimize(cvar, x0, method="COBYLA", options={"maxiter": maxiter, "rhobeg": 0.2})
        if best is None or res.fun < best.fun:
            best = res
    probs = np.abs(state(best.x)) ** 2
    probs /= probs.sum()
    return QaoaResult(probabilities=probs, angles=best.x, expected_cost=float(best.fun * scale + cost.mean()), evaluations=evals, p=p, n_qubits=n)
