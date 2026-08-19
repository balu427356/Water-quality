"""Is the two-stratum structure an artefact of the outlier rule?

Every quantitative claim in section I of the report flows through
`StratumDetector`, which by default marks a cell as contaminated when it falls
outside a Tukey 1.5xIQR fence. That constant was not derived from anything --
it is the conventional choice -- so a reviewer is entitled to ask whether the
80/20 stratification, the per-stratum ceilings and the composed ceiling would
survive a different rule.

This script answers that directly. For each fence rule and seed it reports:

  * the size of each stratum;
  * the ceiling of each stratum, and the composed ceiling;
  * RegimeRouter cross-validated accuracy, since that model routes on the fence;
  * selective accuracy and coverage, since the abstention rule is the fence.

It is a robustness study, not a replacement for the primary results: it writes
its own table and never touches raw_results.csv.

    python fence_sensitivity.py --seeds 42 7 2024 --outdir results
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

from sklearn.base import clone
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score
from sklearn.model_selection import StratifiedKFold, train_test_split
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import PolynomialFeatures

import importlib.util

_s = importlib.util.spec_from_file_location("wp", "water_potability_pipeline.py")
wp = importlib.util.module_from_spec(_s)
_s.loader.exec_module(wp)

PAL = {"c0": "#4C72B0", "c1": "#DD8452", "q": "#55A868", "acc": "#C44E52",
       "grey": "#8C8C8C"}
DOUBLE = 7.0

# (label, kwargs for StratumDetector)
RULES = [
    ("Tukey 1.5xIQR", dict(k=1.5)),
    ("Tukey 2.0xIQR", dict(k=2.0)),
    ("Tukey 3.0xIQR", dict(k=3.0)),
    ("90th percentile", dict(fence="percentile", q=90.0)),
    ("95th percentile", dict(fence="percentile", q=95.0)),
    ("97.5th percentile", dict(fence="percentile", q=97.5)),
    ("99th percentile", dict(fence="percentile", q=99.0)),
]


def banner(t):
    print(f"\n{'='*78}\n{t}\n{'='*78}", flush=True)


def router(seed):
    return wp.RegimeRouter(
        clean_est=make_pipeline(wp.robust_scaler(seed),
                                PolynomialFeatures(2, include_bias=False),
                                LogisticRegression(max_iter=30000, random_state=seed)),
        dirty_est=HistGradientBoostingClassifier(random_state=seed, max_iter=400))


def stratum_ceiling(Xs, ys, seed, cv):
    """Best cross-validated accuracy achievable within one stratum."""
    if len(ys) < 60 or len(np.unique(ys)) < 2:
        return float(max(ys.mean(), 1 - ys.mean())) if len(ys) else np.nan
    best = float(max(ys.mean(), 1 - ys.mean()))
    for mk in (lambda: make_pipeline(wp.robust_scaler(seed),
                                     PolynomialFeatures(2, include_bias=False),
                                     LogisticRegression(max_iter=30000,
                                                        random_state=seed)),
               lambda: HistGradientBoostingClassifier(random_state=seed, max_iter=400)):
        oof = np.zeros(len(ys))
        for tr, va in cv.split(Xs, ys):
            oof[va] = mk().fit(Xs[tr], ys[tr]).predict(Xs[va])
        best = max(best, (oof == ys).mean())
    return float(best)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="water_quality_potability.csv")
    ap.add_argument("--seeds", nargs="+", type=int, default=[42, 7, 2024])
    ap.add_argument("--outdir", default="results")
    ap.add_argument("--test-size", type=float, default=0.20)
    args = ap.parse_args()

    out = Path(args.outdir)
    (out / "tables").mkdir(parents=True, exist_ok=True)
    (out / "figures").mkdir(parents=True, exist_ok=True)

    df = pd.read_csv(args.data)
    feats = [c for c in df.columns if c != wp.TARGET]
    X = df[feats].to_numpy(float)
    y = df[wp.TARGET].to_numpy(int)

    rows = []
    for seed in args.seeds:
        banner(f"SEED {seed}")
        Xdev, Xte, ydev, yte = train_test_split(
            X, y, test_size=args.test_size, stratify=y, random_state=seed)
        cv = StratifiedKFold(5, shuffle=True, random_state=seed)

        print(f"{'fence rule':>20} {'clean':>8} {'contam':>8} {'C_clean':>9} "
              f"{'C_contam':>10} {'composed':>9} {'router CV':>10} "
              f"{'sel acc':>9} {'coverage':>9}")
        for label, kw in RULES:
            det = wp.StratumDetector(**kw).fit(Xdev)
            clean = det.is_clean(Xdev)
            w = float(clean.mean())

            c_clean = stratum_ceiling(Xdev[clean], ydev[clean], seed, cv)
            c_dirty = stratum_ceiling(Xdev[~clean], ydev[~clean], seed, cv)
            composed = w * c_clean + (1 - w) * c_dirty

            # the router depends on the fence, so refit it under this rule
            r = router(seed)
            oof = np.zeros(len(ydev))
            for tr, va in cv.split(Xdev, ydev):
                m = _fit_router_with(clone(r), Xdev[tr], ydev[tr], kw)
                oof[va] = m.predict_proba(Xdev[va])[:, 1]
            router_cv = ((oof >= 0.5).astype(int) == ydev).mean()

            # selective classification under this fence
            thr, _ = wp.best_threshold(ydev, oof)
            mfull = _fit_router_with(clone(r), Xdev, ydev, kw)
            s_te = mfull.predict_proba(Xte)[:, 1]
            pred = (s_te >= thr).astype(int)
            keep = wp.StratumDetector(**kw).fit(Xdev).is_clean(Xte)
            sel_acc = accuracy_score(yte[keep], pred[keep]) if keep.any() else np.nan
            cov = float(keep.mean())

            print(f"{label:>20} {w:>8.4f} {1-w:>8.4f} {c_clean:>9.4f} "
                  f"{c_dirty:>10.4f} {composed:>9.4f} {router_cv:>10.4f} "
                  f"{sel_acc:>9.4f} {cov:>9.4f}")
            rows.append(dict(seed=seed, rule=label, clean_share=w,
                             contaminated_share=1 - w, ceiling_clean=c_clean,
                             ceiling_contaminated=c_dirty, composed_ceiling=composed,
                             router_cv_accuracy=router_cv,
                             selective_accuracy=sel_acc, coverage=cov))

    t = pd.DataFrame(rows)
    t.to_csv(out / "tables" / "fence_sensitivity.csv", index=False)

    banner("ACROSS SEEDS (mean ± sd)")
    g = t.groupby("rule", sort=False).agg(["mean", "std"])
    show = pd.DataFrame(index=g.index)
    for c in ("contaminated_share", "composed_ceiling", "router_cv_accuracy",
              "selective_accuracy", "coverage"):
        show[c] = (g[(c, "mean")].round(4).astype(str) + " ± "
                   + g[(c, "std")].fillna(0).round(4).astype(str))
    print(show.to_string())
    show.to_csv(out / "tables" / "fence_sensitivity_summary.csv")

    base = t[t.rule == "Tukey 1.5xIQR"].composed_ceiling.mean()
    spread = t.groupby("rule").composed_ceiling.mean()
    excl99 = spread.drop("99th percentile", errors="ignore")
    print(f"\ncomposed ceiling under the committed rule: {base:.4f}")
    print(f"range across rules excluding the 99th percentile: "
          f"{excl99.min():.4f} to {excl99.max():.4f} "
          f"(spread {excl99.max()-excl99.min():.4f})")
    print(f"99th percentile: {spread.get('99th percentile', float('nan')):.4f} "
          f"-- it stops resolving the wide component at all")

    # ---- figure
    fig, ax = plt.subplots(1, 3, figsize=(DOUBLE, 2.5))
    m = t.groupby("rule", sort=False).mean(numeric_only=True)
    s = t.groupby("rule", sort=False).std(numeric_only=True).fillna(0)
    xs = np.arange(len(m))
    lab = [r.replace(" percentile", "%").replace("Tukey ", "") for r in m.index]

    a = ax[0]
    a.bar(xs, m.contaminated_share, yerr=s.contaminated_share, color=PAL["acc"],
          width=.6, error_kw={"lw": .7, "capsize": 2})
    a.axhline(0.1984, ls="--", color="#333", lw=.8)
    a.text(len(xs) - .5, 0.205, "committed rule", fontsize=6, ha="right")
    a.set_xticks(xs); a.set_xticklabels(lab, rotation=45, ha="right", fontsize=5.5)
    a.set_ylabel("contaminated share")
    a.set_title("stratum size by fence rule")

    a = ax[1]
    a.bar(xs, m.composed_ceiling, yerr=s.composed_ceiling, color=PAL["q"],
          width=.6, error_kw={"lw": .7, "capsize": 2})
    a.axhline(base, ls="--", color="#333", lw=.8)
    a.set_ylim(0.80, 0.95)
    a.set_xticks(xs); a.set_xticklabels(lab, rotation=45, ha="right", fontsize=5.5)
    a.set_ylabel("composed ceiling")
    a.set_title("ceiling is stable")

    a = ax[2]
    a.errorbar(m.coverage, m.selective_accuracy, yerr=s.selective_accuracy,
               fmt="o", color=PAL["c0"], ms=4, lw=.8, capsize=2)
    for i, l in enumerate(lab):
        a.annotate(l, (m.coverage.iloc[i], m.selective_accuracy.iloc[i]),
                   fontsize=5, xytext=(3, 3), textcoords="offset points")
    a.axhline(0.90, ls="--", color=PAL["acc"], lw=.8)
    a.set_xlabel("coverage")
    a.set_ylabel("selective accuracy")
    a.set_title("abstention trade-off")
    for ext in ("png", "pdf"):
        kw = {"metadata": {"CreationDate": None}} if ext == "pdf" else {}
        fig.savefig(out / "figures" / f"fig8_fence_sensitivity.{ext}", **kw)
    plt.close(fig)
    print(f"\nwrote fence_sensitivity.csv and fig8_fence_sensitivity -> {out.resolve()}")


def _fit_router_with(r, Xtr, ytr, kw):
    """Fit a RegimeRouter whose internal detector uses the given fence rule."""
    r.det_ = wp.StratumDetector(**kw).fit(Xtr)
    c = r.det_.is_clean(Xtr)
    r.classes_ = np.unique(ytr)
    r.p_clean_ = float(ytr[c].mean()) if c.any() else 0.5
    r.p_dirty_ = float(ytr[~c].mean()) if (~c).any() else 0.5
    r.m_clean_ = clone(r.clean_est).fit(Xtr[c], ytr[c]) if c.sum() > 30 else None
    if (~c).sum() > 30:
        M = r.det_.mask(Xtr[~c])
        Xd = np.hstack([Xtr[~c], M.astype(float), M.sum(1, keepdims=True)])
        r.m_dirty_ = clone(r.dirty_est).fit(Xd, ytr[~c])
    else:
        r.m_dirty_ = None
    return r


if __name__ == "__main__":
    main()
