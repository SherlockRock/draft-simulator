#!/usr/bin/env python
"""Both-sides role feasibility of the evaluable holdout sibling sets under a
positions table — the number behind design § 1/§ 3 and the recurring-run gate
in scripts/refresh-champion-positions.mjs (design § 5).

    .venv/bin/python positions_feasibility.py [--champions PATH | --meta PATH] [--train-dir DIR]

Prints one JSON object: {"sets", "opp5", "team4True", "bothSides", "everyCandidate"}.
"Feasible" is the locked-picks half of feasibility.rs::can_complete_roles, ported
by fm_explore.role_feasible; every listed position counts as playable. One
implementation, shared with positions_refresh_probe.py, so the gate and the
design's evidence cannot drift.
"""
import argparse
import csv
import json
from pathlib import Path

from common import ROOT
from fm_explore import TRAIN_DIR, role_feasible
from fm_explore_scan import SLOT_COLS

# champion-meta vocabulary -> role_feasible's linear-vector vocabulary
META_TO_LINEAR = {"TOP": "TOP", "JUNGLE": "JUNGLE", "MIDDLE": "MIDDLE", "BOTTOM": "BOTTOM", "SUPPORT": "UTILITY"}


def load_holdout_sets(train_dir=TRAIN_DIR):
    """Evaluable holdout sibling sets as {match_id, patch, side ("blue"|"red", the
    held-out slot's side), slot (0-9, canonical role order: 0-4 blue TOP..UTILITY,
    5-9 red), team (the four locked teammates), opp (the real opposing five),
    cands, true}."""
    train_dir = Path(train_dir)
    with open(train_dir / "holdout_drafts.csv", newline="") as fh:
        drafts = {r["match_id"]: r for r in csv.DictReader(fh)}
    sets = []
    with open(train_dir / "sibling_sets.csv", newline="") as fh:
        for r in csv.DictReader(fh):
            if r["evaluable"] != "True" or r["match_id"] not in drafts:
                continue
            slot = int(r["slot"])
            picks = [drafts[r["match_id"]][c] for c in SLOT_COLS]
            own = picks[:5] if slot < 5 else picks[5:]
            opp = picks[5:] if slot < 5 else picks[:5]
            k = slot % 5
            sets.append({"match_id": r["match_id"], "patch": r["patch"], "side": r["side"], "slot": slot,
                         "team": own[:k] + own[k + 1:], "opp": opp,
                         "cands": r["candidate_aliases"].split(), "true": r["true_alias"]})
    return sets


def _linear(positions):
    return [META_TO_LINEAR[p] for p in positions]


def positions_from_champions_json(doc):
    return {c["id"]: {"positions": _linear(c["positions"])} for c in doc["champions"]}


def positions_from_meta_json(doc):
    return {alias: {"positions": _linear(e.get("positions", []))} for alias, e in doc["champions"].items()}


def measure(sets, meta):
    n = len(sets)
    opp = sum(role_feasible(s["opp"], meta) for s in sets)
    tr = sum(role_feasible(s["team"] + [s["true"]], meta) for s in sets)
    both = sum(role_feasible(s["opp"], meta) and role_feasible(s["team"] + [s["true"]], meta) for s in sets)
    ev = sum(all(role_feasible(s["team"] + [c], meta) for c in s["cands"]) for s in sets)
    return {"sets": n, "opp5": opp / n, "team4True": tr / n, "bothSides": both / n, "everyCandidate": ev / n}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group()
    src.add_argument("--champions", default=str(ROOT / "frontend/src/data/champions.json"))
    src.add_argument("--meta", default=None, help="a compiled champion-meta.json instead of champions.json")
    ap.add_argument("--train-dir", default=str(TRAIN_DIR))
    args = ap.parse_args(argv)
    if args.meta:
        meta = positions_from_meta_json(json.loads(Path(args.meta).read_text()))
    else:
        meta = positions_from_champions_json(json.loads(Path(args.champions).read_text()))
    print(json.dumps(measure(load_holdout_sets(args.train_dir), meta)))


if __name__ == "__main__":
    main()
