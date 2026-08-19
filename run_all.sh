#!/usr/bin/env bash
#
# Reproduce every number in REPORT.md.
#
#   ./run_all.sh                       # committed configuration, ~2.5-3 h on 4 cores
#   ./run_all.sh --quick               # smoke test, ~10 min, numbers will be poor
#   ./run_all.sh --seeds "42 7 2024 1" # more seeds, tighter error bars
#   ./run_all.sh --outdir results_new  # write somewhere other than results/
#
# Stage order is not arbitrary. vqc_arm.py merges its rows into
# raw_results.csv, so finalize.py has to run after it or the summary will be
# missing the VQC. The two verification scripts run first so a broken
# environment fails in three minutes instead of three hours.
#
# Results are written after every seed, so interrupting a long run still leaves
# usable output -- rerun finalize.py on its own to rebuild the summary from
# whatever seeds finished.

set -euo pipefail

SEEDS="42 7 2024"
TRIALS=30
QSUB=1000
OUTDIR="results"
QUICK=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --quick)   QUICK=1; shift ;;
        --seeds)   SEEDS="$2"; shift 2 ;;
        --trials)  TRIALS="$2"; shift 2 ;;
        --outdir)  OUTDIR="$2"; shift 2 ;;
        -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

# Prefer an activated environment, then a local .venv (what the README builds),
# then whatever python is on PATH. Override with PYTHON=/path/to/python.
if [[ -n "${PYTHON:-}" ]]; then
    PY="$PYTHON"
elif [[ -n "${VIRTUAL_ENV:-}" && -x "$VIRTUAL_ENV/bin/python" ]]; then
    PY="$VIRTUAL_ENV/bin/python"
elif [[ -x .venv/bin/python ]]; then
    PY=".venv/bin/python"
elif [[ -x .venv/Scripts/python.exe ]]; then
    PY=".venv/Scripts/python.exe"
else
    PY="python"
fi
command -v "$PY" >/dev/null || { echo "no python found; set PYTHON=..." >&2; exit 1; }

if ! "$PY" -c "import numpy, pandas, sklearn, scipy, lightgbm, xgboost, catboost, optuna" 2>/dev/null; then
    echo "missing dependencies for '$PY'." >&2
    echo "  python -m venv .venv && . .venv/bin/activate" >&2
    echo "  pip install -r requirements.txt" >&2
    exit 1
fi

if [[ ! -f water_quality_potability.csv ]]; then
    echo "water_quality_potability.csv not found -- run from the repository root" >&2
    exit 1
fi

if [[ $QUICK -eq 1 ]]; then
    SEEDS="42 7"; TRIALS=8; QSUB=400
    [[ "$OUTDIR" == "results" ]] && OUTDIR="results_smoke"
fi

mkdir -p logs "$OUTDIR"
START=$(date +%s)

banner() { printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }

stage() {                       # stage <name> <command...>
    local name="$1"; shift
    banner "$name"
    local t0 dt; t0=$(date +%s)
    if ! "$@" 2>&1 | tee "logs/${name}.log"; then
        echo "FAILED at stage '${name}' -- see logs/${name}.log" >&2
        exit 1
    fi
    dt=$(( $(date +%s) - t0 ))
    printf '  [%s done in %d min %d s]\n' "$name" $(( dt / 60 )) $(( dt % 60 ))
}

echo "seeds:   $SEEDS"
echo "trials:  $TRIALS      quantum subsample: $QSUB"
echo "outdir:  $OUTDIR      logs: logs/"
if [[ $QUICK -eq 1 ]]; then
    echo "mode:    QUICK -- smoke test only, the accuracies are not meaningful"
else
    echo "mode:    full reproduction, expect roughly 2.5-3 hours on 4 cores"
fi

# --- verification first: fails fast on a broken environment ----------------- #
stage "01_vqc_selftest"   "$PY" -W ignore vqc.py
stage "02_leakage_audit"  "$PY" -W ignore leakage_audit.py

# --- the pipeline ----------------------------------------------------------- #
# shellcheck disable=SC2086   # SEEDS is a deliberately word-split list
stage "03_pipeline" "$PY" -u -W ignore water_potability_pipeline.py \
    --seeds $SEEDS --trials "$TRIALS" --quantum-sub "$QSUB" --outdir "$OUTDIR"

# shellcheck disable=SC2086
stage "04_vqc_arm" "$PY" -u -W ignore vqc_arm.py \
    --seeds $SEEDS --outdir "$OUTDIR"

stage "05_finalize" "$PY" -W ignore finalize.py --outdir "$OUTDIR"

# shellcheck disable=SC2086
stage "06_selective" "$PY" -u -W ignore selective.py \
    --seeds $SEEDS --outdir "$OUTDIR"

ELAPSED=$(( $(date +%s) - START ))
banner "COMPLETE in $((ELAPSED / 60)) min $((ELAPSED % 60)) s"
echo "tables:  $OUTDIR/tables/     (summary_formatted.csv is the headline table)"
echo "figures: $OUTDIR/figures/    (600 dpi PNG and vector PDF)"
echo "logs:    logs/"
