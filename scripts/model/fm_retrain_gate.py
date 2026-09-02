#!/usr/bin/env python
"""Per-retrain regression gate (design §5): paired sibling MRR, new vs previous
weights, on the current sibling sets. Blocks when the regression exceeds BOTH the
paired MDE and the card's 3-seed MRR spread.

    .venv/bin/python fm_retrain_gate.py [--new data/compiled/fm-weights.json] [--previous <path>]

--previous defaults to `git show HEAD:data/compiled/fm-weights.json`; when HEAD has no
weights (first ship) the gate prints that and passes.
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

def previous_from_git():
    try:
        return json.loads(subprocess.check_output(["git", "show", "HEAD:data/compiled/fm-weights.json"], cwd=ROOT, text=True, stderr=subprocess.DEVNULL))
    except subprocess.CalledProcessError:
        return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--new", default=str(ROOT / "data/compiled/fm-weights.json"))
    ap.add_argument("--previous", default=None)
    a = ap.parse_args()
    new = json.loads(Path(a.new).read_text())
    prev = json.loads(Path(a.previous).read_text()) if a.previous else previous_from_git()
    if prev is None:
        print("fm_retrain_gate: no previous weights in HEAD — first ship, gate PASS")
        return 0
    card = json.loads((REPORTS / "fm-weights-card.json").read_text())
    spread = float(card["seed_sibling_mrr_spread"])
    sets = load_sibling_sets()
    tn, tp = ServingTable(new), ServingTable(prev)
    mn, mp = sibling_marginals(tn, sets), sibling_marginals(tp, sets)
    idx = [i for i in range(len(sets)) if mn[i] is not None and mp[i] is not None]
    d = np.array([rr_top1_of(mn[i])[0] - rr_top1_of(mp[i])[0] for i in idx])
    boot = metrics.paired_bootstrap(d)
    rho = float(np.nanmean([stats.spearmanr(mn[i], mp[i]).statistic for i in idx if mn[i].std() > 0 and mp[i].std() > 0]))
    verdict, reason = decide(boot["mean"], boot["mde"], spread)
    print(f"paired sibling MRR Δ(new − previous) {boot['mean']:+.5f} CI [{boot['ci_lo']:+.5f}, {boot['ci_hi']:+.5f}] MDE {boot['mde']:.5f} · Spearman ρ vs previous {rho:+.3f} · {verdict}: {reason}")
    card["spearman_vs_previous_weights"] = rho
    (REPORTS / "fm-weights-card.json").write_text(json.dumps(card, indent=1) + "\n")
    return 0 if verdict == "PASS" else 1

if __name__ == "__main__":
    sys.exit(main())
