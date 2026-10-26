"""QUBO formulation of the sampling-level problem.

Variables: x[z, l] for every zone z and non-skip level l ("skip" is all zeros).
Minimise   -sum v[z,l] x[z,l]                         (maximise planned value)
         + A * sum_z sum_{l<l'} x[z,l] x[z,l']          (at most one level per zone)
         + budget penalty on g = B - sum e[l] x[z,l]    (energy budget)

The budget is an inequality. Instead of slack qubits it uses unbalanced penalisation,
h(g) = -lam1 * g + lam2 * g**2 (Montanez-Barrera et al., 2022), which keeps the qubit count at
4 per zone. The penalty is not exact, so every candidate is checked for feasibility afterwards.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .models import LEVELS, PlanRequest
from .planner import value_matrix

SAMPLE_LEVELS = LEVELS[1:]  # skip is "no variable set"


@dataclass
class Qubo:
    Q: np.ndarray  # upper-triangular, diagonal holds the linear terms
    offset: float
    n_zones: int

    @property
    def n_vars(self) -> int:
        return self.Q.shape[0]


def build_qubo(req: PlanRequest, lam1: float | None = None, lam2: float | None = None, one_hot: float | None = None) -> Qubo:
    values, energy = value_matrix(req)
    nz = len(req.zones)
    m = len(SAMPLE_LEVELS)
    n = nz * m
    vmax = float(values.max()) if values.size else 1.0
    B = float(req.energy_budget)
    emax = float(energy.max()) or 1.0
    # Scales chosen relative to the value range so that overspending by one unit costs more than
    # the most valuable single choice; tests check the ground state for the demo lake.
    lam2 = lam2 if lam2 is not None else 1.2 * vmax / emax
    lam1 = lam1 if lam1 is not None else 0.05 * vmax / emax
    A = one_hot if one_hot is not None else 2.0 * vmax + 1.0
    Q = np.zeros((n, n))
    e = np.array([energy[LEVELS.index(l)] for l in SAMPLE_LEVELS] * nz)
    for z in range(nz):
        for a in range(m):
            i = z * m + a
            Q[i, i] -= values[z][a + 1]
            for b in range(a + 1, m):
                Q[i, z * m + b] += A
    # h(g) with g = B - e.x:  -lam1*B + lam1*e.x + lam2*(B^2 - 2B e.x + (e.x)^2)
    offset = -lam1 * B + lam2 * B * B
    for i in range(n):
        Q[i, i] += lam1 * e[i] - 2 * lam2 * B * e[i] + lam2 * e[i] * e[i]  # x_i^2 = x_i
        for j in range(i + 1, n):
            Q[i, j] += 2 * lam2 * e[i] * e[j]
    return Qubo(Q=Q, offset=offset, n_zones=nz)


def energies(q: Qubo) -> np.ndarray:
    """QUBO energy of every bitstring (bit i of the index is variable i). Only for small n."""
    n = q.n_vars
    idx = np.arange(2**n, dtype=np.int64)
    bits = [((idx >> i) & 1).astype(np.float64) for i in range(n)]
    out = np.full(2**n, q.offset)
    for i in range(n):
        if q.Q[i, i]:
            out += q.Q[i, i] * bits[i]
        for j in range(i + 1, n):
            if q.Q[i, j]:
                out += q.Q[i, j] * bits[i] * bits[j]
    return out


def decode(index: int, n_zones: int) -> list[str] | None:
    """Bitstring -> level per zone, or None if a zone has more than one level set."""
    m = len(SAMPLE_LEVELS)
    out: list[str] = []
    for z in range(n_zones):
        on = [a for a in range(m) if (index >> (z * m + a)) & 1]
        if len(on) > 1:
            return None
        out.append(SAMPLE_LEVELS[on[0]] if on else "skip")
    return out


def encode(choice: list[str]) -> int:
    m = len(SAMPLE_LEVELS)
    idx = 0
    for z, l in enumerate(choice):
        if l != "skip":
            idx |= 1 << (z * m + SAMPLE_LEVELS.index(l))
    return idx
