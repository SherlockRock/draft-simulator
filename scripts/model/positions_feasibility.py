#!/usr/bin/env python
"""Both-sides role feasibility of the evaluable holdout sibling sets under a
positions table — the number behind design § 1/§ 3 and the recurring-run gate
in scripts/refresh-champion-positions.mjs (design § 5).

    .venv/bin/python positions_feasibility.py [--champions PATH | --meta PATH] [--train-dir DIR]
                                             [--field playable|positions]

Prints one JSON object: {"sets", "opp5", "team4True", "bothSides", "everyCandidate", "field"}.
"Feasible" is the locked-picks half of feasibility.rs::can_complete_roles, ported
by fm_explore.role_feasible. The roles a champion may fill are its `--field`:
`playable` (the default — the engine's legality set, champion-role-shares design
§ 4.1), falling back to `positions` for a row without it; or `positions`, the
listed roles (the pre-slice-A mask, 0.738 on the 16.19 holdout against 0.976).
`field` in the output names the RULE measured (`playable` is "playable ?? positions
per row" — exactly what the engines read, whatever the table carries), and
`fallbackRows` counts the rows that had no `playable` under that rule (every row
on a table from before the field, or after --source ugg). One implementation,
shared with positions_refresh_probe.py, so the gate and the design's evidence
cannot drift.
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


def _roles_of(row, field):
    """The roles the row may fill under `field`: its playable when asked for and present, else its positions."""
    if field == "playable" and row.get("playable") is not None:
        return row["playable"]
    return row.get("positions", [])


def fallback_rows(rows, field):
    """How many rows the `playable` rule read through the fallback (no `playable` on the row); 0 under
    the `positions` rule. The field's NAME stays the rule's: a measurement on a table where every row
    fell back still measured what the engines read, and a later run on the same rule compares like
    with like (judge r1 I1: labelling it "positions" would disarm the drop clause exactly when the
    legality set collapsed)."""
    if field != "playable":
        return 0
    return sum(1 for row in rows if row.get("playable") is None)


def positions_from_champions_json(doc, field="playable"):
    return {c["id"]: {"positions": _linear(_roles_of(c, field))} for c in doc["champions"]}


def positions_from_meta_json(doc, field="playable"):
    return {alias: {"positions": _linear(_roles_of(e, field))} for alias, e in doc["champions"].items()}


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
    ap.add_argument("--field", choices=["playable", "positions"], default="playable",
                    help="the roles a champion may fill: playable (default; falls back to positions) or positions")
    args = ap.parse_args(argv)
    if args.meta:
        doc = json.loads(Path(args.meta).read_text())
        meta = positions_from_meta_json(doc, args.field)
        fallback = fallback_rows(doc["champions"].values(), args.field)
    else:
        doc = json.loads(Path(args.champions).read_text())
        meta = positions_from_champions_json(doc, args.field)
        fallback = fallback_rows(doc["champions"], args.field)
    print(json.dumps({**measure(load_holdout_sets(args.train_dir), meta), "field": args.field, "fallbackRows": fallback}))


if __name__ == "__main__":
    main()
