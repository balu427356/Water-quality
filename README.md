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
| `water_potability_pipeline.py` | the complete pipeline: forensics, ceiling analysis, representation search, 8-family classical arm with Optuna, 4-map quantum arm, ensembles, threshold tuning, multi-seed evaluation |
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
pip install numpy pandas scikit-learn scipy matplotlib seaborn lightgbm xgboost catboost optuna

# full run: 10 seeds, publication settings (~2-3 h on 4 cores)
python water_potability_pipeline.py

# fast smoke test (~10 min)
python water_potability_pipeline.py --quick

# reproduce one seed exactly
python water_potability_pipeline.py --seeds 42 --trials 40

# verify the leakage protocol
python leakage_audit.py
```

Outputs land in `results/`: `tables/` (CSV + JSON), `figures/` (600 dpi PNG and
vector PDF), and `manifest.json` recording seeds, chosen representation, best
model, and runtime.

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
