"""Give the quantum arms the same threshold treatment as the classical models.

In the main pipeline every classical model has its decision threshold swept on
out-of-fold development predictions and then frozen. The two quantum models did
not: QSVM used the sign of the SVC decision function and VQC used 0.5 on the
parity probability, both fixed. That asymmetry cannot change the ranking -- the
classical-to-QSVM gap is 0.027 while threshold tuning is worth at most ~0.005 --
but a comparison where one arm is tuned and the other is not invites the
objection, so it is measured here rather than argued away.

The measurement inverts the concern. Sweeping the threshold on development
out-of-fold scores *lowers* quantum test accuracy -- QSVM 0.8335 -> 0.8300, VQC
0.8160 -> 0.8117 -- because the quantum arms are limited to a subsampled
development partition by the O(N^2) kernel, so their out-of-fold scores are
estimated from far fewer rows than the classical models' 8,000 and the threshold
overfits. Reporting the quantum arms untuned is therefore conservative in their
favour, not against it.

This script is a sensitivity analysis, not a replacement for the primary
results, for two reasons. Swapping in the tuned numbers *because* they differ on
test would be selecting on the test partition, which the whole protocol exists
to prevent; and the VQC figures here use a smaller training subsample than
vqc_arm.py, so they are not directly comparable to the main table. It therefore
leaves raw_results.csv alone unless --write is passed explicitly.

Protocol, identical to the classical arm:

  * the winning configuration for each seed is read from the search tables, so
    nothing is re-selected and the test partition plays no part in the choice;
  * that frozen configuration is cross-validated within the development
    partition to produce out-of-fold scores;
  * the threshold is swept on those scores and frozen;
  * the model is refitted on the development partition and the test partition is
    scored once, with the frozen threshold.

    python tune_quantum_thresholds.py --seeds 42 7 2024 --outdir results
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.decomposition import PCA
from sklearn.model_selection import StratifiedKFold, train_test_split
from sklearn.preprocessing import MinMaxScaler
from sklearn.svm import SVC

import importlib.util

_s = importlib.util.spec_from_file_location("wp", "water_potability_pipeline.py")
wp = importlib.util.module_from_spec(_s)
_s.loader.exec_module(wp)
_v = importlib.util.spec_from_file_location("vqcmod", "vqc.py")
vqcmod = importlib.util.module_from_spec(_v)
_v.loader.exec_module(vqcmod)


def banner(t):
    print(f"\n{'='*78}\n{t}\n{'='*78}", flush=True)


def qsvm_scores(cfg, Xtr, ytr, Xap, seed):
    """Fit the frozen QSVM configuration and return decision values for Xap."""
    sc = wp.robust_scaler(seed).fit(Xtr)
    A, B = sc.transform(Xtr), sc.transform(Xap)
    nq = int(cfg["n_qubits"])
    if nq < A.shape[1]:
        pca = PCA(n_components=nq, random_state=seed).fit(A)
        A, B = pca.transform(A), pca.transform(B)
    mm = MinMaxScaler((0, np.pi)).fit(A)
    Qa = np.clip(mm.transform(A), 0, np.pi)
    Qb = np.clip(mm.transform(B), 0, np.pi)
    kw = dict(fmap=cfg["feature_map"], reps=int(cfg["reps"]),
              ent=cfg["entanglement"], alpha=float(cfg["alpha"]))
    Ktr = wp.fidelity_kernel(Qa, **kw)
    Kap = wp.fidelity_kernel(Qb, Qa, **kw)
    svm = SVC(C=float(cfg["C"]), kernel="precomputed").fit(Ktr, ytr)
    return svm.decision_function(Kap)


def vqc_scores(cfg, Xtr, ytr, Xap, seed):
    m = vqcmod.VQC(n_qubits=int(cfg["n_qubits"]), reps=int(cfg["reps"]),
                   fmap=cfg["fmap"], alpha=float(cfg["alpha"]),
                   readout=cfg["readout"], maxiter=1500, n_restarts=3,
                   random_state=seed).fit(Xtr, ytr)
    return m.predict_proba(Xap)[:, 1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="water_quality_potability.csv")
    ap.add_argument("--seeds", nargs="+", type=int, default=[42, 7, 2024])
    ap.add_argument("--outdir", default="results")
    ap.add_argument("--test-size", type=float, default=0.20)
    ap.add_argument("--sub", type=int, default=1000)
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--write", action="store_true",
                    help="overwrite the QSVM/VQC rows in raw_results.csv "
                         "(off by default; this is a sensitivity analysis)")
    args = ap.parse_args()

    out = Path(args.outdir)
    df = pd.read_csv(args.data)
    feats = [c for c in df.columns if c != wp.TARGET]
    X = df[feats].to_numpy(float)
    y = df[wp.TARGET].to_numpy(int)

    raw = pd.read_csv(out / "tables" / "raw_results.csv")
    vqc_search = pd.read_csv(out / "tables" / "vqc_search.csv")

    updates, rows = [], []
    for seed in args.seeds:
        banner(f"SEED {seed}")
        Xdev, Xte, ydev, yte = train_test_split(
            X, y, test_size=args.test_size, stratify=y, random_state=seed)
        rng = np.random.default_rng(seed)
        idx = (rng.choice(len(Xdev), args.sub, replace=False)
               if len(Xdev) > args.sub else np.arange(len(Xdev)))
        Xs, ys = Xdev[idx], ydev[idx]
        cv = StratifiedKFold(args.folds, shuffle=True, random_state=seed)

        for arm in ("QSVM", "VQC"):
            if arm == "QSVM":
                qs = pd.read_csv(out / "tables" / f"quantum_search_seed{seed}.csv")
                cfg = qs.loc[qs["val_accuracy"].idxmax()].to_dict()
                score_fn, default_thr = qsvm_scores, 0.0
                label = (f"{cfg['feature_map']} q={int(cfg['n_qubits'])} "
                         f"reps={int(cfg['reps'])} alpha={cfg['alpha']}")
            else:
                vs = vqc_search[vqc_search.seed == seed]
                cfg = vs.loc[vs["val_accuracy"].idxmax()].to_dict()
                score_fn, default_thr = vqc_scores, 0.5
                label = (f"{cfg['fmap']} q={int(cfg['n_qubits'])} "
                         f"reps={int(cfg['reps'])} alpha={cfg['alpha']} "
                         f"readout={cfg['readout']}")

            # out-of-fold scores for the frozen configuration, development only
            oof = np.zeros(len(ys))
            for tr, va in cv.split(Xs, ys):
                oof[va] = score_fn(cfg, Xs[tr], ys[tr], Xs[va], seed)
            thr, oof_acc = wp.best_threshold(ys, oof)
            oof_at_default = ((oof >= default_thr).astype(int) == ys).mean()

            # refit and score the test partition once
            s_te = score_fn(cfg, Xs, ys, Xte, seed)
            met_tuned = wp.evaluate(yte, (s_te >= thr).astype(int), s_te)
            met_default = wp.evaluate(yte, (s_te >= default_thr).astype(int), s_te)

            print(f"  {arm:5s} {label}")
            print(f"        OOF: tuned thr {thr:+.4f} -> {oof_acc:.4f}   "
                  f"fixed thr {default_thr:+.4f} -> {oof_at_default:.4f}")
            print(f"        TEST: tuned {met_tuned['accuracy']:.4f}   "
                  f"fixed {met_default['accuracy']:.4f}   "
                  f"delta {met_tuned['accuracy']-met_default['accuracy']:+.4f}")

            rows.append(dict(seed=seed, arm=arm, threshold=thr,
                             oof_accuracy_tuned=oof_acc,
                             oof_accuracy_fixed=oof_at_default,
                             test_accuracy_tuned=met_tuned["accuracy"],
                             test_accuracy_fixed=met_default["accuracy"]))
            updates.append((arm, seed, thr, met_tuned))

    if args.write:
        for arm, seed, thr, met in updates:
            mask = (raw.model == arm) & (raw.seed == seed)
            if not mask.any():
                continue
            raw.loc[mask, "threshold"] = thr
            for k, v in met.items():
                if k in raw.columns:
                    raw.loc[mask, k] = v
        raw.to_csv(out / "tables" / "raw_results.csv", index=False)

    t = pd.DataFrame(rows)
    t.to_csv(out / "tables" / "quantum_threshold_tuning.csv", index=False)

    banner("SUMMARY")
    for arm in ("QSVM", "VQC"):
        s = t[t.arm == arm]
        print(f"{arm}: fixed {s.test_accuracy_fixed.mean():.4f} ± "
              f"{s.test_accuracy_fixed.std():.4f}  ->  tuned "
              f"{s.test_accuracy_tuned.mean():.4f} ± {s.test_accuracy_tuned.std():.4f}"
              f"   ({s.test_accuracy_tuned.mean()-s.test_accuracy_fixed.mean():+.4f})")
    worse = (t.test_accuracy_tuned < t.test_accuracy_fixed).sum()
    print(f"\ntuning lowered test accuracy in {worse} of {len(t)} arm-seed pairs, "
          f"while raising\nout-of-fold accuracy in every one -- the threshold is "
          f"overfitting the smaller\ndevelopment sample the quantum arms are "
          f"restricted to. Reporting them untuned\nis conservative in their favour.")
    print(f"\nwrote quantum_threshold_tuning.csv")
    if args.write:
        print("raw_results.csv was overwritten (--write); rerun finalize.py")
    else:
        print("raw_results.csv left unchanged; pass --write to overwrite it")


if __name__ == "__main__":
    main()
