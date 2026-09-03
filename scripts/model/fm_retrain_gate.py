#!/usr/bin/env python
"""Per-retrain regression gate (design §5): paired sibling MRR, new vs previous
weights, on the current sibling sets. Blocks when the regression exceeds BOTH the
paired MDE and the card's 3-seed MRR spread.

    .venv/bin/python fm_retrain_gate.py [--new data/compiled/fm-weights.json] [--previous <path>] [--card <path>]

--previous defaults to `git show HEAD:data/compiled/fm-weights.json`; when HEAD has no
weights (first ship) the gate prints that and passes. On BLOCK the card file is left
untouched; `spearman_vs_previous_weights` is written only on PASS.
"""
import argparse, json, subprocess, sys
from pathlib import Path

import numpy as np
from scipy import stats

import metrics
from common import ROOT
from fm_serve import ServingTable
from measure_vs_evaluator import rr_top1_of
from ship_fm import REPORTS, load_sibling_sets, sibling_marginals

def decide(delta_mean, mde, spread):
    if delta_mean >= 0:
        return "PASS", "no regression"
    if abs(delta_mean) <= mde:
        return "PASS", f"regression {delta_mean:+.5f} inside the paired MDE {mde:.5f}"
    if abs(delta_mean) <= spread:
        return "PASS", f"regression {delta_mean:+.5f} inside the 3-seed spread {spread:.5f}"
    return "BLOCK", f"regression {delta_mean:+.5f} exceeds MDE {mde:.5f} and seed spread {spread:.5f}"

def evaluate(new_table, prev_table, sets, spread):
    """Pure decision core: paired sibling-MRR delta (new vs previous) on `sets`,
    bootstrapped, plus Spearman rho of the two tables' marginals. Returns a dict
    with verdict, reason, mean, ci_lo, ci_hi, mde, rho."""
    mn, mp = sibling_marginals(new_table, sets), sibling_marginals(prev_table, sets)
    idx = [i for i in range(len(sets)) if mn[i] is not None and mp[i] is not None]
    d = np.array([rr_top1_of(mn[i])[0] - rr_top1_of(mp[i])[0] for i in idx])
    boot = metrics.paired_bootstrap(d)
    rho = float(np.nanmean([stats.spearmanr(mn[i], mp[i]).statistic for i in idx if mn[i].std() > 0 and mp[i].std() > 0]))
    verdict, reason = decide(boot["mean"], boot["mde"], spread)
    return {"verdict": verdict, "reason": reason, "mean": boot["mean"], "ci_lo": boot["ci_lo"],
            "ci_hi": boot["ci_hi"], "mde": boot["mde"], "rho": rho}

def previous_from_git():
    """None only when HEAD genuinely has no weights file (first ship) — any other
    git failure (broken repo/cwd, etc.) must not rubber-stamp PASS."""
    result = subprocess.run(
        ["git", "show", "HEAD:data/compiled/fm-weights.json"],
        cwd=ROOT, capture_output=True, text=True,
    )
    if result.returncode == 0:
        return json.loads(result.stdout)
    stderr = result.stderr
    if "does not exist in" in stderr or "exists on disk, but not in" in stderr:
        return None
    raise SystemExit(f"fm_retrain_gate: git show HEAD:data/compiled/fm-weights.json failed:\n{stderr}")

def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--new", default=str(ROOT / "data/compiled/fm-weights.json"))
    ap.add_argument("--previous", default=None)
    ap.add_argument("--card", default=str(REPORTS / "fm-weights-card.json"))
    a = ap.parse_args(argv)
    new = json.loads(Path(a.new).read_text())
    prev = json.loads(Path(a.previous).read_text()) if a.previous else previous_from_git()
    if prev is None:
        print("fm_retrain_gate: no previous weights in HEAD — first ship, gate PASS")
        return 0
    card_path = Path(a.card)
    card = json.loads(card_path.read_text())
    spread = float(card["seed_sibling_mrr_spread"])
    sets = load_sibling_sets()
    result = evaluate(ServingTable(new), ServingTable(prev), sets, spread)
    print(f"paired sibling MRR Δ(new − previous) {result['mean']:+.5f} "
          f"CI [{result['ci_lo']:+.5f}, {result['ci_hi']:+.5f}] MDE {result['mde']:.5f} · "
          f"Spearman ρ vs previous {result['rho']:+.3f} · {result['verdict']}: {result['reason']}")
    if result["verdict"] == "PASS":
        card["spearman_vs_previous_weights"] = result["rho"]
        card_path.write_text(json.dumps(card, indent=1) + "\n")
    return 0 if result["verdict"] == "PASS" else 1

if __name__ == "__main__":
    sys.exit(main())
