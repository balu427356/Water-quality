"""Selective classification on the water potability table.

About a fifth of the rows are drawn from a contaminated component whose
features carry almost no information about the label. Forcing a prediction on
those rows is what drags full-coverage accuracy down to ~0.85. A selective
classifier abstains on them instead and reports accuracy together with the
fraction of rows it was willing to answer.

Two rejection rules are compared:

  stratum    abstain when the row falls in the contaminated stratum, decided by
             Tukey fences fitted on training data alone. The rule never sees a
             label, so coverage is fixed before any prediction is made.
  confidence abstain on the least confident predictions, the standard
             softmax-response baseline.

The point of including both is that the stratum rule is derived from data
quality rather than from the model's own uncertainty, so it is not circular:
it would reject the same rows for a model that had never been trained.

Every threshold and every fitted object comes from the development partition.
The test partition is scored once per seed.

    python selective.py --seeds 42 7 2024 --outdir results
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

from sklearn.base import clone
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, roc_auc_score
from sklearn.model_selection import StratifiedKFold, train_test_split
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import PolynomialFeatures

import importlib.util

spec = importlib.util.spec_from_file_location("wp", "water_potability_pipeline.py")
wp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wp)

PAL = {"c0": "#4C72B0", "c1": "#DD8452", "q": "#55A868", "acc": "#C44E52",
       "grey": "#8C8C8C"}
DOUBLE = 7.0


def banner(t):
    print(f"\n{'='*78}\n{t}\n{'='*78}", flush=True)


def build_model(seed, feats):
    """The regime-aware router, which is the pipeline's best full-coverage model."""
    return wp.RegimeRouter(
        clean_est=make_pipeline(wp.robust_scaler(seed),
                                PolynomialFeatures(2, include_bias=False),
                                LogisticRegression(max_iter=30000, random_state=seed)),
        dirty_est=HistGradientBoostingClassifier(random_state=seed, max_iter=400),
        feats=feats)


def risk_coverage(y, score, conf, thr):
    """Accuracy as a function of coverage, rejecting least-confident rows first."""
    pred = (score >= thr).astype(int)
    correct = (pred == y).astype(float)
    order = np.argsort(-conf)                      # most confident first
    c = correct[order]
    k = np.arange(1, len(y) + 1)
    return k / len(y), np.cumsum(c) / k


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

    rows, curves = [], []
    for seed in args.seeds:
        banner(f"SEED {seed}")
        Xdev, Xte, ydev, yte = train_test_split(
            X, y, test_size=args.test_size, stratify=y, random_state=seed)

        # --- threshold chosen on out-of-fold development predictions only
        cv = StratifiedKFold(5, shuffle=True, random_state=seed)
        oof = np.zeros(len(ydev))
        for tr, va in cv.split(Xdev, ydev):
            oof[va] = clone(build_model(seed, feats)).fit(
                Xdev[tr], ydev[tr]).predict_proba(Xdev[va])[:, 1]
        thr, oof_acc = wp.best_threshold(ydev, oof)
        print(f"threshold {thr:.4f} chosen on out-of-fold predictions "
              f"(OOF accuracy {oof_acc:.4f})")

        model = clone(build_model(seed, feats)).fit(Xdev, ydev)
        s_te = model.predict_proba(Xte)[:, 1]
        pred = (s_te >= thr).astype(int)

        # --- rejection rule 1: contaminated stratum, decided without labels
        det = wp.StratumDetector().fit(Xdev)
        keep = det.is_clean(Xte)
        cov = float(keep.mean())
        full_acc = accuracy_score(yte, pred)
        sel_acc = accuracy_score(yte[keep], pred[keep])
        rej_acc = accuracy_score(yte[~keep], pred[~keep]) if (~keep).any() else np.nan

        print(f"  full coverage      : accuracy {full_acc:.4f}  (n={len(yte)})")
        print(f"  stratum-selective  : accuracy {sel_acc:.4f} at coverage "
              f"{cov:.4f}  (n={int(keep.sum())})")
        print(f"  on abstained rows  : accuracy {rej_acc:.4f}  "
              f"(n={int((~keep).sum())})")

        # --- rejection rule 2: confidence baseline, matched to the same coverage
        conf = np.abs(s_te - thr)
        cut = np.quantile(conf, 1.0 - cov)
        keep_c = conf >= cut
        conf_acc = accuracy_score(yte[keep_c], pred[keep_c])
        print(f"  confidence-matched : accuracy {conf_acc:.4f} at coverage "
              f"{keep_c.mean():.4f}")

        auc = roc_auc_score(yte, s_te)
        rows.append(dict(seed=seed, threshold=thr, oof_accuracy=oof_acc,
                         full_accuracy=full_acc, coverage=cov,
                         selective_accuracy=sel_acc, abstained_accuracy=rej_acc,
                         confidence_matched_accuracy=conf_acc, roc_auc=auc,
                         n_test=len(yte), n_kept=int(keep.sum())))

        cv_, acc_ = risk_coverage(yte, s_te, conf, thr)
        curves.append(pd.DataFrame({"seed": seed, "coverage": cv_, "accuracy": acc_}))

    res = pd.DataFrame(rows)
    res.to_csv(out / "tables" / "selective_results.csv", index=False)
    allc = pd.concat(curves, ignore_index=True)
    allc.to_csv(out / "tables" / "risk_coverage_curves.csv", index=False)

    banner(f"SELECTIVE CLASSIFICATION SUMMARY ({len(args.seeds)} seeds)")
    m, s = res.mean(numeric_only=True), res.std(numeric_only=True).fillna(0.0)
    print(f"full coverage accuracy       : {m.full_accuracy:.4f} ± {s.full_accuracy:.4f}")
    print(f"coverage (clean stratum)     : {m.coverage:.4f} ± {s.coverage:.4f}")
    print(f"SELECTIVE ACCURACY           : {m.selective_accuracy:.4f} ± "
          f"{s.selective_accuracy:.4f}")
    print(f"accuracy on abstained rows   : {m.abstained_accuracy:.4f} ± "
          f"{s.abstained_accuracy:.4f}")
    print(f"confidence baseline, matched : {m.confidence_matched_accuracy:.4f} ± "
          f"{s.confidence_matched_accuracy:.4f}")
    gain = m.selective_accuracy - m.confidence_matched_accuracy
    print(f"\nstratum rule vs confidence rule at equal coverage: {gain:+.4f}")
    print(f"90% reached at {m.coverage:.1%} coverage: "
          f"{'YES' if m.selective_accuracy >= 0.90 else 'NO'}")

    # ---- figure
    fig, ax = plt.subplots(1, 2, figsize=(DOUBLE, 2.7))
    a = ax[0]
    for seed, g in allc.groupby("seed"):
        a.plot(g.coverage, g.accuracy, lw=1.0, alpha=.75, label=f"seed {seed}")
    a.axhline(0.90, ls="--", color=PAL["acc"], lw=.9)
    a.text(0.02, 0.903, "90%", fontsize=6, color=PAL["acc"])
    a.axvline(m.coverage, ls=":", color=PAL["c0"], lw=.9)
    a.text(m.coverage, 0.995, " clean stratum", fontsize=6, color=PAL["c0"],
           va="top", rotation=90)
    a.set_xlabel("coverage")
    a.set_ylabel("accuracy on answered rows")
    a.set_ylim(0.8, 1.0)
    a.legend(fontsize=6)
    a.set_title("risk-coverage (confidence rejection)")

    a = ax[1]
    labels = ["full\ncoverage", "stratum\nselective", "confidence\nmatched"]
    vals = [m.full_accuracy, m.selective_accuracy, m.confidence_matched_accuracy]
    errs = [s.full_accuracy, s.selective_accuracy, s.confidence_matched_accuracy]
    b = a.bar(labels, vals, yerr=errs, color=[PAL["grey"], PAL["q"], PAL["c0"]],
              width=.6, error_kw={"lw": .8, "capsize": 3})
    for r, v in zip(b, vals):
        a.text(r.get_x() + r.get_width() / 2, v, f"{v:.4f}", ha="center",
               va="bottom", fontsize=7)
    a.axhline(0.90, ls="--", color=PAL["acc"], lw=.9)
    a.text(2.45, 0.903, "90% target", fontsize=6, color=PAL["acc"], ha="right")
    a.set_ylim(0.75, 1.0)
    a.set_ylabel("accuracy")
    a.set_title(f"at {m.coverage:.1%} coverage")
    for ext in ("png", "pdf"):
        kw = {"metadata": {"CreationDate": None}} if ext == "pdf" else {}
        fig.savefig(out / "figures" / f"fig6_selective.{ext}", **kw)
    plt.close(fig)

    json.dump({k: (float(v) if isinstance(v, (int, float, np.floating)) else v)
               for k, v in m.to_dict().items()},
              open(out / "tables" / "selective_summary.json", "w"), indent=2)
    print(f"\nwrote selective_results.csv, risk_coverage_curves.csv, "
          f"fig6_selective -> {out.resolve()}")


if __name__ == "__main__":
    main()
