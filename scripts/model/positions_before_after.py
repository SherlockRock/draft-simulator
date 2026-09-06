#!/usr/bin/env python
"""Design § 8 steps 5 and 5b for the champion-meta positions refresh
(exploration tooling; data-dependent, no tests).

    .venv/bin/python positions_before_after.py --old-meta PATH --new-meta PATH [--per-turn 3] [--seed 1]

Runs real holdout drafts through the prebuilt index.node (fm_engine_probe.cjs,
CHAMPION_META_PATH env) under the PRODUCTION search config, once per meta, and
reports per state: root children (0 = the empty tree the prune produces when a
side is role-infeasible) and the top-1 / top-5 suggestions; then how many
top-1s and top-5 sets changed, with the changes that involve Locke (a NEW
candidate in the new arm, not a positions effect) counted separately.

States are built exactly the way engine-core/tests/fm_search_ab.rs::prefix
builds the A/B's strata (design § 8 5b, "the A/B's strata"): a real evaluable
holdout draft is truncated to a turn index by walking TURN_SEQUENCE and filling
picks in canonical role order (blue TOP, JUNGLE, … then red) with the draft's
real bans (an empty ban cell becomes the "__noban{i}" placeholder). So a
turn-19 state is the real state before red's last pick; a turn-7 state is the
same real draft with the first two picks placed — a real SET of champions at a
real turn, in canonical rather than recorded pick order (the holdout has no
pick order). Every pick turn is covered: 6,7,8,9,10,11 (pick1) and
16,17,18,19 (pick2), --per-turn drafts each (default 3 → 30 states), the tour
§ 6 state prepended. Each request takes ~10-13 s (the 5 s budget is not
enforced; early pair turns are the slow ones), so 31 states × 2 metas ≈ 12 min.
"""
import argparse
import csv
import os
import random
from pathlib import Path

from fm_explore import TRAIN_DIR, TURN_SEQUENCE, build_engine_request, engine_children, load_meta, run_engine
from fm_explore_scan import SLOT_COLS

PICK_TURNS = [t for t, (_, action, _) in enumerate(TURN_SEQUENCE) if action == "pick"]   # 6..11, 16..19
BAN_COLS = [f"ban_{'b' if i < 5 else 'r'}{i % 5}" for i in range(10)]

# The tour § 6 state as a holdout-shaped row: prefix(TOUR_ROW, 19) reads five blue
# picks, four red picks and ten (empty → placeholder) bans.
TOUR_ROW = {"match_id": "tour §6 EUW1_7957728380", "blue": ["Gragas", "Hecarim", "Akali", "Xayah", "Shen"],
            "red": ["Sejuani", "Sylas", "Lissandra", "Tristana"], "bans": [""] * 10}

# backend/services/navigatorEngine.js — production config, copied verbatim
PROD_SEARCH = {"branchWidth": 5, "pairBranchWidth": 500, "singlePairTopK": 32, "maxDepth": 8,
               "broadDepth": 8, "extensionTurnThreshold": 8, "latencyBudgetMs": 5000}
PROD_PHASES = {
    "blue": {"ban1": {"comp": 0.35, "info": 0.65, "coverage": 0.0}, "pick1": {"comp": 0.5, "info": 0.5, "coverage": 0.3},
             "ban2": {"comp": 0.6, "info": 0.4, "coverage": 0.4}, "pick2": {"comp": 0.8, "info": 0.2, "coverage": 1.5}},
    "red": {"ban1": {"comp": 0.3, "info": 0.7, "coverage": 0.0}, "pick1": {"comp": 0.4, "info": 0.6, "coverage": 0.3},
            "ban2": {"comp": 0.5, "info": 0.5, "coverage": 0.4}, "pick2": {"comp": 0.8, "info": 0.2, "coverage": 1.5}},
}
PROD_PENALTIES = {"outOfRole": 0.25, "outOfPool": 0.75}


def load_holdout_rows(train_dir=TRAIN_DIR):
    """Evaluable holdout drafts as {match_id, blue[5], red[5], bans[10]} in canonical
    role order — the same rows engine-core/tests/fm_search_ab.rs::read_holdout uses."""
    with open(Path(train_dir) / "holdout_drafts.csv", newline="") as fh:
        return [{"match_id": r["match_id"], "blue": [r[c] for c in SLOT_COLS[:5]],
                 "red": [r[c] for c in SLOT_COLS[5:]], "bans": [r[c] for c in BAN_COLS]}
                for r in csv.DictReader(fh) if r["evaluable"] == "True"]


def prefix(row, turn):
    """fm_search_ab.rs::prefix, ported: walk TURN_SEQUENCE[:turn], placing picks in
    canonical role order and the draft's real bans in ban-turn order. An empty ban
    cell is a real "no ban" and becomes the A/B's "__noban{i}" placeholder — an id no
    champion table contains. That is safe on the wire too: engine-node's projection
    copies ban ids into DraftState without checking them against champion-meta
    (projection.rs ban handling), and only picks are role-evaluated. Filling the slot
    with a real champion instead would remove that champion from the candidate set
    and change the suggestions being compared."""
    blue, red, bans = [], [], []
    b = r = bb = rb = 0
    for side, action, _ in TURN_SEQUENCE[:turn]:
        if action == "pick":
            if side == "blue":
                blue.append(row["blue"][b]); b += 1
            else:
                red.append(row["red"][r]); r += 1
        elif side == "blue":
            bans.append(row["bans"][bb] or f"__noban{bb}"); bb += 1
        else:
            bans.append(row["bans"][5 + rb] or f"__noban{5 + rb}"); rb += 1
    return {"name": f"{row['match_id']} turn {turn}", "turn": turn, "blue": blue, "red": red, "bans": bans}


def production_request(state, meta):
    side = TURN_SEQUENCE[state["turn"]][0]
    req = build_engine_request(state["blue"], state["red"], side, meta, our_side=side, bans=state["bans"])
    req["config"]["search"] = dict(PROD_SEARCH)
    req["config"]["weights"]["phaseWeights"] = PROD_PHASES
    req["config"]["weights"]["penalties"] = dict(PROD_PENALTIES)
    return req


def suggestions(state, meta_path):
    meta = load_meta(meta_path)
    env = dict(os.environ, CHAMPION_META_PATH=str(Path(meta_path).resolve()))
    response, status = run_engine(production_request(state, meta), env=env)
    kids = engine_children(response)
    ranked = sorted(kids.items(), key=lambda kv: -kv[1])
    return {"children": len(kids), "top": [list(k) for k, _ in ranked[:5]], "status": status}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--old-meta", required=True)
    ap.add_argument("--new-meta", required=True)
    ap.add_argument("--per-turn", type=int, default=3, help="real drafts per pick turn (10 pick turns)")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", default=str(Path(__file__).with_name("reports") / "positions-before-after.md"))
    args = ap.parse_args(argv)
    drafts = load_holdout_rows()
    random.Random(args.seed).shuffle(drafts)
    states = [prefix(TOUR_ROW, 19)]
    i = 0
    for turn in PICK_TURNS:
        for _ in range(args.per_turn):
            states.append(prefix(drafts[i], turn)); i += 1

    rows, top1_changed, top5_changed, locke_changed, empty_before, empty_after = [], 0, 0, 0, 0, 0
    for st in states:
        try:
            old = suggestions(st, args.old_meta)
            new = suggestions(st, args.new_meta)
        except (RuntimeError, KeyError, ValueError) as err:
            # one engine failure must not lose the previous ~12 minutes: record and continue
            print(f"{st['name'][:48]:48s} t{st['turn']:2d} ENGINE ERROR: {str(err)[:200]}", flush=True)
            rows.append((st["name"], st["turn"], "err", "err", [], [], False, False))
            continue
        empty_before += old["children"] == 0
        empty_after += new["children"] == 0
        t1 = old["top"][:1] != new["top"][:1]
        t5 = sorted(map(tuple, old["top"])) != sorted(map(tuple, new["top"]))
        # Locke is a NEW candidate in the new arm (absent from the old meta), so a
        # change that involves him is a roster effect, not a positions effect.
        locke = t5 and any("Locke" in k for k in old["top"] + new["top"])
        top1_changed += t1
        top5_changed += t5
        locke_changed += locke
        rows.append((st["name"], st["turn"], old["children"], new["children"], old["top"][:1], new["top"][:1], t5, locke))
        print(f"{st['name'][:48]:48s} t{st['turn']:2d} children {old['children']:3d} -> {new['children']:3d}  top1 {old['top'][:1]} -> {new['top'][:1]}"
              f"{'  top5 changed' if t5 else ''}{' (Locke)' if locke else ''}", flush=True)
    lines = ["# Positions refresh — before/after suggestion diff (design § 8 step 5b)", "",
             f"states {len(states)} = tour §6 + {args.per_turn} real holdout drafts × 10 pick turns (seed {args.seed}), "
             f"built as fm_search_ab.rs::prefix builds the A/B's strata; production search config; "
             f"old = `{args.old_meta}`, new = `{args.new_meta}`", "",
             f"- empty trees (children = 0): {empty_before} before -> {empty_after} after",
             f"- top-1 changed: {top1_changed}/{len(states)}",
             f"- top-5 set changed: {top5_changed}/{len(states)}, of which {locke_changed} involve Locke (new candidate, not a positions effect)", "",
             "| state | turn | children before | after | top-1 before | after | top-5 changed |", "|---|---|---|---|---|---|---|"]
    for name, turn, cb, ca, t1b, t1a, t5, locke in rows:
        lines.append(f"| {name} | {turn} | {cb} | {ca} | {t1b} | {t1a} | {('yes (Locke)' if locke else 'yes') if t5 else ''} |")
    Path(args.out).write_text("\n".join(lines) + "\n")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
