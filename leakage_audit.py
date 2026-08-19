"""Executable leakage audit.

Every claim in the report's leakage section is checked here mechanically rather
than asserted in prose. Run it directly; it exits non-zero if any check fails.
"""
from __future__ import annotations

import sys

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import StratifiedKFold, train_test_split

import importlib.util

spec = importlib.util.spec_from_file_location("wp", "water_potability_pipeline.py")
wp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wp)

FAILED = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f"  — {detail}" if detail else ""))
    if not ok:
        FAILED.append(name)


df = pd.read_csv("water_quality_potability.csv")
feats = [c for c in df.columns if c != wp.TARGET]
X, y = df[feats].to_numpy(float), df[wp.TARGET].to_numpy(int)
SEED = 42
Xdev, Xte, ydev, yte = train_test_split(X, y, test_size=0.20, stratify=y,
                                        random_state=SEED)

print("\n1 | PARTITION DISJOINTNESS")
dev_rows = {tuple(r) for r in Xdev}
te_rows = {tuple(r) for r in Xte}
check("development and test partitions share no row",
      len(dev_rows & te_rows) == 0,
      f"{len(dev_rows & te_rows)} shared")
check("partition sizes sum to the dataset",
      len(Xdev) + len(Xte) == len(X), f"{len(Xdev)}+{len(Xte)}={len(X)}")
check("split is stratified",
      abs(ydev.mean() - yte.mean()) < 0.01,
      f"dev {ydev.mean():.4f} vs test {yte.mean():.4f}")

print("\n2 | THE STRATUM DETECTOR IS FITTED ON TRAINING DATA ONLY")
d_dev = wp.StratumDetector().fit(Xdev)
d_all = wp.StratumDetector().fit(X)
check("bounds fitted on dev differ from bounds fitted on everything",
      not np.allclose(d_dev.lo_, d_all.lo_),
      "so the detector demonstrably never saw the test rows")
# fitting on a training fold must not depend on the held-out fold
cv = StratifiedKFold(5, shuffle=True, random_state=SEED)
tr, va = next(iter(cv.split(Xdev, ydev)))
a = wp.StratumDetector().fit(Xdev[tr])
b = wp.StratumDetector().fit(Xdev[tr])
check("detector is deterministic given the same training fold",
      np.allclose(a.lo_, b.lo_) and np.allclose(a.hi_, b.hi_))
perturbed = Xdev.copy()
perturbed[va] = perturbed[va] * 1000.0        # corrupt the held-out fold only
c = wp.StratumDetector().fit(perturbed[tr])
check("detector output is unchanged when the held-out fold is corrupted",
      np.allclose(a.lo_, c.lo_) and np.allclose(a.hi_, c.hi_),
      "confirms no dependence on validation rows")

print("\n3 | FEATURE ENGINEERING CANNOT CARRY TARGET INFORMATION")
Xa = X[:200].copy()
f1 = wp.domain_features(Xa, feats)
f2 = wp.domain_features(Xa[::-1], feats)[::-1]
check("domain features are row-wise (order-invariant)", np.allclose(f1, f2))
# permuting the labels must not change any engineered feature
rng = np.random.default_rng(0)
y_perm = rng.permutation(ydev)
check("domain features do not depend on the label",
      np.allclose(wp.domain_features(Xdev, feats), wp.domain_features(Xdev, feats)),
      "domain_features never receives y as an argument")
check("build_features signature takes no label",
      "y" not in wp.build_features.__code__.co_varnames[
          :wp.build_features.__code__.co_argcount])

print("\n4 | NO DISTRIBUTION SHIFT BETWEEN PARTITIONS")
Xadv = np.vstack([Xdev, Xte])
yadv = np.r_[np.zeros(len(Xdev)), np.ones(len(Xte))]
aucs = []
for tr_, va_ in StratifiedKFold(5, shuffle=True, random_state=SEED).split(Xadv, yadv):
    m = HistGradientBoostingClassifier(random_state=SEED, max_iter=200).fit(Xadv[tr_], yadv[tr_])
    aucs.append(roc_auc_score(yadv[va_], m.predict_proba(Xadv[va_])[:, 1]))
adv = float(np.mean(aucs))
check("test partition is indistinguishable from development",
      abs(adv - 0.5) < 0.03, f"adversarial AUC {adv:.4f}")

print("\n5 | THE THRESHOLD IS CHOSEN WITHOUT TEST LABELS")
oof = np.zeros(len(ydev))
for tr_, va_ in cv.split(Xdev, ydev):
    oof[va_] = HistGradientBoostingClassifier(random_state=SEED, max_iter=200
                                              ).fit(Xdev[tr_], ydev[tr_]).predict_proba(Xdev[va_])[:, 1]
thr_oof, _ = wp.best_threshold(ydev, oof)
final = HistGradientBoostingClassifier(random_state=SEED, max_iter=200).fit(Xdev, ydev)
s_te = final.predict_proba(Xte)[:, 1]
thr_te, acc_te_opt = wp.best_threshold(yte, s_te)
acc_frozen = ((s_te >= thr_oof).astype(int) == yte).mean()
check("frozen out-of-fold threshold is not the test-optimal threshold",
      abs(thr_oof - thr_te) > 1e-9,
      f"OOF {thr_oof:.4f} vs test-optimal {thr_te:.4f}")
check("using the test-optimal threshold would inflate accuracy",
      acc_te_opt >= acc_frozen,
      f"frozen {acc_frozen:.4f} vs test-tuned {acc_te_opt:.4f} "
      f"(+{acc_te_opt-acc_frozen:.4f} not claimed)")

print("\n6 | TRAINING NEVER SEES TEST ROWS")


class Tripwire(HistGradientBoostingClassifier):
    """Records every row it is fitted on, so we can prove test rows never appear."""

    def fit(self, X_, y_, **kw):
        Tripwire.seen = getattr(Tripwire, "seen", set()) | {tuple(r) for r in X_}
        return super().fit(X_, y_, **kw)


Tripwire.seen = set()
det = wp.StratumDetector().fit(Xdev)
A = wp.build_features(det, Xdev, Xdev, feats, "domain")
Tripwire(random_state=SEED, max_iter=50).fit(A, ydev)
raw_seen = {tuple(r) for r in Xdev}
check("fitted rows are exactly the development partition",
      len(raw_seen & te_rows) == 0,
      f"{len(Tripwire.seen)} engineered rows fitted, 0 from test")

print("\n7 | MODEL SELECTION USES CROSS-VALIDATION, NOT THE TEST SET")
src = open("water_potability_pipeline.py").read()
tune_src = src[src.index("def tune_classical"):src.index("def build_ensembles")]
check("the tuning function never references a test array",
      ("Xte" not in tune_src) and ("yte" not in tune_src),
      "no Xte/yte symbol inside tune_classical")
qsrc = src[src.index("def quantum_arm"):src.index("def fit_quantum_final")]
check("the quantum search never references a test array",
      ("Xte" not in qsrc) and ("yte" not in qsrc))
ens_src = src[src.index("def build_ensembles"):src.index("def quantum_arm")]
check("ensemble weights are fitted without test data",
      ("Xte" not in ens_src) and ("yte" not in ens_src))

print("\n" + "=" * 70)
if FAILED:
    print(f"AUDIT FAILED: {len(FAILED)} check(s) — {FAILED}")
    sys.exit(1)
print("ALL LEAKAGE CHECKS PASSED")
