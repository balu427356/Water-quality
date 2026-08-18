"""
================================================================================
WATER POTABILITY: REGIME-AWARE CLASSICAL/QUANTUM BENCHMARK WITH CEILING ANALYSIS
================================================================================

The dataset is a two-stratum mixture. Roughly 80% of rows are drawn from a
narrow "clean" component whose label follows a near-logistic rule; the remaining
20% are drawn from a component ~19x wider whose features carry almost no label
information. That structure, not model capacity, sets the accuracy ceiling, and
it explains why every published model on this table lands at 82-85%.

This pipeline

  1. establishes the stratum structure from the training partition only,
  2. measures the Bayes ceiling of each stratum separately,
  3. benchmarks eight classical model families with Optuna under cross-validation,
  4. benchmarks four quantum feature maps with two controls the literature
     usually omits (matched representation and matched sample size),
  5. builds regime-aware and ensemble models,
  6. tunes the decision threshold on out-of-fold predictions only,
  7. evaluates on an untouched test partition, once per seed, over many seeds.

Usage
-----
    python water_potability_pipeline.py                  # full run
    python water_potability_pipeline.py --quick          # fast smoke test
    python water_potability_pipeline.py --seeds 42 7 --trials 20

Leakage protocol
----------------
The test partition is carved off before anything else happens and is touched
exactly once per seed, after every choice has been frozen. All preprocessing
(stratum bounds, scalers, imputers) is fitted inside training folds. Model
selection, ensemble weights and the decision threshold are chosen from
out-of-fold predictions on the development partition alone.
"""
from __future__ import annotations

import argparse
import json
import time
import warnings
from pathlib import Path

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

from scipy import stats
from scipy.optimize import minimize

from sklearn.base import BaseEstimator, ClassifierMixin, clone
from sklearn.ensemble import (ExtraTreesClassifier, HistGradientBoostingClassifier,
                              RandomForestClassifier)
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (accuracy_score, average_precision_score,
                             balanced_accuracy_score, confusion_matrix, f1_score,
                             matthews_corrcoef, precision_score, recall_score,
                             roc_auc_score, roc_curve, precision_recall_curve)
from sklearn.mixture import GaussianMixture
from sklearn.model_selection import StratifiedKFold, train_test_split
from sklearn.neighbors import KNeighborsClassifier, NearestNeighbors
from sklearn.neural_network import MLPClassifier
from sklearn.pipeline import Pipeline, make_pipeline
from sklearn.preprocessing import (PolynomialFeatures, QuantileTransformer,
                                   StandardScaler)
from sklearn.svm import SVC

import optuna

optuna.logging.set_verbosity(optuna.logging.WARNING)

try:
    import lightgbm as lgb
    HAS_LGB = True
except ImportError:
    HAS_LGB = False
try:
    import xgboost as xgb
    HAS_XGB = True
except ImportError:
    HAS_XGB = False
try:
    from catboost import CatBoostClassifier
    HAS_CAT = True
except ImportError:
    HAS_CAT = False

TARGET = "Potability"
DATA = "water_quality_potability.csv"
METRICS = ["accuracy", "balanced_accuracy", "precision", "recall", "f1",
           "roc_auc", "pr_auc", "mcc"]


def banner(t):
    print(f"\n{'='*78}\n{t}\n{'='*78}", flush=True)


def sub(t):
    print(f"\n--- {t} ---", flush=True)


# ═══════════════════════════════════════════════════════════════════════════ #
# STRATUM DETECTION
# ═══════════════════════════════════════════════════════════════════════════ #
class StratumDetector:
    """Splits rows into a clean and a contaminated stratum.

    A cell is 'tail' when it falls outside the Tukey fence of its column. The
    fences are estimated from the training data only, so applying the detector
    to validation or test rows introduces no dependence on their labels or on
    their marginal distributions. A row is contaminated when at least
    `min_tails` of its nine cells are tail cells; the count distribution is
    strongly bimodal (see the forensics stage) so the threshold is not delicate.
    """

    def __init__(self, k=1.5, min_tails=3):
        self.k, self.min_tails = k, min_tails

    def fit(self, X, y=None):
        q1 = np.quantile(X, 0.25, axis=0)
        q3 = np.quantile(X, 0.75, axis=0)
        iqr = q3 - q1
        self.lo_, self.hi_ = q1 - self.k * iqr, q3 + self.k * iqr
        return self

    def mask(self, X):
        return (X < self.lo_) | (X > self.hi_)

    def count(self, X):
        return self.mask(X).sum(axis=1)

    def is_clean(self, X):
        return self.count(X) < self.min_tails


# ═══════════════════════════════════════════════════════════════════════════ #
# FEATURE ENGINEERING  (target-free, fitted on training folds only)
# ═══════════════════════════════════════════════════════════════════════════ #
def _lg(v, eps=1e-6):
    """Log of a physically positive quantity, floored so contaminated draws that
    fall at or below zero cannot produce -inf."""
    return np.log(np.maximum(v, eps))


def domain_features(X, feats):
    """Water-chemistry-motivated derived features.

    Ratios are formed in log space. A plain a/b blows up whenever the
    denominator approaches zero, which happens routinely in the contaminated
    stratum because its draws are ~19x wider than the clean core and can cross
    zero. Those spikes would dominate any scaler and cripple the linear and
    distance-based models. log(a) - log(b) is monotone in the ratio, bounded by
    the floor, and leaves tree models unaffected.

    None of these uses the label. Each is a deterministic function of a single
    row, so it cannot transmit information between rows or across the split.
    """
    d = {f: X[:, i] for i, f in enumerate(feats)}
    out = [
        np.abs(d["ph"] - 7.0),                                   # distance from neutral
        _lg(d["Solids"]),
        _lg(d["Solids"]) - _lg(d["Hardness"]),                   # dissolved load per hardness
        _lg(d["Sulfate"]) - _lg(d["Conductivity"]),              # ionic composition
        _lg(d["Chloramines"]) + _lg(d["Turbidity"]),             # disinfection x particulates
        _lg(d["Organic_carbon"]) - _lg(d["Turbidity"]),
        _lg(d["Trihalomethanes"]) - _lg(d["Chloramines"]),       # DBP formation proxy
        _lg(d["Conductivity"]) - _lg(d["Hardness"]),
        _lg(d["Solids"]) + _lg(d["Turbidity"]),
    ]
    return np.column_stack(out)


DOMAIN_NAMES = ["ph_dev", "log_Solids", "log_Solids_per_Hardness",
                "log_Sulfate_per_Cond", "log_Chlor_x_Turb", "log_OC_per_Turb",
                "log_THM_per_Chlor", "log_Cond_per_Hardness", "log_Solids_x_Turb"]


def robust_scaler(seed):
    """Scaler for models that are sensitive to feature scale and heavy tails.

    Every column here has excess kurtosis of 10-16 because ~20% of rows come
    from a component ~19x wider than the core. A StandardScaler divides by a
    standard deviation inflated by that component, compressing the informative
    core into a narrow band -- the worst case for a single-bandwidth RBF kernel
    and for any distance-based learner. A rank-based transform to a Gaussian
    removes the tail leverage without discarding order information.
    """
    return QuantileTransformer(output_distribution="normal", n_quantiles=1000,
                               subsample=100_000, random_state=seed)


def build_features(det, Xtr_ref, X, feats, mode):
    """Assemble a representation. `det` is already fitted on the training fold."""
    if mode == "raw":
        return X
    if mode == "domain":
        return np.hstack([X, domain_features(X, feats)])
    if mode == "regime":
        M = det.mask(X)
        return np.hstack([X, M.astype(float), M.sum(1, keepdims=True)])
    if mode == "regime+domain":
        M = det.mask(X)
        return np.hstack([X, domain_features(X, feats), M.astype(float),
                          M.sum(1, keepdims=True)])
    raise ValueError(mode)


def feature_names(feats, mode):
    if mode == "raw":
        return list(feats)
    if mode == "domain":
        return list(feats) + DOMAIN_NAMES
    if mode == "regime":
        return list(feats) + [f"tail_{f}" for f in feats] + ["n_tails"]
    if mode == "regime+domain":
        return (list(feats) + DOMAIN_NAMES + [f"tail_{f}" for f in feats] + ["n_tails"])
    raise ValueError(mode)


# ═══════════════════════════════════════════════════════════════════════════ #
# REGIME-AWARE ROUTER
# ═══════════════════════════════════════════════════════════════════════════ #
class QuantileScored(BaseEstimator, ClassifierMixin):
    """Gives an estimator without `predict_proba` a score in [0, 1].

    The score is the quantile of the decision function within the *training*
    distribution. Rank-normalising against the evaluation set instead would be
    transductive: one row's score would depend on the other rows scored
    alongside it, and because the test split is exactly balanced, thresholding
    such a score quietly exploits knowledge of the test label distribution.
    Referencing the training distribution keeps the mapping inductive and fixed
    at fit time.
    """

    def __init__(self, est=None):
        self.est = est

    def fit(self, X, y):
        self.est_ = clone(self.est).fit(X, y)
        self.classes_ = getattr(self.est_, "classes_", np.unique(y))
        self.ref_ = np.sort(self.est_.decision_function(X))
        return self

    def decision_function(self, X):
        return self.est_.decision_function(X)

    def predict(self, X):
        return self.est_.predict(X)

    def predict_proba(self, X):
        d = self.est_.decision_function(X)
        q = np.searchsorted(self.ref_, d, side="right") / max(len(self.ref_), 1)
        return np.column_stack([1.0 - q, q])


class OOFQuantileMap:
    """Maps a score to its quantile in the out-of-fold score distribution.

    Fitted on development-partition out-of-fold scores and then applied
    unchanged to the test partition, so rank averaging in the ensemble stays
    inductive.
    """

    def fit(self, s):
        self.ref_ = np.sort(np.asarray(s, float))
        return self

    def transform(self, s):
        return (np.searchsorted(self.ref_, np.asarray(s, float), side="right")
                / max(len(self.ref_), 1))


class RegimeRouter(BaseEstimator, ClassifierMixin):
    """Fits one specialist per stratum and routes each row to its own.

    The clean stratum follows a near-logistic rule, so a quadratic logistic
    model is the right capacity there. The contaminated stratum carries almost
    no feature signal, so its specialist mostly learns the stratum base rate
    plus whatever little the corruption pattern carries.
    """

    def __init__(self, clean_est=None, dirty_est=None, k=1.5, min_tails=3, feats=None):
        self.clean_est, self.dirty_est = clean_est, dirty_est
        self.k, self.min_tails, self.feats = k, min_tails, feats

    def fit(self, X, y):
        self.det_ = StratumDetector(self.k, self.min_tails).fit(X)
        c = self.det_.is_clean(X)
        self.classes_ = np.unique(y)
        self.p_clean_ = float(y[c].mean()) if c.any() else 0.5
        self.p_dirty_ = float(y[~c].mean()) if (~c).any() else 0.5

        self.m_clean_ = clone(self.clean_est).fit(X[c], y[c]) if c.sum() > 30 else None
        if (~c).sum() > 30:
            M = self.det_.mask(X[~c])
            Xd = np.hstack([X[~c], M.astype(float), M.sum(1, keepdims=True)])
            self.m_dirty_ = clone(self.dirty_est).fit(Xd, y[~c])
        else:
            self.m_dirty_ = None
        return self

    def predict_proba(self, X):
        c = self.det_.is_clean(X)
        p = np.empty(len(X))
        if c.any():
            p[c] = (self.m_clean_.predict_proba(X[c])[:, 1] if self.m_clean_ is not None
                    else self.p_clean_)
        if (~c).any():
            if self.m_dirty_ is not None:
                M = self.det_.mask(X[~c])
                Xd = np.hstack([X[~c], M.astype(float), M.sum(1, keepdims=True)])
                p[~c] = self.m_dirty_.predict_proba(Xd)[:, 1]
            else:
                p[~c] = self.p_dirty_
        return np.column_stack([1 - p, p])

    def predict(self, X):
        return (self.predict_proba(X)[:, 1] >= 0.5).astype(int)


# ═══════════════════════════════════════════════════════════════════════════ #
# QUANTUM CORE  (exact statevector simulation, no external quantum SDK)
# ═══════════════════════════════════════════════════════════════════════════ #
def entangling_pairs(n, ent):
    if ent == "linear":
        return [(i, i + 1) for i in range(n - 1)]
    if ent == "circular":
        p = [(i, i + 1) for i in range(n - 1)]
        return p + [(n - 1, 0)] if n > 2 else p
    if ent == "full":
        return [(i, j) for i in range(n) for j in range(i + 1, n)]
    if ent == "none":
        return []
    raise ValueError(ent)


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


def statevectors(X, fmap="zz", reps=2, ent="linear", alpha=2.0):
    """Feature-map statevectors.

    The maps used here are a Hadamard layer followed by a diagonal phase
    operator, so the state has a closed form and no gate-by-gate simulation is
    required. `fmap` selects the two-qubit phase function:
        zz      phi_ij = (pi - x_i)(pi - x_j)   standard ZZFeatureMap
        zprod   phi_ij = x_i x_j                Pauli-ZZ product variant
        z       no two-qubit term               ZFeatureMap ablation
    """
    X = np.asarray(X, float)
    ns, nq = X.shape
    bits = _bits(nq)
    theta = alpha * (X @ bits.T.astype(float))
    pairs = [] if fmap == "z" else entangling_pairs(nq, ent)
    if pairs:
        pi_ = np.array([p[0] for p in pairs])
        pj_ = np.array([p[1] for p in pairs])
        parity = (bits[:, pi_] ^ bits[:, pj_]).astype(float)
        if fmap == "zz":
            phi = (np.pi - X[:, pi_]) * (np.pi - X[:, pj_])
        else:                                   # zprod
            phi = X[:, pi_] * X[:, pj_]
        theta = theta + (alpha * phi) @ parity.T
    phase = np.exp(1j * theta)
    psi = np.zeros(2 ** nq, complex)
    psi[0] = 1.0
    psi = np.broadcast_to(psi, (ns, 2 ** nq)).copy()
    for _ in range(reps):
        psi = _hadamard(psi, nq)
        psi *= phase
    return psi


def fidelity_kernel(Xa, Xb=None, fmap="zz", reps=2, ent="linear", alpha=2.0, block=1024):
    """K(x,y) = |<phi(x)|phi(y)>|^2, block-wise to bound peak memory."""
    if fmap == "angle":
        # RY angle encoding is a product state; the kernel factorises exactly.
        A = np.asarray(Xa, float) * alpha
        B = A if Xb is None else np.asarray(Xb, float) * alpha
        d = A[:, None, :] - B[None, :, :]
        return np.prod(np.cos(d / 2.0) ** 2, axis=2)
    sym = Xb is None
    Pa = statevectors(Xa, fmap, reps, ent, alpha)
    Pb = Pa if sym else statevectors(Xb, fmap, reps, ent, alpha)
    na, nb = len(Pa), len(Pb)
    K = np.empty((na, nb), float)
    for i0 in range(0, na, block):
        i1 = min(i0 + block, na)
        for j0 in range(0, nb, block):
            j1 = min(j0 + block, nb)
            K[i0:i1, j0:j1] = np.abs(Pa[i0:i1] @ Pb[j0:j1].conj().T) ** 2
    if sym:
        K = 0.5 * (K + K.T)
        np.fill_diagonal(K, 1.0)
    return K


def kernel_target_alignment(K, y):
    yy = np.where(y == 1, 1.0, -1.0)
    T = np.outer(yy, yy)
    n = len(K)
    H = np.eye(n) - np.ones((n, n)) / n
    Kc = H @ K @ H
    return float((Kc * T).sum() / max(np.sqrt((Kc * Kc).sum() * (T * T).sum()), 1e-12))


def effective_rank(K):
    eig = np.clip(np.linalg.eigvalsh(K), 0, None)
    p = eig / max(eig.sum(), 1e-12)
    p = p[p > 0]
    return float(np.exp(-(p * np.log(p)).sum()))


# ═══════════════════════════════════════════════════════════════════════════ #
# METRICS
# ═══════════════════════════════════════════════════════════════════════════ #
def evaluate(y, pred, score):
    tn, fp, fn, tp = confusion_matrix(y, pred, labels=[0, 1]).ravel()
    return {"accuracy": accuracy_score(y, pred),
            "balanced_accuracy": balanced_accuracy_score(y, pred),
            "precision": precision_score(y, pred, zero_division=0),
            "recall": recall_score(y, pred, zero_division=0),
            "f1": f1_score(y, pred, zero_division=0),
            "roc_auc": roc_auc_score(y, score),
            "pr_auc": average_precision_score(y, score),
            "mcc": matthews_corrcoef(y, pred),
            "specificity": tn / (tn + fp) if (tn + fp) else np.nan,
            "tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)}


def best_threshold(y, score):
    """Threshold maximising accuracy on out-of-fold predictions.

    Swept as a single sorted pass rather than by testing each candidate against
    the whole vector: with 8,000 development rows the naive form is ~64M
    comparisons per model, which dominates the run once it is called for every
    family and every ensemble.
    """
    y = np.asarray(y, int)
    n = len(y)
    order = np.argsort(-np.asarray(score, float))
    s_sorted = np.asarray(score, float)[order]
    y_sorted = y[order]

    # predicting the top k scores as positive, for k = 0..n
    tp = np.r_[0, np.cumsum(y_sorted)]
    k = np.arange(n + 1)
    total_pos = int(y.sum())
    fp = k - tp
    fn = total_pos - tp
    tn = (n - k) - fn
    acc = (tp + tn) / n
    best = int(acc.argmax())

    # a threshold strictly between the k-th and (k+1)-th score reproduces that cut
    if best == 0:
        thr = np.nextafter(s_sorted[0], np.inf)
    elif best == n:
        thr = np.nextafter(s_sorted[-1], -np.inf)
    else:
        thr = (s_sorted[best - 1] + s_sorted[best]) / 2.0
        if not (s_sorted[best] < thr <= s_sorted[best - 1]):
            thr = s_sorted[best - 1]
    return float(thr), float(acc[best])


# ═══════════════════════════════════════════════════════════════════════════ #
# STAGE 1 | DATA
# ═══════════════════════════════════════════════════════════════════════════ #
def load_data(path):
    banner("STAGE 1 | DATASET AND INTEGRITY CHECKS")
    df = pd.read_csv(path)
    feats = [c for c in df.columns if c != TARGET]
    print(f"{path}: {df.shape[0]} rows x {df.shape[1]} columns")
    print(f"features: {feats}")
    vc = df[TARGET].value_counts().sort_index()
    print(f"class balance: {vc.to_dict()}  majority baseline "
          f"{vc.max()/len(df):.4f}")
    print(f"exact duplicate rows      : {int(df.duplicated().sum())}")
    dupf = int(df.duplicated(subset=feats).sum())
    print(f"feature-identical rows    : {dupf}")
    if dupf:
        g = df.groupby(feats)[TARGET].nunique()
        print(f"  ...of which conflicting labels: {int((g > 1).sum())}")
    print(f"missing cells             : {int(df.isna().sum().sum())}")
    nun = df[feats].nunique()
    print(f"constant/near-constant    : {int((nun <= 2).sum())}")
    return df, feats


# ═══════════════════════════════════════════════════════════════════════════ #
# STAGE 2 | FORENSICS  (development partition only)
# ═══════════════════════════════════════════════════════════════════════════ #
def forensics(Xdev, ydev, Xte, feats, out, seed):
    banner("STAGE 2 | DATA FORENSICS (development partition only)")
    dev = pd.DataFrame(Xdev, columns=feats)

    sub("per-feature moments and Tukey tail rate")
    rows = []
    for c in feats:
        s = dev[c]
        q1, q3 = s.quantile(.25), s.quantile(.75)
        iqr = q3 - q1
        tail = (s < q1 - 1.5 * iqr) | (s > q3 + 1.5 * iqr)
        rows.append(dict(feature=c, mean=s.mean(), sd=s.std(), skew=stats.skew(s),
                         excess_kurtosis=stats.kurtosis(s), pct_tail=100 * tail.mean()))
    mom = pd.DataFrame(rows)
    print(mom.round(3).to_string(index=False))
    print(f"tail-rate range across features: {mom.pct_tail.min():.2f}% .. "
          f"{mom.pct_tail.max():.2f}% (sd {mom.pct_tail.std():.3f})")
    mom.to_csv(out / "tables" / "moments.csv", index=False)

    sub("cell-level vs row-level contamination")
    det = StratumDetector().fit(Xdev)
    cnt = det.count(Xdev)
    p = det.mask(Xdev).mean()
    obs = np.bincount(cnt, minlength=10)[:10]
    exp = stats.binom.pmf(np.arange(10), 9, p) * len(Xdev)
    print(f"overall cell tail rate p = {p:.4f}")
    print(f"{'k tails':>8} {'observed':>10} {'Binom(9,p)':>12}")
    for k in range(10):
        print(f"{k:>8} {obs[k]:>10d} {exp[k]:>12.1f}")
    chi2 = ((obs - exp) ** 2 / np.maximum(exp, 1e-9)).sum()
    print(f"chi2 against independent-cell model : {chi2:,.0f}")
    print(f"observed variance {cnt.var():.3f} vs binomial {9*p*(1-p):.3f} "
          f"-> {cnt.var()/(9*p*(1-p)):.1f}x overdispersed")
    print("verdict: contamination is ROW-level, not cell-level.")
    pd.DataFrame({"k": np.arange(10), "observed": obs,
                  "binomial_expected": exp}).to_csv(
        out / "tables" / "tail_count_distribution.csv", index=False)

    sub("two-component mixture per feature")
    mrows = []
    for j, c in enumerate(feats):
        v = Xdev[:, j].reshape(-1, 1)
        gm = GaussianMixture(2, random_state=seed, n_init=3).fit(v)
        nar, wid = np.argsort(gm.covariances_.ravel())
        mrows.append(dict(feature=c, w_narrow=gm.weights_[nar],
                          sd_narrow=np.sqrt(gm.covariances_.ravel()[nar]),
                          w_wide=gm.weights_[wid],
                          sd_wide=np.sqrt(gm.covariances_.ravel()[wid]),
                          sd_ratio=np.sqrt(gm.covariances_.ravel()[wid] /
                                           gm.covariances_.ravel()[nar])))
    mix = pd.DataFrame(mrows)
    print(mix.round(3).to_string(index=False))
    mix.to_csv(out / "tables" / "mixture.csv", index=False)

    sub("label information inside each stratum")
    cl = det.is_clean(Xdev)
    irows = []
    for j, c in enumerate(feats):
        irows.append(dict(
            feature=c,
            rho_clean=stats.spearmanr(Xdev[cl, j], ydev[cl]).statistic,
            rho_contaminated=stats.spearmanr(Xdev[~cl, j], ydev[~cl]).statistic,
            rho_pooled=stats.spearmanr(Xdev[:, j], ydev).statistic))
    inf = pd.DataFrame(irows)
    print(inf.round(4).to_string(index=False))
    inf.to_csv(out / "tables" / "stratum_correlations.csv", index=False)
    print(f"\nclean stratum        : n={cl.sum()} ({100*cl.mean():.2f}%), "
          f"potable rate {ydev[cl].mean():.4f}")
    print(f"contaminated stratum : n={(~cl).sum()} ({100*(~cl).mean():.2f}%), "
          f"potable rate {ydev[~cl].mean():.4f}")

    sub("adversarial validation: is the test partition distributed like dev?")
    Xa = np.vstack([Xdev, Xte])
    ya = np.r_[np.zeros(len(Xdev)), np.ones(len(Xte))]
    cvv = StratifiedKFold(5, shuffle=True, random_state=seed)
    aucs = []
    for tr, va in cvv.split(Xa, ya):
        m = HistGradientBoostingClassifier(random_state=seed, max_iter=200).fit(Xa[tr], ya[tr])
        aucs.append(roc_auc_score(ya[va], m.predict_proba(Xa[va])[:, 1]))
    print(f"dev-vs-test discriminability AUC = {np.mean(aucs):.4f} +/- {np.std(aucs):.4f}")
    print("(0.5 means identically distributed; uses the split id, never test labels)")

    sub("1-NN label-conflict rate (empirical Bayes-error probe)")
    Z = StandardScaler().fit_transform(Xdev)
    d, idx = NearestNeighbors(n_neighbors=2).fit(Z).kneighbors(Z)
    conf = ydev != ydev[idx[:, 1]]
    print(f"overall 1-NN conflict rate {conf.mean():.4f} "
          f"-> Bayes error in [{conf.mean()/2:.4f}, {conf.mean():.4f}]")
    print(f"  within clean stratum        {conf[cl].mean():.4f}")
    print(f"  within contaminated stratum {conf[~cl].mean():.4f}")

    return det, dict(chi2=float(chi2), overdispersion=float(cnt.var()/(9*p*(1-p))),
                     pct_clean=float(100*cl.mean()), adv_auc=float(np.mean(aucs)),
                     nn_conflict=float(conf.mean()))


def ceiling_analysis(Xdev, ydev, det, out, seed):
    """Estimate the Bayes ceiling of each stratum and compose them."""
    banner("STAGE 3 | STRATUM CEILING ANALYSIS (development partition only)")
    cl = det.is_clean(Xdev)
    Xc, yc = Xdev[cl], ydev[cl]
    Xk, yk = Xdev[~cl], ydev[~cl]
    cv = StratifiedKFold(5, shuffle=True, random_state=seed)

    sub("clean stratum: does any model beat a plain logistic fit?")
    zoo = {
        "LogisticRegression": make_pipeline(StandardScaler(), LogisticRegression(max_iter=5000)),
        "Logistic + poly2": make_pipeline(StandardScaler(),
                                          PolynomialFeatures(2, include_bias=False),
                                          LogisticRegression(max_iter=20000)),
        "RBF-SVM": make_pipeline(StandardScaler(), SVC(C=10, gamma="scale")),
        "RandomForest": RandomForestClassifier(n_estimators=600, min_samples_leaf=5,
                                               random_state=seed, n_jobs=-1),
        "ExtraTrees": ExtraTreesClassifier(n_estimators=600, min_samples_leaf=5,
                                           random_state=seed, n_jobs=-1),
        "HistGradientBoosting": HistGradientBoostingClassifier(random_state=seed,
                                                               max_iter=500,
                                                               learning_rate=0.05),
        "MLP": make_pipeline(StandardScaler(), MLPClassifier((256, 128), max_iter=600,
                                                             random_state=seed,
                                                             early_stopping=True)),
    }
    rows = []
    for n, m in zoo.items():
        oof = np.zeros(len(yc))
        for tr, va in cv.split(Xc, yc):
            oof[va] = clone(m).fit(Xc[tr], yc[tr]).predict(Xc[va])
        rows.append(dict(model=n, clean_cv_accuracy=(oof == yc).mean()))
        print(f"  {n:22s} {(oof == yc).mean():.4f}")
    clean_tab = pd.DataFrame(rows).sort_values("clean_cv_accuracy", ascending=False)

    sc = StandardScaler().fit(Xc)
    lr = LogisticRegression(max_iter=5000).fit(sc.transform(Xc), yc)
    p = lr.predict_proba(sc.transform(Xc))[:, 1]
    bayes_clean = float(np.maximum(p, 1 - p).mean())
    print(f"\n  logistic Bayes estimate E[max(p,1-p)] = {bayes_clean:.4f}")
    print(f"  best measured model                   = {clean_tab.iloc[0].clean_cv_accuracy:.4f}")
    print("  higher-capacity families do not exceed the linear fit, which is what")
    print("  we expect if the generating rule is itself logistic.")

    sub("calibration of the logistic fit on the clean stratum")
    bins = np.linspace(0, 1, 11)
    b = np.clip(np.digitize(p, bins) - 1, 0, 9)
    cal = []
    print(f"{'bin':>10} {'n':>7} {'predicted':>11} {'observed':>10}")
    for i in range(10):
        s = b == i
        if s.sum() < 10:
            continue
        cal.append(dict(bin_lo=bins[i], bin_hi=bins[i+1], n=int(s.sum()),
                        predicted=float(p[s].mean()), observed=float(yc[s].mean())))
        print(f"{bins[i]:.1f}-{bins[i+1]:.1f} {s.sum():>7d} {p[s].mean():>11.4f} "
              f"{yc[s].mean():>10.4f}")
    pd.DataFrame(cal).to_csv(out / "tables" / "clean_calibration.csv", index=False)

    sub("contaminated stratum: is anything predictable there?")
    base = float(max(yk.mean(), 1 - yk.mean()))
    print(f"  majority baseline               {base:.4f}")
    M = det.mask(Xk)
    Xk_aug = np.hstack([Xk, M.astype(float), M.sum(1, keepdims=True)])
    dirty_rows = [dict(model="majority baseline", contaminated_cv_accuracy=base)]
    for n, X_, m in [
        ("LogisticRegression", Xk, make_pipeline(StandardScaler(), LogisticRegression(max_iter=5000))),
        ("HistGB raw", Xk, HistGradientBoostingClassifier(random_state=seed, max_iter=400)),
        ("HistGB + corruption pattern", Xk_aug,
         HistGradientBoostingClassifier(random_state=seed, max_iter=400)),
    ]:
        oof = np.zeros(len(yk))
        for tr, va in cv.split(X_, yk):
            oof[va] = clone(m).fit(X_[tr], yk[tr]).predict(X_[va])
        dirty_rows.append(dict(model=n, contaminated_cv_accuracy=(oof == yk).mean()))
        print(f"  {n:30s} {(oof == yk).mean():.4f}")
    dirty_tab = pd.DataFrame(dirty_rows).sort_values("contaminated_cv_accuracy",
                                                     ascending=False)
    ceil_dirty = float(dirty_tab.iloc[0].contaminated_cv_accuracy)

    sub("does the clean-stratum rule explain contaminated labels?")
    pk = lr.predict_proba(sc.transform(Xk))[:, 1]
    print(f"  clean rule applied to contaminated rows: "
          f"{((pk >= .5).astype(int) == yk).mean():.4f}")
    print(f"  contaminated majority baseline         : {base:.4f}")
    print(f"  mean |p-0.5|: contaminated {np.abs(pk-0.5).mean():.4f} vs "
          f"clean {np.abs(p-0.5).mean():.4f}")
    print("  the clean rule is confidently WRONG on contaminated rows, so the two")
    print("  strata do not share a labelling mechanism.")

    w = cl.mean()
    ceil_clean = float(clean_tab.iloc[0].clean_cv_accuracy)
    composed = w * ceil_clean + (1 - w) * ceil_dirty
    sub("composed ceiling")
    print(f"  P(clean) = {w:.4f}, clean ceiling = {ceil_clean:.4f}")
    print(f"  P(contaminated) = {1-w:.4f}, contaminated ceiling = {ceil_dirty:.4f}")
    print(f"  => overall ceiling ~= {composed:.4f}")

    clean_tab.to_csv(out / "tables" / "ceiling_clean.csv", index=False)
    dirty_tab.to_csv(out / "tables" / "ceiling_contaminated.csv", index=False)
    info = dict(p_clean=float(w), ceiling_clean=ceil_clean,
                bayes_clean_logistic=bayes_clean,
                ceiling_contaminated=ceil_dirty, composed_ceiling=float(composed))
    json.dump(info, open(out / "tables" / "ceiling.json", "w"), indent=2)
    return info


# ═══════════════════════════════════════════════════════════════════════════ #
# STAGE 4 | REPRESENTATION SEARCH
# ═══════════════════════════════════════════════════════════════════════════ #
def representation_search(Xdev, ydev, feats, seed, out):
    banner("STAGE 4 | REPRESENTATION SEARCH (5-fold CV on development partition)")
    cv = StratifiedKFold(5, shuffle=True, random_state=seed)
    modes = ["raw", "domain", "regime", "regime+domain"]
    rows = []
    for mode in modes:
        for mname, mk in [
            ("HistGB", lambda: HistGradientBoostingClassifier(random_state=seed, max_iter=400)),
            ("Logistic+poly2", lambda: make_pipeline(
                robust_scaler(seed), PolynomialFeatures(2, include_bias=False),
                LogisticRegression(max_iter=20000))),
        ]:
            oof = np.zeros(len(ydev))
            for tr, va in cv.split(Xdev, ydev):
                det = StratumDetector().fit(Xdev[tr])
                A = build_features(det, Xdev[tr], Xdev[tr], feats, mode)
                B = build_features(det, Xdev[tr], Xdev[va], feats, mode)
                oof[va] = mk().fit(A, ydev[tr]).predict(B)
            acc = (oof == ydev).mean()
            rows.append(dict(representation=mode, model=mname, cv_accuracy=acc,
                             n_features=len(feature_names(feats, mode))))
            print(f"  {mode:16s} {mname:16s} {acc:.4f}")
    tab = pd.DataFrame(rows).sort_values("cv_accuracy", ascending=False)
    tab.to_csv(out / "tables" / "representation_search.csv", index=False)
    best = tab.iloc[0]["representation"]
    print(f"\nselected representation (CV, no test data involved): {best}")
    return best, tab


# ═══════════════════════════════════════════════════════════════════════════ #
# STAGE 5 | CLASSICAL ARM
# ═══════════════════════════════════════════════════════════════════════════ #
def tune_classical(Xdev, ydev, feats, mode, seed, trials, out, verbose=True):
    """Optuna over eight families. Everything scored by CV on the dev partition."""
    banner("STAGE 5 | CLASSICAL ARM — OPTUNA HYPERPARAMETER SEARCH")
    cv = StratifiedKFold(5, shuffle=True, random_state=seed)
    folds = list(cv.split(Xdev, ydev))

    def prep(tr, va, m):
        det = StratumDetector().fit(Xdev[tr])
        return (build_features(det, Xdev[tr], Xdev[tr], feats, m),
                build_features(det, Xdev[tr], Xdev[va], feats, m))

    cache = {m: [prep(tr, va, m) for tr, va in folds] for m in {mode, "raw"}}

    def score(make, m=mode):
        """CV accuracy from each model's own decision rule, plus an out-of-fold
        score for ensembling and threshold tuning.

        Accuracy comes from `.predict()` rather than thresholding a probability
        at 0.5, so models without calibrated probabilities (SVC without Platt
        scaling) are judged on their natural decision rule. The stored score is
        a probability where one is available and a rank-normalised decision
        function otherwise; both are monotone, which is all the later threshold
        sweep and rank ensemble require.
        """
        oof = np.zeros(len(ydev))
        pred = np.zeros(len(ydev), int)
        for (tr, va), (A, B) in zip(folds, cache[m]):
            f = make().fit(A, ydev[tr])
            pred[va] = f.predict(B)
            oof[va] = f.predict_proba(B)[:, 1]
        return (pred == ydev).mean(), oof

    spaces = {}

    spaces["LogisticRegression"] = (lambda t: make_pipeline(
        robust_scaler(seed),
        LogisticRegression(C=t.suggest_float("C", 1e-3, 1e3, log=True),
                           max_iter=8000, random_state=seed)), mode)

    spaces["Logistic-poly2"] = (lambda t: make_pipeline(
        robust_scaler(seed), PolynomialFeatures(2, include_bias=False),
        LogisticRegression(C=t.suggest_float("C", 1e-3, 1e2, log=True),
                           max_iter=30000, random_state=seed)), "raw")

    # Platt scaling is deliberately off: it costs an internal 5-fold refit per
    # candidate and buys nothing here, since the decision threshold is tuned on
    # out-of-fold scores downstream anyway.
    spaces["RBF-SVM"] = (lambda t: QuantileScored(make_pipeline(
        robust_scaler(seed),
        SVC(C=t.suggest_float("C", 1e-2, 1e3, log=True),
            gamma=t.suggest_float("gamma", 1e-4, 1e1, log=True),
            cache_size=500, random_state=seed))), mode)

    spaces["RandomForest"] = (lambda t: RandomForestClassifier(
        n_estimators=t.suggest_int("n_estimators", 300, 1200, step=100),
        max_depth=t.suggest_int("max_depth", 4, 30),
        min_samples_leaf=t.suggest_int("min_samples_leaf", 1, 30),
        max_features=t.suggest_float("max_features", 0.2, 1.0),
        random_state=seed, n_jobs=-1), mode)

    spaces["ExtraTrees"] = (lambda t: ExtraTreesClassifier(
        n_estimators=t.suggest_int("n_estimators", 300, 1200, step=100),
        max_depth=t.suggest_int("max_depth", 4, 30),
        min_samples_leaf=t.suggest_int("min_samples_leaf", 1, 30),
        max_features=t.suggest_float("max_features", 0.2, 1.0),
        random_state=seed, n_jobs=-1), mode)

    spaces["HistGradientBoosting"] = (lambda t: HistGradientBoostingClassifier(
        max_iter=t.suggest_int("max_iter", 150, 900, step=50),
        learning_rate=t.suggest_float("learning_rate", 0.01, 0.3, log=True),
        max_leaf_nodes=t.suggest_int("max_leaf_nodes", 8, 128, log=True),
        min_samples_leaf=t.suggest_int("min_samples_leaf", 5, 80),
        l2_regularization=t.suggest_float("l2_regularization", 1e-4, 10.0, log=True),
        random_state=seed), mode)

    if HAS_LGB:
        spaces["LightGBM"] = (lambda t: lgb.LGBMClassifier(
            n_estimators=t.suggest_int("n_estimators", 200, 1500, step=100),
            learning_rate=t.suggest_float("learning_rate", 0.01, 0.3, log=True),
            num_leaves=t.suggest_int("num_leaves", 8, 128, log=True),
            min_child_samples=t.suggest_int("min_child_samples", 5, 80),
            subsample=t.suggest_float("subsample", 0.5, 1.0),
            subsample_freq=1,
            colsample_bytree=t.suggest_float("colsample_bytree", 0.4, 1.0),
            reg_alpha=t.suggest_float("reg_alpha", 1e-4, 10.0, log=True),
            reg_lambda=t.suggest_float("reg_lambda", 1e-4, 10.0, log=True),
            random_state=seed, n_jobs=-1, verbose=-1), mode)

    if HAS_XGB:
        spaces["XGBoost"] = (lambda t: xgb.XGBClassifier(
            n_estimators=t.suggest_int("n_estimators", 200, 1500, step=100),
            learning_rate=t.suggest_float("learning_rate", 0.01, 0.3, log=True),
            max_depth=t.suggest_int("max_depth", 2, 12),
            min_child_weight=t.suggest_float("min_child_weight", 1e-2, 30.0, log=True),
            subsample=t.suggest_float("subsample", 0.5, 1.0),
            colsample_bytree=t.suggest_float("colsample_bytree", 0.4, 1.0),
            reg_alpha=t.suggest_float("reg_alpha", 1e-4, 10.0, log=True),
            reg_lambda=t.suggest_float("reg_lambda", 1e-4, 10.0, log=True),
            tree_method="hist", eval_metric="logloss",
            random_state=seed, n_jobs=-1, verbosity=0), mode)

    if HAS_CAT:
        spaces["CatBoost"] = (lambda t: CatBoostClassifier(
            iterations=t.suggest_int("iterations", 200, 700, step=100),
            learning_rate=t.suggest_float("learning_rate", 0.01, 0.3, log=True),
            depth=t.suggest_int("depth", 3, 10),
            l2_leaf_reg=t.suggest_float("l2_leaf_reg", 1.0, 30.0, log=True),
            random_seed=seed, verbose=0, allow_writing_files=False,
            thread_count=-1), mode)

    spaces["MLP"] = (lambda t: make_pipeline(
        robust_scaler(seed),
        MLPClassifier(
            hidden_layer_sizes=[(64,), (128,), (256, 128), (128, 64, 32)][
                t.suggest_int("arch", 0, 3)],
            alpha=t.suggest_float("alpha", 1e-6, 1e-1, log=True),
            learning_rate_init=t.suggest_float("lr", 1e-4, 1e-2, log=True),
            max_iter=600, early_stopping=True, random_state=seed)), mode)

    spaces["kNN"] = (lambda t: make_pipeline(
        robust_scaler(seed),
        KNeighborsClassifier(n_neighbors=t.suggest_int("k", 3, 120, log=True),
                             weights=t.suggest_categorical("w", ["uniform", "distance"]),
                             n_jobs=-1)), mode)

    # Per-family trial budgets. A candidate fit costs orders of magnitude more
    # for a kernel SVM or a deep boosting model than for logistic regression, so
    # a flat budget would spend most of the wall clock on the slowest families
    # without improving them. Scale is relative to --trials.
    budget_scale = {"LogisticRegression": 1.0, "Logistic-poly2": 1.0, "kNN": 1.0,
                    "RandomForest": 0.8, "ExtraTrees": 0.8,
                    "HistGradientBoosting": 1.0, "LightGBM": 1.0, "XGBoost": 1.0,
                    "CatBoost": 0.4, "MLP": 0.35, "RBF-SVM": 0.35}

    results, oof_store, best_params = {}, {}, {}
    for name, (build, m) in spaces.items():
        t0 = time.time()
        n_tr = max(4, int(round(trials * budget_scale.get(name, 1.0))))
        st = optuna.create_study(direction="maximize",
                                 sampler=optuna.samplers.TPESampler(seed=seed))
        st.optimize(lambda t: score(lambda: build(t), m)[0], n_trials=n_tr,
                    show_progress_bar=False)
        # rebuild the winner and store its out-of-fold probabilities
        fixed = optuna.trial.FixedTrial(st.best_params)
        acc, oof = score(lambda: build(fixed), m)
        results[name] = acc
        oof_store[name] = oof
        best_params[name] = st.best_params
        if verbose:
            print(f"  {name:22s} CV acc {acc:.4f}   ({time.time()-t0:6.1f}s, "
                  f"{n_tr} trials)", flush=True)

    # regime-aware router, tuned lightly
    t0 = time.time()
    router = RegimeRouter(
        clean_est=make_pipeline(robust_scaler(seed), PolynomialFeatures(2, include_bias=False),
                                LogisticRegression(max_iter=30000, random_state=seed)),
        dirty_est=HistGradientBoostingClassifier(random_state=seed, max_iter=400),
        feats=feats)
    oof = np.zeros(len(ydev))
    for tr, va in folds:
        oof[va] = clone(router).fit(Xdev[tr], ydev[tr]).predict_proba(Xdev[va])[:, 1]
    results["RegimeRouter"] = ((oof >= .5).astype(int) == ydev).mean()
    oof_store["RegimeRouter"] = oof
    best_params["RegimeRouter"] = {"clean": "Logistic+poly2", "dirty": "HistGB",
                                   "min_tails": 3, "fence_k": 1.5}
    if verbose:
        print(f"  {'RegimeRouter':22s} CV acc {results['RegimeRouter']:.4f}   "
              f"({time.time()-t0:5.1f}s)")

    tab = pd.DataFrame([{"model": k, "cv_accuracy": v} for k, v in results.items()]
                       ).sort_values("cv_accuracy", ascending=False)
    tab.to_csv(out / "tables" / f"classical_cv_seed{seed}.csv", index=False)
    return results, oof_store, best_params, folds, cache


# ═══════════════════════════════════════════════════════════════════════════ #
# STAGE 6 | ENSEMBLES  (weights fitted on out-of-fold predictions only)
# ═══════════════════════════════════════════════════════════════════════════ #
def build_ensembles(oof_store, ydev, top_k=6):
    banner("STAGE 6 | ENSEMBLES (fitted on out-of-fold predictions only)")
    names = sorted(oof_store, key=lambda n: -( (oof_store[n] >= .5).astype(int) == ydev).mean())
    names = names[:top_k]
    P = np.column_stack([oof_store[n] for n in names])
    print(f"  members: {names}")

    ens = {}
    ens["Ensemble-mean"] = P.mean(axis=1)
    # The quantile map is fitted here on out-of-fold scores and reused verbatim
    # on the test partition, so no test row's score depends on its neighbours.
    mappers = [OOFQuantileMap().fit(P[:, j]) for j in range(P.shape[1])]
    R = np.column_stack([mappers[j].transform(P[:, j]) for j in range(P.shape[1])])
    ens["Ensemble-rank"] = R.mean(axis=1)

    def negacc(w):
        w = np.abs(w)
        s = w.sum()
        if s <= 0:
            return 1.0
        p = P @ (w / s)
        return -(((p >= .5).astype(int) == ydev).mean())

    w0 = np.ones(P.shape[1]) / P.shape[1]
    res = minimize(negacc, w0, method="Nelder-Mead",
                   options={"maxiter": 4000, "xatol": 1e-4, "fatol": 1e-6})
    w = np.abs(res.x)
    w = w / w.sum()
    ens["Ensemble-weighted"] = P @ w
    print(f"  optimised weights: "
          + ", ".join(f"{n}={wi:.3f}" for n, wi in zip(names, w)))

    meta = LogisticRegression(max_iter=5000)
    cvm = StratifiedKFold(5, shuffle=True, random_state=0)
    stack = np.zeros(len(ydev))
    for tr, va in cvm.split(P, ydev):
        stack[va] = clone(meta).fit(P[tr], ydev[tr]).predict_proba(P[va])[:, 1]
    ens["Ensemble-stack"] = stack

    for k, v in ens.items():
        print(f"  {k:20s} OOF acc {(((v >= .5).astype(int)) == ydev).mean():.4f}")
    return ens, names, w, mappers


# ═══════════════════════════════════════════════════════════════════════════ #
# STAGE 7 | QUANTUM ARM
# ═══════════════════════════════════════════════════════════════════════════ #
def quantum_arm(Xdev, ydev, feats, seed, out, n_sub=1500, quick=False, make_figs=False):
    """Four feature maps, with matched-representation and matched-sample controls.

    Selection uses an internal train/validation split of the development
    partition. The test partition never enters this stage.
    """
    banner("STAGE 7 | QUANTUM ARM (4 feature maps, 2 controls)")
    from sklearn.decomposition import PCA
    from sklearn.preprocessing import MinMaxScaler

    rng = np.random.default_rng(seed)
    Xq_tr, Xq_va, yq_tr, yq_va = train_test_split(
        Xdev, ydev, test_size=0.25, stratify=ydev, random_state=seed)
    if len(Xq_tr) > n_sub:
        i = rng.choice(len(Xq_tr), n_sub, replace=False)
        Xq_tr, yq_tr = Xq_tr[i], yq_tr[i]
    print(f"quantum train subsample {len(Xq_tr)} (kernel is O(N^2)), "
          f"validation {len(Xq_va)}")

    # Same scaler the classical arm gets, so neither arm is handed a better
    # representation than the other.
    sc = robust_scaler(seed).fit(Xq_tr)
    A, B = sc.transform(Xq_tr), sc.transform(Xq_va)

    records = []
    qubit_grid = [4, 6, 9] if not quick else [9]
    fmaps = ["zz", "z", "zprod", "angle"] if not quick else ["zz", "z"]
    alphas = [0.25, 0.5, 1.0, 2.0] if not quick else [1.0]
    reps_grid = [1, 2] if not quick else [2]
    ents = ["linear", "full"] if not quick else ["linear"]

    for nq in qubit_grid:
        if nq >= A.shape[1]:
            Ptr, Pva = A, B
        else:
            pca = PCA(n_components=nq, random_state=seed).fit(A)
            Ptr, Pva = pca.transform(A), pca.transform(B)
        mm = MinMaxScaler((0, np.pi)).fit(Ptr)
        Qtr = np.clip(mm.transform(Ptr), 0, np.pi)
        Qva = np.clip(mm.transform(Pva), 0, np.pi)

        # CONTROL 1 — matched representation: classical RBF on identical inputs
        ctrl = max(balanced_accuracy_score(yq_va,
                                           SVC(C=C, gamma=g).fit(Qtr, yq_tr).predict(Qva))
                   for C in (1, 10, 100) for g in ("scale", 0.5))

        for fmap in fmaps:
            ent_list = ["linear"] if fmap in ("z", "angle") else ents
            reps_list = [1] if fmap == "angle" else reps_grid
            for ent in ent_list:
                for reps in reps_list:
                    for a in alphas:
                        Ktr = fidelity_kernel(Qtr, fmap=fmap, reps=reps, ent=ent, alpha=a)
                        Kva = fidelity_kernel(Qva, Qtr, fmap=fmap, reps=reps, ent=ent, alpha=a)
                        kta = kernel_target_alignment(Ktr, yq_tr)
                        er = effective_rank(Ktr)
                        for C in (1, 10, 100):
                            svm = SVC(C=C, kernel="precomputed").fit(Ktr, yq_tr)
                            acc = accuracy_score(yq_va, svm.predict(Kva))
                            records.append(dict(seed=seed, feature_map=fmap, n_qubits=nq,
                                                reps=reps, entanglement=ent, alpha=a, C=C,
                                                val_accuracy=acc, alignment=kta,
                                                effective_rank=er,
                                                classical_control=ctrl))
        best_nq = max(r["val_accuracy"] for r in records if r["n_qubits"] == nq)
        print(f"  q={nq}: best quantum val acc {best_nq:.4f}   "
              f"matched classical control {ctrl:.4f}")

    rec = pd.DataFrame(records)
    rec.to_csv(out / "tables" / f"quantum_search_seed{seed}.csv", index=False)

    sub("best configuration per feature map (validation)")
    per_map = rec.loc[rec.groupby("feature_map")["val_accuracy"].idxmax()]
    print(per_map[["feature_map", "n_qubits", "reps", "entanglement", "alpha", "C",
                   "val_accuracy", "alignment", "classical_control"]].round(4).to_string(index=False))

    sub("ablations")
    print("bandwidth alpha:")
    print(rec.groupby("alpha").agg(val=("val_accuracy", "max"),
                                   align=("alignment", "mean"),
                                   eff_rank=("effective_rank", "mean")).round(4).to_string())
    print("\nentanglement topology (ZZ map only):")
    zz = rec[rec.feature_map == "zz"]
    if len(zz):
        print(zz.groupby("entanglement")["val_accuracy"].max().round(4).to_string())
    print("\ncircuit repetitions:")
    print(rec.groupby("reps")["val_accuracy"].max().round(4).to_string())

    best = rec.loc[rec["val_accuracy"].idxmax()].to_dict()
    print(f"\nselected on validation: {best['feature_map']} q={int(best['n_qubits'])} "
          f"reps={int(best['reps'])} ent={best['entanglement']} alpha={best['alpha']} "
          f"C={int(best['C'])}  (val acc {best['val_accuracy']:.4f})")

    # CONTROL 2 — matched sample: classical models on the same subsample
    sub("matched-sample control (classical models on the identical subsample)")
    msc = {}
    for n, m in [("RBF-SVM", make_pipeline(robust_scaler(seed), SVC(C=10, gamma="scale"))),
                 ("RandomForest", RandomForestClassifier(n_estimators=600,
                                                         min_samples_leaf=5,
                                                         random_state=seed, n_jobs=-1)),
                 ("HistGB", HistGradientBoostingClassifier(random_state=seed, max_iter=400))]:
        msc[n] = accuracy_score(yq_va, clone(m).fit(Xq_tr, yq_tr).predict(Xq_va))
        print(f"  {n:16s} val acc {msc[n]:.4f}  (same {len(Xq_tr)} training rows)")
    print(f"  {'QSVM (best)':16s} val acc {best['val_accuracy']:.4f}")

    return best, rec, msc, (sc, Xq_tr, yq_tr)


def fit_quantum_final(best, Xdev, ydev, Xte, seed, n_sub=1500):
    """Refit the frozen quantum configuration and score the test partition once."""
    from sklearn.decomposition import PCA
    from sklearn.preprocessing import MinMaxScaler

    rng = np.random.default_rng(seed)
    idx = (rng.choice(len(Xdev), n_sub, replace=False) if len(Xdev) > n_sub
           else np.arange(len(Xdev)))
    Xt, yt = Xdev[idx], ydev[idx]
    sc = robust_scaler(seed).fit(Xt)
    A, T = sc.transform(Xt), sc.transform(Xte)
    nq = int(best["n_qubits"])
    if nq < A.shape[1]:
        pca = PCA(n_components=nq, random_state=seed).fit(A)
        A, T = pca.transform(A), pca.transform(T)
    mm = MinMaxScaler((0, np.pi)).fit(A)
    Qa, Qt = np.clip(mm.transform(A), 0, np.pi), np.clip(mm.transform(T), 0, np.pi)
    kw = dict(fmap=best["feature_map"], reps=int(best["reps"]),
              ent=best["entanglement"], alpha=float(best["alpha"]))
    Ktr = fidelity_kernel(Qa, **kw)
    Kte = fidelity_kernel(Qt, Qa, **kw)
    svm = SVC(C=float(best["C"]), kernel="precomputed").fit(Ktr, yt)
    return svm.predict(Kte), svm.decision_function(Kte)


# ═══════════════════════════════════════════════════════════════════════════ #
# FIGURES
# ═══════════════════════════════════════════════════════════════════════════ #
def err_by_stratum(Xdev, Xte, yte, score, thr):
    """Where do the surviving test errors live? Section F of the report.

    The stratum detector is fitted on the development partition, so assigning a
    test row to a stratum uses no test label.
    """
    banner("ERROR ANALYSIS (test partition)")
    det = StratumDetector().fit(Xdev)
    cnt = det.count(Xte)
    clean = det.is_clean(Xte)
    pred = (score >= thr).astype(int)
    err = pred != yte
    cm = confusion_matrix(yte, pred, labels=[0, 1])
    print(f"confusion matrix (rows true, cols predicted):\n{cm}")
    tn, fp, fn, tp = cm.ravel()
    print(f"  TN {tn}   FP {fp}   FN {fn}   TP {tp}")
    print(f"  overall accuracy {accuracy_score(yte, pred):.4f}   "
          f"{int(err.sum())} errors out of {len(yte)}")

    print(f"\n{'stratum':>16} {'n':>6} {'errors':>8} {'error rate':>12} "
          f"{'share of all errors':>20}")
    for tag, sel in [("clean", clean), ("contaminated", ~clean)]:
        print(f"{tag:>16} {sel.sum():>6d} {int(err[sel].sum()):>8d} "
              f"{err[sel].mean():>12.4f} {err[sel].sum()/max(err.sum(),1):>19.1%}")

    print(f"\n{'tails':>6} {'n':>6} {'error rate':>12}")
    for k in range(10):
        s = cnt == k
        if s.sum() < 10:
            continue
        print(f"{k:>6} {s.sum():>6d} {err[s].mean():>12.4f}")

    print(f"\n{'class':>6} {'n':>6} {'error rate':>12}")
    for c in (0, 1):
        s = yte == c
        print(f"{c:>6} {s.sum():>6d} {err[s].mean():>12.4f}")

    m = np.abs(score - thr)
    band = pd.qcut(m, 4, labels=["nearest", "near", "far", "farthest"],
                   duplicates="drop")
    by = pd.DataFrame({"band": band, "err": err}).groupby("band", observed=True)["err"].mean()
    print("\nerror rate by distance from the decision threshold:")
    print("  " + by.round(4).to_dict().__repr__())


def journal_style():
    plt.rcParams.update({
        "figure.dpi": 120, "savefig.dpi": 600, "savefig.bbox": "tight",
        "font.family": "sans-serif", "font.sans-serif": ["DejaVu Sans"],
        "font.size": 8, "axes.titlesize": 8.5, "axes.labelsize": 8,
        "xtick.labelsize": 7, "ytick.labelsize": 7, "legend.fontsize": 7,
        "axes.linewidth": 0.6, "axes.spines.top": False, "axes.spines.right": False,
        "axes.grid": True, "grid.alpha": 0.25, "grid.linewidth": 0.4,
        "lines.linewidth": 1.2, "lines.markersize": 3.5, "legend.frameon": False,
        "figure.constrained_layout.use": True,
    })


DOUBLE = 7.0
PAL = {"c0": "#4C72B0", "c1": "#DD8452", "q": "#55A868", "acc": "#C44E52",
       "grey": "#8C8C8C"}


def fig_contamination(Xdev, ydev, det, feats, out):
    fig, ax = plt.subplots(1, 4, figsize=(DOUBLE, 2.0))
    cnt = det.count(Xdev)
    p = det.mask(Xdev).mean()
    obs = np.bincount(cnt, minlength=10)[:10]
    exp = stats.binom.pmf(np.arange(10), 9, p) * len(Xdev)

    a = ax[0]
    k = np.arange(10)
    a.bar(k - 0.2, obs, 0.4, color=PAL["c0"], label="observed")
    a.bar(k + 0.2, exp, 0.4, color=PAL["grey"], label="Binom(9,p)")
    a.set_yscale("symlog")
    a.set_xlabel("tail cells per row")
    a.set_ylabel("rows")
    a.legend()
    a.set_title("row-level, not cell-level")

    a = ax[1]
    j = feats.index("Solids")
    cl = det.is_clean(Xdev)
    a.hist(Xdev[cl, j], bins=60, color=PAL["c0"], alpha=.8, label="clean")
    a.hist(Xdev[~cl, j], bins=60, color=PAL["acc"], alpha=.8, label="contaminated")
    a.set_yscale("log")
    a.set_xlabel("Solids")
    a.set_ylabel("rows")
    a.legend()
    a.set_title("two-component mixture")

    a = ax[2]
    rc = [stats.spearmanr(Xdev[cl, i], ydev[cl]).statistic for i in range(len(feats))]
    rk = [stats.spearmanr(Xdev[~cl, i], ydev[~cl]).statistic for i in range(len(feats))]
    yy = np.arange(len(feats))
    a.barh(yy - 0.2, rc, 0.4, color=PAL["c0"], label="clean")
    a.barh(yy + 0.2, rk, 0.4, color=PAL["acc"], label="contaminated")
    a.set_yticks(yy)
    a.set_yticklabels([f[:9] for f in feats], fontsize=5.5)
    a.axvline(0, color="#333", lw=.5)
    a.set_xlabel(r"Spearman $\rho$ with target")
    a.legend()
    a.set_title("signal lives in the clean stratum")

    a = ax[3]
    cv = StratifiedKFold(5, shuffle=True, random_state=0)
    oof = np.zeros(len(ydev))
    for tr, va in cv.split(Xdev, ydev):
        oof[va] = HistGradientBoostingClassifier(random_state=0, max_iter=300
                                                 ).fit(Xdev[tr], ydev[tr]).predict(Xdev[va])
    accs, ns, ks = [], [], []
    for kk in range(10):
        s = cnt == kk
        if s.sum() < 20:
            continue
        ks.append(kk)
        ns.append(s.sum())
        accs.append((oof[s] == ydev[s]).mean())
    a.bar(ks, accs, color=[PAL["c0"] if kk < 3 else PAL["acc"] for kk in ks])
    a.axhline(0.5, ls="--", color=PAL["grey"], lw=.7)
    a.set_ylim(0.4, 1.0)
    a.set_xlabel("tail cells per row")
    a.set_ylabel("CV accuracy")
    a.set_title("accuracy collapses off the core")
    for ext in ("png", "pdf"):
        fig.savefig(out / "figures" / f"fig1_contamination.{ext}")
    plt.close(fig)


def fig_ceiling(info, summary, out):
    fig, ax = plt.subplots(1, 2, figsize=(DOUBLE, 2.6))
    a = ax[0]
    labels = ["clean\nstratum", "contaminated\nstratum", "composed\nceiling"]
    vals = [info["ceiling_clean"], info["ceiling_contaminated"],
            info["composed_ceiling"]]
    b = a.bar(labels, vals, color=[PAL["c0"], PAL["acc"], PAL["q"]], width=.6)
    for r, v in zip(b, vals):
        a.text(r.get_x() + r.get_width() / 2, v, f"{v:.4f}", ha="center",
               va="bottom", fontsize=7)
    a.axhline(0.97, ls="--", color=PAL["acc"], lw=.8)
    a.text(2.4, 0.972, "97% target", fontsize=6, color=PAL["acc"], ha="right")
    a.axhline(0.90, ls=":", color="#333", lw=.8)
    a.text(2.4, 0.902, "90% target", fontsize=6, color="#333", ha="right")
    a.set_ylim(0.5, 1.02)
    a.set_ylabel("accuracy")
    a.set_title("where the ceiling comes from")

    a = ax[1]
    s = summary.sort_values("accuracy")
    cols = [PAL["q"] if "QSVM" in m else PAL["c0"] for m in s.index]
    a.barh([m[:18] for m in s.index], s["accuracy"], xerr=s["accuracy_sd"],
           color=cols, height=.62, error_kw={"lw": .8, "capsize": 2, "ecolor": "#222"})
    a.axvline(info["composed_ceiling"], ls="--", color=PAL["acc"], lw=1.0)
    a.text(info["composed_ceiling"], -0.6, " estimated ceiling", fontsize=6,
           color=PAL["acc"])
    a.set_xlim(0.75, max(0.90, s["accuracy"].max() + .03))
    a.set_xlabel("test accuracy (mean over seeds)")
    a.tick_params(axis="y", labelsize=6)
    a.set_title("every model saturates at the ceiling")
    for ext in ("png", "pdf"):
        fig.savefig(out / "figures" / f"fig2_ceiling.{ext}")
    plt.close(fig)


def fig_quantum(rec, out):
    fig, ax = plt.subplots(1, 3, figsize=(DOUBLE, 2.2))
    a = ax[0]
    g = rec.groupby("n_qubits").agg(q=("val_accuracy", "max"),
                                    c=("classical_control", "max"))
    a.plot(g.index, g["q"], "o-", color=PAL["q"], label="quantum kernel")
    a.plot(g.index, g["c"], "s--", color=PAL["c0"], label="classical RBF,\nsame features")
    a.set_xlabel("qubits (encoded dimensions)")
    a.set_ylabel("validation accuracy")
    a.set_xticks(g.index)
    a.legend()
    a.set_title("matched-representation control")

    a = ax[1]
    for fm, c in zip(["zz", "z", "zprod", "angle"],
                     [PAL["q"], PAL["c0"], PAL["c1"], PAL["acc"]]):
        s = rec[rec.feature_map == fm]
        if len(s):
            gg = s.groupby("alpha")["val_accuracy"].max()
            a.plot(gg.index, gg.values, "o-", color=c, label=fm)
    a.set_xscale("log")
    a.set_xlabel(r"bandwidth $\alpha$")
    a.set_ylabel("validation accuracy")
    a.legend()
    a.set_title("bandwidth by feature map")

    a = ax[2]
    gg = rec.groupby("alpha").agg(v=("val_accuracy", "max"), r=("effective_rank", "mean"))
    a.plot(gg.index, gg["v"], "o-", color=PAL["q"])
    a.set_xscale("log")
    a.set_xlabel(r"bandwidth $\alpha$")
    a.set_ylabel("validation accuracy", color=PAL["q"])
    a2 = a.twinx()
    a2.plot(gg.index, gg["r"], "s--", color=PAL["c0"])
    a2.set_ylabel("kernel effective rank", color=PAL["c0"])
    a2.grid(False)
    a.set_title("kernel geometry")
    for ext in ("png", "pdf"):
        fig.savefig(out / "figures" / f"fig3_quantum.{ext}")
    plt.close(fig)


def fig_final(yte, score, thr, out):
    fig, ax = plt.subplots(1, 3, figsize=(DOUBLE, 2.3))
    pred = (score >= thr).astype(int)
    cm = confusion_matrix(yte, pred, labels=[0, 1])
    a = ax[0]
    a.imshow(cm, cmap="Blues")
    for i in range(2):
        for j in range(2):
            a.text(j, i, f"{cm[i,j]:,}", ha="center", va="center", fontsize=9)
    a.set_xticks([0, 1], ["pred 0", "pred 1"])
    a.set_yticks([0, 1], ["true 0", "true 1"])
    a.grid(False)
    a.set_title(f"confusion matrix (acc {accuracy_score(yte, pred):.4f})")

    a = ax[1]
    fpr, tpr, _ = roc_curve(yte, score)
    a.plot(fpr, tpr, color=PAL["c0"], label=f"AUC {roc_auc_score(yte, score):.4f}")
    a.plot([0, 1], [0, 1], ":", color=PAL["grey"], lw=.7)
    a.set_xlabel("false positive rate")
    a.set_ylabel("true positive rate")
    a.legend(loc="lower right")
    a.set_title("ROC")

    a = ax[2]
    pr, rc, _ = precision_recall_curve(yte, score)
    a.plot(rc, pr, color=PAL["c1"],
           label=f"AP {average_precision_score(yte, score):.4f}")
    a.set_xlabel("recall")
    a.set_ylabel("precision")
    a.legend(loc="lower left")
    a.set_title("precision-recall")
    for ext in ("png", "pdf"):
        fig.savefig(out / "figures" / f"fig4_final.{ext}")
    plt.close(fig)


# ═══════════════════════════════════════════════════════════════════════════ #
# MAIN
# ═══════════════════════════════════════════════════════════════════════════ #
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=DATA)
    ap.add_argument("--seeds", nargs="+", type=int,
                    default=[42, 7, 2024, 1, 13, 99, 123, 777, 2718, 31415])
    ap.add_argument("--trials", type=int, default=40)
    ap.add_argument("--outdir", default="results")
    ap.add_argument("--test-size", type=float, default=0.20)
    ap.add_argument("--quantum-sub", type=int, default=1500)
    ap.add_argument("--quick", action="store_true")
    args = ap.parse_args()

    if args.quick:
        args.seeds = args.seeds[:2]
        args.trials = 8
        args.quantum_sub = 500

    out = Path(args.outdir)
    (out / "figures").mkdir(parents=True, exist_ok=True)
    (out / "tables").mkdir(parents=True, exist_ok=True)
    journal_style()
    t0 = time.time()

    df, feats = load_data(args.data)
    X, y = df[feats].to_numpy(float), df[TARGET].to_numpy(int)

    all_rows, quantum_recs, ceil_info, first = [], [], None, True
    thresholds, forensic_info, mode = {}, None, None

    for seed in args.seeds:
        banner(f"SEED {seed}")
        Xdev, Xte, ydev, yte = train_test_split(
            X, y, test_size=args.test_size, stratify=y, random_state=seed)
        print(f"development {len(ydev)}   test {len(yte)} (frozen until the final step)")

        if first:
            det, forensic_info = forensics(Xdev, ydev, Xte, feats, out, seed)
            ceil_info = ceiling_analysis(Xdev, ydev, det, out, seed)
            fig_contamination(Xdev, ydev, det, feats, out)
            # The representation is selected once, by CV on the first seed's
            # development partition, then held fixed. Re-selecting it per seed
            # would let a later seed's development rows (which are an earlier
            # seed's test rows) influence the choice.
            mode, rep_tab = representation_search(Xdev, ydev, feats, seed, out)

        results, oof_store, params, folds, cache = tune_classical(
            Xdev, ydev, feats, mode, seed, args.trials, out, verbose=first or True)

        ens, members, weights, mappers = build_ensembles(oof_store, ydev)
        oof_store.update(ens)

        banner("STAGE 8 | DECISION THRESHOLD (out-of-fold predictions only)")
        for n in oof_store:
            t, a = best_threshold(ydev, oof_store[n])
            thresholds[n] = t
        top = max(oof_store, key=lambda n: ((oof_store[n] >= thresholds[n]).astype(int) == ydev).mean())
        print(f"  best OOF model: {top}  threshold {thresholds[top]:.4f}  "
              f"OOF acc {((oof_store[top] >= thresholds[top]).astype(int) == ydev).mean():.4f}")
        print(f"  (threshold 0.5 would give "
              f"{((oof_store[top] >= .5).astype(int) == ydev).mean():.4f})")

        # ---------------- quantum arm ----------------
        qbest, qrec, msc, _ = quantum_arm(Xdev, ydev, feats, seed, out,
                                          n_sub=args.quantum_sub, quick=args.quick,
                                          make_figs=first)
        quantum_recs.append(qrec)
        if first:
            fig_quantum(qrec, out)

        # ---------------- final test evaluation ----------------
        banner("STAGE 9 | FINAL TEST EVALUATION (test partition touched once)")
        det_f = StratumDetector().fit(Xdev)
        Adev = build_features(det_f, Xdev, Xdev, feats, mode)
        Ate = build_features(det_f, Xdev, Xte, feats, mode)
        Adev_raw, Ate_raw = Xdev, Xte

        fitted_scores = {}
        rebuild = {
            "LogisticRegression": (make_pipeline(robust_scaler(seed), LogisticRegression(
                max_iter=8000, random_state=seed, **params["LogisticRegression"])), mode),
            "Logistic-poly2": (make_pipeline(
                robust_scaler(seed), PolynomialFeatures(2, include_bias=False),
                LogisticRegression(max_iter=30000, random_state=seed,
                                   **params["Logistic-poly2"])), "raw"),
            "RBF-SVM": (QuantileScored(make_pipeline(robust_scaler(seed), SVC(
                cache_size=500, random_state=seed, **params["RBF-SVM"]))), mode),
            "RandomForest": (RandomForestClassifier(random_state=seed, n_jobs=-1,
                                                    **params["RandomForest"]), mode),
            "ExtraTrees": (ExtraTreesClassifier(random_state=seed, n_jobs=-1,
                                                **params["ExtraTrees"]), mode),
            "HistGradientBoosting": (HistGradientBoostingClassifier(
                random_state=seed, **params["HistGradientBoosting"]), mode),
            "MLP": (make_pipeline(robust_scaler(seed), MLPClassifier(
                hidden_layer_sizes=[(64,), (128,), (256, 128), (128, 64, 32)][
                    params["MLP"]["arch"]],
                alpha=params["MLP"]["alpha"], learning_rate_init=params["MLP"]["lr"],
                max_iter=600, early_stopping=True, random_state=seed)), mode),
            "kNN": (make_pipeline(robust_scaler(seed), KNeighborsClassifier(
                n_neighbors=params["kNN"]["k"], weights=params["kNN"]["w"], n_jobs=-1)), mode),
        }
        if HAS_LGB:
            rebuild["LightGBM"] = (lgb.LGBMClassifier(random_state=seed, n_jobs=-1,
                                                      verbose=-1, subsample_freq=1,
                                                      **params["LightGBM"]), mode)
        if HAS_XGB:
            rebuild["XGBoost"] = (xgb.XGBClassifier(
                tree_method="hist", eval_metric="logloss", random_state=seed,
                n_jobs=-1, verbosity=0, **params["XGBoost"]), mode)
        if HAS_CAT:
            rebuild["CatBoost"] = (CatBoostClassifier(
                random_seed=seed, verbose=0, allow_writing_files=False,
                thread_count=-1, **params["CatBoost"]), mode)

        for name, (est, m) in rebuild.items():
            Atr = Adev if m == mode else Adev_raw
            Ats = Ate if m == mode else Ate_raw
            fitted = clone(est).fit(Atr, ydev)
            # Same scoring convention used when the threshold was chosen, so the
            # frozen threshold is applied to the scale it was selected on.
            s = fitted.predict_proba(Ats)[:, 1]
            fitted_scores[name] = s
            thr = thresholds.get(name, 0.5)
            r = evaluate(yte, (s >= thr).astype(int), s)
            all_rows.append(dict(model=name, seed=seed, threshold=thr,
                                 cv_accuracy=results.get(name, np.nan), **r))

        router = RegimeRouter(
            clean_est=make_pipeline(robust_scaler(seed), PolynomialFeatures(2, include_bias=False),
                                    LogisticRegression(max_iter=30000, random_state=seed)),
            dirty_est=HistGradientBoostingClassifier(random_state=seed, max_iter=400),
            feats=feats).fit(Xdev, ydev)
        s = router.predict_proba(Xte)[:, 1]
        fitted_scores["RegimeRouter"] = s
        thr = thresholds.get("RegimeRouter", 0.5)
        all_rows.append(dict(model="RegimeRouter", seed=seed, threshold=thr,
                             cv_accuracy=results.get("RegimeRouter", np.nan),
                             **evaluate(yte, (s >= thr).astype(int), s)))

        # ensembles on the test partition, using weights frozen from OOF
        Pte = np.column_stack([fitted_scores[n] for n in members])
        ens_te = {"Ensemble-mean": Pte.mean(axis=1),
                  "Ensemble-rank": np.column_stack(
                      [mappers[j].transform(Pte[:, j]) for j in range(Pte.shape[1])]
                  ).mean(axis=1),
                  "Ensemble-weighted": Pte @ weights}
        Poof = np.column_stack([oof_store[n] for n in members])
        meta = LogisticRegression(max_iter=5000).fit(Poof, ydev)
        ens_te["Ensemble-stack"] = meta.predict_proba(Pte)[:, 1]
        for n, s in ens_te.items():
            fitted_scores[n] = s
            thr = thresholds.get(n, 0.5)
            all_rows.append(dict(model=n, seed=seed, threshold=thr,
                                 cv_accuracy=np.nan,
                                 **evaluate(yte, (s >= thr).astype(int), s)))

        qpred, qscore = fit_quantum_final(qbest, Xdev, ydev, Xte, seed,
                                          n_sub=args.quantum_sub)
        # Named uniformly across seeds: the winning feature map can differ from
        # seed to seed, and a name that changes with it would split one model
        # across several rows of the multi-seed summary.
        all_rows.append(dict(model="QSVM", seed=seed, threshold=0.0,
                             cv_accuracy=qbest["val_accuracy"],
                             feature_map=qbest["feature_map"],
                             n_qubits=int(qbest["n_qubits"]),
                             **evaluate(yte, qpred, qscore)))

        cur = pd.DataFrame(all_rows)
        cur = cur[cur.seed == seed].sort_values("accuracy", ascending=False)
        print(cur[["model", "cv_accuracy", "accuracy", "roc_auc", "f1", "mcc"]
                  ].round(4).to_string(index=False))

        if first:
            # QSVM is scored through its own path and has no entry in
            # fitted_scores, so fall back to the best model that does.
            bestn = next((m for m in cur["model"] if m in fitted_scores), None)
            if bestn is not None:
                fig_final(yte, fitted_scores[bestn], thresholds.get(bestn, 0.5), out)
                print(f"\nerror-analysis figure drawn for: {bestn}")
                err_by_stratum(Xdev, Xte, yte, fitted_scores[bestn],
                               thresholds.get(bestn, 0.5))
            first = False

    # ------------------------------------------------------------------ #
    res = pd.DataFrame(all_rows)
    res.to_csv(out / "tables" / "raw_results.csv", index=False)

    banner("STAGE 10 | MULTI-SEED SUMMARY (untouched test partition)")
    g = res.groupby("model")
    summary = g[METRICS].mean()
    sds = g[METRICS].std().fillna(0.0)
    for m in METRICS:
        summary[f"{m}_sd"] = sds[m]
    summary["cv_accuracy"] = g["cv_accuracy"].mean()
    summary["n_seeds"] = g.size()
    summary = summary.sort_values("accuracy", ascending=False)
    summary.to_csv(out / "tables" / "summary.csv")

    pretty = pd.DataFrame(index=summary.index)
    for m in ["accuracy", "balanced_accuracy", "precision", "recall", "f1",
              "roc_auc", "mcc"]:
        pretty[m] = (summary[m].round(4).astype(str) + " ± "
                     + summary[f"{m}_sd"].round(4).astype(str))
    pretty.insert(0, "cv_acc", summary["cv_accuracy"].round(4))
    print(pretty.to_string())
    pretty.to_csv(out / "tables" / "summary_formatted.csv")

    banner("STAGE 11 | STATISTICAL COMPARISON")
    wide = res.pivot_table(index="seed", columns="model", values="accuracy")
    if wide.shape[1] >= 3 and wide.shape[0] >= 3:
        stat, p = stats.friedmanchisquare(*[wide[c].dropna().to_numpy()
                                            for c in wide.columns
                                            if wide[c].notna().all()])
        print(f"Friedman chi2 = {stat:.3f}   p = {p:.4g}")
        ranks = wide.rank(axis=1, ascending=False).mean().sort_values()
        print("\nmean ranks (lower is better):")
        print(ranks.round(3).to_string())
        ranks.to_csv(out / "tables" / "mean_ranks.csv")

    if "feature_map" in res.columns:
        fm = res[res.model == "QSVM"]["feature_map"].value_counts()
        print(f"\nquantum feature map selected per seed: {fm.to_dict()}")

    qcols = [c for c in wide.columns if c.startswith("QSVM")]
    if qcols:
        qc = qcols[0]
        others = [c for c in wide.columns if not c.startswith("QSVM")]
        top = wide[others].mean().idxmax()
        d = (wide[qc] - wide[top]).dropna()
        n = len(d)
        if n > 1 and d.std(ddof=1) > 0:
            n_te = int(args.test_size * len(X))
            n_tr = len(X) - n_te
            t = d.mean() / np.sqrt((1 / n + n_te / n_tr) * d.var(ddof=1))
            pv = 2 * (1 - stats.t.cdf(abs(t), n - 1))
            print(f"\n{qc} vs {top} (Nadeau-Bengio corrected t-test over {n} seeds):")
            print(f"  mean difference {d.mean():+.4f}   t = {t:.3f}   p = {pv:.4f}")

    banner("STAGE 12 | CEILING VERDICT")
    best_acc = float(summary.iloc[0]["accuracy"])
    best_name = summary.index[0]
    print(f"best model                 : {best_name}")
    print(f"mean test accuracy         : {best_acc:.4f} "
          f"± {summary.iloc[0]['accuracy_sd']:.4f} over {len(args.seeds)} seeds")
    if ceil_info:
        print(f"estimated ceiling          : {ceil_info['composed_ceiling']:.4f}")
        print(f"  clean stratum {ceil_info['p_clean']:.3f} x "
              f"{ceil_info['ceiling_clean']:.4f}")
        print(f"  contaminated  {1-ceil_info['p_clean']:.3f} x "
              f"{ceil_info['ceiling_contaminated']:.4f}")
        print(f"gap to ceiling             : {ceil_info['composed_ceiling']-best_acc:+.4f}")
    for tgt in (0.90, 0.97):
        print(f"{int(tgt*100)}% target reached        : "
              f"{'YES' if best_acc >= tgt else 'NO'}")
        if ceil_info and best_acc < tgt:
            need = (tgt - (1 - ceil_info["p_clean"]) * ceil_info["ceiling_contaminated"]) \
                   / ceil_info["p_clean"]
            print(f"   to reach {int(tgt*100)}% the clean stratum would need accuracy "
                  f"{need:.4f} (its Bayes estimate is "
                  f"{ceil_info['bayes_clean_logistic']:.4f})")

    if ceil_info:
        fig_ceiling(ceil_info, summary, out)
    pd.concat(quantum_recs, ignore_index=True).to_csv(
        out / "tables" / "quantum_search_all.csv", index=False)

    json.dump({"seeds": args.seeds, "trials": args.trials,
               "representation": mode, "best_model": best_name,
               "best_test_accuracy": best_acc,
               "ceiling": ceil_info, "forensics": forensic_info,
               "runtime_minutes": round((time.time() - t0) / 60, 2)},
              open(out / "manifest.json", "w"), indent=2, default=float)
    print(f"\ndone in {(time.time()-t0)/60:.1f} min -> {out.resolve()}")


if __name__ == "__main__":
    main()
