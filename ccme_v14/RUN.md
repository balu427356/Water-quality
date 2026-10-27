# How to run `WaterQuality_CCME_v14.ipynb`

You need: Python 3.12 or 3.13, about 16 GB of RAM, a few GB of free disk, and several hours. No GPU is needed.

## 1. Get the files

```bash
git clone -b ccr-cf9e1a57-cqnpd9 https://github.com/balu427356/Water-quality.git
cd Water-quality/ccme_v14
```

(Or download `ccme_v14/` from that branch on GitHub.)

## 2. Put the data next to the notebook

Download the dataset of Karim et al. (2025) from figshare (https://doi.org/10.6084/m9.figshare.27800394) and save the CSV as
`ccme_v14/Combined_dataset.csv`. The notebook reads that exact name from the folder it runs in (rename the file if it is called
differently). Correct file: Table 1 of the run shows 2,827,977 records.

## 3. Install the packages

```bash
python -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install torch==2.14.1 --index-url https://download.pytorch.org/whl/cpu    # optional: small CPU-only PyTorch
pip install -r requirements.txt
```

## 4. Optional: test the installation (≈ 20–30 min)

Runs the whole notebook with reduced sizes on a synthetic file with the same columns. The numbers are meaningless; it only checks
that everything works before the long run.

```bash
python tools/make_synthetic.py smoke/Combined_dataset.csv
python tools/run_notebook.py WaterQuality_CCME_v14.ipynb smoke --smoke
```

It should end with `finished`.

## 5. Full run

**Without a browser (recommended for a run of several hours):**

```bash
python tools/run_notebook.py WaterQuality_CCME_v14.ipynb .
```

It prints a line after every cell. To keep it running after you close the terminal (Linux/macOS):

```bash
nohup python tools/run_notebook.py WaterQuality_CCME_v14.ipynb . > run.log 2>&1 &
tail -f run.log
```

**Or in Jupyter:** `pip install notebook`, run `jupyter notebook`, open `WaterQuality_CCME_v14.ipynb`, then *Kernel → Restart &
Run All*. Keep the computer awake until the last cell has finished.

**If it stops** (power cut, disconnect, error): run the same command again. Finished parts are restored from `checkpoints/` and
are not recomputed. Do not edit the configuration cell (§1) between runs: any change creates a new pipeline ID and everything is
recomputed.

## 6. Google Colab

1. Upload the `ccme_v14` folder, with `Combined_dataset.csv` in it, to Google Drive.
2. Open `WaterQuality_CCME_v14.ipynb` in Colab (CPU runtime; High-RAM if available) and add this as the first cell:
   ```python
   from google.colab import drive; drive.mount("/content/drive")
   %cd /content/drive/MyDrive/ccme_v14
   !pip install -q shap lime
   ```
3. *Runtime → Run all*. Colab disconnects after some hours; because the working folder is on Drive, the checkpoints survive —
   reconnect and *Run all* again to resume. Colab's preinstalled package versions are newer or older than those in
   `requirements.txt`; if a cell fails because of a version, install the listed version.

## 7. What you get

| Where | What |
|---|---|
| `WaterQuality_CCME_v14_executed.ipynb` | the notebook with all outputs (from `run_notebook.py`; in Jupyter, save the notebook) |
| `tables_v14/paper_tables/table_NN.csv` | every numbered table (1–60) as shown in the notebook |
| `tables_v14/*.csv`, `*.tex` | full-precision tables and LaTeX versions |
| `tables_v14/results_summary.md` | all key numbers as a text list |
| `figures_v14/*.png`, `*.pdf` | figures (PNG at 300 dpi and PDF) |

Read first: **Table 13** (leakage audit — the notebook stops if a check fails), **Table 14** (main results), **Table 30**
(comparison with the formula rule), **Table 60** (which claims the results support) and **Table 58** (changes relative to v13).

## Common problems

| Message | Cause |
|---|---|
| `No Combined_dataset.csv in …` / `FileNotFoundError` | the data file is not in the folder you run from, or has another name |
| `MemoryError`, or the process is killed | not enough RAM: close other programs or use a machine with ≥ 16 GB |
| `AssertionError` in §9b | a leakage check failed — do not use the results |
| `ModuleNotFoundError` | the virtual environment is not activated, or step 3 was skipped |
