#!/usr/bin/env python
"""Task 1b-a — the leaf mask table, derived analytically from TURN_SEQUENCE.

Which slots are filled at a search leaf is a deterministic function of the
leaf's turn index, and the leaf's turn index is a deterministic function of
(root turn, plies searched). TURN_SEQUENCE (draft_state.rs) is a fixed 20-entry
array, so the whole table is computable in Python — no engine instrumentation.

One subtlety the table has to model: `expand_pair` (search.rs:793-804) pushes
BOTH halves of a pair-pick turn but recurses with `remaining_depth - 1`. So one
ply advances the turn index by 2 at a pair start and by 1 everywhere else.

The leaf mask distribution the training masks are drawn from is

    (distribution of root turn indices users query from)  ×  (achieved-depth
    distribution measured by Task 1b-b)

Neither factor is in this file. The first is a stated product assumption
(v1: uniform over the 20 turns); the second is a measurement. This module
supplies the deterministic middle and `leaf_turn_distribution()` composes them.

    python scripts/model/mask_table.py            # writes scripts/model/mask_table.json
"""

import json
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "mask_table.json"

# Transcribed from packages/engine-core/src/draft_state.rs TURN_SEQUENCE.
# test_mask_table.py re-parses the Rust source and asserts this matches.
# (side, action, phase, pair_start, pair_end)
TURN_SEQUENCE = [
    ("blue", "ban", "Ban1", False, False),
    ("red", "ban", "Ban1", False, False),
    ("blue", "ban", "Ban1", False, False),
    ("red", "ban", "Ban1", False, False),
    ("blue", "ban", "Ban1", False, False),
    ("red", "ban", "Ban1", False, False),
    ("blue", "pick", "Pick1", False, False),
    ("red", "pick", "Pick1", True, False),
    ("red", "pick", "Pick1", False, True),
    ("blue", "pick", "Pick1", True, False),
    ("blue", "pick", "Pick1", False, True),
    ("red", "pick", "Pick1", False, False),
    ("red", "ban", "Ban2", False, False),
    ("blue", "ban", "Ban2", False, False),
    ("red", "ban", "Ban2", False, False),
    ("blue", "ban", "Ban2", False, False),
    ("red", "pick", "Pick2", False, False),
    ("blue", "pick", "Pick2", True, False),
    ("blue", "pick", "Pick2", False, True),
    ("red", "pick", "Pick2", False, False),
]

TOTAL_TURNS = len(TURN_SEQUENCE)

# backend/services/navigatorEngine.js sends maxDepth: 8; the request's value
# beats SearchParams::default's 6 (engine-node/src/projection.rs:145-153).
# Iterative deepening runs 1..=max_depth within AB_COMPUTE_BUDGET_MS, so the
# achieved depth is a measurement (Task 1b-b), and 8 is only a cap.
BACKEND_MAX_DEPTH = 8


def pattern_at(turn_index):
    """Counts of what is on the board when the draft is at `turn_index`.

    `turn_index` is the index of the turn ABOUT to be taken, so slots
    [0, turn_index) are filled.
    """
    counts = {"blue_picks": 0, "red_picks": 0, "blue_bans": 0, "red_bans": 0}
    for side, action, _phase, _ps, _pe in TURN_SEQUENCE[:turn_index]:
        counts[f"{side}_{action}s"] += 1
    counts["turn_index"] = turn_index
    counts["filled_picks"] = counts["blue_picks"] + counts["red_picks"]
    counts["masked_slots"] = 10 - counts["filled_picks"]
    counts["visible_bans"] = counts["blue_bans"] + counts["red_bans"]
    counts["terminal"] = turn_index >= TOTAL_TURNS
    return counts


def leaf_turn(root_turn, depth):
    """Turn index reached after `depth` plies from `root_turn`.

    A pair-start turn is expanded as a single decision unit covering two slots,
    so it advances the turn index by 2 for one ply.
    """
    t = root_turn
    for _ in range(depth):
        if t >= TOTAL_TURNS:
            break
        t += 2 if TURN_SEQUENCE[t][3] else 1
    return min(t, TOTAL_TURNS)


def build_table(max_depth=BACKEND_MAX_DEPTH):
    rows = []
    for root in range(TOTAL_TURNS):
        for depth in range(max_depth + 1):
            t = leaf_turn(root, depth)
            row = {"root_turn": root, "depth": depth, "leaf_turn": t}
            row.update(pattern_at(t))
            rows.append(row)
    return rows


def leaf_turn_distribution(depth_dist, root_dist=None, max_depth=BACKEND_MAX_DEPTH):
    """Compose the two factors into P(leaf turn index).

    depth_dist: {depth: probability} — measured by Task 1b-b.
    root_dist:  {root turn: probability} — the stated product assumption;
                defaults to uniform over the 20 turns (v1).
    """
    if root_dist is None:
        root_dist = {r: 1.0 / TOTAL_TURNS for r in range(TOTAL_TURNS)}
    out = {}
    for root, p_root in root_dist.items():
        for depth, p_depth in depth_dist.items():
            t = leaf_turn(root, min(depth, max_depth))
            out[t] = out.get(t, 0.0) + p_root * p_depth
    return out


def masked_slot_distribution(depth_dist, root_dist=None, max_depth=BACKEND_MAX_DEPTH):
    """P(number of masked pick slots at the leaf) — the training mask draw."""
    out = {}
    for t, p in leaf_turn_distribution(depth_dist, root_dist, max_depth).items():
        m = pattern_at(t)["masked_slots"]
        out[m] = out.get(m, 0.0) + p
    return out


ASSUMPTIONS = {
    "root_turn_distribution": (
        "v1: uniform over the 20 turn indices. This is a PRODUCT assumption about where "
        "users open the Navigator, not a measurement of the engine. Revisit with usage data."
    ),
    "role_subset_order": (
        "v1: uniform over role subsets of the required size. Riot's match data carries no "
        "pick order, so WHICH roles are filled at a partial turn cannot be learned from the "
        "corpus. Stored versus-series drafts do carry pick order and could replace this later."
    ),
    "ban_visibility": (
        "In the 70% draft-order-prefix branch the visible ban count is DETERMINED by the same "
        "turn index (ban phase 2 is TURN_SEQUENCE[12..16], after Pick1), so bans are never "
        "drawn independently there — an independent draw would produce unreachable states such "
        "as 'all 10 bans with <3 picks per side'. The i.i.d./phase ban regimes apply only to "
        "the 30% strategic branch."
    ),
    "pair_ply_accounting": (
        "expand_pair pushes both halves of a pair-pick turn and recurses with remaining_depth-1 "
        "(search.rs:793-804), so a ply advances the turn index by 2 at turns 7, 9 and 17."
    ),
}


def main():
    rows = build_table()
    reachable = sorted({r["leaf_turn"] for r in rows})
    doc = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "packages/engine-core/src/draft_state.rs::TURN_SEQUENCE",
        "total_turns": TOTAL_TURNS,
        "backend_max_depth": BACKEND_MAX_DEPTH,
        "pair_start_turns": [i for i, t in enumerate(TURN_SEQUENCE) if t[3]],
        "assumptions": ASSUMPTIONS,
        "turn_sequence": [
            {"index": i, "side": s, "action": a, "phase": p, "pair_start": ps, "pair_end": pe}
            for i, (s, a, p, ps, pe) in enumerate(TURN_SEQUENCE)
        ],
        "patterns_by_leaf_turn": {str(t): pattern_at(t) for t in range(TOTAL_TURNS + 1)},
        "table": rows,
        "reachable_leaf_turns": reachable,
    }
    OUT.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")

    print(f"wrote {OUT}  ({len(rows)} (root, depth) rows)")
    print(f"pair-start turns: {doc['pair_start_turns']}")
    print("\nmasked-slot count by leaf turn index:")
    for t in range(TOTAL_TURNS + 1):
        p = pattern_at(t)
        print(
            f"  turn {t:>2}: picks b{p['blue_picks']}/r{p['red_picks']}  "
            f"bans b{p['blue_bans']}/r{p['red_bans']}  masked={p['masked_slots']}"
        )
    uniform_depth = {d: 1.0 / BACKEND_MAX_DEPTH for d in range(1, BACKEND_MAX_DEPTH + 1)}
    print("\nmasked-slot distribution under uniform root turn × uniform depth 1..8")
    print("(placeholder depth factor — Task 1b-b measures the real one):")
    dist = masked_slot_distribution(uniform_depth)
    for m in sorted(dist):
        print(f"  {m} masked: {dist[m]:.4f}")
    bucket = {"0": 0.0, "1-3": 0.0, "4-6": 0.0, "7-9": 0.0, "10": 0.0}
    for m, p in dist.items():
        key = "0" if m == 0 else "1-3" if m <= 3 else "4-6" if m <= 6 else "7-9" if m <= 9 else "10"
        bucket[key] += p
    print("  buckets: " + "  ".join(f"{k}={v:.4f}" for k, v in bucket.items()))


if __name__ == "__main__":
    main()
