"""The mask table transcribes TURN_SEQUENCE from Rust. These tests keep the copy honest."""

import re

import pytest

from common import ROOT
from mask_table import (
    BACKEND_MAX_DEPTH,
    TOTAL_TURNS,
    TURN_SEQUENCE,
    build_table,
    leaf_turn,
    masked_slot_distribution,
    pattern_at,
)

RUST_SRC = ROOT / "packages/engine-core/src/draft_state.rs"


def parse_rust_turn_sequence():
    """Re-derive TURN_SEQUENCE from the Rust source so the Python copy cannot drift."""
    src = RUST_SRC.read_text(encoding="utf-8")
    body = re.search(r"pub const TURN_SEQUENCE: \[TurnInfo; \d+\] = \[(.*?)\n\];", src, re.S)
    assert body, "TURN_SEQUENCE not found in draft_state.rs — the parser needs updating"
    out = []
    for side, action, phase, ps, pe in re.findall(
        r"t\(\s*Side::(\w+),\s*ActionType::(\w+),\s*Phase::(\w+),\s*(\w+),\s*(\w+),?\s*\)",
        body.group(1),
    ):
        out.append((side.lower(), action.lower(), phase, ps == "true", pe == "true"))
    return out


def test_python_turn_sequence_matches_rust():
    assert parse_rust_turn_sequence() == TURN_SEQUENCE


def test_backend_max_depth_matches_navigator_engine():
    js = (ROOT / "backend/services/navigatorEngine.js").read_text(encoding="utf-8")
    m = re.search(r"maxDepth:\s*(\d+)", js)
    assert m, "maxDepth not found in navigatorEngine.js"
    assert int(m.group(1)) == BACKEND_MAX_DEPTH


def test_terminal_state_has_five_picks_per_side_and_ten_bans():
    p = pattern_at(TOTAL_TURNS)
    assert (p["blue_picks"], p["red_picks"]) == (5, 5)
    assert (p["blue_bans"], p["red_bans"]) == (5, 5)
    assert p["masked_slots"] == 0


def test_pair_ply_advances_two_turns():
    # turns 7, 9, 17 are pair starts: one ply covers both halves.
    for pair_start in (7, 9, 17):
        assert leaf_turn(pair_start, 1) == pair_start + 2
    # a non-pair turn advances by one.
    assert leaf_turn(0, 1) == 1
    assert leaf_turn(12, 1) == 13


def test_depth_never_overshoots_terminal():
    for root in range(TOTAL_TURNS):
        for depth in range(BACKEND_MAX_DEPTH + 1):
            assert root <= leaf_turn(root, depth) <= TOTAL_TURNS


def test_leaf_turn_is_monotone_in_depth():
    for root in range(TOTAL_TURNS):
        seq = [leaf_turn(root, d) for d in range(BACKEND_MAX_DEPTH + 1)]
        assert seq == sorted(seq)


def test_masked_slot_count_is_monotone_non_increasing_in_turn():
    counts = [pattern_at(t)["masked_slots"] for t in range(TOTAL_TURNS + 1)]
    assert counts == sorted(counts, reverse=True)


def test_every_bucket_is_reachable_as_a_search_leaf():
    """Task 4's mask buckets are 0 / 1-3 / 4-6 / 7-9. The prefix branch must be
    able to produce each, or the bucket replicas have no reachable states."""
    dist = masked_slot_distribution({d: 1.0 / BACKEND_MAX_DEPTH for d in range(1, BACKEND_MAX_DEPTH + 1)})
    reached = {m for m, p in dist.items() if p > 0}
    for lo, hi in ((0, 0), (1, 3), (4, 6), (7, 9)):
        assert any(lo <= m <= hi for m in reached), f"bucket {lo}-{hi} unreachable"


def test_pair_end_turns_are_the_only_unreachable_leaf_turns():
    """A mid-pair turn can be a ROOT but never a search LEAF (expand_pair covers
    both halves in one ply), so masked counts 8, 6 and 2 carry zero mass."""
    dist = masked_slot_distribution({d: 1.0 / BACKEND_MAX_DEPTH for d in range(1, BACKEND_MAX_DEPTH + 1)})
    missing = {m for m in range(11) if dist.get(m, 0.0) == 0.0}
    pair_end_masked = {pattern_at(t)["masked_slots"] for t, e in enumerate(TURN_SEQUENCE) if e[4]}
    assert missing == pair_end_masked == {2, 6, 8}


def test_bans_are_never_ahead_of_the_draft_order():
    """Guards the ban-visibility assumption: no state has 10 bans with <3 picks
    per side, and no state has more than 3 bans per side before Pick1 completes."""
    for t in range(TOTAL_TURNS + 1):
        p = pattern_at(t)
        if p["visible_bans"] == 10:
            assert p["blue_picks"] >= 3 and p["red_picks"] >= 3
        if p["filled_picks"] < 6:
            assert p["blue_bans"] <= 3 and p["red_bans"] <= 3


def test_table_covers_every_root_and_depth():
    rows = build_table()
    assert len(rows) == TOTAL_TURNS * (BACKEND_MAX_DEPTH + 1)
    assert {(r["root_turn"], r["depth"]) for r in rows} == {
        (r, d) for r in range(TOTAL_TURNS) for d in range(BACKEND_MAX_DEPTH + 1)
    }


def test_distribution_sums_to_one():
    dist = masked_slot_distribution({4: 0.5, 5: 0.3, 6: 0.2})
    assert sum(dist.values()) == pytest.approx(1.0)
