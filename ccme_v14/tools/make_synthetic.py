"""Synthetic stand-in for Combined_dataset.csv (Karim et al. 2025) used ONLY to smoke-test that the
notebook executes end to end. Same columns, five countries, station series with repeated visits,
country-median imputation, reporting-limit constants, an aggregate identifier (China), out-of-range
rows, duplicates and the published label (DO/pH as maxima, denominator 12). The values are random;
no result computed on this file says anything about water quality."""
import os, sys
import numpy as np, pandas as pd

rng = np.random.default_rng(0)
F = ["NH3", "BOD", "DO", "PO4", "pH", "T", "N", "NO3"]
COLS = {"NH3": "Ammonia (mg/l)", "BOD": "Biochemical Oxygen Demand (mg/l)", "DO": "Dissolved Oxygen (mg/l)",
        "PO4": "Orthophosphate (mg/l)", "pH": "pH (ph units)", "T": "Temperature (cel)", "N": "Nitrogen (mg/l)",
        "NO3": "Nitrate (mg/l)"}
GUIDE_PUB = {"NH3": (None, .5), "BOD": (None, 6), "DO": (None, 14), "PO4": (None, .05), "pH": (None, 8.5), "T": (None, 25),
             "N": (None, 20), "NO3": (None, 45)}
CLASSES = ["Poor", "Marginal", "Fair", "Good", "Excellent"]
# country: (sites, visits per site, pollution level, imputation probability, records per day)
SPEC = {"England": (500, 45, 1.0, 0.18, 1), "Ireland": (350, 40, 0.45, 0.22, 1), "Canada": (120, 12, 0.7, 0.12, 1),
        "USA": (40, 120, 0.4, 0.75, 2), "China": (1, 120, 0.5, 0.15, 20)}


def series(n, level):
    # autocorrelated site series for the eight parameters
    z = np.zeros((n, len(F))); e = rng.normal(0, 1, (n, len(F)))
    for t in range(n): z[t] = (0.7 * z[t - 1] if t else 0) + 0.7 * e[t]
    site = rng.normal(0, 0.6, len(F))
    nh3 = np.exp(np.log(0.08 * level) + 1.1 * (z[:, 0] + site[0]))
    bod = np.exp(np.log(2.2 * level ** .5) + 0.6 * (z[:, 1] + site[1]))
    do = np.clip(10 - 1.8 * (z[:, 2] + site[2]) - 2.2 * np.log(level), 0.2, 19.5)
    po4 = np.exp(np.log(0.06 * level) + 0.9 * (z[:, 3] + site[3]))
    ph = np.clip(7.7 + 0.45 * (z[:, 4] + site[4]), 5.0, 9.8)
    temp = np.clip(12 + 5 * np.sin(np.arange(n) / 2.0) + 2 * site[5] + rng.normal(0, 1.5, n), -1, 30)
    no3 = np.exp(np.log(3.0 * level) + 0.7 * (z[:, 7] + site[7]))
    n_ = no3 * np.exp(rng.normal(0.05, 0.05, n)) + 0.3 * rng.random(n)
    return np.c_[nh3, bod, do, po4, ph, temp, n_, no3]


rows = []
for c, (S, V, lev, p_imp, rpd) in SPEC.items():
    for s in range(S):
        site = "CHN_ALL" if c == "China" else f"{c[:3].upper()}_{s:04d}"
        start = np.datetime64("2001-01-01") + np.timedelta64(int(rng.integers(0, 1500)), "D")
        steps = rng.integers(14, 75, V) if c != "Canada" else rng.integers(150, 380, V)
        dates = start + np.cumsum(steps).astype("timedelta64[D]")
        X = series(V, lev * np.exp(rng.normal(0, 0.9)))
        wb = rng.choice(["River", "Lake", "Canal", "Estuary"], p=[.7, .15, .1, .05])
        for t in range(V):
            for r in range(rpd if rpd == 1 else int(rng.integers(1, rpd + 1))):
                x = X[t] * (1 if r == 0 else np.exp(rng.normal(0, .05, len(F))))
                rows.append([c, site, wb, pd.Timestamp(dates[t]).strftime("%d-%m-%Y"), *x])
df = pd.DataFrame(rows, columns=["Country", "Area", "Waterbody Type", "Date"] + [COLS[f] for f in F])
# imputation: country median (documented) + reporting-limit constant for England NH3 + a non-median constant for Ireland DO
for c, (S, V, lev, p_imp, rpd) in SPEC.items():
    m = df.Country == c
    for f in F:
        col = COLS[f]; med = df.loc[m, col].median(); hit = m & (rng.random(len(df)) < p_imp)
        df.loc[hit, col] = med
    if c == "England":
        lod = m & (df[COLS["NH3"]] < 0.03); df.loc[lod, COLS["NH3"]] = 0.03
    if c == "Ireland":
        hit = m & (rng.random(len(df)) < 0.2); df.loc[hit, COLS["DO"]] = 11.6841
df[[COLS[f] for f in F]] = df[[COLS[f] for f in F]].round(5)
# a few invalid rows and exact duplicates
bad = rng.choice(len(df), 40, replace=False); df.loc[bad[:20], COLS["T"]] = 55.0; df.loc[bad[20:], COLS["pH"]] = 15.0
df = pd.concat([df, df.sample(60, random_state=1)], ignore_index=True)
# published label: DO and pH treated as maxima, denominator 12 (reproduced exactly in the notebook, Section 5)
nf = np.zeros(len(df)); exc = np.zeros(len(df))
for f, (lo, hi) in GUIDE_PUB.items():
    x = df[COLS[f]].to_numpy(float); mk = x > hi; nf += mk; exc += np.where(mk, x / hi - 1, 0)
nse = exc / 12
score = 100 - np.sqrt(2 * (100 * nf / 12) ** 2 + (nse / (.01 * nse + .01)) ** 2) / 1.732
df["CCME_Values"] = score; df["CCME_WQI"] = [CLASSES[k] for k in np.digitize(score, [45, 65, 80, 95])]
out = sys.argv[1] if len(sys.argv) > 1 else "Combined_dataset.csv"
os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
df.to_csv(out, index=False)
print(out, df.shape, df.Country.value_counts().to_dict(), df.CCME_WQI.value_counts().to_dict())
