"""Builds WaterQuality_CCME_v14.ipynb from the executed v13 notebook.

Every change is an exact text replacement that must match exactly once (the script stops otherwise), so the diff between
v13 and v14 is precisely the list below. All outputs are cleared: the v14 notebook must be executed on the real data."""
import json, sys, copy

SRC, DST = sys.argv[1], sys.argv[2]
nb = json.load(open(SRC))
cells = nb["cells"]
assert len(cells) == 99, len(cells)


def src(i): return "".join(cells[i]["source"])


def put(i, text): cells[i]["source"] = text.splitlines(keepends=True)


def rep(i, old, new, count=1):
    s = src(i); n = s.count(old)
    assert n == count, f"cell {i}: expected {count} match(es), found {n} for:\n{old[:200]}"
    put(i, s.replace(old, new))


# ============================================================ cell 0: title and change log
rep(0, "### Cross-country evaluation on 2.82 million records from five countries — v13 (audited label, leakage audit, extended baselines, practical value)",
    "### Cross-country evaluation on 2.82 million records from five countries — v14 (corrections of v13)")
rep(0, "are the **formula rule** (the same\nformula with the unmeasured tests at their last value; no learning)",
    "are the **formula rule** (the same\nformula with the unmeasured tests at their last genuinely measured value; no learning)")
rep(0, "### New in v13 (methodological audit for journal submission)", """### New in v14 — corrections of v13 (pre-submission review)
| # | Problem in v13 | Correction in v14 | Where |
|---|---|---|---|
| 1 | **Adaptive selection used one Monte-Carlo draw, not `MS`.** The hypothetical values of a sample were assigned to the same cell of `LABCUR` (`LABCUR[np.repeat(rows, MS), j] = draws`); with repeated indices numpy keeps only the last value, so all `MS` draws were identical | Hypothetical values are written into a copy with one row per draw; no global array is modified | §8 `adaptive_masks` |
| 2 | **Quadratic weighted kappa re-indexed the classes** that occur in a subset (scikit-learn default, mirrored by the fast bootstrap metric), so the weight between e.g. Marginal and Good changed whenever a class was absent (Ireland has 2 Poor samples; most bootstrap draws lose a class) | QWK weights on the fixed ordinal index 0–4 (`labels=range(K)`), in both implementations; unit test with absent classes | §8 |
| 3 | **Training labels contained imputed values.** Every station row trained the models, but its label was computed from the eight values *including* country-median imputations that the model sees as missing — e.g. England's imputed PO₄ (0.144 mg/L > 0.05) made every such row fail PO₄ | Rows may train, tune or support a model only if their laboratory values are genuinely measured (`TRAIN_TIER = "B"`); tier A and the v13 behaviour are re-evaluated in §15e; the leakage audit tests it | §3, §6, §8, §9b, §15e |
| 4 | **"Last genuine value" was the value at *t−1*.** The rule, the proxy features and the cost analysis treated an unmeasured test as *passing* whenever its *t−1* value was imputed (45 % of tier-A samples, Table 33 of v13) | The most recent genuinely measured value of the same series (at most `LAST_MAX_AGE_DAYS` old) is carried forward; the leakage audit verifies its origin; Table 33 groups by its age | §6, §9b, §12c |
| 5 | **The headline was not on unseen countries.** It used 10 % of the test country's labels, and 30–84 % of the test sites also contributed training labels, while the text and Table 14 said "never seen in training" | `MAIN_BUDGET = 0.0`: the headline uses no sample of the test country; the 10–50 % budgets remain in Table 21 | §1, §9, §10 |
| 6 | **Failure rates counted imputed values** (Table 11; "PO₄ fails in 67.4 % of station site-days", Table 52) | Computed on genuinely measured values only | §6, §15 |
| 7 | **Subgroup claims rested on unadjusted p-values** (0 vs 1 vs 2 vs 3 tests; age of the last value; Tables 26–27) | Holm-adjusted p within each family; an automated claim check (Table 60) states which claims the run supports | §12, §12c, §17 |
| 8 | **Nitrate units.** Table 9 shows nitrate is reported as N in England and Ireland, but the label applies 45 mg/L, the drinking-water value *as NO₃* (= 10 mg/L as N) | The same guideline expressed as N (10 mg/L) is added to the sensitivity analysis; the inconsistency is stated as a limitation | §1, §15b, §18 |
| 9 | **Notes for the manuscript contained hard-coded v13 numbers** that would not match a re-run | Notes rewritten without numbers; every number comes from the tables of the run | §18 |
| 10 | Reproducibility table compared with v12 although v14 changes the method | Becomes "changes relative to v13" | §16b |
| 11 | The run failed on Windows: a checkpoint name contained ":" ("NH₃: CCME guideline…"), and text files with ≤, ₄ were written in the system encoding | File names are sanitised; text files are written as UTF-8 | §1, §15, §17 |

> **Execution status.** v14 has a new pipeline ID, so no v13 checkpoint can be reused, and all outputs are cleared: run the notebook
> end-to-end on `Combined_dataset.csv` before using any number. The code was executed end-to-end on a synthetic file with the same
> columns (smoke test only, no results).

### New in v13 (methodological audit for journal submission)""")
rep(0, """> **Execution record.** Pipeline `v13-r1-e2915f9fa2` (same seeds as v12). The expensive computations — main experiment (≈ 100 min), extended
> baselines, deep and few-shot models, robustness checks including the new PO₄/NH₃ variants, and the QRC comparison — were first
> computed under this pipeline ID and checkpointed (in parts, because background jobs on the execution machine are limited to 2 h).
> The notebook was then executed end-to-end in one fresh kernel (24.9 min), restoring those checkpoints (each verified on load
> against the pipeline ID), so the corresponding cells print "restored" and short run times. All main-experiment repeats and the
> deep-learning and QRC results reproduce the v12 run exactly (§16b). The v12 notebook itself is unchanged.""",
    """> **Execution record (v13, superseded).** v13 ran as pipeline `v13-r1-e2915f9fa2` and reproduced the v12 run exactly. Its numbers
> are affected by corrections 1–7 above and must not be reused.""")

# ============================================================ cell 1: list of tables
rep(1, "| 11 | How often each laboratory test fails its objective | §6 |", "| 11 | How often each laboratory test fails its objective (genuinely measured values) | §6 |")
rep(1, "| 14 | Main results on unseen test countries (tier A, 10 % target labels) | §10 |", "| 14 | Main results on unseen test countries (tier A, no labels from the test country) | §10 |")
rep(1, "| 29 | All baselines on the same test records (tier A, 2 laboratory tests, 10 % target labels) | §12b |",
    "| 29 | All baselines on the same test records (tier A, 2 laboratory tests, no labels from the test country) | §12b |")
rep(1, "| 58 | Reproducibility: v13 rerun vs the v12 run | §16b |", "| 58 | Changes relative to v13 (effect of the v14 corrections) | §16b |")
rep(1, "| 59 | Summary of the main results (every value is taken from the tables above) | §17 |",
    "| 59 | Summary of the main results (every value is taken from the tables above) | §17 |\n| 60 | Claim check: which statements the results support | §17 |")

# ============================================================ cell 3: configuration
rep(3, 'PIPELINE_VERSION = "v13-r1"', 'PIPELINE_VERSION = "v14-r1"')
rep(3, "MAIN_BUDGET     = 0.10\n", "MAIN_BUDGET     = 0.0                # headline: no sample of the test country is used (unseen countries); budgets > 0 in §10\n")
rep(3, "MIN_TIER_A_EVAL = 50                 # min genuinely measured evaluation samples for a primary test country\n",
    "MIN_TIER_A_EVAL = 50                 # min genuinely measured evaluation samples for a primary test country\n"
    "TRAIN_TIER      = \"B\"                # rows whose labels may train/tune/support a model: \"A\" = all 8 values genuine, \"B\" = the 4\n"
    "                                     # laboratory values genuine (no imputed laboratory value in a label), \"all\" = v13 behaviour\n"
    "TRAIN_TIER_VARIANTS = [\"A\", \"all\"]   # re-evaluated in §15e\n"
    "LAST_MAX_AGE_DAYS = 400              # unmeasured tests enter the rule/proxy at their last GENUINE value of at most this age (§6)\n")
rep(3, '                   "Nitrate ≤ 13 mg/L (CCME long-term)": ("NO3", (None, 13.0)),\n',
    '                   "Nitrate ≤ 13 mg/L (CCME long-term)": ("NO3", (None, 13.0)),\n'
    '                   "Nitrate ≤ 10 mg/L (Health Canada drinking-water MAC, expressed as N)": ("NO3", (None, 10.0)),\n')
rep(3, 'FIG_DIR, TAB_DIR = "figures_v13", "tables_v13"', 'FIG_DIR, TAB_DIR = "figures_v14", "tables_v14"')
# text files contain ≤, ₄, − ...: write them as UTF-8 (the Windows default encoding cannot hold these characters)
rep(3, 'try: open(f"{TAB_DIR}/{name}.tex", "w").write(', 'try: open(f"{TAB_DIR}/{name}.tex", "w", encoding="utf-8").write(')
rep(97, '_ = open(f"{TAB_DIR}/results_summary.md", "w").write(', '_ = open(f"{TAB_DIR}/results_summary.md", "w", encoding="utf-8").write(')
# checkpoint names are built from variant names; "NH₃: CCME guideline" contains ":", which Windows does not allow in file names
rep(86, '        name = f"rob_{analysis}_{variant}_{c}".replace(" ", "_").replace("/", "_")',
    r'''        name = "".join("_" if ch in ' <>:"/\\|?*' else ch for ch in f"rob_{analysis}_{variant}_{c}")   # valid file name on every OS''')

# ============================================================ cell 4: presentation helpers
rep(4, "'repro', 'summary']", "'repro', 'summary', 'claims']")
rep(4, '("_t-1_ratio", "{p} at t−1 ÷ objective")', '("_t-1_ratio", "{p}: last genuine value ÷ objective")')
rep(4, '"Formula rule (last value) – 2 tests":  (G_RULE, "Rule: unmeasured tests at last value", 2),',
    '"Formula rule (last value) – 2 tests":  (G_RULE, "Rule: unmeasured tests at last genuine value", 2),')
rep(4, 'DASH = "–"\n', 'DASH = "–"\n'
    'def budget_txt(b=None):\n'
    '    b = MAIN_BUDGET if b is None else b\n'
    '    return "no labels from the test country" if b == 0 else f"{100 * b:.0f} % target labels"\n')

# ============================================================ cell 9: EDA sample (works on files with < 400,000 rows)
rep(9, "samp = df.sample(400_000, random_state=SEED)", "samp = df.sample(min(400_000, len(df)), random_state=SEED)")

# ============================================================ cell 26 / 27: panel, last genuine value, training tier
rep(26, "the objective, plus the number of earlier site-days (strictly before *t*; given to every learned model).",
    "the objective, plus the number of earlier site-days (strictly before *t*; given to every learned model). An unmeasured laboratory\n"
    "test enters the formula rule and the proxy features at its **last genuine value**: the most recent genuinely measured value of the\n"
    "series before *t*, at most `LAST_MAX_AGE_DAYS` old (missing if there is none). Rows whose label may train a model are restricted\n"
    "to `TRAIN_TIER` (§8).")
rep(27, "def set_state(protocol=\"genuine\", rule=\"union\"):",
    "SD_DAYS = dtv.astype(\"datetime64[D]\").astype(\"int64\")\n"
    "def last_genuine(protocol, rule):\n"
    "    # most recent genuinely measured value of each laboratory test strictly before t in the same (country, site) series, at most\n"
    "    # LAST_MAX_AGE_DAYS old (NaN if none). Returns the values, their site-day index (-1 = none) and their age in days.\n"
    "    gen = ~bits_to_mask(SD_BITS[rule]) if protocol == \"genuine\" else np.ones(SDF.shape, bool)\n"
    "    val, src = np.full((len(I0), len(LIX)), np.nan), np.full((len(I0), len(LIX)), -1)\n"
    "    for q, j in enumerate(LIX):\n"
    "        last = np.maximum.accumulate(np.where(gen[:, j], np.arange(len(SDF)), -1))[I1]       # latest genuine site-day <= t-1\n"
    "        ok = (last >= START[I0]) & (SD_DAYS[I0] - SD_DAYS[np.maximum(last, 0)] <= LAST_MAX_AGE_DAYS)\n"
    "        val[ok, q] = SDF[last[ok], j]; src[ok, q] = last[ok]\n"
    "    age = np.where(src >= 0, SD_DAYS[I0][:, None] - SD_DAYS[np.maximum(src, 0)], np.nan)\n"
    "    return val, src, age\n"
    "def set_state(protocol=\"genuine\", rule=\"union\"):")
rep(27, "    global XBASE, LABCUR, LABLAG, SENCUR, LABRAW, y_all, YL1_RAW, TIER_A, TIER_B, PROTOCOL, RULE\n",
    "    global XBASE, LABCUR, LABLAG, SENCUR, LABRAW, y_all, YL1_RAW, TIER_A, TIER_B, PROTOCOL, RULE, LABEL_OK, LAST_SRC, LAST_AGE\n")
rep(27, "    LABCUR, LABLAG, SENCUR, LABRAW = X0m[:, LIX], X1m[:, LIX], X0m[:, SIX], X0[:, LIX]\n"
        "    TIER_A = ~m0.any(1); TIER_B = ~m0[:, LIX].any(1); PROTOCOL, RULE = protocol, rule\n",
    "    LABCUR, SENCUR, LABRAW = X0m[:, LIX], X0m[:, SIX], X0[:, LIX]\n"
    "    LABLAG, LAST_SRC, LAST_AGE = last_genuine(protocol, rule)     # v13: X1m[:, LIX], i.e. the value at t-1 and NaN (= pass) if imputed\n"
    "    TIER_A = ~m0.any(1); TIER_B = ~m0[:, LIX].any(1); PROTOCOL, RULE = protocol, rule\n"
    "    # rows whose label may train, tune or support a model: no imputed value of the training tier at t (labels are computed from\n"
    "    # all eight values at t, imputed ones included, so an imputed value would enter the label while the model sees it as missing)\n"
    "    LABEL_OK = ({\"A\": TIER_A, \"B\": TIER_B}.get(TRAIN_TIER, np.ones(len(I0), bool)) if protocol == \"genuine\" else np.ones(len(I0), bool)).copy()\n")
rep(27, 'summary["tier_A_station_eval_samples"] = pd.Series(late & TIER_A & STATION).groupby(ctry).sum()\n',
    'summary["tier_A_station_eval_samples"] = pd.Series(late & TIER_A & STATION).groupby(ctry).sum()\n'
    'summary["label_rows_%"] = pd.Series(LABEL_OK & STATION).groupby(ctry).mean() * 100\n')
rep(27, '      "| supplementary only:", [c for c in ALL_COUNTRIES if c not in PRIMARY])\n',
    '      "| supplementary only:", [c for c in ALL_COUNTRIES if c not in PRIMARY])\n'
    'print(f"rows usable as training labels (station series, TRAIN_TIER = {TRAIN_TIER}):", pd.Series(LABEL_OK & STATION).groupby(ctry).sum().to_dict())\n')
rep(27, "fail_share = pd.DataFrame({f: pd.Series(LABRAW[:, j] > GUIDE[f][1]).groupby(ctry).mean() for j, f in enumerate(LABS)}).round(3)",
    "fail_share = pd.DataFrame({f: pd.Series(np.where(np.isnan(LABCUR[:, j]), np.nan, LABCUR[:, j] > GUIDE[f][1])).groupby(ctry).mean()\n"
    "                           for j, f in enumerate(LABS)}).round(3)        # genuinely measured values only (v13 included imputed values)")

# ============================================================ cell 28: Tables 10 and 11
rep(28, '                      ("Share of examples (%)", "freshwater ambient"): fmt_list(s["freshwater_ambient_%"], lambda v: f_num(v, 1)),\n',
    '                      ("Share of examples (%)", "freshwater ambient"): fmt_list(s["freshwater_ambient_%"], lambda v: f_num(v, 1)),\n'
    '                      ("Share of examples (%)", f"training-label rows (station, tier {TRAIN_TIER})"): fmt_list(s["label_rows_%"], lambda v: f_num(v, 1)),\n')
rep(28, 'f"series in the later half of its history: {\', \'.join(PRIMARY)}. At most {CAP_PER_COUNTRY:,} examples per country.")',
    'f"series in the later half of its history: {\', \'.join(PRIMARY)}. At most {CAP_PER_COUNTRY:,} examples per country. "\n'
    '                    f"Training-label rows = station rows whose label contains no imputed value of tier {TRAIN_TIER} (§8).")')
rep(28, 'show_table("failshare", "How often each laboratory test fails its objective", t, stub="Country",\n'
        '               note="All examples, laboratory values as recorded. When a failing test',
    'show_table("failshare", "How often each laboratory test fails its objective (genuinely measured values)", t, stub="Country",\n'
    '               note="All examples, genuinely measured laboratory values only (imputed country medians excluded). When a failing test')

# ============================================================ cell 32: methods text
put(32, """## 8. Methods
**Proposed (knowledge-guided).** XGBoost on history, current sensors, acquired laboratory values and CCME-consistency features:
proxy CCME score and class (each unacquired test at its **last genuine value**, §6), class ceiling (unacquired tests assumed to
pass), numbers and sizes of exceedances, guideline ratios, the CCME score at *t−1*, and the expected number of hidden exceedances
(sum of the long-run exceedance rates of the unacquired tests). Imputed values are hidden (missing).
**Training labels.** The label of a row is computed from its eight values at *t*. A row may train, tune or support a model only if
it has no imputed value of the training tier (`TRAIN_TIER`; default B = the four laboratory values genuinely measured). In v13 every
station row was used, so imputed country medians entered the labels while the model saw the same values as missing (e.g. England's
imputed PO₄ of 0.144 mg/L fails the 0.05 mg/L objective). Tier A and the v13 behaviour are re-evaluated in §15e.
**Monotonicity-constrained inference.** In the CCME formula an additional failed test can only lower the index, so the true class
can never be above the *ceiling* class (all unacquired tests passing). The proposed model's probabilities above the ceiling are set
to zero and renormalised. This never removes the true class. It is a safeguard rather than a source of accuracy: in v13 it changed no
predicted class; its effect is reported as an ablation (§14).
**Black box.** The same learner, inputs and acquisition pattern without CCME-consistency features or constraint.
**Formula rules (no learning).** CCME formula with unacquired tests (i) at their last genuine value or (ii) assumed to pass.
**Other baselines.** Persistence (class at *t−1*), majority class of the training data, forecast-only (history + context).
**Masked-acquisition training.** Each training row is duplicated with a random subset of 0–3 current laboratory values hidden, so
one model serves every acquisition pattern. **Adaptive selection.** Greedy expected-entropy minimisation with `MS` Monte-Carlo draws
per candidate test from laboratory-value density models (§11); every draw is evaluated on its own row (v13 overwrote the draws of
a sample, so only one draw was used). All tuning (learner, target weight, fixed test sets) uses a separate **validation country**.
""")

# ============================================================ cell 33: methods code
rep(33, """def adaptive_masks(model, D, rows, kmax, seed, formula=True):
    rng = np.random.default_rng(seed); n = len(rows); M = np.zeros((n, 4), bool); out = {}; smp = []
    for edges, m in D:
        P = np.zeros((n, len(edges) - 1)); P[:, m.classes_] = m.predict_proba(XBASE[rows]); cdf = P.cumsum(1)
        u = rng.random((n, MS)); bi = np.minimum((cdf[:, None, :] < u[:, :, None]).sum(2), len(edges) - 2)
        smp.append(edges[bi] + rng.random((n, MS)) * (edges[bi + 1] - edges[bi]))
    saved = LABCUR.copy()
    for k in range(1, kmax + 1):
        E = np.full((n, 4), np.inf)
        for j in range(4):
            idx = np.where(~M[:, j])[0]
            if len(idx) == 0: continue
            rr = np.repeat(rows[idx], MS); Mr = np.repeat(M[idx], MS, axis=0); Mr[:, j] = True
            LABCUR[rr, j] = smp[j][idx].ravel()                      # hypothetical value, restored below
            Pr = predict(model, rr, Mr, formula).reshape(len(idx), MS, -1)
            LABCUR[:] = saved
            E[idx, j] = -(Pr * np.log(Pr + 1e-12)).sum(2).mean(1)
        M[np.arange(n), E.argmin(1)] = True; out[k] = M.copy()
    return out
""", """def adaptive_masks(model, D, rows, kmax, seed, formula=True):
    # greedy expected-entropy minimisation with MS Monte-Carlo values per candidate test, drawn from the density models D.
    # Each draw is evaluated on its own row of a copy of the inputs. (v13 wrote the MS draws of a sample into the same cell of the
    # global LABCUR -- LABCUR[np.repeat(rows, MS), j] = draws -- where numpy keeps only the last value, so one draw was used.)
    rng = np.random.default_rng(seed); n = len(rows); M = np.zeros((n, 4), bool); out = {}; smp = []
    for edges, m in D:
        P = np.zeros((n, len(edges) - 1)); P[:, m.classes_] = m.predict_proba(XBASE[rows]); cdf = P.cumsum(1)
        u = rng.random((n, MS)); bi = np.minimum((cdf[:, None, :] < u[:, :, None]).sum(2), len(edges) - 2)
        smp.append(edges[bi] + rng.random((n, MS)) * (edges[bi + 1] - edges[bi]))
    xb_, lab_, lag_, sen_ = XBASE[rows], LABCUR[rows], LABLAG[rows], SENCUR[rows]
    for k in range(1, kmax + 1):
        E = np.full((n, 4), np.inf)
        for j in range(4):
            idx = np.where(~M[:, j])[0]
            if len(idx) == 0: continue
            rep_ = np.repeat(idx, MS)                                      # row i * MS + d = draw d of sample i
            lab_h = lab_[rep_].copy(); lab_h[:, j] = smp[j][idx].ravel()   # hypothetical value of test j
            Mr = M[rep_].copy(); Mr[:, j] = True
            Pr = predict_arrays(model, xb_[rep_], lab_h, lag_[rep_], sen_[rep_], Mr, formula).reshape(len(idx), MS, -1)
            E[idx, j] = -(Pr * np.log(Pr + 1e-12)).sum(2).mean(1)
        M[np.arange(n), E.argmin(1)] = True; out[k] = M.copy()
    return out
""")
rep(33, """def predict(model, rows, M, formula=True, constrained=True):
    P = proba(model, featurize(rows, M, formula))
    return constrain(P, rows, M) if (formula and constrained) else P
""", """def predict(model, rows, M, formula=True, constrained=True):
    P = proba(model, featurize(rows, M, formula))
    return constrain(P, rows, M) if (formula and constrained) else P
def predict_arrays(model, xb, labcur, lablag, sencur, M, formula=True, constrained=True):
    # predict() on explicit arrays (adaptive selection, measurement-level explanations); never touches the global arrays
    P = proba(model, featurize_arrays(xb, labcur, lablag, sencur, M, formula))
    return constrain_c(P, ceiling_arrays(sencur, labcur, M)) if (formula and constrained) else P
""")
rep(33, """def sources(test_c):
    return np.where((ctry != test_c) & STATION)[0] if PROTOCOL == "genuine" else np.where(ctry != test_c)[0]
""", """def sources(test_c):
    # training rows: other countries, station series, and (genuine protocol) labels without imputed values of the training tier
    return np.where((ctry != test_c) & STATION & LABEL_OK)[0] if PROTOCOL == "genuine" else np.where(ctry != test_c)[0]
""")
rep(33, "    lab = idx[d <= np.quantile(d, b)] if b > 0 else np.array([], int)\n",
    "    lab = idx[d <= np.quantile(d, b)] if b > 0 else np.array([], int)\n"
    "    lab = lab[LABEL_OK[lab]]                                   # target labels without imputed values of the training tier\n")
rep(33, 'QWK=cohen_kappa_score(yt, yp, weights="quadratic"),', 'QWK=cohen_kappa_score(yt, yp, weights="quadratic", labels=list(range(K))),')
rep(33, "    pos = np.cumsum(present, 1) - 1; Wq = (pos[:, :, None] - pos[:, None, :]) ** 2.\n",
    "    Wq = ((np.arange(K)[:, None] - np.arange(K)[None, :]) ** 2.)[None]   # weights on the fixed ordinal index (v13: re-indexed present classes)\n")
rep(33, """_cm = np.bincount(_y * K + _p, minlength=K * K).reshape(1, K, K)
assert np.allclose(fm_batch(_cm)[0], [accuracy_score(_y, _p), f1_score(_y, _p, average="macro"), matthews_corrcoef(_y, _p),
                                      cohen_kappa_score(_y, _p, weights="quadratic")]), "fast metrics must equal scikit-learn"
""", """for _yy, _pp in [(_y, _p), (np.where(_y % 2 == 0, _y, 0), np.where(_p % 2 == 0, _p, 0))]:      # second case: classes 1 and 3 absent
    _cm = np.bincount(_yy * K + _pp, minlength=K * K).reshape(1, K, K)
    assert np.allclose(fm_batch(_cm)[0], [accuracy_score(_yy, _pp), f1_score(_yy, _pp, average="macro"), matthews_corrcoef(_yy, _pp),
                                          cohen_kappa_score(_yy, _pp, weights="quadratic", labels=list(range(K)))]), "fast metrics must equal scikit-learn"
""")

# ============================================================ cell 37: leakage audit
rep(37, """ss = {}
for c in PRIMARY:
    lab, ev = target_split(c, MAIN_BUDGET); evA = ev[TIER_A[ev]]; ss[c] = 100 * np.isin(site_ids[evA], site_ids[lab]).mean()
_chk(f"Test sites that also contribute earlier labelled samples ({100 * MAIN_BUDGET:.0f} % budget)", True,
     "; ".join(f"{c}: {v:.1f} %" for c, v in ss.items()) + " — permitted (earlier labels exist in practice); the 0 % budget excludes them (§12b)", how="info")
""", """b_info = min([b for b in BUDGETS if b > 0], default=MAIN_BUDGET); ss = {}
for c in PRIMARY:
    lab, ev = target_split(c, b_info); evA = ev[TIER_A[ev]]; ss[c] = 100 * np.isin(site_ids[evA], site_ids[lab]).mean()
_chk(f"Test sites that also contribute earlier labelled samples ({100 * b_info:.0f} % budget, label-budget analysis only)", True,
     "; ".join(f"{c}: {v:.1f} %" for c, v in ss.items()) + f" — permitted when target labels are used; the headline uses {budget_txt()}", how="info")
m0_ = bits_to_mask(SD_BITS[RULE][I0]); tier_ok = {"A": ~m0_.any(1), "B": ~m0_[:, LIX].any(1)}.get(TRAIN_TIER, np.ones(len(I0), bool))
tr_rows = np.unique(np.concatenate([sources(c) for c in PRIMARY] + [target_split(c, b)[0] for c in PRIMARY for b in BUDGETS]))
_chk(f"Training and target labels contain no imputed values (training tier {TRAIN_TIER})", bool(tier_ok[tr_rows].all()),
     f"{len(tr_rows):,} training/target-label rows checked against the imputation flags"
     + ("" if TRAIN_TIER in ("A", "B") else " (tier 'all' = v13 behaviour: imputed values allowed)"), how="tested" if TRAIN_TIER in ("A", "B") else "info")
rr_, cc_ = np.where(LAST_SRC >= 0); s_ = LAST_SRC[rr_, cc_]; t_ = I0[rr_]; jj_ = np.array(LIX)[cc_]; gm_ = ~bits_to_mask(SD_BITS[RULE])
okl = bool(((key_c[s_] == key_c[t_]) & (key_s[s_] == key_s[t_]) & (dtv[s_] < dtv[t_]) & gm_[s_, jj_]
            & np.isclose(SDF[s_, jj_], LABLAG[rr_, cc_])).all())
_chk("Last genuine laboratory values come from earlier, genuinely measured visits of the same site", okl,
     f"{len(s_):,} carried-forward values recomputed (at most {LAST_MAX_AGE_DAYS} days old)")
""")

# ============================================================ cell 39 / 41: headline
put(39, """## 10. Results (issues 5 and 6)
All intervals are **95 % site-clustered bootstrap intervals** (sites resampled within each country; §12). Headline values are the
equal-weight mean over primary countries of each country's mean over training repeats, on **tier A** samples at
`MAIN_BUDGET` target labels (0 = no sample of the test country is used for training or model selection; the 10–50 % budgets are in
Table 21). Canada contributes few tier-A samples but one third of the weight; per-country results are in Table 17.
""")
rep(41, "    keys, idx = method_rows(HEAD.index); H = HEAD.loc[keys]\n    t = pd.DataFrame({(\"Lab tests\", \"\")",
    "    seen_txt = \" and never seen in training or model selection\" if MAIN_BUDGET == 0 else f\"; {100 * MAIN_BUDGET:.0f} % of each test country's earliest history is labelled\"\n"
    "    keys, idx = method_rows(HEAD.index); H = HEAD.loc[keys]\n    t = pd.DataFrame({(\"Lab tests\", \"\")")
rep(41, 'show_table("headline", f"Main results on unseen test countries (tier A, {100 * MAIN_BUDGET:.0f} % target labels)", t,',
    'show_table("headline", f"Main results on unseen test countries (tier A, {budget_txt()})", t,')
rep(41, 'note=f"Mean over the test countries ({\', \'.join(PRIMARY)}), each weighted equally and never seen in training. 95% CI = "',
    'note=f"Mean over the test countries ({\', \'.join(PRIMARY)}), each weighted equally{seen_txt}. 95% CI = "')
rep(41, "Balanced \"\n                    \"accuracy equals macro recall in a multi-class problem.",
    "Balanced \"\n                    \"accuracy equals macro recall when every predicted class occurs in the test data.")

# ============================================================ cell 53 / 54 / 56: Holm adjustment of Tables 26-27
rep(53, "COMP = [(", """def holm(p):
    p = np.asarray(p, float); o = np.argsort(p); adj = np.empty(len(p)); run = 0.0
    for r, i in enumerate(o): run = max(run, (len(p) - r) * p[i]); adj[i] = min(1.0, run)
    return adj
COMP = [(""")
rep(53, 'INF = pd.DataFrame(inf_rows); savetab(INF, "tab_inference_meta");',
    'INF = pd.DataFrame(inf_rows)\n'
    'INF["p_boot_holm"] = INF.groupby("metric").p_boot.transform(lambda s: holm(s.to_numpy()))   # Holm over the comparisons, per metric\n'
    'INF["p_RE_holm"] = INF.groupby("metric").p_RE.transform(lambda s: holm(s.to_numpy()))\n'
    'savetab(INF, "tab_inference_meta");')
rep(54, "f_p(r.p_boot, 1 / N_BOOT, 3), f_num(r.RE_diff * sc, dd, True),", "f_p(r.p_boot_holm, 1 / N_BOOT, 3), f_num(r.RE_diff * sc, dd, True),")
rep(54, 'f"[{f_num(r.RE_CI_low * sc, dd, True)}, {f_num(r.RE_CI_high * sc, dd, True)}]", f_p(r.p_RE),',
    'f"[{f_num(r.RE_CI_low * sc, dd, True)}, {f_num(r.RE_CI_high * sc, dd, True)}]", f_p(r.p_RE_holm),')
rep(54, "b[2] = float(r.p_boot) < 0.05; b[5] = float(r.p_RE) < 0.05", "b[2] = float(r.p_boot_holm) < 0.05; b[5] = float(r.p_RE_holm) < 0.05")
rep(54, '("Site bootstrap", "p"), ("Random effects", "Δ"), ("Random effects", "95% CI"),\n                ("Random effects", "p"),',
    '("Site bootstrap", "p (Holm)"), ("Random effects", "Δ"), ("Random effects", "95% CI"),\n                ("Random effects", "p (Holm)"),')
rep(54, '+ " Bold = p < 0.05.")', '+ " p-values are Holm-adjusted over the comparisons of this table. Bold = adjusted p < 0.05.")')
rep(56, """def holm(p):
    p = np.asarray(p, float); o = np.argsort(p); adj = np.empty(len(p)); run = 0.0
    for r, i in enumerate(o): run = max(run, (len(p) - r) * p[i]); adj[i] = min(1.0, run)
    return adj
""", "")
rep(57, 'show_table("xbase", "All baselines on the same test records (tier A, 2 laboratory tests, 10 % target labels)", t, stub="Method",',
    'show_table("xbase", f"All baselines on the same test records (tier A, 2 laboratory tests, {budget_txt()})", t, stub="Method",')

# ============================================================ cell 59 / 60: practical value
rep(59, 'FEWER = pd.DataFrame(few_rows).round(4); savetab(FEWER, "tab_accuracy_by_number_of_tests")',
    'FEWER = pd.DataFrame(few_rows); FEWER["dAcc_p_holm"] = holm(FEWER.dAcc_p.to_numpy())        # Holm over the numbers of tests\n'
    'FEWER = FEWER.round(4); savetab(FEWER, "tab_accuracy_by_number_of_tests")')
rep(59, """GAP1 = pool.gap1.to_numpy()
def _miss_last(c, ev): return (np.isnan(LABLAG[ev]) & ~fixed_mask(len(ev), MAINSTORE[c]["FIXED"][2])).any(1)
GG = {"previous visit ≤ 31 days earlier": lambda c, ev: GAP1[ev] <= 31,
      "previous visit 32–92 days earlier": lambda c, ev: (GAP1[ev] > 31) & (GAP1[ev] <= 92),
      "previous visit > 92 days earlier": lambda c, ev: GAP1[ev] > 92,
      "last value of an unmeasured test not available": _miss_last}
""", """def _age_last(c, ev):
    # age (days) of the older last genuine value of the unmeasured tests; NaN if one of them has none within LAST_MAX_AGE_DAYS
    hid = ~fixed_mask(len(ev), MAINSTORE[c]["FIXED"][2]); return np.where(hid, LAST_AGE[ev], -1.0).max(1)
GG = {"last genuine values ≤ 31 days old": lambda c, ev: _age_last(c, ev) <= 31,
      "last genuine values 32–92 days old": lambda c, ev: (_age_last(c, ev) > 31) & (_age_last(c, ev) <= 92),
      f"last genuine values 93–{LAST_MAX_AGE_DAYS} days old": lambda c, ev: _age_last(c, ev) > 92,
      "last value of an unmeasured test not available": lambda c, ev: np.isnan(_age_last(c, ev))}
""")
rep(59, 'GAPS = pd.DataFrame(gg_rows).round(4); savetab(GAPS, "tab_accuracy_by_last_lab_value")',
    'GAPS = pd.DataFrame(gg_rows); GAPS["dAcc_p_holm"] = holm(GAPS.dAcc_p.to_numpy())             # Holm over the groups\n'
    'GAPS = GAPS.round(4); savetab(GAPS, "tab_accuracy_by_last_lab_value")')
rep(60, '("Δ accuracy, proposed − rule (pp)", "p"): [f_p(p, 1 / N_BOOT, 3) for p in f.dAcc_p]}, index=idx)',
    '("Δ accuracy, proposed − rule (pp)", "p (Holm)"): [f_p(p, 1 / N_BOOT, 3) for p in f.dAcc_p_holm]}, index=idx)')
rep(60, 'B[:, cols.index(("Δ accuracy, proposed − rule (pp)", "p"))] = f.dAcc_p.to_numpy() < 0.05',
    'B[:, cols.index(("Δ accuracy, proposed − rule (pp)", "p (Holm)"))] = f.dAcc_p_holm.to_numpy() < 0.05')
rep(60, '"Δ: site-bootstrap 95% CI and p. Bold = best of the three methods for each metric; Δ p < 0.05.")',
    '"Δ: site-bootstrap 95% CI; p Holm-adjusted over the rows. Bold = best of the three methods for each metric; adjusted p < 0.05.")')
rep(60, '("Δ accuracy, proposed − rule (pp)", "p"): [f_p(p, 1 / N_BOOT, 3) for p in g.dAcc_p]}, index=idx)',
    '("Δ accuracy, proposed − rule (pp)", "p (Holm)"): [f_p(p, 1 / N_BOOT, 3) for p in g.dAcc_p_holm]}, index=idx)')
rep(60, 'B[:, cols.index(("Δ accuracy, proposed − rule (pp)", "p"))] = g.dAcc_p.to_numpy() < 0.05',
    'B[:, cols.index(("Δ accuracy, proposed − rule (pp)", "p (Holm)"))] = g.dAcc_p_holm.to_numpy() < 0.05')
rep(60, """               note="'Not available' = the last value of at least one unmeasured test was imputed and is hidden, so the rule must assume it passes. "
                    "Groups overlap; countries with fewer than 10 samples in a group are omitted. Bold = best of the three methods; Δ p < 0.05.")""",
    """               note=f"Age = days since the last genuinely measured value of the unmeasured tests (the older of the two). 'Not available' = no "
                    f"genuine value of an unmeasured test within {LAST_MAX_AGE_DAYS} days, so the rule must assume it passes. Countries with fewer "
                    "than 10 samples in a group are omitted; p Holm-adjusted over the groups. Bold = best of the three methods; adjusted p < 0.05.")""")
rep(60, '"incubation (Standard Methods 5210 B). Accuracy = agreement with the class from all eight values.")',
    '"incubation (Standard Methods 5210 B). Accuracy = agreement with the class from all eight values. If \'N\' is total oxidised "\n'
    '                    "nitrogen rather than total nitrogen (its median is close to that of nitrate in England and Ireland, " + tref("units")\n'
    '                    + "), its fee is that of the nitrate/nitrite analysis, not TKN + nitrate/nitrite.")')

# ============================================================ cell 68: predict_arrays moved to §8
rep(68, """def predict_arrays(model, xb, labcur, lablag, sencur, M, formula=True, constrained=True):
    P = proba(model, featurize_arrays(xb, labcur, lablag, sencur, M, formula))
    return constrain_c(P, ceiling_arrays(sencur, labcur, M)) if (formula and constrained) else P
""", "# predict_arrays() is defined in §8 (it is also used by the adaptive selection)\n")

# ============================================================ cell 78 / 80: deep models
rep(78, "(iv) Transformer-ProtoNet with CCME-consistency features. Synthetic samples are never used for evaluation.",
    "(iv) Transformer-ProtoNet with CCME-consistency features. Synthetic samples are never used for evaluation. Support samples, like\n"
    "  all training labels, come from rows of the training tier (§8).\n\n"
    "**Limitation.** The deep models have one fixed architecture, `DEEP_EPOCHS` epochs and no early stopping or hyper-parameter search\n"
    "(CPU budget), and the WGAN-GP uses fewer epochs than the original. Their results are untuned reference points; report them as such.")
rep(80, "idx_c = np.where((ctry == c) & STATION)[0]; d_ = days[idx_c]; early = idx_c[d_ <= np.quantile(d_, .5)]",
    "idx_c = np.where((ctry == c) & STATION)[0]; d_ = days[idx_c]; early = idx_c[d_ <= np.quantile(d_, .5)]; early = early[LABEL_OK[early]]")

# ============================================================ cell 85 / 86 / 87: robustness
rep(85, "measures and the parameters that dominate the label (PO₄ fails its objective in most failing samples).",
    "measures and the parameters that dominate the label (PO₄ fails its objective in most failing samples); **15e** other rows for the\n"
    "training labels (tier A; all station rows with imputed values in the labels, as in v13). Nitrate is also tested at 10 mg/L as N\n"
    "(the drinking-water value of the primary label expressed in the unit Table 9 indicates for England and Ireland).")
rep(86, "rob = []\n", 'rob = []\nTT_LABEL = {"A": "Training labels from tier A rows (all eight values genuine)", "B": "Training labels from tier B rows (laboratory values genuine)",\n'
    '            "all": "Training labels from all station rows (imputed values in the labels, v13)"}\n')
rep(86, "SD_ST = sd.loc[sd.station.to_numpy(), F].to_numpy(float)          # every station site-day of the cleaned dataset\n",
    "SD_ST = sd.loc[sd.station.to_numpy(), F].to_numpy(float)          # every station site-day of the cleaned dataset\n"
    "SD_GEN = ~bits_to_mask(SD_BITS[\"union\"])[sd.station.to_numpy()]    # genuinely measured values of those site-days\n")
rep(86, '        r_["fail_share_pct"] = 100 * fl.mean()', '        r_["fail_share_pct"] = 100 * fl[SD_GEN[:, j]].mean()          # genuinely measured values only (v13: all values)')
rep(86, """    for rv_ in IMPUTATION_VARIANTS:
        set_state("genuine", rv_); rob += run_check("imputation rule", rv_, PRIMARY); print(f"15c {rv_} done", flush=True)
    set_state("genuine", "union")
""", """    for rv_ in IMPUTATION_VARIANTS:
        set_state("genuine", rv_); rob += run_check("imputation rule", rv_, PRIMARY); print(f"15c {rv_} done", flush=True)
    set_state("genuine", "union")
    TT_MAIN = TRAIN_TIER
    for tt_ in TRAIN_TIER_VARIANTS:
        TRAIN_TIER = tt_; set_state("genuine", "union"); rob += run_check("training labels", TT_LABEL[tt_], PRIMARY)
        print(f"15e training tier {tt_} done", flush=True)
    TRAIN_TIER = TT_MAIN; set_state("genuine", "union")
""")
rep(87, '            ("imputation rule", IMPUTATION_VARIANTS, "Alternative imputation-detection rules (15c)"),\n',
    '            ("imputation rule", IMPUTATION_VARIANTS, "Alternative imputation-detection rules (15c)"),\n'
    '            ("training labels", None, "Alternative training-label rows (15e)"),\n')
rep(87, "NH₃ ≤ {GUIDE['NH3'][1]}\" if an == \"primary\"",
    "NH₃ ≤ {GUIDE['NH3'][1]}, training tier {TRAIN_TIER}\" if an == \"primary\"")
rep(87, '("Station site-days failing its objective (%)", "")', '("Station site-days failing its objective (%, genuine values)", "")')

# ============================================================ cell 92-94: changes vs v13
put(92, """## 16b. Changes relative to v13
v14 corrects the v13 method (change log at the top), so its values are expected to differ. The cell below lists, value by value,
how the headline, calibration, statistical, deep-learning and QRC results changed relative to v13 (whose values were identical to
v12). Report these changes in the response to reviewers; they are not a reproducibility test.
""")
rep(93, "V12_REF = {", "V13_REF = {   # values of the executed v13 notebook (identical to the v12 run)")
rep(93, """}          # values of the executed v12 notebook (tables of §10, §10b, §12, §14b, §16)
rep_rows = []
def _cmp(tab, obj, rkey, col, v12):
    try: v13 = float(obj.loc[rkey, col])
    except (KeyError, TypeError): v13 = np.nan
    rep_rows.append(dict(table=tab, row=str(rkey), column=col, v12=v12, v13=v13, abs_diff=abs(v13 - v12) if not np.isnan(v13) else np.nan))
for (tab, rkey, col), v in V12_REF.items():
    obj = {"headline": HEAD, "calibration": CAL, "inference": INF, "zero-shot deep": zt if RUN_DEEP else None, "QRC": TQ if RUN_QRC else None}[tab]
    if obj is not None: _cmp(tab, obj, rkey, col, v)
REPRO = pd.DataFrame(rep_rows); REPRO["identical_at_4dp"] = REPRO.abs_diff < 5e-5; savetab(REPRO, "tab_reproducibility_vs_v12")
print(REPRO.groupby("table").agg(values=("v12", "size"), identical=("identical_at_4dp", "sum"), max_abs_diff=("abs_diff", "max")))""", """}          # tables of §10, §10b, §12, §14b, §16 of v13
rep_rows = []
def _cmp(tab, obj, rkey, col, old):
    try: new = float(obj.loc[rkey, col])
    except (KeyError, TypeError): new = np.nan
    rep_rows.append(dict(table=tab, row=str(rkey), column=col, v13=old, v14=new, change=new - old if not np.isnan(new) else np.nan))
for (tab, rkey, col), v in V13_REF.items():
    obj = {"headline": HEAD, "calibration": CAL, "inference": INF, "zero-shot deep": zt if RUN_DEEP else None, "QRC": TQ if RUN_QRC else None}[tab]
    if obj is not None: _cmp(tab, obj, rkey, col, v)
REPRO = pd.DataFrame(rep_rows); REPRO["unchanged_at_4dp"] = REPRO.change.abs() < 5e-5; savetab(REPRO, "tab_changes_vs_v13")
print(REPRO.groupby("table").agg(values=("v13", "size"), unchanged=("unchanged_at_4dp", "sum"), max_abs_change=("change", lambda s: s.abs().max())))
""")
put(94, """# Tables (presentation of the results above; numbered automatically)
def _present():
    g = REPRO.groupby("table", sort=False).agg(n=("v13", "size"), same=("unchanged_at_4dp", "sum"), mx=("change", lambda s: s.abs().max()))
    t = pd.DataFrame({"Values compared": fmt_list(g.n, f_int), "Unchanged at 4 decimals": fmt_list(g.same, f_int),
                      "Largest |change|": [DASH if _isnan(v) else f"{v:.4f}" for v in g.mx]}, index=list(g.index))
    show_table("repro", "Changes relative to v13 (effect of the v14 corrections)", t, stub="Results table",
               note="v13 values (identical to the v12 run). v14 uses no test-country labels in the headline, no imputed values in the training "
                    "labels, the last genuine value instead of the value at t−1, all Monte-Carlo draws in the adaptive selection and fixed QWK "
                    "weights, so changes are expected. Value-by-value changes: tab_changes_vs_v13.csv.")
_present()
""")

# ============================================================ cell 96: summary table; new cell: claim check
rep(96, '    rows.append(("Leakage audit", f"{(LEAKAGE.status == \'pass\').sum()} tested checks passed, none failed", tref("leakage")))\n',
    '    rows.append(("Leakage audit", f"{(LEAKAGE.status == \'pass\').sum()} tested checks passed, none failed", tref("leakage")))\n'
    '    rows.append(("Training labels", f"no imputed value of tier {TRAIN_TIER} in any training, tuning or support label; alternatives in §15e", tref("panel", "robust_models")))\n')
rep(96, '    rows.append(("Main result: proposed, 2 tests",', '    rows.append((f"Main result ({budget_txt()}): proposed, 2 tests",')
rep(96, '    rows.append(("Reproducibility", f"{int(REPRO.identical_at_4dp.sum())} of {len(REPRO)} v12 values reproduced identically at 4 decimals", tref("repro")))',
    '    rows.append(("Changes vs v13", f"{int(REPRO.unchanged_at_4dp.sum())} of {len(REPRO)} v13 values unchanged at 4 decimals (changes are expected, §16b)", tref("repro")))')
rep(97, 'L.append(f"Reproducibility vs v12: {int(REPRO.identical_at_4dp.sum())}/{len(REPRO)} values identical at 4 decimals.")',
    'L.append(f"Changes vs v13: {int(REPRO.unchanged_at_4dp.sum())}/{len(REPRO)} values unchanged at 4 decimals (corrections, §16b).")\n'
    'for _, r in CLAIMS.iterrows(): L.append(f"Claim check [{r.claim}]: {r.verdict} (estimate {r.estimate}, {r.interval}, p {r.p}).")')

CLAIM_CELL = '''# Claim check (Table 60). Every candidate statement of the manuscript is tested against the values computed in this run.
# "supported" = the 95 % site-bootstrap interval excludes zero in the claimed direction AND the p-value (Holm-adjusted within its
# family where a family of comparisons was made) is below 0.05. "descriptive" rows have no interval. Write the paper from this table.
CL = []
def _claim(family, claim, est, lo=None, hi=None, p=None, table="", interval="95% CI"):
    if lo is None: verdict = "supported (descriptive)" if est > 0 else "not supported (descriptive)"
    else: verdict = "supported" if (lo > 0 and (p is None or p < 0.05)) else "not supported"
    CL.append(dict(family=family, claim=claim, estimate=f"{est:+.4f}", interval=DASH if lo is None else f"{interval} [{lo:+.4f}, {hi:+.4f}]",
                   p=DASH if p is None else f"{p:.3f}", verdict=verdict, table=table))
pf, bb = "Proposed – 2 tests fixed", "Black box – 2 tests"
v = VSRULE.set_index(["method", "metric"])
for met, nm in [("Accuracy", "accuracy"), ("MacroF1", "macro-F1")]:
    r = v.loc[(pf, met)]
    _claim("Main comparison", f"Proposed beats the formula rule in {nm} (2 tests)", r.mean_diff, r.boot_CI_low, r.boot_CI_high, r.p_boot_holm, tref("xbase_tests"))
I = inf_pairs(INF, COMP)
def _inf(a, b, met): return I[(I.pair_a == a) & (I.pair_b == b) & (I.metric == met)].iloc[0]
for met, nm in [("Accuracy", "accuracy"), ("MacroF1", "macro-F1")]:
    r = _inf(pf, bb, met); _claim("Main comparison", f"Proposed beats the black box in {nm}", r.mean_diff, r.boot_CI_low, r.boot_CI_high, r.p_boot_holm, tref("stats_f1", "stats_acc"))
for b_, nm in [("Ablation: without monotonicity constraint", "The monotonicity constraint improves macro-F1"),
               ("Ablation: without history", "Site history improves macro-F1"), ("Ablation: without current sensors", "Current field sensors improve macro-F1")]:
    r = _inf(pf, b_, "MacroF1"); _claim("Components", nm, r.mean_diff, r.boot_CI_low, r.boot_CI_high, r.p_boot_holm, tref("stats_f1"))
r = _inf("Proposed – 2 tests adaptive", pf, "MacroF1")
_claim("Components", "Adaptive test selection beats the validation-chosen fixed pair (macro-F1)", r.mean_diff, r.boot_CI_low, r.boot_CI_high, r.p_boot_holm, tref("stats_f1"))
cf = [(nm, paired(BTX, a_, b_, 1)) for nm, a_, b_ in [("logistic regression", XN["lr+"], XN["lr"]), ("random forest", XN["rf+"], XN["rf"]), ("XGBoost", pf, bb)]]
for (nm, r), ph in zip(cf, holm([r["p_boot"] for _, r in cf])):
    _claim("CCME-consistency features", f"CCME-consistency features improve {nm} (macro-F1)", r["mean_diff"], r["boot_CI_low"], r["boot_CI_high"], ph, tref("xbase"))
for _, r in FEWER.iterrows():
    _claim("Fewer laboratory tests", f"Proposed beats the rule in accuracy with {int(r.k)} laboratory test{'s' if r.k != 1 else ''}", r.dAcc, r.dAcc_lo, r.dAcc_hi, r.dAcc_p_holm, tref("fewer_tests"))
for _, r in GAPS.iterrows():
    _claim("Age of the last value", f"Proposed beats the rule in accuracy: {r.group}", r.dAcc, r.dAcc_lo, r.dAcc_hi, r.dAcc_p_holm, tref("gap_groups"))
r = TRIAGE.set_index("method").loc["Proposed: least confident first"]
_claim("Practical value", "Selective full-panel testing needs the model (accuracy at 20 % sent vs rule-based selection)", r.d20_vs_rule_triage, r.d20_CI_low, r.d20_CI_high, r.d20_p, tref("triage"))
hd = HDET_S
_claim("Practical value", "The proposed model flags hidden failures better than the site's past exceedance rates (ROC-AUC difference)",
       float(hd.loc["Proposed: probability of a class below the ceiling", "ROC_AUC"] - hd.loc["Site history: probability from past exceedance rates", "ROC_AUC"]),
       table=tref("hidden_detect"))
if RUN_QRC:
    for _, r in QD.iterrows():
        _claim("Quantum reservoir", f"{r.comparison}: first model better (macro-F1)", r.mean_diff_MacroF1, r["min"], r["max"], table=tref("qrc_diff"), interval="range")
CLAIMS = pd.DataFrame(CL); savetab(CLAIMS, "tab_claim_check")
def _present():
    t = pd.DataFrame({"Estimate": list(CLAIMS.estimate), "Interval": list(CLAIMS.interval), "p": list(CLAIMS.p), "Verdict": list(CLAIMS.verdict),
                      "Table": list(CLAIMS.table)}, index=pd.MultiIndex.from_tuples(list(zip(CLAIMS.family, CLAIMS.claim))))
    B = np.zeros(t.shape, bool); B[:, 3] = CLAIMS.verdict.str.startswith("supported").to_numpy()
    show_table("claims", "Claim check: which statements the results support", t, stub="Claim", left=["Interval", "Verdict", "Table"], bold=B,
               note="Estimate = difference (first − second, 0–1 scale; accuracy as a fraction). Supported = interval excludes zero in the claimed "
                    "direction and p < 0.05; p is Holm-adjusted within each family of comparisons (none for the selective-testing row). QRC rows "
                    "use the range over countries × seeds instead of a CI. Descriptive rows compare point estimates only. Bold = supported.")
_present()
'''
new_cell = {"cell_type": "code", "execution_count": None, "id": "c1a1c4ec", "metadata": {}, "outputs": [], "source": CLAIM_CELL.splitlines(keepends=True)}
cells.insert(97, new_cell)          # after the summary table (cell 96); the old cell 97 (text summary) becomes 98

# ============================================================ notes for the manuscript (now cell 99)
put(99, """## 18. Notes for the manuscript (v14)

**Every number in the paper must come from the tables of a v14 run.** This section contains no numbers on purpose: the v13 notes
quoted values that the corrections change. Claims are decided by Table 60, not by these notes.

**Task statement (use verbatim).** "We estimate the record-level CCME-type class of a sample from its four field-sensor values, a
subset of its four laboratory values and the site's recent history, for monitoring stations in countries not seen during training."
State that the field-sensor values are inputs of the label by design, and report the formula-rule baseline, which shows how much of
the performance needs learning. If `MAIN_BUDGET` > 0 is used for any headline, do not write "countries not seen during training".

**How to describe the label.** "A single-sample CCME-type index: the CCME WQI 1.0 formula applied to one record, with the CCME
dissolved-oxygen minimum (5.5 mg/L) and pH range (6.5–9.0) and, for the other six parameters, the objectives of the published
dataset label." Do not call it "the CCME WQI" (CCME requires at least four parameters and four samples per site and year; report the
site-year agreement of Table 7). List every objective with its basis (Table 8). State that the dataset does not report units, that
nitrate appears to be reported as N in England and Ireland (Table 9) while the nitrate objective of 45 mg/L is a value *as NO₃*
(10 mg/L as N; tested in §15b), and that "N" behaves like total oxidised nitrogen in England and Ireland (median close to nitrate).

**Training labels and imputation.** State that labels used for training, tuning and few-shot support contain no imputed laboratory
value (`TRAIN_TIER`), that evaluation uses tier A only, and report §15e. Values equal to a frequent constant are treated as imputed;
some of these constants are reporting limits (e.g. England NH₃ 0.03 mg/L), i.e. censored measurements rather than imputations —
say so, because excluding them removes clean samples from tier A.

### How to frame the contribution
Decide the framing after the run, from Table 60:
- If the proposed model does **not** beat the formula rule (as in v13), the paper is an *audited benchmark*: (i) audit and
  correction of a widely used public label; (ii) a leakage-free reduced-panel task on genuinely measured samples from unseen
  countries; (iii) evidence that CCME-consistency features are what lets learners transfer across countries; (iv) an honest
  comparison showing that a no-learning formula rule with the last genuine laboratory values is as accurate as every learner.
  Title suggestion: *Does machine learning beat the formula? An audited cross-country benchmark for water-quality classification
  with a reduced laboratory panel.*
- Claim an advantage of learning only for rows marked "supported" in Table 60.
- Do not present the monotonicity constraint, adaptive selection or QRC as contributions unless Table 60 supports them; QRC is
  better placed in the supplement.

### Limitations to state
Single-sample index; five of eight objectives are those of the published label, not CCME guidelines; reporting units are not
documented (nitrate as N vs NO₃; "N" possibly total oxidised N); nitrate is treated as a field-sensor value although it is a
laboratory analysis in these archives (in-situ optical/ISE nitrate sensors exist but have different accuracy); three primary test
countries, Canada small but weighted equally; tier-A evaluation covers a minority of samples and may differ from the population;
heuristic imputation detection (validated in §4b, varied in §15c) that also flags reporting limits; freshwater objectives applied
to some non-freshwater samples (freshwater subset in §10); untuned deep baselines; fees from two US public laboratories; selective
testing requires that the sample is kept for the remaining tests within their holding time (BOD: 48 h, US EPA 40 CFR Part 136,
Table II); the quantum reservoir is classically simulated.

### Positioning against prior work (Table 37)
Reduced-panel prediction of water-quality indices is established (Xu et al., 2024; García-Ceja & González-Mendoza, 2026; Bordjihene
et al., 2026), mostly with random splits within one region and labels computed from the model's own inputs. A 2026 review (Ab Karim
et al., *Environments* 13:267) notes that the deterministic structure of WQIs often makes high predictive performance reflect the
predefined formulation rather than independent pattern learning; paraphrase it (the v13 notes quoted a sentence that does not appear
in its abstract — check the full text before quoting).

### References used in this notebook
Checked against bibliographic databases (October 2026): Karim et al. 2025; Rahman, Chung & Ng 2026; Xu et al. 2024; Bordjihene et
al. 2026; Ab Karim et al. 2026 (*Environments*). **Not found — verify before citing:** García-Ceja & González-Mendoza (2026), LNCS
16221:80–90. The regulatory sources (CCME, S.I. 272/2009, US EPA 1986, Health Canada, fee schedules) should be checked at the cited URLs.
- CCME (2001; user's manual 2017) Water Quality Index 1.0. https://ccme.ca/en/res/wqimanualen.pdf
- CCME (2017) Synthesis of research and application of the CCME WQI. https://ccme.ca/en/res/synthesis-of-research-and-application-of-the-ccme-water-quality-index-2017.pdf
- CCME Canadian Water Quality Guidelines: dissolved oxygen (1999) https://ccme.ca/en/chemical/154 ; ammonia (2010) https://ccme.ca/en/res/ammonia-en-canadian-water-quality-guidelines-for-the-protection-of-aquatic-life.pdf ; nitrate (2012) https://ccme.ca/en/chemical/140 ; phosphorus guidance framework (2004) https://ccme.ca/en/chemical/167
- Ireland, S.I. No. 272/2009 as amended by S.I. No. 77/2019, Schedule 5 (river standards).
- US EPA (1986) Quality Criteria for Water, EPA 440/5-86-001. https://www.epa.gov/sites/default/files/2018-10/documents/quality-criteria-water-1986.pdf
- Health Canada, Guidelines for Canadian Drinking Water Quality — nitrate and nitrite (MAC 45 mg/L as nitrate = 10 mg/L as nitrate-N).
- Standard Methods 5210 B (5-day BOD test). https://nemi.gov/methods/method_summary/5715
- Oklahoma DEQ State Environmental Laboratory Services, Lab Services Fee Schedule FY27; Montana DPHHS Environmental Laboratory Testing Fee Schedule (2024).
- Karim et al. (2025) Scientific Data 12:391, https://doi.org/10.1038/s41597-025-04715-4 ; data https://doi.org/10.6084/m9.figshare.27800394
- Rahman, Chung & Ng (2026) Front. Water 8:1902772, https://doi.org/10.3389/frwa.2026.1902772
- Xu et al. (2024) Heliyon 10:e33695, https://doi.org/10.1016/j.heliyon.2024.e33695 ; García-Ceja & González-Mendoza (2026) LNCS 16221:80–90, https://doi.org/10.1007/978-3-032-09037-9_7 (not verified) ; Bordjihene et al. (2026) Front. Earth Sci. 14, https://doi.org/10.3389/feart.2026.1761770
- Ab Karim et al. (2026) Water quality monitoring and assessment using machine learning: a review of formulation, modeling approaches, and explainable artificial intelligence. Environments 13:267, https://doi.org/10.3390/environments13050267
""")

# ============================================================ clear outputs and metadata of the v13 run
for c in cells:
    if c["cell_type"] == "code":
        c["outputs"] = []; c["execution_count"] = None
    c.get("metadata", {}).pop("execution", None)
nb["metadata"].pop("v13_execution", None)
json.dump(nb, open(DST, "w"), indent=1, ensure_ascii=False)
print("written", DST, "cells:", len(cells))
