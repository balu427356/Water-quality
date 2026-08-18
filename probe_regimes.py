"""How well can we do on clean rows alone, and what is the corrupted-row ceiling?

Dev partition only. Decides whether a two-regime model can reach the target.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from scipy import stats
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.model_selection import StratifiedKFold, train_test_split
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVC

RNG = 42
TARGET = "Potability"

df = pd.read_csv("water_quality_potability.csv")
FEATS = [c for c in df.columns if c != TARGET]
X_all, y_all = df[FEATS].to_numpy(float), df[TARGET].to_numpy(int)
Xdev, Xte, ydev, yte = train_test_split(X_all, y_all, test_size=0.20,
                                        stratify=y_all, random_state=RNG)


def banner(t):
    print(f"\n{'='*78}\n{t}\n{'='*78}", flush=True)


def tail_counts(Xfit, Xapply, k=1.5):
    """Count per-row tail cells. Bounds estimated on Xfit only."""
    q1 = np.quantile(Xfit, 0.25, axis=0)
    q3 = np.quantile(Xfit, 0.75, axis=0)
    iqr = q3 - q1
    lo, hi = q1 - k * iqr, q3 + k * iqr
    return ((Xapply < lo) | (Xapply > hi)).sum(axis=1)


cnt_dev = tail_counts(Xdev, Xdev)
clean = cnt_dev <= 2
corrupt = ~clean

banner("REGIME SIZES (dev)")
print(f"clean   (<=2 tails): {clean.sum():5d}  ({100*clean.mean():.2f}%)  "
      f"potable rate {ydev[clean].mean():.4f}")
print(f"corrupt (>=3 tails): {corrupt.sum():5d}  ({100*corrupt.mean():.2f}%)  "
      f"potable rate {ydev[corrupt].mean():.4f}")

banner("A | CLEAN-ROW CEILING (5-fold CV within clean rows only)")
Xc, yc = Xdev[clean], ydev[clean]
cv = StratifiedKFold(5, shuffle=True, random_state=RNG)

for name, mk in [
    ("LogReg", lambda: LogisticRegression(max_iter=5000)),
    ("RBF-SVM", lambda: SVC(C=10, gamma="scale")),
    ("HistGB-300", lambda: HistGradientBoostingClassifier(random_state=RNG, max_iter=300)),
    ("HistGB-1000-lr03", lambda: HistGradientBoostingClassifier(
        random_state=RNG, max_iter=1000, learning_rate=0.03, max_leaf_nodes=63,
        l2_regularization=1.0, early_stopping=False)),
]:
    oof = np.zeros(len(yc))
    for tr, va in cv.split(Xc, yc):
        sc = StandardScaler().fit(Xc[tr])
        m = mk().fit(sc.transform(Xc[tr]), yc[tr])
        oof[va] = m.predict(sc.transform(Xc[va]))
    print(f"  {name:20s} clean-row CV accuracy {(oof == yc).mean():.4f}")

banner("B | CORRUPTED-ROW CEILING (5-fold CV within corrupted rows only)")
Xk, yk = Xdev[corrupt], ydev[corrupt]
print(f"  majority-class baseline: {max(yk.mean(), 1-yk.mean()):.4f}")
for name, mk in [
    ("LogReg", lambda: LogisticRegression(max_iter=5000)),
    ("HistGB-300", lambda: HistGradientBoostingClassifier(random_state=RNG, max_iter=300)),
]:
    oof = np.zeros(len(yk))
    for tr, va in cv.split(Xk, yk):
        sc = StandardScaler().fit(Xk[tr])
        m = mk().fit(sc.transform(Xk[tr]), yk[tr])
        oof[va] = m.predict(sc.transform(Xk[va]))
    print(f"  {name:20s} corrupt-row CV accuracy {(oof == yk).mean():.4f}")

banner("C | IMPLIED OVERALL CEILING")
w_clean, w_corr = clean.mean(), corrupt.mean()
base_corr = max(ydev[corrupt].mean(), 1 - ydev[corrupt].mean())
print(f"  overall = {w_clean:.4f} * C_clean + {w_corr:.4f} * C_corrupt")
for cc in (0.90, 0.93, 0.95, 0.97, 0.99, 1.00):
    for kk in (base_corr, 0.65):
        pass
    print(f"    C_clean={cc:.2f}, C_corrupt={base_corr:.3f}  ->  "
          f"{w_clean*cc + w_corr*base_corr:.4f}")
print(f"\n  to hit 0.90 overall with C_corrupt={base_corr:.3f}, need C_clean = "
      f"{(0.90 - w_corr*base_corr)/w_clean:.4f}")

banner("D | WHAT DO CLEAN ROWS LOOK LIKE? (correlations on clean rows, dev)")
rows = []
for j, c in enumerate(FEATS):
    rows.append(dict(feature=c,
                     rho_clean=stats.spearmanr(Xdev[clean, j], ydev[clean]).statistic,
                     rho_all=stats.spearmanr(Xdev[:, j], ydev).statistic))
print(pd.DataFrame(rows).round(4).to_string(index=False))

banner("E | IS THE CLEAN REGIME A SIMPLE RULE? (single-feature thresholds, clean rows)")
for j, c in enumerate(FEATS):
    v = Xdev[clean, j]
    best, bt = 0.0, None
    for t in np.quantile(v, np.linspace(0.02, 0.98, 97)):
        for sign in (1, -1):
            acc = (((v > t) if sign > 0 else (v <= t)).astype(int) == yc).mean()
            if acc > best:
                best, bt = acc, (t, sign)
    print(f"  {c:18s} best single-threshold accuracy {best:.4f}  at {bt[0]:.4f}")
