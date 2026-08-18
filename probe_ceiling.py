"""Two questions.

1. Is the clean regime already at its Bayes limit? If the label is generated as
   y ~ Bernoulli(sigma(w.x)), the best possible accuracy is E[max(p, 1-p)].
   Comparing that to measured accuracy tells us whether more model capacity can
   ever help.
2. Corrupted rows are not uniformly hopeless: a row with 6 tail cells still has
   3 informative ones. Masking tail cells to NaN and using a NaN-native learner
   should recover that. Does it?

Dev partition only.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold, train_test_split
from sklearn.preprocessing import StandardScaler, PolynomialFeatures
from sklearn.pipeline import make_pipeline

RNG = 42
TARGET = "Potability"
df = pd.read_csv("water_quality_potability.csv")
FEATS = [c for c in df.columns if c != TARGET]
X_all, y_all = df[FEATS].to_numpy(float), df[TARGET].to_numpy(int)
Xdev, Xte, ydev, yte = train_test_split(X_all, y_all, test_size=0.20,
                                        stratify=y_all, random_state=RNG)
cv = StratifiedKFold(5, shuffle=True, random_state=RNG)


def banner(t):
    print(f"\n{'='*78}\n{t}\n{'='*78}", flush=True)


def tail_mask(Xfit, Xapply, k=1.5):
    q1 = np.quantile(Xfit, 0.25, axis=0)
    q3 = np.quantile(Xfit, 0.75, axis=0)
    iqr = q3 - q1
    return (Xapply < q1 - k * iqr) | (Xapply > q3 + k * iqr)


M_dev = tail_mask(Xdev, Xdev)
cnt_dev = M_dev.sum(axis=1)
clean = cnt_dev <= 2

# ------------------------------------------------------------------ Q1
banner("Q1 | IS THE CLEAN REGIME AT ITS BAYES LIMIT?")
Xc, yc = Xdev[clean], ydev[clean]
sc = StandardScaler().fit(Xc)
lr = LogisticRegression(max_iter=5000).fit(sc.transform(Xc), yc)
p = lr.predict_proba(sc.transform(Xc))[:, 1]
print(f"in-sample accuracy            {( (p>=.5).astype(int)==yc).mean():.4f}")
print(f"E[max(p,1-p)] (Bayes acc if the logistic model IS the truth): "
      f"{np.maximum(p, 1-p).mean():.4f}")

print("\ncalibration — if the logistic model is the true generator, observed"
      "\nfrequency should track predicted probability inside each bin:")
bins = np.linspace(0, 1, 11)
b = np.clip(np.digitize(p, bins) - 1, 0, 9)
print(f"{'bin':>12} {'n':>6} {'mean pred':>10} {'observed':>10}")
for i in range(10):
    s = b == i
    if s.sum() < 10:
        continue
    print(f"{bins[i]:.1f}-{bins[i+1]:.1f}   {s.sum():>6d} "
          f"{p[s].mean():>10.4f} {yc[s].mean():>10.4f}")

print("\ncan extra capacity beat plain logistic on clean rows? (5-fold CV)")
for name, mk in [
    ("LogReg (linear)", lambda: make_pipeline(StandardScaler(), LogisticRegression(max_iter=5000))),
    ("LogReg + poly2", lambda: make_pipeline(
        StandardScaler(), PolynomialFeatures(2, include_bias=False),
        LogisticRegression(max_iter=20000, C=1.0))),
    ("HistGB deep", lambda: HistGradientBoostingClassifier(
        random_state=RNG, max_iter=800, learning_rate=0.05, max_leaf_nodes=63)),
]:
    oof = np.zeros(len(yc))
    for tr, va in cv.split(Xc, yc):
        oof[va] = mk().fit(Xc[tr], yc[tr]).predict(Xc[va])
    print(f"  {name:22s} {(oof == yc).mean():.4f}")

# ------------------------------------------------------------------ Q2
banner("Q2 | ACCURACY BY EXACT TAIL COUNT (baseline HistGB on raw features)")
oof_raw = np.zeros(len(ydev))
for tr, va in cv.split(Xdev, ydev):
    m = HistGradientBoostingClassifier(random_state=RNG, max_iter=400).fit(Xdev[tr], ydev[tr])
    oof_raw[va] = m.predict_proba(Xdev[va])[:, 1]
pr_raw = (oof_raw >= .5).astype(int)
print(f"overall raw-feature OOF accuracy: {(pr_raw == ydev).mean():.4f}")
print(f"{'tails':>6} {'n':>6} {'n_clean_cells':>14} {'accuracy':>10} {'base rate':>10}")
for k in range(10):
    s = cnt_dev == k
    if s.sum() < 10:
        continue
    base = max(ydev[s].mean(), 1 - ydev[s].mean())
    print(f"{k:>6} {s.sum():>6d} {9-k:>14d} {(pr_raw[s]==ydev[s]).mean():>10.4f} {base:>10.4f}")

banner("Q3 | DOES MASKING TAIL CELLS TO NaN HELP? (NaN-native HistGB)")
oof_msk = np.zeros(len(ydev))
for tr, va in cv.split(Xdev, ydev):
    Mtr = tail_mask(Xdev[tr], Xdev[tr])
    Mva = tail_mask(Xdev[tr], Xdev[va])          # bounds from TRAIN fold only
    A, B = Xdev[tr].copy(), Xdev[va].copy()
    A[Mtr] = np.nan
    B[Mva] = np.nan
    # keep the corruption pattern itself as features
    A = np.hstack([A, Mtr.astype(float), Mtr.sum(1, keepdims=True)])
    B = np.hstack([B, Mva.astype(float), Mva.sum(1, keepdims=True)])
    m = HistGradientBoostingClassifier(random_state=RNG, max_iter=400).fit(A, ydev[tr])
    oof_msk[va] = m.predict_proba(B)[:, 1]
pr_msk = (oof_msk >= .5).astype(int)
print(f"overall masked OOF accuracy: {(pr_msk == ydev).mean():.4f}   "
      f"(raw was {(pr_raw == ydev).mean():.4f})")
print(f"{'tails':>6} {'n':>6} {'raw':>9} {'masked':>9} {'delta':>9}")
for k in range(10):
    s = cnt_dev == k
    if s.sum() < 10:
        continue
    a, bq = (pr_raw[s] == ydev[s]).mean(), (pr_msk[s] == ydev[s]).mean()
    print(f"{k:>6} {s.sum():>6d} {a:>9.4f} {bq:>9.4f} {bq-a:>+9.4f}")

banner("Q4 | ORACLE CEILING GIVEN THE REGIME STRUCTURE")
print("Best achievable = per-tail-count ceiling, where the clean regime is capped")
print("by its logistic Bayes rate and fully-corrupt rows by their base rate.")
tot = 0.0
for k in range(10):
    s = cnt_dev == k
    if s.sum() == 0:
        continue
    if k <= 2:
        cap = np.maximum(p, 1 - p).mean()      # logistic Bayes on clean
    else:
        cap = max(ydev[s].mean(), 1 - ydev[s].mean())
        n_clean_cells = 9 - k
        if n_clean_cells > 0:
            cap = max(cap, (pr_msk[s] == ydev[s]).mean())
    tot += cap * s.sum()
print(f"implied overall ceiling: {tot/len(ydev):.4f}")
