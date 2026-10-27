"""Run the notebook from start to finish without a browser, printing progress.

usage:  python tools/run_notebook.py WaterQuality_CCME_v14.ipynb <folder> [--smoke]

<folder> must contain Combined_dataset.csv. Tables, figures and checkpoints are written there, and the executed notebook is saved
as <folder>/<notebook name>_executed.ipynb -- also when a cell fails, with the error shown in that cell. Running the same command
again resumes: finished parts are restored from <folder>/checkpoints/. --smoke uses reduced sizes (installation test, about
20-30 min on the synthetic file of tools/make_synthetic.py; its numbers are meaningless)."""
import os, sys, time
import nbformat
from nbclient import NotebookClient
from nbclient.exceptions import CellExecutionError

args = [a for a in sys.argv[1:] if not a.startswith("--")]
if len(args) != 2:
    sys.exit(__doc__)
nb_path, folder = args
if not os.path.isfile(os.path.join(folder, "Combined_dataset.csv")):
    sys.exit(f"No Combined_dataset.csv in {os.path.abspath(folder)} -- put the data file there first.")
nb = nbformat.read(nb_path, as_version=4)
if "--smoke" in sys.argv:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from smoke_run import shrink
    nb = shrink(nb)
out = os.path.join(folder, os.path.splitext(os.path.basename(nb_path))[0] + ("_smoke" if "--smoke" in sys.argv else "") + "_executed.ipynb")
code = [i for i, c in enumerate(nb.cells) if c.cell_type == "code"]
t0 = time.time()


def done(cell, cell_index, **_):
    if cell.cell_type == "code":
        print(f"[{time.strftime('%H:%M:%S')}] code cell {code.index(cell_index) + 1}/{len(code)} finished "
              f"({(time.time() - t0) / 60:.1f} min elapsed)", flush=True)


client = NotebookClient(nb, timeout=None, kernel_name="python3", resources={"metadata": {"path": folder}}, on_cell_complete=done)
print(f"running {nb_path} in {os.path.abspath(folder)} -- this takes several hours on the full data", flush=True)
try:
    client.execute()
    ok = True
except CellExecutionError as e:
    ok = False; print(f"\nA cell failed:\n{str(e)[-2500:]}", flush=True)
finally:
    nbformat.write(nb, out)
print(f"\n{'finished' if ok else 'STOPPED'} after {(time.time() - t0) / 60:.1f} min; executed notebook: {out}"
      + ("" if ok else "\nFix the problem and run the same command again: completed parts are restored from the checkpoints."))
sys.exit(0 if ok else 1)
