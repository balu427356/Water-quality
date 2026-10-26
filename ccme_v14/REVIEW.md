# Pre-submission review of `WaterQuality_CCME_v13_executed.ipynb`

Scope: all 99 cells (code, outputs and text) of the v13 notebook, read against its own tables. Corrections are in
`WaterQuality_CCME_v14.ipynb` (built by `tools/make_v14.py`, which applies each change as an exact text replacement, so the diff is
fully auditable). The real dataset (figshare) could not be downloaded from this environment, so **v14 has not been run on the real
data**: run it end-to-end before using any number. It was executed end-to-end on a synthetic file with the same columns (smoke test,
§6 below).

## 1. Bottom line

The notebook is unusually careful (leakage audit, site bootstrap, formula baselines, label audit), but in its current form a Q1
reviewer would find four problems that change results or claims:

1. **The central claim is not supported by its own tables.** With two laboratory tests the proposed model is *not* better than the
   no-learning formula rule: accuracy 94.54 % vs 94.72 % (Δ −0.18 pp, 95 % CI −1.53 to +0.65), macro-F1 0.903 vs 0.920 (v13
   Tables 14, 30). It is also worse than plain site history at flagging hidden failures (ROC-AUC 0.559 vs 0.736, Table 34). The
   paper cannot be framed as "knowledge-guided ML improves water-quality classification"; it can be framed as an audited benchmark
   showing that learners only transfer across countries once they are given the formula, and then match but do not beat it.
2. **The "unseen countries" headline used test-country labels** (10 %; 30–84 % of test sites also contributed training labels),
   while the title, the task statement and the note of Table 14 say "never seen in training".
3. **Training labels contained imputed values** that the model sees as missing.
4. **Two code bugs** (adaptive selection used one Monte-Carlo draw instead of 12; QWK weights re-indexed absent classes) and a
   **weaker-than-described formula baseline** ("last genuine value" was only the *t−1* value).

## 2. Errors found and corrected in v14

| # | Severity | Where (v13) | Problem | Evidence | Correction (v14) |
|---|---|---|---|---|---|
| 1 | Critical (claim) | §10, Table 14, title | Headline at `MAIN_BUDGET = 0.10` (10 % of the test country's history labelled) but described as countries "never seen in training"; Table 13 shows 30.4 % (England) and 84.3 % (Ireland) of test sites also contribute labelled rows | Table 13 "info" row; Table 14 note | `MAIN_BUDGET = 0.0`: no sample of the test country is used. Cost is negligible for the proposed model (v13 Table 21: 94.47 % at 0 % vs 94.54 % at 10 %); the black box is much worse without labels (81.83 % vs 90.76 %). Budgets 10–50 % stay in Table 21 |
| 2 | Major (method) | §6 `set_state`, §8 `sources`, `target_split`, §14b few-shot | Labels are computed from all eight values at *t*, imputed country medians included, but every station row trains the model, which sees those values as missing. Example: England's PO₄ median is 0.144 mg/L (> 0.05 objective) and is imputed in 28.3 % of records, so all those rows "fail" PO₄ in their label | Table 5 (England PO₄); `y_all` uses `SDF[I0]` | Rows may train, tune or support a model only if their four laboratory values are genuinely measured (`TRAIN_TIER = "B"`); tier A and the v13 behaviour are re-evaluated in a new §15e; a new leakage-audit check tests it |
| 3 | Major (bug) | §8 `adaptive_masks` | `LABCUR[np.repeat(rows, MS), j] = draws` assigns the 12 draws of a sample to the **same array cell**; numpy keeps the last one, so the expected entropy was computed from one draw. Affects every "adaptive" result (Tables 14, 23–25, 45) | Demonstration: draws `[0.01, 0.20, 0.60, 1.50]` reach the model as `[1.5, 1.5, 1.5, 1.5]` | Draws are evaluated on separate rows of a copy (`predict_arrays`); global arrays are never modified |
| 4 | Major (method/text) | §6, §8, rule baseline, proxy features, Table 33 | Text says unmeasured tests enter at their "last genuine value"; code uses the value at *t−1* and treats it as **passing** whenever it was imputed. Table 33: 1,319 tier-A samples (≈ 45 %) had no usable *t−1* value | `LABLAG = X1m[:, LIX]` | Carry forward the most recent genuinely measured value of the same series (≤ `LAST_MAX_AGE_DAYS` = 400 days); its origin is verified in the leakage audit; Table 33 now groups by the age of that value. This strengthens the rule baseline and the proxy features |
| 5 | Major (multiplicity) | Tables 26–27, 32–33; §18 claim 6 | "Fewer tests: the model is more accurate than the rule" and "0.7 pp more accurate when the previous visit is recent (p = 0.015, 0.041)" rest on unadjusted p-values. Holm over the four rows: 0.023/0.045/0.053 → ≥ 0.09; 0.015/0.041 → ≥ 0.06. **None survives** | v13 Tables 32, 33 | Holm-adjusted p in Tables 26–27, 32, 33; automated claim check (new Table 60) |
| 6 | Major (label) | §5b Table 9, objectives | Table 9 indicates nitrate is reported **as N** in England and Ireland, yet the label applies 45 mg/L, the drinking-water value **as NO₃** (= 10 mg/L as N) — a 4.4-fold looser objective in the two largest countries | Table 9 vs Table 8 | Sensitivity variant "Nitrate ≤ 10 mg/L as N" added (§15b); stated as a limitation. The primary label is left unchanged because it is defined by the published label (author decision, §3) |
| 7 | Minor (bug) | §8 `metrics9`, `fm_batch` | QWK used scikit-learn's default, which re-indexes the classes present in a subset; with absent classes the quadratic weights are wrong (example: 0.717 vs 0.664 on the same predictions). Canada (1 Poor, 2 Marginal, 3 Fair samples) and most bootstrap draws are affected | `cohen_kappa_score(..., weights="quadratic")` | Fixed ordinal weights `labels=range(5)` in both implementations; unit test with absent classes |
| 8 | Minor (numbers) | Table 11; Table 52; §17 summary | Failure rates computed with imputed values ("PO₄ fails in 67.4 % of station site-days"; England PO₄ 76.9 %) — inflated by the imputed 0.144 mg/L | `LABRAW` / `SD_ST` include imputations | Genuinely measured values only |
| 9 | Minor (text) | §18 notes | Notes quote hard-coded v13 numbers that will not match any re-run | — | Rewritten without numbers; claims come from Table 60 |
| 10 | Minor (text) | §16b | "Reproducibility vs v12" is meaningless once the method changes | — | Becomes "changes relative to v13" |
| 11 | Minor (robustness) | §2 | `df.sample(400_000)` crashes on any file with fewer rows | — | `min(400_000, len(df))` |
| 12 | Minor (text) | Table 15 note | "Balanced accuracy equals macro recall in a multi-class problem" is only true when every predicted class occurs in the test data | — | Note corrected |

## 3. Issues a reviewer will raise that are author decisions (not changed in v14)

* **Framing and title.** v13's own "not supported" list is correct. Decide the framing from Table 60 after the v14 run; a
  suggested benchmark framing and title are in §18 of v14. Do not present the monotonicity constraint as a contribution: it changed
  no predicted class (Δ = 0.0000, Tables 26, 45).
* **Primary nitrate objective.** Either keep 45 mg/L and justify it (published label), or use the unit-consistent value
  (10 mg/L as N) for countries that report as N. Table 52 shows the CCME long-term value as N changes 23–42 % of classes.
* **"N" is probably total oxidised nitrogen, not total N, in England and Ireland.** Its median equals that of nitrate (4.60 vs 4.51
  and 1.36 vs 1.35 mg/L, Table 9). Then N largely duplicates the nitrate input, and the cost table prices it wrongly (Oklahoma
  US$ 90 = TKN + nitrate/nitrite; a TON analysis costs ≈ US$ 38). Check the source agencies' determinand codes.
* **Nitrate treated as a free field sensor.** In these archives nitrate is a laboratory analysis; in-situ optical/ISE sensors exist
  but have different accuracy. State the assumption or price nitrate.
* **Reporting limits treated as imputations.** England NH₃ 0.030 mg/L (24 % of values, not the median) is very likely a detection
  limit. These are censored *measurements* that clearly pass the 0.5 mg/L objective; flagging them as imputed removes clean samples
  from tier A and biases tier A towards polluted samples.
* **Tier-A representativeness.** Evaluation uses 4.7 % (Ireland) to 24 % (Canada) of examples. Compare their class mix and site
  coverage with the full population.
* **Equal country weighting.** Canada (56 samples, 21 sites) has the same weight as England (1,934 samples). Report a pooled,
  sample-weighted headline as a sensitivity analysis.
* **Deep baselines are untuned** (15 epochs, no early stopping or search) and the WGAN-GP uses 500 instead of 1,000 epochs. The
  "Rahman et al. re-implementation" results must be described as an untuned re-implementation, not as a refutation.
* **QRC** is unrelated to the main question and loses to XGBoost on the same inputs (Δ macro-F1 −0.124); move it to the supplement.
* **Site-year comparison (Table 7)** uses imputed values as well; minor.

## 4. Reference check (bibliographic databases, October 2026)

| Reference | Status |
|---|---|
| Karim et al. (2025) *Scientific Data* 12:391 — dataset | found |
| Rahman, Chung & Ng (2026) *Front. Water* 8:1902772 — Transformer-FSL-GAN, 97.33 % | found; abstract matches the numbers quoted |
| Xu et al. (2024) *Heliyon* 10:e33695 | found; "RF with TP and AN, accuracy > 85 %" matches |
| Bordjihene et al. (2026) *Front. Earth Sci.* 10.3389/feart.2026.1761770 | found; XGBoost R² = 0.987 matches |
| Ab Karim et al. (2026) *Environments* 13:267 (review) | found; the sentence quoted in v13 ("may primarily learn to replicate the underlying formulation") is **not in the abstract** — paraphrase or check the full text |
| García-Ceja & González-Mendoza (2026) LNCS 16221:80–90 | **not found — verify before citing** |

## 5. What is new in the v14 notebook

* Configuration: `PIPELINE_VERSION = "v14-r1"` (no v13 checkpoint can be reused), `MAIN_BUDGET = 0.0`, `TRAIN_TIER = "B"`,
  `TRAIN_TIER_VARIANTS = ["A", "all"]`, `LAST_MAX_AGE_DAYS = 400`, nitrate-as-N variant; outputs to `figures_v14/`, `tables_v14/`.
* Leakage audit: two new tested checks (training labels without imputed values; origin of every carried-forward value).
* §15e: training-label tiers re-evaluated. §16b: changes vs v13. Table 60: automated claim check (supported only if the CI excludes
  zero in the claimed direction and the Holm-adjusted p < 0.05).
* All outputs cleared; the change log is at the top of the notebook.

## 6. Smoke test

Pending: the end-to-end run on the synthetic file is in progress; this section is updated when it finishes.

## 7. Next steps

1. Run v14 end-to-end on `Combined_dataset.csv` (expect several hours; the checkpoints let it resume).
2. Write the results and discussion from Table 60 and Tables 14, 21, 29–35; report Table 58 (changes vs v13) in the cover letter.
3. Decide the points in §3 (nitrate objective, reporting limits, weighting, framing) before submission.
4. Verify the García-Ceja & González-Mendoza reference and the review quotation.
