# Water Potability: regime-aware benchmark and accuracy-ceiling analysis

This repository investigates why every model trained on
`water_quality_potability.csv` (10,000 rows, 9 features, balanced) stalls between
82% and 85% accuracy, and establishes quantitatively where the ceiling comes from.

The short answer: the table is a **two-stratum mixture**. About 80% of rows come
from a narrow component whose label follows a near-logistic rule; the other 20%
come from a component roughly 19x wider whose features carry almost no label
information. Neither additional model capacity nor a quantum kernel can cross
the ceiling that structure imposes.

## Contents

| file | purpose |
|---|---|
| `run_all.sh` | one-command reproduction; runs verification first, then all four stages in order |
| `requirements.txt` | pinned versions used for the committed results |
| `water_potability_pipeline.py` | the complete pipeline: forensics, ceiling analysis, representation search, 8-family classical arm with Optuna, 4-map QSVM arm, ensembles, threshold tuning, multi-seed evaluation |
| `vqc.py` | variational quantum classifier — statevector simulator, ansatz, training, self-tests |
| `vqc_arm.py` | VQC hyperparameter search, matched controls, test evaluation |
| `selective.py` | selective classification and risk–coverage analysis |
| `finalize.py` | rebuilds summary, statistics and figures from `raw_results.csv` |
| `leakage_audit.py` | executable proof of the leakage protocol; exits non-zero if any check fails |
| `forensics.py` | standalone contamination forensics |
| `probe_regimes.py` | per-stratum accuracy probes |
| `probe_ceiling.py` | Bayes-limit and tail-masking probes |
| `probe_generator.py` | generative-mechanism stress tests |
| `REPORT.md` | full write-up, sections A–I |
| `pipeline_noleak.ipynb` | the original notebook this work replaces |

## Reproducing the result

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt

./run_all.sh                    # everything, ~2.5-3 h on 4 cores
```

`run_all.sh` runs the two verification scripts first, so a broken environment
fails in three minutes rather than three hours, then runs the four stages in
order and tees each to `logs/`. It finds `.venv` automatically; override with
`PYTHON=/path/to/python`.

```bash
./run_all.sh --quick                    # smoke test, ~10 min, numbers not meaningful
./run_all.sh --seeds "42 7 2024 1 13"   # more seeds, tighter error bars
./run_all.sh --outdir results_new       # write elsewhere
```

Or run the stages yourself. The order matters: `vqc_arm.py` merges its rows into
`raw_results.csv`, so `finalize.py` has to come after it.

```bash
python water_potability_pipeline.py --seeds 42 7 2024 --trials 30 --quantum-sub 1000
python vqc_arm.py   --seeds 42 7 2024 --outdir results
python finalize.py  --outdir results
python selective.py --seeds 42 7 2024 --outdir results

python vqc.py            # VQC simulator self-tests
python leakage_audit.py  # leakage protocol; exits non-zero on failure
```

Outputs land in `results/`: `tables/` (CSV + JSON), `figures/` (600 dpi PNG and
vector PDF), and `manifest.json` recording seeds, chosen representation, best
model, and runtime.

Results are written after **every seed**, so an interrupted run is still usable —
rerun `finalize.py` alone to rebuild the summary from the seeds that finished.
Most of the wall clock is the classical Optuna search (~50 min per seed, with
RandomForest alone accounting for ~20 of that); the VQC arm adds ~5 min per seed.

The dataset is read from the local `water_quality_potability.csv`. The original
notebook downloaded it through `kagglehub`; that call was removed so the run does
not depend on network access or Kaggle credentials.

## Leakage protocol

The test partition is carved off before anything else runs and is scored exactly
once per seed, after every choice is frozen.

| fitted object | fitted on |
|---|---|
| stratum detector (Tukey fences) | training fold |
| scalers, polynomial expansion | training fold |
| hyperparameters (Optuna) | cross-validation within development |
| representation choice | cross-validation on the first seed's development partition |
| ensemble weights, stacking meta-model | out-of-fold predictions only |
| decision threshold | out-of-fold predictions only |
| quantum feature-map configuration | development-internal validation split |
| reported metrics | test partition, scored once |

`leakage_audit.py` checks each of these mechanically, including a tripwire
estimator that records every row it is fitted on and a check that corrupting the
held-out fold leaves the fitted stratum bounds unchanged.
