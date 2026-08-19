"""Forensic EDA for the Water Potability table.

Every estimated quantity here is computed on the DEV partition only. The test
partition is split off first and never touched, so nothing in this file can
inform a later modelling choice through the test labels.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from scipy import stats
from sklearn.mixture import GaussianMixture
from sklearn.model_selection import train_test_split, cross_val_score, StratifiedKFold
from sklearn.neighbors import NearestNeighbors
from sklearn.preprocessing import StandardScaler, QuantileTransformer
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.feature_selection import mutual_info_classif

RNG = 42
TARGET = "Potability"
pd.set_option("display.width", 200)


def banner(t):
    print(f"\n{'='*78}\n{t}\n{'='*78}", flush=True)


df = pd.read_csv("water_quality_potability.csv")
FEATS = [c for c in df.columns if c != TARGET]
X_all = df[FEATS].to_numpy(float)
y_all = df[TARGET].to_numpy(int)

# Test split carved off IMMEDIATELY. Everything below sees dev only.
Xdev, Xte, ydev, yte = train_test_split(
    X_all, y_all, test_size=0.20, stratify=y_all, random_state=RNG
)
dev = pd.DataFrame(Xdev, columns=FEATS)
dev[TARGET] = ydev

banner("PARTITIONS")
print(f"total {len(X_all)}   dev {len(Xdev)}   test {len(Xte)} (frozen, untouched)")
print(f"dev class balance: {np.bincount(ydev)}")

# ---------------------------------------------------------------- 1. moments
banner("1 | PER-FEATURE MOMENTS AND TAIL RATE (dev only)")
rows = []
for c in FEATS:
    s = dev[c]
    q1, q3 = s.quantile(0.25), s.quantile(0.75)
    iqr = q3 - q1
    tail = (s < q1 - 1.5 * iqr) | (s > q3 + 1.5 * iqr)
    rows.append(
        dict(feature=c, mean=s.mean(), sd=s.std(), skew=stats.skew(s),
             exkurt=stats.kurtosis(s), pct_tail=100 * tail.mean(),
             iqr=iqr, range=s.max() - s.min(), ratio_range_iqr=(s.max() - s.min()) / iqr)
    )
mom = pd.DataFrame(rows)
print(mom.round(3).to_string(index=False))
print(f"\ntail-rate spread across 9 features: "
      f"{mom.pct_tail.min():.2f}% .. {mom.pct_tail.max():.2f}%  "
      f"(sd {mom.pct_tail.std():.3f})")

# ------------------------------------------------- 2. cell- vs row-level test
banner("2 | IS CONTAMINATION CELL-LEVEL OR ROW-LEVEL?")
tailmask = np.zeros_like(Xdev, dtype=bool)
for j, c in enumerate(FEATS):
    s = dev[c]
    q1, q3 = s.quantile(0.25), s.quantile(0.75)
    iqr = q3 - q1
    tailmask[:, j] = ((s < q1 - 1.5 * iqr) | (s > q3 + 1.5 * iqr)).to_numpy()

per_row = tailmask.sum(axis=1)
obs = np.bincount(per_row, minlength=10)[:10]
p_hat = tailmask.mean()
exp = stats.binom.pmf(np.arange(10), 9, p_hat) * len(dev)
print(f"overall cell tail rate p = {p_hat:.4f}")
print(f"{'k':>3} {'observed':>10} {'Binom(9,p)':>12}")
for k in range(10):
    print(f"{k:>3} {obs[k]:>10d} {exp[k]:>12.1f}")
chi2 = ((obs - exp) ** 2 / np.maximum(exp, 1e-9)).sum()
print(f"\nchi2 vs independent-cell model: {chi2:.1f}")
print(f"observed mean tails/row {per_row.mean():.3f}  binomial expectation {9*p_hat:.3f}")
print(f"observed var {per_row.var():.3f}  binomial var {9*p_hat*(1-p_hat):.3f}")
print("rows with 0 tails: %d (%.1f%%)   rows with >=5 tails: %d (%.2f%%)"
      % ((per_row == 0).sum(), 100*(per_row == 0).mean(),
         (per_row >= 5).sum(), 100*(per_row >= 5).mean()))

# ------------------------------------------------ 3. mixture structure / core
banner("3 | TWO-COMPONENT MIXTURE PER FEATURE (dev only)")
mrows = []
for j, c in enumerate(FEATS):
    v = dev[c].to_numpy().reshape(-1, 1)
    gm = GaussianMixture(2, random_state=RNG, n_init=3).fit(v)
    order = np.argsort(gm.covariances_.ravel())  # narrow first
    narrow, wide = order
    resp = gm.predict_proba(v)
    in_wide = resp[:, wide] > 0.5
    mrows.append(dict(
        feature=c,
        w_narrow=gm.weights_[narrow], sd_narrow=np.sqrt(gm.covariances_.ravel()[narrow]),
        w_wide=gm.weights_[wide], sd_wide=np.sqrt(gm.covariances_.ravel()[wide]),
        sd_ratio=np.sqrt(gm.covariances_.ravel()[wide] / gm.covariances_.ravel()[narrow]),
        pct_wide=100 * in_wide.mean()))
mix = pd.DataFrame(mrows)
print(mix.round(3).to_string(index=False))

# -------------------------------- 4. is the tail informative about the label?
banner("4 | LABEL INFORMATION IN CORE CELLS vs TAIL CELLS")
print("Spearman |rho| with target computed on core rows vs tail rows, per feature.")
irows = []
for j, c in enumerate(FEATS):
    core = ~tailmask[:, j]
    tail = tailmask[:, j]
    rc = stats.spearmanr(dev[c][core], ydev[core]).statistic if core.sum() > 30 else np.nan
    rt = stats.spearmanr(dev[c][tail], ydev[tail]).statistic if tail.sum() > 30 else np.nan
    # class balance inside tail cells: if tails were pure noise, ~50/50
    irows.append(dict(feature=c, n_core=int(core.sum()), n_tail=int(tail.sum()),
                      rho_core=rc, rho_tail=rt,
                      pct_potable_core=100*ydev[core].mean(),
                      pct_potable_tail=100*ydev[tail].mean()))
inf = pd.DataFrame(irows)
print(inf.round(4).to_string(index=False))

# ------------------------------------------- 5. accuracy vs clean-cell count
banner("5 | DOES ACCURACY DEGRADE WITH TAIL COUNT? (5-fold CV on dev)")
cv = StratifiedKFold(5, shuffle=True, random_state=RNG)
oof = np.zeros(len(ydev))
for tr, va in cv.split(Xdev, ydev):
    m = HistGradientBoostingClassifier(random_state=RNG, max_iter=300).fit(Xdev[tr], ydev[tr])
    oof[va] = m.predict_proba(Xdev[va])[:, 1]
pred = (oof >= 0.5).astype(int)
print(f"baseline HistGB OOF accuracy on dev: {(pred == ydev).mean():.4f}")
print(f"{'tails':>6} {'n':>7} {'accuracy':>10}")
for k in range(0, 7):
    sel = per_row == k if k < 6 else per_row >= 6
    if sel.sum() < 20:
        continue
    print(f"{k if k<6 else '6+':>6} {sel.sum():>7d} {(pred[sel] == ydev[sel]).mean():>10.4f}")

# ------------------------------------------ 6. empirical Bayes-error probe
banner("6 | NEAR-DUPLICATE CONFLICT RATE (empirical Bayes-error probe, dev only)")
Z = StandardScaler().fit_transform(Xdev)
nn = NearestNeighbors(n_neighbors=2).fit(Z)
d, idx = nn.kneighbors(Z)
d1, nb = d[:, 1], idx[:, 1]
conflict = ydev != ydev[nb]
for q in (0.001, 0.01, 0.05, 0.10, 0.25, 0.50):
    thr = np.quantile(d1, q)
    sel = d1 <= thr
    print(f"  closest {q*100:5.1f}% of pairs (dist<={thr:.4f}): "
          f"label-conflict rate {conflict[sel].mean():.4f}  n={sel.sum()}")
print(f"  overall 1-NN label-conflict rate: {conflict.mean():.4f}")
print(f"  => 1-NN error estimate implies Bayes error roughly in "
      f"[{conflict.mean()/2:.4f}, {conflict.mean():.4f}]")

# --------------------------------------------------- 7. local overlap in dev
banner("7 | LOCAL LABEL AGREEMENT (k=25, dev only)")
nn2 = NearestNeighbors(n_neighbors=26).fit(Z)
_, idx2 = nn2.kneighbors(Z)
agree = (ydev[idx2[:, 1:]] == ydev[:, None]).mean(axis=1)
print(f"mean local agreement: {agree.mean():.4f}")
print(f"fraction in majority-disagreeing neighbourhoods: {(agree < 0.5).mean():.4f}")
print(f"OOF error inside those: {(pred != ydev)[agree < 0.5].mean():.4f}")
print(f"OOF error outside:      {(pred != ydev)[agree >= 0.5].mean():.4f}")

# same, but in a quantile-transformed space (tails compressed)
Zq = QuantileTransformer(output_distribution="normal", random_state=RNG).fit_transform(Xdev)
nn3 = NearestNeighbors(n_neighbors=26).fit(Zq)
_, idx3 = nn3.kneighbors(Zq)
agree_q = (ydev[idx3[:, 1:]] == ydev[:, None]).mean(axis=1)
print(f"\nsame metric under QuantileTransformer(normal):")
print(f"mean local agreement: {agree_q.mean():.4f}   "
      f"disagreeing fraction: {(agree_q < 0.5).mean():.4f}")

# --------------------------------------------------------- 8. mutual information
banner("8 | MUTUAL INFORMATION WITH TARGET (dev only, bits)")
mi = mutual_info_classif(Xdev, ydev, random_state=RNG) / np.log(2)
mitab = pd.DataFrame({"feature": FEATS, "MI_bits": mi}).sort_values("MI_bits", ascending=False)
print(mitab.round(4).to_string(index=False))
print(f"sum of marginal MI: {mi.sum():.4f} bits   target entropy: 1.0000 bits")

# MI on core-only values (tails masked to NaN then dropped per-feature)
print("\nMI computed on core cells only (per feature, tail rows dropped):")
core_mi = []
for j, c in enumerate(FEATS):
    core = ~tailmask[:, j]
    v = Xdev[core, j].reshape(-1, 1)
    core_mi.append(mutual_info_classif(v, ydev[core], random_state=RNG)[0] / np.log(2))
print(pd.DataFrame({"feature": FEATS, "MI_core_bits": core_mi, "MI_full_bits": mi})
      .sort_values("MI_core_bits", ascending=False).round(4).to_string(index=False))

# ------------------------------------------------ 9. adversarial validation
banner("9 | ADVERSARIAL VALIDATION (dev vs test) — distribution shift check")
Xadv = np.vstack([Xdev, Xte])
yadv = np.r_[np.zeros(len(Xdev)), np.ones(len(Xte))]
auc = cross_val_score(HistGradientBoostingClassifier(random_state=RNG, max_iter=200),
                      Xadv, yadv, cv=StratifiedKFold(5, shuffle=True, random_state=RNG),
                      scoring="roc_auc")
print(f"dev-vs-test discriminability AUC: {auc.mean():.4f} +/- {auc.std():.4f}")
print("(0.50 = identically distributed; this uses NO test labels, only the split id)")

print("\nforensics complete.")
