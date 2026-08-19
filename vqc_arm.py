"""VQC arm: hyperparameter search, matched controls, and test evaluation.

Runs as a separate stage so the classical and QSVM arms do not have to be
recomputed. It follows the same protocol as the quantum arm in
`water_potability_pipeline.py`:

  * configurations are scored on a validation split carved out of the
    development partition; the test partition is not touched during the search;
  * the winning configuration is frozen, refitted on the development partition,
    and used to score the test partition exactly once per seed;
  * two controls are reported -- a classical model on the identical PCA -> [0, pi]
    encoded features (matched representation), and classical models fitted on
    the identical subsample the VQC was limited to (matched sample size).

Results are appended to `results/tables/raw_results.csv` so `finalize.py` folds
the VQC into the multi-seed summary alongside every other model.

    python vqc_arm.py --seeds 42 7 2024 --outdir results
"""
from __future__ import annotations

import argparse
import itertools
import time
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
from sklearn.model_selection import train_test_split
from sklearn.neural_network import MLPClassifier
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

import importlib.util

_s = importlib.util.spec_from_file_location("wp", "water_potability_pipeline.py")
wp = importlib.util.module_from_spec(_s)
_s.loader.exec_module(wp)
_v = importlib.util.spec_from_file_location("vqcmod", "vqc.py")
vqcmod = importlib.util.module_from_spec(_v)
_v.loader.exec_module(vqcmod)
VQC = vqcmod.VQC

PAL = {"c0": "#4C72B0", "c1": "#DD8452", "q": "#55A868", "acc": "#C44E52",
       "grey": "#8C8C8C"}
DOUBLE = 7.0


def banner(t):
    print(f"\n{'='*78}\n{t}\n{'='*78}", flush=True)


def search_grid(quick):
    if quick:
        return dict(n_qubits=[4], reps=[2], fmap=["zz"], alpha=[0.5],
                    readout=["parity"])
    return dict(n_qubits=[4, 6, 8], reps=[2, 4], fmap=["zz", "z"],
                alpha=[0.25, 0.5, 1.0], readout=["parity", "z0"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="water_quality_potability.csv")
    ap.add_argument("--seeds", nargs="+", type=int, default=[42, 7, 2024])
    ap.add_argument("--outdir", default="results")
    ap.add_argument("--test-size", type=float, default=0.20)
    ap.add_argument("--sub", type=int, default=2000,
                    help="training subsample for the VQC search")
    ap.add_argument("--maxiter", type=int, default=400)
    ap.add_argument("--final-maxiter", type=int, default=1500)
    ap.add_argument("--quick", action="store_true")
    args = ap.parse_args()

    out = Path(args.outdir)
    (out / "tables").mkdir(parents=True, exist_ok=True)
    (out / "figures").mkdir(parents=True, exist_ok=True)

    df = pd.read_csv(args.data)
    feats = [c for c in df.columns if c != wp.TARGET]
    X = df[feats].to_numpy(float)
    y = df[wp.TARGET].to_numpy(int)

    grid = search_grid(args.quick)
    keys = list(grid)
    combos = list(itertools.product(*[grid[k] for k in keys]))
    print(f"VQC search space: {len(combos)} configurations per seed")

    new_rows, searches = [], []
    for seed in args.seeds:
        banner(f"SEED {seed}")
        Xdev, Xte, ydev, yte = train_test_split(
            X, y, test_size=args.test_size, stratify=y, random_state=seed)

        # internal split of the development partition; test is untouched here
        Xtr, Xva, ytr, yva = train_test_split(
            Xdev, ydev, test_size=0.25, stratify=ydev, random_state=seed)
        rng = np.random.default_rng(seed)
        if len(Xtr) > args.sub:
            i = rng.choice(len(Xtr), args.sub, replace=False)
            Xtr, ytr = Xtr[i], ytr[i]
        print(f"VQC train {len(Xtr)}  validation {len(Xva)}  "
              f"(test {len(yte)} held back)")

        recs = []
        t_start = time.time()
        for combo in combos:
            cfg = dict(zip(keys, combo))
            t0 = time.time()
            m = VQC(**cfg, maxiter=args.maxiter, n_restarts=1,
                    random_state=seed).fit(Xtr, ytr)
            acc = accuracy_score(yva, m.predict(Xva))
            recs.append(dict(seed=seed, **cfg, val_accuracy=acc,
                             n_params=m.n_params_, train_loss=m.loss_,
                             seconds=round(time.time() - t0, 2)))
        rec = pd.DataFrame(recs)
        searches.append(rec)
        print(f"search finished in {(time.time()-t_start)/60:.1f} min")

        best = rec.loc[rec["val_accuracy"].idxmax()].to_dict()
        print(f"\nbest on validation: n_qubits={int(best['n_qubits'])} "
              f"reps={int(best['reps'])} fmap={best['fmap']} "
              f"alpha={best['alpha']} readout={best['readout']}  "
              f"val acc {best['val_accuracy']:.4f}")

        print("\nablations (max validation accuracy):")
        for k in keys:
            g = rec.groupby(k)["val_accuracy"].max()
            print(f"  {k:10s} " + "  ".join(f"{i}={vv:.4f}" for i, vv in g.items()))

        # ---- matched-representation control: classical models on the identical
        #      PCA -> [0, pi] encoded features the VQC sees
        probe = VQC(n_qubits=int(best["n_qubits"]), reps=1, maxiter=1,
                    n_restarts=1, random_state=seed).fit(Xtr, ytr)
        Etr, Eva = probe._prep(Xtr), probe._prep(Xva)
        ctrl = {}
        for nm, mk in [("LogReg", make_pipeline(StandardScaler(),
                                                LogisticRegression(max_iter=5000))),
                       ("MLP", make_pipeline(StandardScaler(),
                                             MLPClassifier((64, 32), max_iter=600,
                                                           random_state=seed,
                                                           early_stopping=True)))]:
            ctrl[nm] = accuracy_score(yva, clone(mk).fit(Etr, ytr).predict(Eva))
        print(f"\nmatched-representation control (same encoded features): "
              + "  ".join(f"{k} {v:.4f}" for k, v in ctrl.items()))

        # ---- matched-sample control: classical models on the identical rows
        msc = {}
        for nm, mk in [("HistGB", HistGradientBoostingClassifier(random_state=seed,
                                                                max_iter=400)),
                       ("LogReg", make_pipeline(StandardScaler(),
                                                LogisticRegression(max_iter=5000)))]:
            msc[nm] = accuracy_score(yva, clone(mk).fit(Xtr, ytr).predict(Xva))
        print(f"matched-sample control ({len(Xtr)} raw rows): "
              + "  ".join(f"{k} {v:.4f}" for k, v in msc.items()))

        # ---- freeze, refit on the development partition, score test once
        cfg = {k: (int(best[k]) if k in ("n_qubits", "reps") else best[k])
               for k in keys}
        idx = (rng.choice(len(Xdev), args.sub, replace=False)
               if len(Xdev) > args.sub else np.arange(len(Xdev)))
        final = VQC(**cfg, maxiter=args.final_maxiter, n_restarts=3,
                    random_state=seed).fit(Xdev[idx], ydev[idx])
        s_te = final.predict_proba(Xte)[:, 1]
        met = wp.evaluate(yte, (s_te >= 0.5).astype(int), s_te)
        print(f"\nTEST (scored once): accuracy {met['accuracy']:.4f}  "
              f"AUC {met['roc_auc']:.4f}  F1 {met['f1']:.4f}  MCC {met['mcc']:.4f}")

        new_rows.append(dict(model="VQC", seed=seed, threshold=0.5,
                             cv_accuracy=best["val_accuracy"],
                             feature_map=best["fmap"],
                             n_qubits=int(best["n_qubits"]), **met))

    srch = pd.concat(searches, ignore_index=True)
    srch.to_csv(out / "tables" / "vqc_search.csv", index=False)

    # ---- merge into the shared results table
    raw_path = out / "tables" / "raw_results.csv"
    if raw_path.exists():
        raw = pd.read_csv(raw_path)
        raw = raw[raw.model != "VQC"]      # replace, so reruns stay idempotent
    else:
        raw = pd.DataFrame()
    merged = pd.concat([raw, pd.DataFrame(new_rows)], ignore_index=True)
    merged.to_csv(raw_path, index=False)

    banner("VQC SUMMARY")
    v = pd.DataFrame(new_rows)
    print(f"test accuracy {v.accuracy.mean():.4f} ± {v.accuracy.std():.4f} "
          f"over {len(v)} seeds")
    print(f"per seed: {dict(zip(v.seed, v.accuracy.round(4)))}")
    q = raw[raw.model == "QSVM"] if len(raw) else raw
    if len(q):
        print(f"QSVM for comparison: {q.accuracy.mean():.4f} ± {q.accuracy.std():.4f}")
    print(f"\nappended to {raw_path}; rerun finalize.py to refresh the summary")

    # ---- figure
    fig, ax = plt.subplots(1, 3, figsize=(DOUBLE, 2.4))
    a = ax[0]
    g = srch.groupby("n_qubits")["val_accuracy"].max()
    a.plot(g.index, g.values, "o-", color=PAL["q"])
    a.set_xlabel("qubits")
    a.set_ylabel("validation accuracy")
    a.set_xticks(g.index)
    a.set_title("VQC vs circuit width")

    a = ax[1]
    for ro, c in [("parity", PAL["q"]), ("z0", PAL["c0"])]:
        s = srch[srch.readout == ro]
        if len(s):
            gg = s.groupby("alpha")["val_accuracy"].max()
            a.plot(gg.index, gg.values, "o-", color=c, label=ro)
    a.set_xscale("log")
    a.set_xlabel(r"bandwidth $\alpha$")
    a.set_ylabel("validation accuracy")
    a.legend()
    a.set_title("bandwidth and readout")

    a = ax[2]
    comp = pd.read_csv(out / "tables" / "raw_results.csv")
    order = ["VQC", "QSVM"]
    extra = [m for m in ["RBF-SVM", "Ensemble-stack"] if m in set(comp.model)]
    order += extra
    means = [comp[comp.model == m].accuracy.mean() for m in order]
    errs = [comp[comp.model == m].accuracy.std() for m in order]
    cols = [PAL["acc"], PAL["q"]] + [PAL["c0"]] * len(extra)
    a.bar([o[:12] for o in order], means, yerr=errs, color=cols, width=.6,
          error_kw={"lw": .8, "capsize": 3})
    a.set_ylim(0.75, 0.90)
    a.set_ylabel("test accuracy")
    a.tick_params(axis="x", labelsize=6, rotation=20)
    a.set_title("quantum vs classical")
    for ext in ("png", "pdf"):
        kw = {"metadata": {"CreationDate": None}} if ext == "pdf" else {}
        fig.savefig(out / "figures" / f"fig7_vqc.{ext}", **kw)
    plt.close(fig)
    print(f"wrote vqc_search.csv and fig7_vqc -> {out.resolve()}")


if __name__ == "__main__":
    main()
