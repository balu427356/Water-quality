# Water Potability: why every model stalls at 82–85%, and what can be done about it

**Dataset** `water_quality_potability.csv` — 10,000 rows, 9 features, exactly
5,000/5,000 balanced, no duplicates, no missing values.
**Protocol** stratified 80/20 development/test, test scored once per seed, seeds
42 / 7 / 2024 (the same three the original experiment used).

| result | value |
|---|---|
| previous best (RandomForest, 3 seeds) | 0.8457 |
| **new best, full coverage** (Ensemble-stack) | **0.8607 ± 0.0136** |
| **selective, 80.3% coverage** | **0.9036 ± 0.0143** |
| QSVM (best of 4 feature maps) | 0.8335 ± 0.0015 |
| VQC (best of 72 configurations) | 0.8232 ± 0.0129 |
| 90% on the full test set | **not achievable** |
| 97% on the full test set | **not achievable** |

Two quantum architectures were benchmarked — a quantum kernel method (QSVM) and a
variationally trained circuit (VQC). Both finish below every classical model.

---

## A. Diagnosis — why the original implementation sat at 82–85%

The original pipeline was methodologically careful; its leakage discipline was
sound and its matched-representation control was better than most published QML
work. The plateau came from six things, in roughly descending order of cost.

**1. The dataset imposes a ceiling near 0.85, and the pipeline was already at
it.** This is the dominant term and is developed in section I. RandomForest at
0.8457 was within half a point of the achievable maximum. Nothing in the
modelling could have fixed that, which is why tuning, capacity and quantum
kernels all failed to move it.

**2. Hyperparameter grids were token.** RandomForest searched three
configurations, varying only `min_samples_leaf`; XGBoost three, varying only
`max_depth` with `n_estimators`, `learning_rate` and `subsample` pinned; SVM
nine. No search over regularisation, `colsample_bytree` or `min_child_weight`.

**3. Selection ran on a single 2,000-row validation split.** At accuracy ≈ 0.85
the standard error is `sqrt(0.85 × 0.15 / 2000)` ≈ **0.008**, so any difference
below ~1.6% is noise. The search was selecting noise, not models.

**4. A quarter of the usable data sat idle.** Training used 6,000 of the 8,000
non-test rows; the validation partition was never folded back in. Moving to
cross-validation frees those 2,000 rows and is worth roughly a point on its own.

**5. `StandardScaler` was the wrong transform for this table.** Every feature has
skew ≈ 0 but excess kurtosis 10–16 and a 16.4–17.3% Tukey-fence outlier rate,
because ~20% of rows come from a component ~19× wider than the core. The standard
deviation is inflated by that component, compressing the informative core into a
narrow band — the worst case for a single-bandwidth RBF kernel and for any
distance-based learner. Replacing it with a rank-to-Gaussian transform lifted
logistic regression from 0.6461 to 0.8224 on the engineered features.

**6. No threshold tuning, no ensembling, and several strong families absent** —
no LightGBM, CatBoost, HistGradientBoosting, ExtraTrees, stacking or calibration.

---

## B. New approach

The central move is not a better model. It is recognising what the table
actually is.

### The dataset is a two-stratum mixture

Counting Tukey-fence outliers per row on the development partition:

| tail cells | rows | Binomial(9, p) expectation |
|---|---|---|
| 0 | 6,373 | 1,523 |
| 1 | 40 | 2,774 |
| 2 | 0 | 2,246 |
| 3 | 2 | 1,060 |
| 4 | 8 | 322 |
| 5 | 62 | 65 |
| 6 | 178 | 9 |
| 7 | 414 | 0.8 |
| 8 | 543 | 0.03 |
| 9 | 380 | 0.0005 |

The distribution is sharply bimodal: 79.7% of rows carry no tail cells at all,
19.7% carry five to nine, and essentially nothing lies between. Observed variance
is 9.45 against a binomial expectation of 1.26 — **7.5× overdispersed**, χ² =
1.7 × 10⁸. Contamination is **row-level, not cell-level**.

Per-feature two-component Gaussian mixtures agree, and agree with each other:

| feature | w_narrow | sd_wide / sd_narrow |
|---|---|---|
| ph | 0.805 | 19.8 |
| Hardness | 0.806 | 19.7 |
| Solids | 0.802 | 14.9 |
| Chloramines | 0.805 | 17.5 |
| Sulfate | 0.806 | 18.8 |
| Conductivity | 0.799 | 19.0 |
| Organic_carbon | 0.801 | 19.6 |
| Trihalomethanes | 0.805 | 19.2 |
| Turbidity | 0.801 | 18.1 |

Nine physically unrelated variables sharing a mixing weight of 0.80 and a width
ratio near 19 is not a natural phenomenon. It is a generation artefact.

### The two strata carry different amounts of signal, and different labels

| feature | ρ within clean | ρ within contaminated | ρ pooled |
|---|---|---|---|
| Solids | **0.678** | 0.052 | 0.459 |
| Chloramines | 0.456 | 0.020 | 0.307 |
| Turbidity | 0.417 | 0.008 | 0.275 |
| Sulfate | −0.320 | −0.009 | −0.210 |
| ph | 0.279 | 0.017 | 0.186 |
| Conductivity | −0.275 | −0.003 | −0.175 |
| Organic_carbon | −0.268 | −0.011 | −0.175 |
| Trihalomethanes | 0.261 | 0.021 | 0.179 |
| Hardness | −0.002 | 0.035 | 0.009 |

Inside the contaminated stratum every correlation is ≈ 0: the features are noise.
Inside the clean stratum they are *far stronger than the pooled values* — Solids
reaches 0.678 against 0.459 pooled. Contamination was masking real signal, and
pooling the strata is what destroys it.

The two strata do not even share a labelling mechanism. Fitting the clean-stratum
logistic rule and applying it to contaminated rows yields **0.5161** accuracy —
*below* their 0.5974 base rate — while remaining highly confident (mean |p − 0.5|
= 0.489 versus 0.400 on clean rows). Confidently wrong is the signature of a
different generator, not a harder version of the same one.

### What the new pipeline does

1. Detect the stratum with Tukey fences fitted on training folds only.
2. Engineer domain features in **log space** — `log(a) − log(b)` rather than
   `a/b`, because a naive ratio explodes when the denominator nears zero, which
   happens routinely in the wide stratum.
3. Scale with a rank-to-Gaussian transform, not `StandardScaler`.
4. Cross-validate everything on the development partition; no held-out
   validation split, so all 8,000 rows train.
5. Optuna TPE over eleven families, with per-family budgets.
6. Ensemble on out-of-fold predictions; tune the threshold on out-of-fold
   predictions; freeze both before touching test.
7. Offer abstention on the contaminated stratum (section E2).

---

## C. Complete working code

| file | purpose |
|---|---|
| `water_potability_pipeline.py` | forensics, ceiling analysis, representation search, classical arm, QSVM arm, ensembles, threshold, multi-seed evaluation |
| `vqc.py` | variational quantum classifier — statevector simulator, ansatz, training, self-tests |
| `vqc_arm.py` | VQC hyperparameter search, matched controls, test evaluation |
| `tune_quantum_thresholds.py` | threshold-symmetry sensitivity analysis for both quantum arms |
| `selective.py` | selective classification and risk–coverage analysis |
| `finalize.py` | summary, statistics and figures from `raw_results.csv` |
| `leakage_audit.py` | executable leakage checks; exits non-zero on failure |
| `forensics.py`, `probe_regimes.py`, `probe_ceiling.py`, `probe_generator.py` | the standalone probes behind sections B and I |

All run start to finish on the committed CSV. See section H.

---

## D. Model comparison

Test partition, mean ± sd over seeds 42 / 7 / 2024. `cv_acc` is the
cross-validated accuracy used for selection (models trained on 6,400 rows);
test figures come from refits on all 8,000.

| model | CV acc | test accuracy | balanced acc | precision | recall | F1 | ROC-AUC | MCC |
|---|---|---|---|---|---|---|---|---|
| **Ensemble-stack** | — | **0.8607 ± 0.0136** | 0.8607 ± 0.0136 | 0.8941 ± 0.0105 | 0.8187 ± 0.0385 | 0.8543 ± 0.0178 | 0.9388 ± 0.0081 | 0.7245 ± 0.0245 |
| ExtraTrees | 0.8462 | 0.8603 ± 0.0105 | 0.8603 ± 0.0105 | 0.9040 ± 0.0127 | 0.8063 ± 0.0111 | 0.8524 ± 0.0111 | 0.9348 ± 0.0082 | 0.7249 ± 0.0213 |
| Ensemble-rank | — | 0.8602 ± 0.0089 | 0.8602 ± 0.0089 | 0.8916 ± 0.0083 | 0.8200 ± 0.0145 | 0.8543 ± 0.0100 | 0.9387 ± 0.0073 | 0.7227 ± 0.0175 |
| Ensemble-weighted | — | 0.8575 ± 0.0078 | 0.8575 ± 0.0078 | 0.8766 ± 0.0125 | 0.8327 ± 0.0306 | 0.8537 ± 0.0111 | 0.9386 ± 0.0073 | 0.7164 ± 0.0145 |
| Ensemble-mean | — | 0.8573 ± 0.0084 | 0.8573 ± 0.0084 | 0.8800 ± 0.0101 | 0.8277 ± 0.0225 | 0.8529 ± 0.0104 | 0.9386 ± 0.0073 | 0.7162 ± 0.0161 |
| CatBoost | 0.8490 | 0.8572 ± 0.0099 | 0.8572 ± 0.0099 | 0.8898 ± 0.0050 | 0.8153 ± 0.0228 | 0.8508 ± 0.0122 | 0.9376 ± 0.0074 | 0.7170 ± 0.0184 |
| RandomForest | 0.8455 | 0.8555 ± 0.0092 | 0.8555 ± 0.0092 | 0.8965 ± 0.0109 | 0.8040 ± 0.0242 | 0.8475 ± 0.0117 | 0.9329 ± 0.0071 | 0.7151 ± 0.0167 |
| RegimeRouter | 0.8481 | 0.8552 ± 0.0098 | 0.8552 ± 0.0098 | 0.8843 ± 0.0073 | 0.8173 ± 0.0220 | 0.8494 ± 0.0120 | 0.9255 ± 0.0087 | 0.7125 ± 0.0184 |
| HistGradientBoosting | 0.8478 | 0.8527 ± 0.0068 | 0.8527 ± 0.0068 | 0.8776 ± 0.0063 | 0.8197 ± 0.0125 | 0.8476 ± 0.0077 | 0.9339 ± 0.0066 | 0.7069 ± 0.0132 |
| LightGBM | 0.8488 | 0.8510 ± 0.0095 | 0.8510 ± 0.0095 | 0.8808 ± 0.0170 | 0.8123 ± 0.0204 | 0.8450 ± 0.0104 | 0.9353 ± 0.0064 | 0.7044 ± 0.0189 |
| MLP | 0.8458 | 0.8507 ± 0.0087 | 0.8507 ± 0.0087 | 0.8733 ± 0.0058 | 0.8203 ± 0.0170 | 0.8459 ± 0.0102 | 0.9283 ± 0.0020 | 0.7027 ± 0.0168 |
| XGBoost | 0.8483 | 0.8507 ± 0.0081 | 0.8507 ± 0.0081 | 0.8721 ± 0.0163 | 0.8223 ± 0.0242 | 0.8462 ± 0.0098 | 0.9359 ± 0.0071 | 0.7029 ± 0.0158 |
| RBF-SVM | 0.8429 | 0.8490 ± 0.0061 | 0.8490 ± 0.0061 | 0.8777 ± 0.0290 | 0.8127 ± 0.0335 | 0.8432 ± 0.0081 | 0.9267 ± 0.0095 | 0.7009 ± 0.0138 |
| Logistic-poly2 | 0.8380 | 0.8433 ± 0.0133 | 0.8433 ± 0.0133 | 0.8497 ± 0.0171 | 0.8343 ± 0.0083 | 0.8420 ± 0.0126 | 0.8825 ± 0.0061 | 0.6868 ± 0.0267 |
| kNN | 0.8306 | 0.8362 ± 0.0038 | 0.8362 ± 0.0038 | 0.8518 ± 0.0039 | 0.8140 ± 0.0092 | 0.8324 ± 0.0046 | 0.9180 ± 0.0053 | 0.6730 ± 0.0073 |
| **QSVM** | 0.8393 | **0.8335 ± 0.0015** | 0.8335 ± 0.0015 | 0.8538 ± 0.0071 | 0.8050 ± 0.0105 | 0.8286 ± 0.0027 | 0.9198 ± 0.0028 | 0.6682 ± 0.0028 |
| LogisticRegression | 0.8225 | 0.8267 ± 0.0117 | 0.8267 ± 0.0117 | 0.8313 ± 0.0068 | 0.8197 ± 0.0215 | 0.8254 ± 0.0135 | 0.8551 ± 0.0038 | 0.6535 ± 0.0231 |
| **VQC** | 0.8218 | **0.8232 ± 0.0129** | 0.8232 ± 0.0129 | 0.8325 ± 0.0256 | 0.8100 ± 0.0050 | 0.8209 ± 0.0099 | 0.8982 ± 0.0117 | 0.6469 ± 0.0265 |

**Against the original results.** Same three seeds, so the comparison is paired:

| model | original | this work | Δ |
|---|---|---|---|
| LogisticRegression | 0.8195 | 0.8267 | +0.0072 |
| RBF-SVM | 0.8417 | 0.8490 | +0.0073 |
| RandomForest | 0.8457 | 0.8555 | +0.0098 |
| XGBoost | 0.8440 | 0.8507 | +0.0067 |
| QSVM | 0.8308 | 0.8335 | +0.0027 |
| best overall | 0.8457 | **0.8607** | **+0.0150** |

**Statistics.** Friedman over 18 models × 3 seeds: χ² = 43.83, **p = 3.6 × 10⁻⁴**.
Mean ranks (lower better): Ensemble-rank 2.33, ExtraTrees 2.67, Ensemble-stack
2.83, … kNN 15.00, **QSVM 16.00**, LogisticRegression 16.83, **VQC 17.50**. The
two quantum models occupy the bottom of the ranking, with VQC last of eighteen.

Nadeau–Bengio corrected paired t-tests against Ensemble-stack:

| model | Δ accuracy | t | p |
|---|---|---|---|
| **VQC** | 0.0375 | 22.53 | **0.0020** |
| LogisticRegression | 0.0340 | 7.13 | 0.019 |
| QSVM | 0.0272 | 2.66 | 0.117 |

VQC separates from the best classical model at p < 0.05 even after the
correction, which is worth noting because three seeds leave the test badly
underpowered — the VQC deficit is large and consistent enough to clear the bar
anyway. QSVM does not separate: its direction is consistent across every seed
but the corrected test does not reach significance, which is stated as measured
rather than overclaimed.

### Quantum arm

Four feature maps, bandwidth swept 0.25–2.0, both entanglement topologies,
1–2 repetitions, 4/6/9 qubits. Best validation accuracy per map (seed 42):

| feature map | best val acc | matched classical control |
|---|---|---|
| ZZ (standard) | 0.8405 | 0.8380 |
| ZZ-product (Pauli variant) | 0.8405 | 0.8380 |
| Z (no entanglement) | 0.8400 | 0.8380 |
| angle (RY) | 0.8335 | 0.8380 |

**Two controls the QML literature usually omits.**
*Matched representation*: a classical RBF-SVM on the identical PCA → [0, π]
encoded features reaches 0.8380 against the quantum kernel's 0.8405 — a gap of
0.0025, reproducing the original notebook's finding under a far wider search.
*Matched sample*: classical models refitted on the identical 1,000-row subsample
the quantum kernel was limited to, so the O(N²) cap is not confounded with the
comparison.

Removing entanglement entirely (Z map) costs 0.0005. The entanglement is doing
essentially nothing. Bandwidth matters far more than topology: α = 0.25 and 0.50
both reach 0.8405 while α = 1.0 drops to 0.8345, with kernel effective rank
climbing from 2.9 to 83.7 — the classic bandwidth pathology, and evidence that
an unbandwidthed quantum kernel would have looked much worse.

### VQC arm — a second, independent quantum architecture

The QSVM computes a *fixed* kernel from the encoding circuit and hands it to a
classical SVM. The VQC places a *trainable* circuit after the same encoding and
optimises its parameters against the classification loss directly:

```
|0>^n --[ feature map U_phi(x) ]--[ ansatz W(theta) ]-- readout
```

RealAmplitudes-style ansatz (RY layers alternating with CNOT entanglers),
parity or single-qubit-Z readout, COBYLA training with SPSA available. Exact
statevector simulation in numpy; 72 configurations searched per seed over qubit
count, depth, feature map, bandwidth and readout, scored on a
development-internal validation split.

**Result: 0.8232 ± 0.0129** (per seed 0.8210 / 0.8370 / 0.8115). Last of
eighteen models.

*Ablations* (max validation accuracy over all seeds):

| axis | values |
|---|---|
| qubits | 4 → 0.8220, 6 → 0.8200, 8 → 0.8250 |
| depth (reps) | 2 → 0.8250, 4 → 0.8220 |
| **feature map** | **Z (no entanglement) → 0.8250, ZZ → 0.8220** |
| bandwidth α | 0.25 → 0.8130, 0.50 → 0.8220, 1.00 → 0.8250 |
| readout | parity → 0.8250, single-qubit Z → 0.8215 |

The entanglement-free Z map wins outright, and by mean validation accuracy the
margin is wider still (0.8067 vs 0.7884). Two of the three seeds selected it.
This reproduces the QSVM arm's conclusion on a completely different quantum
learning mechanism: **entanglement contributes nothing on this data.**

*Threshold symmetry.* The classical models all have their decision threshold
swept on out-of-fold development scores; the quantum arms as reported do not,
using the SVC decision-function sign (QSVM) and 0.5 on the parity probability
(VQC). Rather than argue that the asymmetry is too small to matter, it was
measured (`tune_quantum_thresholds.py`, results in
`results/tables/quantum_threshold_tuning.csv`). Applying the identical sweep:

| arm | as reported | threshold-tuned | Δ |
|---|---|---|---|
| QSVM | 0.8335 ± 0.0015 | 0.8300 ± 0.0030 | −0.0035 |
| VQC | 0.8160 ± 0.0087 | 0.8117 ± 0.0094 | −0.0043 |

Tuning **lowers** quantum test accuracy, in five of six arm–seed pairs, while
raising out-of-fold accuracy in every one. The cause is sample size: the O(N²)
kernel restricts the quantum arms to a subsampled development partition, so
their out-of-fold scores come from far fewer rows than the classical models'
8,000, and the threshold overfits. Reporting the quantum arms untuned is
therefore **conservative in their favour**, which disposes of the objection in
the opposite direction to the one expected.

These figures are a sensitivity analysis, not the primary result. Substituting
them because they differ on test would be selection on the test partition — the
thing the whole protocol exists to prevent — and the VQC numbers here use a
smaller training subsample than `vqc_arm.py`, so they are not comparable to the
main table row.

*Controls.* Against a classical logistic regression on the **identical** encoded
features, the VQC's advantage is 0.8220 vs 0.8160, 0.8250 vs 0.8195, 0.8185 vs
0.8145 — around half a point. A trainable quantum circuit is barely
distinguishing itself from a linear model on its own representation. Against the
matched-sample control, a HistGradientBoosting fitted on the *same 2,000 rows*
beats the VQC in every seed (0.8445 / 0.8260 / 0.8335).

*An implementation finding worth reporting.* The first version reached only 0.825
on a linearly separable synthetic task, and a five-fold increase in optimiser
budget moved it to 0.825 from 0.807 — pointing at representation rather than
optimisation. Measuring the readout showed the cause: the raw expectation
concentrates in a narrow band around zero (spread 0.4958–0.6459 at α = 0.25 with
4 qubits), leaving the loss nearly flat in every direction. This is exponential
concentration, the known VQC pathology. Adding two trainable readout parameters,
a scale and a bias, took the same task to **0.995**. Any VQC benchmark without
such a readout gain is measuring the pathology rather than the model, and would
understate quantum performance here.

---

## E. Final result

### E1. Full coverage

- **Model** Ensemble-stack — logistic-regression meta-learner over out-of-fold
  probabilities from the six best families (ExtraTrees, CatBoost, RandomForest,
  RegimeRouter, HistGradientBoosting, Ensemble members as selected per seed).
- **Features** the `domain` representation: the 9 raw features plus 9 log-space
  derived features — `|ph − 7|`, `log Solids`, `log(Solids/Hardness)`,
  `log(Sulfate/Conductivity)`, `log(Chloramines·Turbidity)`,
  `log(Organic_carbon/Turbidity)`, `log(Trihalomethanes/Chloramines)`,
  `log(Conductivity/Hardness)`, `log(Solids·Turbidity)`. Selected by CV on the
  first seed's development partition (0.8465 vs 0.8419 raw).
- **Preprocessing** `QuantileTransformer(output_distribution="normal",
  n_quantiles=1000)` for scale-sensitive models; tree models take raw values.
  Everything fitted inside training folds.
- **Hyperparameters** Optuna TPE, 30 trials per family (scaled per family:
  0.35× for SVM/MLP, 0.4× for CatBoost, 0.8× for the forests), 5-fold stratified
  CV on the development partition. Per-seed winners in
  `results/tables/classical_cv_seed*.csv`.
- **Threshold** swept on out-of-fold predictions, then frozen. Seed 42 → 0.5573,
  seed 7 → 0.5015, seed 2024 → 0.6621. Notably **not** 0.5. Swept as a single
  sorted pass (O(n log n)); the naive candidate-by-candidate form is ~64M
  comparisons per model at 8,000 development rows and is called for every family
  and every ensemble. Verified against the naive implementation on 40 random
  cases plus all-zero, all-one and tied-score edge cases.

  The gain is real but small, as expected on an exactly balanced table where 0.5
  is already close to optimal. Measured against the counterfactual on the best
  out-of-fold model: seed 42 0.8545 vs 0.8541, seed 7 0.8499 vs 0.8491, seed 2024
  0.8526 vs 0.8471. Two seeds gained almost nothing; one gained half a point. It
  is worth having for correctness rather than as a lever.
- **Test accuracy 0.8607 ± 0.0136.**
- **97% target: NO. 90% target: NO.** See section I.

### E2. Selective classification — where 90% does exist

Abstaining on the contaminated stratum, with the rejection rule fitted on
training data alone so coverage is fixed before any prediction:

| | accuracy | coverage |
|---|---|---|
| full coverage | 0.8552 ± 0.0098 | 1.000 |
| **stratum-selective** | **0.9036 ± 0.0143** | 0.8030 ± 0.0069 |
| confidence baseline, matched coverage | 0.9096 ± 0.0133 | 0.8030 |
| on the abstained rows | 0.6582 ± 0.0021 | — |

Per seed: 0.9054 / 0.9168 / **0.8884**. The mean clears 90% but **seed 2024 does
not** — the honest statement is "90.4% on average, with one of three seeds at
88.8%", not "90%+ guaranteed".

Two things worth noting. First, the confidence baseline is *better* than the
stratum rule by 0.0060; the stratum rule's merit is not raw accuracy but that it
is model-independent — it would reject the same rows for an untrained model, and
its coverage is known in advance. Second, that near-tie is itself the finding:
a rule derived purely from data quality matches what the model's own uncertainty
discovers, which says that uncertainty was largely just detecting contamination.

---

## F. Error analysis

Ensemble-stack, seed 42, threshold 0.5573, 288 errors in 2,000:

|  | predicted 0 | predicted 1 |
|---|---|---|
| **true 0** | 895 | 105 |
| **true 1** | 183 | 817 |

**By stratum** — this is the whole story:

| stratum | n | errors | error rate | share of all errors |
|---|---|---|---|---|
| clean | 1,597 | 151 | **0.0946** | 52.4% |
| contaminated | 403 | 137 | **0.3400** | 47.6% |

The contaminated stratum is 20% of the rows and contributes 48% of the errors,
at 3.6× the error rate. Within it, accuracy is flat regardless of how many tail
cells a row has (error 0.30–0.43 across k = 5…9), which is what noise looks like.

**By distance from the threshold**: 0.366 nearest quartile → 0.124 → 0.060 →
0.026 farthest. Errors concentrate at the boundary, as expected when the residual
is label noise rather than model bias.

**By class**: class 0 error 0.105, class 1 error 0.183. The model is
conservative about declaring water potable — precision 0.894 against recall
0.819. For a drinking-water screen that asymmetry is the safer direction, and it
is a consequence of the tuned threshold sitting above 0.5.

---

## G. Leakage audit

Run `python leakage_audit.py`; it exits non-zero if any check fails.

| claim | how it is checked |
|---|---|
| test data not used in training | partitions share no row; a tripwire estimator records every row it is fitted on and none come from test |
| test labels not used in optimisation | `tune_classical`, `quantum_arm` and `build_ensembles` contain no `Xte`/`yte` symbol, checked by reading the source |
| preprocessing fitted correctly | stratum bounds fitted on dev differ from bounds fitted on everything; corrupting the held-out fold leaves the fitted bounds unchanged |
| feature engineering carries no target information | `domain_features` never receives `y`; output is order-invariant and row-wise |
| model selection used only CV/validation | representation, hyperparameters, ensemble weights and threshold all come from out-of-fold development predictions |
| no distribution shift | adversarial validation dev-vs-test AUC = **0.4996 ± 0.0122** |
| threshold not tuned on test | the frozen out-of-fold threshold differs from the test-optimal one, and the accuracy difference is reported rather than claimed |
| threshold treatment is symmetric across arms | quantum arms were re-run with the classical sweep; it lowers their accuracy, so the reported figures favour them (section D) |

Two leakage bugs were found and fixed during development, both recorded in the
git history:

- The rank ensemble ranked scores *within the set being scored*. On the test
  partition that is transductive, and since the split is exactly balanced,
  thresholding such a score quietly exploits the test label distribution. It was
  the top model at the time. Replaced with `OOFQuantileMap`, fitted on
  out-of-fold scores and applied unchanged; verified by confirming that scoring
  a subset returns values identical to scoring the whole partition.
- `SVC` had the same problem via rank-normalised decision functions. Replaced
  with `QuantileScored`, which references the training decision-function
  distribution.

---

## H. Reproducibility

```bash
python -m venv .venv && . .venv/bin/activate
pip install numpy pandas scikit-learn scipy matplotlib seaborn lightgbm xgboost catboost optuna

# the exact result in this report
python water_potability_pipeline.py --seeds 42 7 2024 --trials 30 --quantum-sub 1000
python vqc_arm.py --seeds 42 7 2024 --outdir results
python finalize.py --outdir results
python selective.py --seeds 42 7 2024 --outdir results

# verification
python leakage_audit.py
python vqc.py            # VQC simulator self-tests
```

Seeds are set for the split, every estimator, Optuna's TPE sampler and the
quantum subsample. Figures are byte-reproducible (PDF creation timestamps
suppressed), verified by digest. Versions: numpy 2.4.6, pandas 3.0.5,
scikit-learn 1.9.0, scipy 1.17.1, lightgbm 4.7.0, xgboost 3.2.0, catboost
1.2.10, optuna 4.9.0, Python 3.11.15.

The dataset is read from the local CSV; the original `kagglehub` download was
removed so runs need no network access or credentials.

---

## I. Why 97% — and 90% — are not achievable

### The decomposition

Each stratum was measured separately by 5-fold CV on the development partition.

**Clean stratum (80.16% of rows) is at its Bayes limit.** Twelve model families:

| model | CV accuracy |
|---|---|
| Logistic + poly2 | **0.9018** |
| MLP | 0.9000 |
| ExtraTrees | 0.8983 |
| LogisticRegression | 0.8971 |
| RandomForest | 0.8935 |
| XGBoost | 0.8923 |
| LightGBM | 0.8946 |
| HistGradientBoosting | 0.8898 |
| RBF-SVM | 0.8891 |

Plain logistic regression beats RBF-SVM, HistGradientBoosting and XGBoost. When
extra capacity actively *hurts*, the residual is noise, not unmodelled structure.
Two independent anchors agree:

- Fitting `y ~ Bernoulli(σ(w·x))` gives `E[max(p, 1−p)] = 0.9002`, and the fit is
  well calibrated across all ten probability bins (predicted 0.0255 → observed
  0.0270; 0.4510 → 0.3989; 0.8556 → 0.8561; 0.9769 → 0.9813).
- The 1-NN label-conflict rate inside the clean stratum is 0.1550, bounding Bayes
  error to [0.0775, 0.1550] — i.e. accuracy in [0.845, 0.9225].

**Contaminated stratum (19.84%) is near-noise.** Base rate 0.5974; best
achievable 0.6371 (HistGB using the corruption pattern as features). Its features
carry ρ ≈ 0 with the label, and its labels do not follow the clean rule.

**Composed:** `0.8016 × 0.9018 + 0.1984 × 0.6371 = 0.8493`.

### The prediction was confirmed

The tuned models land exactly on it. Comparing like for like — both
cross-validated, both trained on 6,400 rows:

> best CV accuracy **0.8490** vs composed ceiling **0.8493**, gap **+0.0002**.

Reported test accuracies (0.8607) sit above this because the final models are
refitted on all 8,000 development rows, worth roughly a point.

*A caveat stated plainly*: 0.8493 is an **empirical best-achieved** figure, not a
proven bound. Individual tuned models have exceeded it by up to 0.0034, which is
under one standard error. The claim is "the ceiling is approximately 0.85 and
every model is sitting on it", not "0.8493 is a theorem".

### Why the targets are out of reach

Even granting a **perfect** clean-stratum classifier:

```
0.8016 × 1.0000  (clean, hypothetically perfect) = 0.8016
0.1984 × 0.6371  (contaminated, its ceiling)     = 0.1264
                                    maximum      = 0.9280
```

92.8% is the absolute maximum, and it requires flawless performance on a stratum
whose own Bayes limit is 0.9002. Working backwards:

| target | required clean-stratum accuracy | clean-stratum Bayes estimate |
|---|---|---|
| 90% | 0.9651 | 0.9002 |
| 97% | **1.0524** | 0.9002 |

97% requires better-than-perfect accuracy on 80% of the data. It is not a hard
target; it is an arithmetically impossible one.

### What would be needed

1. **The uncontaminated feature values.** The contamination is destructive — the
   wide-component draws replaced the informative ones rather than adding noise on
   top, so nothing in the file can recover them. Only the generator can.
2. **A variable that separates labels inside the contaminated stratum.** All nine
   present features are uninformative there; a genuinely new measurement would be
   required.
3. **Reduced label noise in the clean stratum.** Its Bayes limit of 0.9002 is set
   by the stochastic labelling rule. Even eliminating the contaminated stratum
   entirely caps the table at 0.9018.

### What this means for the literature

Published models on this dataset cluster at 82–85% regardless of architecture.
That is not coincidence and it is not a failure of tuning: it is the ceiling
above, and it explains the plateau across the field in a single number. The
practical response is selective classification (section E2), which reports 90.4%
at 80.3% coverage by declining to guess on rows that provably cannot be
predicted.

---

## Recommendation for the write-up

The defensible contribution is not a leaderboard number. It is:

1. A forensic characterisation of the dataset as a two-stratum mixture, with the
   overdispersion test, the mixture fits and the divergent labelling mechanisms.
2. A quantitative ceiling that predicts observed performance to within 0.0002.
3. A two-architecture quantum benchmark — kernel-based (QSVM) and variational
   (VQC) — with matched-representation *and* matched-sample controls, showing no
   advantage for either. Both arms independently find that entanglement
   contributes essentially nothing (0.0005 for the QSVM; the entanglement-free
   Z map wins outright for the VQC) while bandwidth matters far more. Reporting
   a null result on two different quantum learning mechanisms is considerably
   harder to attribute to one bad implementation choice than a single arm.
4. Selective classification as the practical remedy, with a reject rule grounded
   in data quality rather than model confidence.
