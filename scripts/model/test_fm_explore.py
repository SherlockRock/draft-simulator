"""fm_explore.py — data-free tests on a tiny synthetic artifact, plus one
engine cross-check that skips unless the prebuilt index.node and the shipped
weights are present."""
import shutil
from pathlib import Path

import numpy as np
import pytest

import fm_explore as fx
import fm_serve
from test_ship_fm import _artifact

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def table():
    art = _artifact(seed=3, scale=0.7)
    t = fm_serve.ServingTable(art)
    t.linear_by_alias = {k: v["linear"] for k, v in art["champions"].items()}
    return t


@pytest.fixture
def meta():
    return {"Annie": {"positions": ["MIDDLE", "UTILITY"], "win_rate": 0.52},
            "Olaf": {"positions": ["JUNGLE", "TOP"], "win_rate": 0.49},
            "Galio": {"positions": ["MIDDLE"], "win_rate": 0.50},
            "TwistedFate": {"positions": ["MIDDLE"], "win_rate": 0.48},
            "XinZhao": {"positions": ["JUNGLE"], "win_rate": 0.51},
            "Urgot": {"positions": ["TOP"], "win_rate": 0.47},
            "Leblanc": {"positions": ["MIDDLE"], "win_rate": 0.53},
            "Vladimir": {"positions": ["TOP", "MIDDLE"], "win_rate": 0.50},
            "Fiddlesticks": {"positions": ["JUNGLE", "UTILITY"], "win_rate": 0.55},
            "Kayle": {"positions": ["TOP"], "win_rate": 0.45},
            # two extra names so a 6-ban padding can be drawn from meta minus the picks
            "Sion": {"positions": ["TOP"], "win_rate": 0.50},
            "Vi": {"positions": ["JUNGLE"], "win_rate": 0.50}}


COUNTERS = {"Annie": {"Olaf": -0.10, "Galio": 0.05, "Urgot": -0.02},
            "Kayle": {"Olaf": 0.30}}


# ---- decomposition ------------------------------------------------------------

def test_decompose_terms_sum_to_marginal_and_halved_allocation(table):
    team, opp = ["Olaf", "Galio"], ["Urgot", "Leblanc", "Kayle"]
    d = fx.decompose(table, "Annie", team, opp)
    assert d["marginal"] == pytest.approx(d["linear_expected"] + d["synergy"] + d["counter"])
    assert d["allocation"] == pytest.approx(d["linear_expected"] + 0.5 * (d["synergy"] + d["counter"]))
    assert d["marginal"] == pytest.approx(fm_serve.marginal(table, "Annie", team, opp))
    # the leaf share once picked: allocation() with Annie IN the team (self-excluded)
    assert d["allocation"] == pytest.approx(fm_serve.allocation(table, "Annie", team + ["Annie"], opp))
    assert sum(v for _, v in d["per_teammate"]) == pytest.approx(d["synergy"])
    assert sum(v for _, v in d["per_opponent"]) == pytest.approx(d["counter"])


def test_comp_strength_is_the_clamped_affine_map(table):
    comp, raw = fx.comp_strength(table, 0.1)
    assert raw == pytest.approx(0.5 + table.scale * 0.1) and comp == raw
    comp, raw = fx.comp_strength(table, 5.0)
    assert comp == 1.0 and raw > 1.0
    comp, _ = fx.comp_strength(table, -5.0)
    assert comp == 0.0


def test_marginal_equals_logit_change_from_adding_the_pick(table):
    blue, red = ["Olaf", "Galio"], ["Urgot", "Leblanc"]
    before = fm_serve.structural_logit(table, blue, red)
    for c, side in (("Annie", "blue"), ("Kayle", "red")):
        b2, r2 = (blue + [c], red) if side == "blue" else (blue, red + [c])
        after = fm_serve.structural_logit(table, b2, r2)
        team, opp = (blue, red) if side == "blue" else (red, blue)
        sign = 1.0 if side == "blue" else -1.0
        assert sign * (after - before) == pytest.approx(fm_serve.marginal(table, c, team, opp))


# ---- legacy path --------------------------------------------------------------------

def test_legacy_comp_strength_matches_evaluator_rs(meta):
    # clamp(win_rate − Σ max(−diff, 0)); positive diffs and missing entries add nothing
    assert fx.legacy_comp_strength("Annie", ["Olaf", "Galio", "Urgot", "Kayle"], meta, COUNTERS) == pytest.approx(0.52 - 0.10 - 0.02)
    assert fx.legacy_comp_strength("Kayle", ["Olaf"], meta, COUNTERS) == pytest.approx(0.45)
    assert fx.legacy_comp_strength("Galio", ["Annie"], meta, COUNTERS) == pytest.approx(0.50)
    assert fx.legacy_comp_strength("Locke", [], meta, COUNTERS) is None
    assert fx.legacy_comp_strength("Annie", ["Olaf"] * 6, meta, COUNTERS) == 0.0   # clamped


def test_ranking_orders_by_comp_strength_and_marks_fallback(table, meta):
    rows = fx.rank_candidates(table, meta, COUNTERS, ["Olaf"], ["Urgot"], ["Annie", "Galio", "Kayle", "Zilean"])
    comps = [r["comp_strength"] for r in rows]
    assert comps == sorted(comps, reverse=True)
    assert [r["fm_rank"] for r in rows] == [1, 2, 3, 4]
    zil = next(r for r in rows if r["champion"] == "Zilean")
    assert zil["fallback"] and zil["comp_strength"] == 0.5 and zil["legacy"] is None and "legacy_rank" not in zil
    legacy_ranked = sorted((r for r in rows if r["legacy"] is not None), key=lambda r: -r["legacy"])
    assert [r["legacy_rank"] for r in legacy_ranked] == [1, 2, 3]


# ---- turn logic + feasibility -----------------------------------------------------------

def test_find_turn_matches_the_draft_sequence():
    assert fx.find_turn(0, 0, "blue") == 6
    assert fx.find_turn(1, 0, "red") == 7 and fx.find_turn(1, 1, "red") == 8
    assert fx.find_turn(1, 2, "blue") == 9 and fx.find_turn(2, 2, "blue") == 10
    assert fx.find_turn(3, 2, "red") == 11
    assert fx.find_turn(3, 3, "red") == 16 and fx.find_turn(3, 3, "blue") is None
    assert fx.find_turn(5, 4, "red") == 19
    assert fx.next_side(3, 4) == "blue" and fx.next_side(5, 5) is None


def test_role_feasible_is_a_bipartite_matching(meta):
    assert fx.role_feasible(["Galio", "Leblanc"], meta) is False      # two MIDDLE-only
    assert fx.role_feasible(["Galio", "Annie"], meta) is True         # Annie flexes to UTILITY
    assert fx.role_feasible(["Olaf", "XinZhao", "Galio"], meta) is True   # Olaf must yield JUNGLE and take TOP
    assert fx.role_feasible(["Olaf", "XinZhao", "Urgot"], meta) is False  # three champions, two roles between them
    assert fx.role_feasible(["Olaf", "XinZhao", "Fiddlesticks"], meta) is True
    assert fx.role_feasible(["Unknown"], meta) is False               # no positions → no role
    assert fx.role_feasible([], meta) is True


def test_engine_request_pads_bans_to_the_pick_turn(meta):
    req = fx.build_engine_request(["Olaf", "Galio", "Annie"], ["Urgot", "Leblanc"], "red", meta, "red")
    assert req["draftState"]["currentSlot"] == 11 and req["draftState"]["currentSide"] == "red"
    assert len(req["draftState"]["bans"]) == 6
    assert [b["slot"] for b in req["draftState"]["bans"]] == [0, 1, 2, 3, 4, 5]
    assert all(b["championId"] not in ("Olaf", "Galio", "Annie", "Urgot", "Leblanc") for b in req["draftState"]["bans"])
    assert [p["slot"] for p in req["draftState"]["picks"]] == [6, 9, 10, 7, 8]
    w = req["config"]["weights"]
    assert w["penalties"] == {"outOfRole": 0.0, "outOfPool": 0.0}
    assert all(v == {"comp": 1.0, "info": 0.0, "coverage": 0.0} for v in w["phaseWeights"]["blue"].values())
    assert req["config"]["search"]["maxDepth"] == 1
    with pytest.raises(ValueError):
        fx.build_engine_request(["Olaf", "Galio", "Annie"], ["Urgot", "Leblanc", "Kayle"], "blue", meta, "blue")


def test_invert_side_sum_undoes_the_leaf_mapping():
    scale, n = 0.75, 4
    alloc_sum = 0.123
    composite = 0.5 * n + scale * alloc_sum
    assert fx.invert_side_sum(composite, n, scale) == pytest.approx(alloc_sum)


# ---- champion tour ----------------------------------------------------------------------

def test_champion_report_recomputes_linear_expected_from_prior(table, meta):
    prior = {"Annie": np.array([0.1, 0.1, 0.6, 0.1, 0.1])}
    rep = fx.champion_report(table, meta, prior, "Annie", top=3)
    w = np.array(list(rep["linear_by_role"].values()))
    assert rep["linear_expected_recomputed"] == pytest.approx(float(w @ prior["Annie"]))
    assert len(rep["best_synergy"]) == 3 and rep["best_synergy"][0][1] >= rep["best_synergy"][-1][1]
    assert rep["countered_by"][0][1] <= rep["counters_best_against"][0][1]
    assert "Annie" not in [o for o, _ in rep["best_synergy"] + rep["countered_by"]]


# ---- the Rust path (skips without the artifacts) ---------------------------------------------

needs_engine = pytest.mark.skipif(
    not (ROOT / "packages/engine-node/index.node").exists()
    or not (ROOT / "data/compiled/fm-weights.json").exists()
    or shutil.which("node") is None,
    reason="prebuilt index.node, shipped weights and node are required",
)


@needs_engine
def test_engine_allocation_sums_match_fm_serve_on_a_real_state():
    art, table = fx.load_table()
    meta = fx.load_meta()
    blue = ["Gragas", "Hecarim", "Akali", "Xayah", "Shen"]
    red = ["Sejuani", "Sylas", "Lissandra", "Tristana"]
    check = fx.engine_cross_check(table, meta, blue, red, "red")
    assert "loaded version=" in check["status"]
    assert check["n_children"] >= 10
    for r in check["rows"]:
        assert r["engine_blue_sum"] == pytest.approx(r["python_blue_sum"], abs=1e-9)
        assert r["engine_red_sum"] == pytest.approx(r["python_red_sum"], abs=1e-9)
        assert r["engine_mover_delta"] == pytest.approx(r["marginal"], abs=1e-9)
