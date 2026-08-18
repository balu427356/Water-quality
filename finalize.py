"""Build the summary, statistics and figures from whatever seeds have finished.

The pipeline writes `raw_results.csv` after every seed, so this can be run
against a completed run or against one that was stopped early. It reads only
files the pipeline already produced and fits nothing, so it cannot introduce
leakage.

    python finalize.py --outdir results
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

METRICS = ["accuracy", "balanced_accuracy", "precision", "recall", "f1",
           "roc_auc", "pr_auc", "mcc"]
PAL = {"c0": "#4C72B0", "c1": "#DD8452", "q": "#55A868", "acc": "#C44E52",
       "grey": "#8C8C8C"}
DOUBLE = 7.0
PDF_META = {"CreationDate": None}


def banner(t):
    print(f"\n{'='*78}\n{t}\n{'='*78}")


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


def savefig(fig, out, name):
    for ext in ("png", "pdf"):
        kw = {"metadata": PDF_META} if ext == "pdf" else {}
        fig.savefig(out / "figures" / f"{name}.{ext}", **kw)
    plt.close(fig)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--outdir", default="results")
    ap.add_argument("--test-size", type=float, default=0.20)
    ap.add_argument("--n-total", type=int, default=10000)
    args = ap.parse_args()
    out = Path(args.outdir)
    journal_style()

    res = pd.read_csv(out / "tables" / "raw_results.csv")
    seeds = sorted(res.seed.unique())
    banner(f"SUMMARY OVER {len(seeds)} SEED(S): {seeds}")

    # Only models present in every seed are comparable across seeds.
    counts = res.groupby("model").seed.nunique()
    complete = counts[counts == len(seeds)].index
    dropped = [m for m in counts.index if m not in complete]
    if dropped:
        print(f"excluded (not present in every seed): {dropped}")
    res = res[res.model.isin(complete)]

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
    pretty["cv_acc"] = summary["cv_accuracy"].round(4)
    for m in ["accuracy", "balanced_accuracy", "precision", "recall", "f1",
              "roc_auc", "mcc"]:
        pretty[m] = (summary[m].round(4).astype(str) + " ± "
                     + summary[f"{m}_sd"].round(4).astype(str))
    print(pretty.to_string())
    pretty.to_csv(out / "tables" / "summary_formatted.csv")

    banner("STATISTICAL COMPARISON")
    wide = res.pivot_table(index="seed", columns="model", values="accuracy")
    wide = wide.dropna(axis=1)
    if wide.shape[1] >= 3 and wide.shape[0] >= 3:
        stat, p = stats.friedmanchisquare(*[wide[c].to_numpy() for c in wide.columns])
        print(f"Friedman chi2 = {stat:.3f}   p = {p:.4g}   "
              f"({wide.shape[1]} models x {wide.shape[0]} seeds)")
        ranks = wide.rank(axis=1, ascending=False).mean().sort_values()
        print("\nmean ranks (lower is better):")
        print(ranks.round(3).to_string())
        ranks.to_csv(out / "tables" / "mean_ranks.csv")
    else:
        print(f"Friedman needs >=3 models and >=3 seeds; have {wide.shape[1]} "
              f"models, {wide.shape[0]} seeds")

    # Nadeau-Bengio corrected paired t-tests against the best model. The naive
    # paired t-test is anti-conservative here because the training sets overlap
    # heavily across seeds; the correction inflates the variance accordingly.
    n_te = int(args.test_size * args.n_total)
    n_tr = args.n_total - n_te
    if "QSVM" in wide.columns:
        best = wide.drop(columns=["QSVM"]).mean().idxmax()
        rows = []
        for c in wide.columns:
            if c == best:
                continue
            d = wide[best] - wide[c]
            n = len(d)
            if n > 1 and d.std(ddof=1) > 0:
                t = d.mean() / np.sqrt((1 / n + n_te / n_tr) * d.var(ddof=1))
                pv = 2 * (1 - stats.t.cdf(abs(t), n - 1))
            else:
                t, pv = np.nan, np.nan
            rows.append(dict(model=c, mean_diff_vs_best=d.mean(), t=t, p=pv))
        tt = pd.DataFrame(rows).sort_values("mean_diff_vs_best")
        print(f"\nNadeau-Bengio corrected paired t-tests against {best} "
              f"({len(wide)} seeds):")
        print(tt.round(4).to_string(index=False))
        tt.to_csv(out / "tables" / "paired_tests.csv", index=False)

    if "feature_map" in res.columns:
        fm = res[res.model == "QSVM"]["feature_map"].dropna()
        if len(fm):
            print(f"\nquantum feature map chosen per seed: {fm.value_counts().to_dict()}")

    banner("CEILING VERDICT")
    ceil = None
    cpath = out / "tables" / "ceiling.json"
    if cpath.exists():
        ceil = json.load(open(cpath))
    best_name = summary.index[0]
    best_acc = float(summary.iloc[0]["accuracy"])
    best_sd = float(summary.iloc[0]["accuracy_sd"])
    print(f"best model          : {best_name}")
    print(f"mean test accuracy  : {best_acc:.4f} ± {best_sd:.4f} over {len(seeds)} seeds")
    if ceil:
        print(f"cross-validated ceiling : {ceil['composed_ceiling']:.4f}")
        print(f"  clean stratum        {ceil['p_clean']:.4f} x {ceil['ceiling_clean']:.4f}")
        print(f"  contaminated stratum {1-ceil['p_clean']:.4f} x "
              f"{ceil['ceiling_contaminated']:.4f}")
        cv_best = float(summary["cv_accuracy"].max())
        print(f"\nlike-for-like (both cross-validated, models trained on 6,400 rows):")
        print(f"  best CV accuracy {cv_best:.4f}  vs ceiling "
              f"{ceil['composed_ceiling']:.4f}   gap {ceil['composed_ceiling']-cv_best:+.4f}")
        print(f"\nreported test accuracies come from models refitted on all 8,000")
        print(f"development rows, which is worth roughly a point over the CV figure;")
        print(f"that is why the test number sits above the cross-validated ceiling.")
        for tgt in (0.90, 0.97):
            need = (tgt - (1 - ceil["p_clean"]) * ceil["ceiling_contaminated"]) / ceil["p_clean"]
            print(f"\n{int(tgt*100)}% target reached : {'YES' if best_acc >= tgt else 'NO'}")
            print(f"  the clean stratum would need accuracy {need:.4f}; its Bayes "
                  f"estimate is {ceil['bayes_clean_logistic']:.4f}")

    # ---- figure: ceiling decomposition + model comparison
    if ceil:
        fig, ax = plt.subplots(1, 2, figsize=(DOUBLE, 2.8))
        a = ax[0]
        labels = ["clean\nstratum", "contaminated\nstratum", "composed\nceiling"]
        vals = [ceil["ceiling_clean"], ceil["ceiling_contaminated"],
                ceil["composed_ceiling"]]
        b = a.bar(labels, vals, color=[PAL["c0"], PAL["acc"], PAL["q"]], width=.6)
        for r, v in zip(b, vals):
            a.text(r.get_x() + r.get_width() / 2, v, f"{v:.4f}", ha="center",
                   va="bottom", fontsize=7)
        a.axhline(0.97, ls="--", color=PAL["acc"], lw=.8)
        a.text(2.45, 0.973, "97% target", fontsize=6, color=PAL["acc"], ha="right")
        a.axhline(0.90, ls=":", color="#333", lw=.8)
        a.text(2.45, 0.903, "90% target", fontsize=6, color="#333", ha="right")
        a.set_ylim(0.5, 1.02)
        a.set_ylabel("accuracy")
        a.set_title("where the ceiling comes from")

        a = ax[1]
        s = summary.sort_values("accuracy")
        cols = [PAL["q"] if m == "QSVM" else PAL["c0"] for m in s.index]
        a.barh([m[:20] for m in s.index], s["accuracy"], xerr=s["accuracy_sd"],
               color=cols, height=.62,
               error_kw={"lw": .8, "capsize": 2, "ecolor": "#222"})
        a.axvline(ceil["composed_ceiling"], ls="--", color=PAL["acc"], lw=1.0)
        a.text(ceil["composed_ceiling"], len(s) - 0.2, " CV ceiling", fontsize=6,
               color=PAL["acc"], va="top")
        lo = min(s["accuracy"].min() - 0.02, 0.80)
        a.set_xlim(lo, max(0.88, s["accuracy"].max() + .02))
        a.set_xlabel(f"test accuracy (mean ± sd over {len(seeds)} seeds)")
        a.tick_params(axis="y", labelsize=6)
        a.set_title("every model saturates near the ceiling")
        savefig(fig, out, "fig2_ceiling")

    # ---- figure: classical vs quantum per seed
    if "QSVM" in wide.columns:
        fig, ax = plt.subplots(1, 2, figsize=(DOUBLE, 2.6))
        a = ax[0]
        top = wide.drop(columns=["QSVM"]).mean().idxmax()
        x = np.arange(len(wide))
        a.plot(x, wide[top], "o-", color=PAL["c0"], label=top)
        a.plot(x, wide["QSVM"], "s--", color=PAL["q"], label="QSVM")
        a.set_xticks(x)
        a.set_xticklabels([str(s) for s in wide.index])
        a.set_xlabel("seed")
        a.set_ylabel("test accuracy")
        a.legend()
        a.set_title("per-seed, paired")

        a = ax[1]
        d = (wide[top] - wide["QSVM"])
        a.bar(x, d, color=PAL["acc"], width=.6)
        a.axhline(0, color="#333", lw=.6)
        a.set_xticks(x)
        a.set_xticklabels([str(s) for s in wide.index])
        a.set_xlabel("seed")
        a.set_ylabel(f"{top} − QSVM")
        a.set_title(f"classical advantage (mean {d.mean():+.4f})")
        savefig(fig, out, "fig5_classical_vs_quantum")

    json.dump({"seeds": [int(s) for s in seeds], "best_model": best_name,
               "best_test_accuracy": best_acc, "best_test_accuracy_sd": best_sd,
               "ceiling": ceil},
              open(out / "manifest.json", "w"), indent=2, default=float)
    print(f"\nwrote summary.csv, summary_formatted.csv, manifest.json and figures "
          f"-> {out.resolve()}")


if __name__ == "__main__":
    main()
