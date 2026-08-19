"""Variational Quantum Classifier.

A different quantum model from the QSVM in the main pipeline. The QSVM computes
a fixed kernel from a data-encoding circuit and hands it to a classical SVM; the
VQC instead puts a *trainable* circuit after the encoding and optimises its
parameters directly against a classification loss.

    |0>^n --[ feature map U_phi(x) ]--[ ansatz W(theta) ]-- parity readout

Simulation is exact statevector, in numpy, with no quantum SDK dependency. Two
properties make it fast enough to tune properly:

  * the encoded states |phi(x)> do not depend on theta, so they are computed
    once at fit time and reused for every optimiser evaluation;
  * the ansatz is assembled as a single 2^n x 2^n unitary per parameter vector,
    so applying it to the whole batch is one matrix product whose cost does not
    grow with the number of samples.

Training uses COBYLA by default, the usual choice for VQC because the
parameter-shift gradient costs 2P circuit evaluations per step. SPSA is
available as an alternative; it needs only two evaluations per step regardless
of P and is the standard choice when the circuit count is the binding cost.
"""
from __future__ import annotations

import numpy as np
from scipy.optimize import minimize
from sklearn.base import BaseEstimator, ClassifierMixin
from sklearn.decomposition import PCA
from sklearn.preprocessing import MinMaxScaler, QuantileTransformer

# --------------------------------------------------------------------------- #
# gate primitives
# --------------------------------------------------------------------------- #
def _apply_1q(M, n, q, g):
    """Apply a 2x2 gate to qubit q of every row of M (shape (batch, 2**n))."""
    batch = M.shape[0]
    hi, lo = 2 ** (n - 1 - q), 2 ** q
    V = M.reshape(batch, hi, 2, lo)
    a, b = V[:, :, 0, :].copy(), V[:, :, 1, :].copy()
    V[:, :, 0, :] = g[0, 0] * a + g[0, 1] * b
    V[:, :, 1, :] = g[1, 0] * a + g[1, 1] * b
    return V.reshape(batch, 2 ** n)


def _ry(theta):
    c, s = np.cos(theta / 2.0), np.sin(theta / 2.0)
    return np.array([[c, -s], [s, c]], float)


def _rz(theta):
    e = np.exp(-0.5j * theta)
    return np.array([[e, 0], [0, np.conj(e)]], complex)


def _cx_perm(n, c, t):
    """Index permutation implementing CNOT. CNOT is an involution, so applying
    it to a state vector is a gather with this permutation."""
    idx = np.arange(2 ** n)
    flip = ((idx >> c) & 1).astype(bool)
    perm = idx.copy()
    perm[flip] = idx[flip] ^ (1 << t)
    return perm


def entangler_pairs(n, kind):
    if kind == "linear":
        return [(i, i + 1) for i in range(n - 1)]
    if kind == "circular":
        p = [(i, i + 1) for i in range(n - 1)]
        return p + [(n - 1, 0)] if n > 2 else p
    if kind == "full":
        return [(i, j) for i in range(n) for j in range(i + 1, n)]
    if kind == "none":
        return []
    raise ValueError(kind)


def n_params(n_qubits, reps, rotation):
    """Ansatz parameters only; the readout adds two more (scale and bias)."""
    per = 2 if rotation == "ry_rz" else 1
    return per * n_qubits * (reps + 1)


def ansatz_unitary(n, reps, params, entanglement="linear", rotation="ry"):
    """Assemble the ansatz as one 2**n x 2**n unitary.

    RealAmplitudes-style: alternating rotation layers and CNOT entanglers, with
    a final rotation layer. Building the matrix once and multiplying the batch
    through it is cheaper than replaying gates per sample whenever the batch is
    larger than the state dimension, which it always is here.
    """
    dim = 2 ** n
    U = np.eye(dim, dtype=complex)
    pairs = entangler_pairs(n, entanglement)
    perms = [_cx_perm(n, c, t) for (c, t) in pairs]
    per = 2 if rotation == "ry_rz" else 1
    k = 0
    for r in range(reps + 1):
        for q in range(n):
            U = _apply_1q(U, n, q, _ry(params[k])); k += 1
            if per == 2:
                U = _apply_1q(U, n, q, _rz(params[k])); k += 1
        if r < reps:
            for p in perms:
                U = U[:, p]
    return U


# --------------------------------------------------------------------------- #
# feature map (matches the pipeline's encoding)
# --------------------------------------------------------------------------- #
def _bits(n):
    idx = np.arange(2 ** n)
    return ((idx[:, None] >> np.arange(n)[None, :]) & 1).astype(np.int8)


def _hadamard(psi, n):
    out, h, m = psi, 1, psi.shape[0]
    for _ in range(n):
        out = out.reshape(m, -1, 2 * h)
        a, b = out[:, :, :h].copy(), out[:, :, h:].copy()
        out[:, :, :h], out[:, :, h:] = a + b, a - b
        out = out.reshape(m, -1)
        h *= 2
    return out / np.sqrt(2 ** n)


def encode(X, fmap="zz", reps=2, entanglement="linear", alpha=1.0):
    """ZZ / Z feature-map statevectors, same construction as the QSVM arm."""
    X = np.asarray(X, float)
    ns, nq = X.shape
    bits = _bits(nq)
    theta = alpha * (X @ bits.T.astype(float))
    pairs = [] if fmap == "z" else entangler_pairs(nq, entanglement)
    if pairs:
        pi_ = np.array([p[0] for p in pairs])
        pj_ = np.array([p[1] for p in pairs])
        parity = (bits[:, pi_] ^ bits[:, pj_]).astype(float)
        phi = (np.pi - X[:, pi_]) * (np.pi - X[:, pj_])
        theta = theta + (alpha * phi) @ parity.T
    phase = np.exp(1j * theta)
    psi = np.zeros(2 ** nq, complex)
    psi[0] = 1.0
    psi = np.broadcast_to(psi, (ns, 2 ** nq)).copy()
    for _ in range(reps):
        psi = _hadamard(psi, nq)
        psi *= phase
    return psi


# --------------------------------------------------------------------------- #
# classifier
# --------------------------------------------------------------------------- #
class VQC(BaseEstimator, ClassifierMixin):
    """Variational quantum classifier with parity readout.

    Preprocessing mirrors the QSVM arm exactly -- rank-to-Gaussian scaling, PCA
    to the qubit count, then a linear map into [0, pi] -- so the two quantum
    models differ only in what happens after the encoding, which is the point of
    including both.
    """

    def __init__(self, n_qubits=6, reps=3, entanglement="linear", rotation="ry",
                 fmap="zz", fmap_reps=2, alpha=1.0, readout="parity",
                 optimizer="cobyla", maxiter=500, n_restarts=2, random_state=0):
        self.n_qubits = n_qubits
        self.reps = reps
        self.entanglement = entanglement
        self.rotation = rotation
        self.fmap = fmap
        self.fmap_reps = fmap_reps
        self.alpha = alpha
        self.readout = readout
        self.optimizer = optimizer
        self.maxiter = maxiter
        self.n_restarts = n_restarts
        self.random_state = random_state

    # -- preprocessing ------------------------------------------------------ #
    def _fit_prep(self, X):
        self.scaler_ = QuantileTransformer(output_distribution="normal",
                                           n_quantiles=min(1000, len(X)),
                                           random_state=self.random_state).fit(X)
        Z = self.scaler_.transform(X)
        self.nq_ = int(min(self.n_qubits, Z.shape[1]))
        if self.nq_ < Z.shape[1]:
            self.pca_ = PCA(n_components=self.nq_,
                            random_state=self.random_state).fit(Z)
            Z = self.pca_.transform(Z)
        else:
            self.pca_ = None
        self.mm_ = MinMaxScaler((0, np.pi)).fit(Z)
        return np.clip(self.mm_.transform(Z), 0, np.pi)

    def _prep(self, X):
        Z = self.scaler_.transform(X)
        if self.pca_ is not None:
            Z = self.pca_.transform(Z)
        return np.clip(self.mm_.transform(Z), 0, np.pi)

    # -- readout ------------------------------------------------------------ #
    def _observable(self, n):
        """Eigenvalues of the readout observable over computational basis states.

        `parity` is Z on every qubit, the usual VQC readout. `z0` is Z on the
        first qubit alone. The global parity of an n-qubit state concentrates
        exponentially around zero as n grows, so the single-qubit observable is
        offered as the better-conditioned alternative.
        """
        b = _bits(n)
        if self.readout == "z0":
            return 1.0 - 2.0 * b[:, 0].astype(float)
        return 1.0 - 2.0 * (b.sum(axis=1) % 2).astype(float)

    def _proba_from(self, psi, U, obs, w, bias):
        """P(y=1) = sigmoid(w<O> + b).

        The trainable scale is not decoration. The raw expectation spans only a
        narrow band around zero because of that concentration, so without a
        learnable gain the loss is nearly flat in every direction and the
        optimiser cannot make progress. Two extra parameters fix it.
        """
        e = (np.abs(psi @ U.T) ** 2) @ obs             # <O> in [-1, 1]
        return 1.0 / (1.0 + np.exp(-np.clip(w * e + bias, -60, 60)))

    # -- fit ---------------------------------------------------------------- #
    def fit(self, X, y):
        y = np.asarray(y, int)
        self.classes_ = np.unique(y)
        Q = self._fit_prep(np.asarray(X, float))
        n = self.nq_
        psi = encode(Q, self.fmap, self.fmap_reps, self.entanglement, self.alpha)
        obs = self._observable(n)
        P = n_params(n, self.reps, self.rotation)
        rng = np.random.default_rng(self.random_state)

        # class weights keep the loss balanced if a fold is not exactly even
        w = np.where(y == 1, 0.5 / max(y.mean(), 1e-9),
                     0.5 / max(1 - y.mean(), 1e-9))

        def loss(v):
            U = ansatz_unitary(n, self.reps, v[:P], self.entanglement, self.rotation)
            p = np.clip(self._proba_from(psi, U, obs, v[P], v[P + 1]), 1e-9, 1 - 1e-9)
            return float(-np.mean(w * (y * np.log(p) + (1 - y) * np.log(1 - p))))

        best, best_loss = None, np.inf
        for _ in range(max(1, self.n_restarts)):
            v0 = np.r_[rng.uniform(-np.pi, np.pi, P), 4.0, 0.0]
            if self.optimizer == "spsa":
                v, lv = self._spsa(loss, v0, rng)
            else:
                res = minimize(loss, v0, method="COBYLA",
                               options={"maxiter": self.maxiter, "rhobeg": 0.5})
                v, lv = res.x, float(res.fun)
            if lv < best_loss:
                best, best_loss = v, lv
        self.theta_ = best[:P]
        self.w_, self.bias_ = float(best[P]), float(best[P + 1])
        self.loss_ = best_loss
        self.n_params_ = P + 2
        self.U_ = ansatz_unitary(n, self.reps, self.theta_, self.entanglement,
                                 self.rotation)
        self.obs_ = obs
        return self

    def _spsa(self, loss, t0, rng, a=0.2, c=0.1):
        """Simultaneous perturbation stochastic approximation.

        Two loss evaluations per iteration regardless of parameter count, which
        is why it is the standard optimiser once circuits are the cost driver.
        """
        t = t0.copy()
        best, best_l = t.copy(), loss(t)
        for k in range(self.maxiter):
            ak = a / (k + 1 + 50) ** 0.602
            ck = c / (k + 1) ** 0.101
            d = rng.choice([-1.0, 1.0], size=t.shape)
            lp, lm = loss(t + ck * d), loss(t - ck * d)
            t = t - ak * (lp - lm) / (2.0 * ck) * d
            if k % 10 == 0:
                lv = loss(t)
                if lv < best_l:
                    best, best_l = t.copy(), lv
        lv = loss(t)
        if lv < best_l:
            best, best_l = t.copy(), lv
        return best, best_l

    # -- predict ------------------------------------------------------------ #
    def predict_proba(self, X):
        psi = encode(self._prep(np.asarray(X, float)), self.fmap,
                     self.fmap_reps, self.entanglement, self.alpha)
        p = self._proba_from(psi, self.U_, self.obs_, self.w_, self.bias_)
        return np.column_stack([1.0 - p, p])

    def decision_function(self, X):
        return self.predict_proba(X)[:, 1] - 0.5

    def predict(self, X):
        return (self.predict_proba(X)[:, 1] >= 0.5).astype(int)


# --------------------------------------------------------------------------- #
# self-test
# --------------------------------------------------------------------------- #
if __name__ == "__main__":
    rng = np.random.default_rng(0)
    ok = True

    def chk(name, cond, extra=""):
        global ok
        ok &= bool(cond)
        print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"  {extra}" if extra else ""))

    print("\nSIMULATOR CORRECTNESS")
    for n in (2, 3, 4, 5):
        P = n_params(n, 3, "ry")
        U = ansatz_unitary(n, 3, rng.uniform(-np.pi, np.pi, P), "linear", "ry")
        err = np.abs(U @ U.conj().T - np.eye(2 ** n)).max()
        chk(f"ansatz unitary (n={n})", err < 1e-10, f"max|UU*-I| = {err:.2e}")
    for n in (3, 4):
        X = rng.uniform(0, np.pi, (20, n))
        psi = encode(X, "zz", 2, "linear", 1.0)
        nrm = np.abs((np.abs(psi) ** 2).sum(axis=1) - 1).max()
        chk(f"encoded states normalised (n={n})", nrm < 1e-10, f"max|1-<psi|psi>| = {nrm:.2e}")
        P = n_params(n, 2, "ry")
        U = ansatz_unitary(n, 2, rng.uniform(-np.pi, np.pi, P), "linear", "ry")
        out = psi @ U.T
        nrm2 = np.abs((np.abs(out) ** 2).sum(axis=1) - 1).max()
        chk(f"ansatz preserves norm (n={n})", nrm2 < 1e-10, f"max dev = {nrm2:.2e}")

    # RY(pi) on |0> must give |1> exactly
    s = np.zeros((1, 2), complex); s[0, 0] = 1.0
    s = _apply_1q(s, 1, 0, _ry(np.pi))
    chk("RY(pi)|0> = |1>", abs(abs(s[0, 1]) - 1) < 1e-12)
    # CNOT truth table
    for n, c, t in [(2, 0, 1), (3, 0, 2), (3, 1, 0)]:
        perm = _cx_perm(n, c, t)
        good = all(perm[i] == (i ^ (1 << t) if (i >> c) & 1 else i) for i in range(2 ** n))
        chk(f"CNOT permutation (n={n}, c={c}, t={t})", good)

    print("\nLEARNING CHECK — a separable task the model must fit")
    n = 4
    Xp = rng.uniform(0, np.pi, (400, n))
    ysep = (Xp[:, 0] > np.pi / 2).astype(int)
    m = VQC(n_qubits=n, reps=3, fmap="z", alpha=1.0, readout="z0",
            maxiter=1500, n_restarts=2, random_state=0).fit(Xp, ysep)
    acc = (m.predict(Xp) == ysep).mean()
    chk("VQC fits a separable task", acc > 0.95, f"train accuracy {acc:.3f}")

    print("\nLEARNING CHECK — parity, which a linear model cannot represent")
    yp = ((Xp > np.pi / 2).sum(axis=1) % 2).astype(int)
    m2 = VQC(n_qubits=n, reps=4, fmap="zz", alpha=0.5, readout="parity",
             maxiter=2000, n_restarts=3, random_state=0).fit(Xp, yp)
    acc2 = (m2.predict(Xp) == yp).mean()
    from sklearn.linear_model import LogisticRegression
    lin = (LogisticRegression(max_iter=2000).fit(Xp, yp).predict(Xp) == yp).mean()
    chk("VQC beats logistic regression on parity", acc2 > lin,
        f"VQC {acc2:.3f} vs logistic {lin:.3f}")

    print("\nREADOUT CONCENTRATION (why the trainable scale is needed)")
    for ro in ("parity", "z0"):
        q = VQC(n_qubits=6, reps=2, readout=ro, alpha=1.0, maxiter=5,
                n_restarts=1, random_state=0).fit(Xp, ysep)
        e = (np.abs(encode(q._prep(Xp), q.fmap, q.fmap_reps, q.entanglement,
                           q.alpha) @ q.U_.T) ** 2) @ q.obs_
        print(f"    n=6 readout={ro:7s} <O> spread: sd {e.std():.4f} "
              f"range [{e.min():+.4f}, {e.max():+.4f}]")

    print("\nDETERMINISM")
    a = VQC(n_qubits=4, reps=2, maxiter=120, n_restarts=1, random_state=7).fit(Xp, yp)
    b = VQC(n_qubits=4, reps=2, maxiter=120, n_restarts=1, random_state=7).fit(Xp, yp)
    chk("same seed gives identical parameters", np.allclose(a.theta_, b.theta_))
    chk("predict_proba is inductive (subset == full)",
        np.allclose(a.predict_proba(Xp)[::7, 1], a.predict_proba(Xp[::7])[:, 1]))

    print("\n" + "=" * 60)
    print("ALL VQC SELF-TESTS PASSED" if ok else "SOME VQC SELF-TESTS FAILED")
    raise SystemExit(0 if ok else 1)
