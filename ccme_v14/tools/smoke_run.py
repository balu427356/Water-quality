"""Smoke test: execute a notebook end to end on the synthetic file with reduced sizes.
usage: smoke_run.py <notebook> <run_dir> <out_notebook>
Only the configuration cell (and, for v13, the EDA sample size) is changed; every other cell runs as written."""
import re, sys, time
import nbformat
from nbclient import NotebookClient

SMALL = [(r"CAP_PER_COUNTRY = 60_000", "CAP_PER_COUNTRY = 8_000"), (r"TRAIN_CAP       = 20_000", "TRAIN_CAP       = 3_000"),
         (r"VAL_CAP, TEST_CAP = 4_000, 8_000", "VAL_CAP, TEST_CAP = 800, 1_500"), (r"N_REPEATS       = 3", "N_REPEATS       = 2"),
         (r"MS              = 12", "MS              = 4"), (r"NB, DENS_ITER   = 20, 100", "NB, DENS_ITER   = 10, 20"),
         (r"n_estimators=300", "n_estimators=40"), (r"MIN_TIER_A_EVAL = 50", "MIN_TIER_A_EVAL = 20"), (r"N_BOOT          = 1000", "N_BOOT          = 100"),
         (r"DEEP_TRAIN_CAP, DEEP_EPOCHS = 10_000, 15", "DEEP_TRAIN_CAP, DEEP_EPOCHS = 1_500, 2"), (r"KSHOT_EPISODES  = 3", "KSHOT_EPISODES  = 2"),
         (r"GAN_EPOCHS, GAN_SYN = 500, 30", "GAN_EPOCHS, GAN_SYN = 15, 10"),
         (r"PRIOR_EPISODES, PRIOR_PRETRAIN_EPOCHS = 10, 50", "PRIOR_EPISODES, PRIOR_PRETRAIN_EPOCHS = 2, 2"),
         (r"XAI_N, XAI_BG, LIME_N = 300, 25, 60", "XAI_N, XAI_BG, LIME_N = 60, 6, 4"), (r"QRC_SEEDS       = \[7, 21, 55\]", "QRC_SEEDS       = [7]"),
         (r"QRC_GRID        = \[.*\]", "QRC_GRID        = [(1.0, np.pi / 2, 2)]"),
         (r"QRC_TRAIN_CAP, QRC_EVAL_CAP, QRC_TUNE_N = 6_000, 2_000, \(2_000, 1_000\)", "QRC_TRAIN_CAP, QRC_EVAL_CAP, QRC_TUNE_N = 500, 300, (300, 200)")]


def shrink(nb):
    """Reduced sizes for a quick test (configuration cell only; the results are meaningless)."""
    cfg = nb.cells[3].source
    for pat, new in SMALL:
        cfg, n = re.subn(pat, new, cfg)
        assert n >= 1, pat
    nb.cells[3].source = cfg
    for c in nb.cells:      # v13 only: the EDA sample needs >= 400,000 rows
        if c.cell_type == "code" and "samp = df.sample(400_000, random_state=SEED)" in c.source:
            c.source = c.source.replace("samp = df.sample(400_000, random_state=SEED)", "samp = df.sample(min(400_000, len(df)), random_state=SEED)")
    return nb


if __name__ == "__main__":
    nb_path, run_dir, out_path = sys.argv[1:4]
    nb = shrink(nbformat.read(nb_path, as_version=4))
    t0 = time.time()
    client = NotebookClient(nb, timeout=3600, kernel_name="python3", resources={"metadata": {"path": run_dir}})
    try:
        client.execute()
        status = "ok"
    except Exception as e:
        status = f"FAILED: {type(e).__name__}: {str(e)[-3000:]}"
    nbformat.write(nb, out_path)
    print(f"{nb_path}: {status} | {(time.time() - t0) / 60:.1f} min")
