"""Stress-test the ceiling claim.

If the ceiling is real, three things must hold:
  1. Nothing beats ~0.90 on clean rows, however hard we tune.
  2. Corrupted-row labels are not produced by the clean-row rule.
  3. Nothing in the corruption PATTERN predicts the label beyond the base rate.
Dev partition only.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import warnings

warnings.filterwarnings("ignore")

from sklearn.ensemble import (HistGradientBoostingClassifier, RandomForestClassifier,
                              ExtraTreesClassifier)
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold, train_test_split
from sklearn.neural_network import MLPClassifier
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler, PolynomialFeatures, SplineTransformer
from sklearn.svm import SVC
import lightgbm as lgb
import xgboost as xgb

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
    q1, q3 = np.quantile(Xfit, 0.25, axis=0), np.quantile(Xfit, 0.75, axis=0)
    iqr = q3 - q1
    return (Xapply < q1 - k * iqr) | (Xapply > q3 + k * iqr)


M = tail_mask(Xdev, Xdev)
cnt = M.sum(axis=1)
clean = cnt <= 2
Xc, yc = Xdev[clean], ydev[clean]
Xk, yk = Xdev[~clean], ydev[~clean]


def cvacc(make, X, y):
    oof = np.zeros(len(y))
    for tr, va in cv.split(X, y):
        oof[va] = make().fit(X[tr], y[tr]).predict(X[va])
    return (oof == y).mean()


banner("1 | HOW HARD CAN WE PUSH THE CLEAN REGIME? (5-fold CV, clean rows only)")
zoo = {
    "LogReg": lambda: make_pipeline(StandardScaler(), LogisticRegression(max_iter=5000)),
    "LogReg poly2": lambda: make_pipeline(StandardScaler(), PolynomialFeatures(2, include_bias=False),
                                          LogisticRegression(max_iter=20000)),
    "LogReg poly3": lambda: make_pipeline(StandardScaler(), PolynomialFeatures(3, include_bias=False),
                                          LogisticRegression(max_iter=30000, C=0.5)),
    "LogReg splines": lambda: make_pipeline(StandardScaler(), SplineTransformer(n_knots=8, degree=3),
                                            LogisticRegression(max_iter=30000)),
    "RBF-SVM C=10": lambda: make_pipeline(StandardScaler(), SVC(C=10, gamma="scale")),
    "RBF-SVM C=100": lambda: make_pipeline(StandardScaler(), SVC(C=100, gamma=0.05)),
    "RandomForest": lambda: RandomForestClassifier(n_estimators=800, min_samples_leaf=5,
                                                   random_state=RNG, n_jobs=-1),
    "ExtraTrees": lambda: ExtraTreesClassifier(n_estimators=800, min_samples_leaf=5,
                                               random_state=RNG, n_jobs=-1),
    "HistGB": lambda: HistGradientBoostingClassifier(random_state=RNG, max_iter=600,
                                                     learning_rate=0.05),
    "LightGBM": lambda: lgb.LGBMClassifier(n_estimators=1200, learning_rate=0.03,
                                           num_leaves=63, subsample=0.8,
                                           colsample_bytree=0.8, random_state=RNG,
                                           n_jobs=-1, verbose=-1),
    "XGBoost": lambda: xgb.XGBClassifier(n_estimators=1200, learning_rate=0.03,
                                         max_depth=6, subsample=0.8,
                                         colsample_bytree=0.8, tree_method="hist",
                                         random_state=RNG, n_jobs=-1, verbosity=0),
    "MLP 256-128": lambda: make_pipeline(StandardScaler(),
                                         MLPClassifier((256, 128), max_iter=800,
                                                       random_state=RNG, early_stopping=True)),
}
res = {}
for n, mk in zoo.items():
    res[n] = cvacc(mk, Xc, yc)
    print(f"  {n:18s} {res[n]:.4f}")
print(f"\n  best {max(res, key=res.get)} = {max(res.values()):.4f}")
sc = StandardScaler().fit(Xc)
lr = LogisticRegression(max_iter=5000).fit(sc.transform(Xc), yc)
p_clean = lr.predict_proba(sc.transform(Xc))[:, 1]
print(f"  logistic Bayes estimate E[max(p,1-p)] = {np.maximum(p_clean,1-p_clean).mean():.4f}")

banner("2 | DOES THE CLEAN RULE EXPLAIN CORRUPTED-ROW LABELS?")
p_k = lr.predict_proba(sc.transform(Xk))[:, 1]
print(f"clean-rule accuracy applied to corrupted rows: {((p_k>=.5).astype(int)==yk).mean():.4f}")
print(f"corrupted-row base rate (majority):            {max(yk.mean(),1-yk.mean()):.4f}")
print(f"corrupted-row potable fraction:                {yk.mean():.4f}")
print(f"mean |p-0.5| on corrupted rows: {np.abs(p_k-0.5).mean():.4f}  "
      f"(clean rows: {np.abs(p_clean-0.5).mean():.4f})")
print("\nIf corrupted labels came from the same logistic rule, accuracy here would")
print("be high because wide-component inputs push sigma(w.x) to the extremes.")

banner("3 | IS THERE SIGNAL IN THE CORRUPTION PATTERN ITSELF? (corrupt rows only)")
Pat = np.hstack([Xk, M[~clean].astype(float), cnt[~clean].reshape(-1, 1)])
print(f"  majority baseline                {max(yk.mean(),1-yk.mean()):.4f}")
print(f"  HistGB on raw features           {cvacc(lambda: HistGradientBoostingClassifier(random_state=RNG, max_iter=400), Xk, yk):.4f}")
print(f"  HistGB on features+mask+count    {cvacc(lambda: HistGradientBoostingClassifier(random_state=RNG, max_iter=400), Pat, yk):.4f}")
print(f"  HistGB on mask+count only        {cvacc(lambda: HistGradientBoostingClassifier(random_state=RNG, max_iter=400), Pat[:, 9:], yk):.4f}")
print(f"  LogReg on raw features           {cvacc(lambda: make_pipeline(StandardScaler(), LogisticRegression(max_iter=5000)), Xk, yk):.4f}")

banner("4 | FULL-DATA MODEL WITH REGIME FEATURES (5-fold CV on all dev rows)")
def build(Xfit, Xap):
    Mm = tail_mask(Xfit, Xap)
    return np.hstack([Xap, Mm.astype(float), Mm.sum(1, keepdims=True)])

for name, mk in [
    ("HistGB raw", lambda: HistGradientBoostingClassifier(random_state=RNG, max_iter=500)),
    ("LightGBM raw", lambda: lgb.LGBMClassifier(n_estimators=1000, learning_rate=0.03,
                                                num_leaves=63, random_state=RNG,
                                                n_jobs=-1, verbose=-1)),
]:
    for tag, fx in [("plain", False), ("+regime feats", True)]:
        oof = np.zeros(len(ydev))
        for tr, va in cv.split(Xdev, ydev):
            A = build(Xdev[tr], Xdev[tr]) if fx else Xdev[tr]
            B = build(Xdev[tr], Xdev[va]) if fx else Xdev[va]
            oof[va] = mk().fit(A, ydev[tr]).predict(B)
        print(f"  {name:14s} {tag:15s} {(oof == ydev).mean():.4f}")

banner("5 | TWO-SPECIALIST MODEL (route by regime, fit each separately)")
oof = np.zeros(len(ydev))
for tr, va in cv.split(Xdev, ydev):
    Mtr, Mva = tail_mask(Xdev[tr], Xdev[tr]), tail_mask(Xdev[tr], Xdev[va])
    ctr, cva = Mtr.sum(1) <= 2, Mva.sum(1) <= 2
    # clean specialist
    m1 = make_pipeline(StandardScaler(), PolynomialFeatures(2, include_bias=False),
                       LogisticRegression(max_iter=20000)).fit(Xdev[tr][ctr], ydev[tr][ctr])
    # corrupt specialist
    m2 = HistGradientBoostingClassifier(random_state=RNG, max_iter=300).fit(
        Xdev[tr][~ctr], ydev[tr][~ctr])
    out = np.zeros(len(va))
    if cva.any():
        out[cva] = m1.predict(Xdev[va][cva])
    if (~cva).any():
        out[~cva] = m2.predict(Xdev[va][~cva])
    oof[va] = out
print(f"  two-specialist CV accuracy: {(oof == ydev).mean():.4f}")
