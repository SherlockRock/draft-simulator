"""Task 1a unit tests on a synthetic 1k-row fixture.

The fixture mirrors the real parquet schema (teams_json as a VARCHAR of the
stored JSONB) so `flatten` is exercised for real, not stubbed.
"""

import json
import subprocess
import sys
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd
import pytest

import prepare
from common import POSITIONS, NONE_INDEX, UNKNOWN_INDEX, load_id_to_alias, load_champion_meta, load_evaluable
from mask_table import pattern_at

N_ROWS = 1000
REGIONS = ["euw1", "kr", "na1"]


@pytest.fixture(scope="module")
def id_pool():
    """Real champion ids so the cdragon assertion in build_champion_vocab holds."""
    return sorted(load_id_to_alias())[:40]


def make_fixture(tmp_path, id_pool, n=N_ROWS, seed=7, both_false_rows=3, ragged=True):
    rng = np.random.default_rng(seed)
    base = datetime(2026, 8, 1, tzinfo=timezone.utc)
    rows = []
    for i in range(n):
        region = REGIONS[i % 3]
        # 10 days of games; day 0 gets a thin tail so the ragged cut has work.
        day = 0 if (ragged and i % 200 == 0) else 1 + (i % 9)
        start = base + timedelta(days=day, minutes=i % 1440)
        champs = rng.choice(id_pool, size=10, replace=False)
        bans = rng.choice([c for c in id_pool if c not in champs], size=10, replace=False)
        blue_win = bool(rng.integers(0, 2))
        if i < both_false_rows:
            blue_win, red_win = False, False   # voided game: no winner
        else:
            red_win = not blue_win
        teams = {}
        for k, (side, offset, win) in enumerate((("100", 0, blue_win), ("200", 5, red_win))):
            teams[side] = {
                "win": win,
                "bans": [int(b) for b in bans[k * 5:(k + 1) * 5]],
                "participants": {
                    pos: {"championId": int(champs[offset + j])}
                    for j, pos in enumerate(POSITIONS)
                },
                "teamStats": {"900000": {"totalGold": int(24000 + rng.integers(-4000, 4000))}},
            }
        rows.append(
            {
                "match_id": f"{region.upper()}_{i:06d}",
                "region": region,
                "seed_tier": "MASTER",
                "patch_major": 16,
                "patch_minor": 15 if day < 5 else 16,
                "game_duration": int(rng.integers(900, 2400)),
                "game_start": start,
                "extractor_version": 3,
                "teams_json": json.dumps(teams),
            }
        )
    path = tmp_path / "matches_fixture.parquet"
    pd.DataFrame(rows).to_parquet(path, index=False)
    return path


@pytest.fixture(scope="module")
def prepared(tmp_path_factory, id_pool):
    tmp = tmp_path_factory.mktemp("prep")
    parquet = make_fixture(tmp, id_pool)
    out = tmp / "out"
    subprocess.run(
        [sys.executable, str(prepare.__file__), str(parquet), "--out", str(out),
         "--sibling-n", "5"],
        check=True, capture_output=True, cwd=str(prepare.ROOT / "scripts/model"),
    )
    return out


# --- filters ---------------------------------------------------------------

def test_both_false_winner_rows_are_dropped(tmp_path, id_pool):
    parquet = make_fixture(tmp_path, id_pool, n=100, both_false_rows=5)
    df = prepare.flatten(parquet)
    assert (~(df.b_win.astype(bool) ^ df.r_win.astype(bool))).sum() == 5
    kept = prepare.apply_filters(df, [])
    assert len(kept) == 95
    assert (kept.b_win.astype(bool) ^ kept.r_win.astype(bool)).all()


def test_old_extractor_versions_are_dropped(tmp_path, id_pool):
    parquet = make_fixture(tmp_path, id_pool, n=50, both_false_rows=0)
    df = prepare.flatten(parquet)
    df.loc[:9, "extractor_version"] = 2
    assert len(prepare.apply_filters(df, [])) == 40


def test_v4_rows_are_kept(tmp_path, id_pool):
    """`>= 3`, not `== 3`: extractor v4 adds teams.meta but keeps the shape."""
    parquet = make_fixture(tmp_path, id_pool, n=50, both_false_rows=0)
    df = prepare.flatten(parquet)
    df.loc[:9, "extractor_version"] = 4
    assert len(prepare.apply_filters(df, [])) == 50


def test_ragged_tail_cut_drops_thin_days_per_region(tmp_path, id_pool):
    parquet = make_fixture(tmp_path, id_pool, n=900, both_false_rows=0)
    df = prepare.apply_filters(prepare.flatten(parquet), [])
    cut = prepare.ragged_tail_cut(df, [])
    assert len(cut) < len(df), "the thin day should have been dropped"
    for region, g in cut.groupby("region"):
        counts = pd.to_datetime(g.game_start, utc=True).dt.floor("D").value_counts()
        assert (counts >= prepare.RAGGED_TAIL_FRACTION * counts.median()).all()


def test_patch_cut_drops_rows_after_max_patch(tmp_path, id_pool):
    parquet = make_fixture(tmp_path, id_pool, n=60, both_false_rows=0)
    df = prepare.apply_filters(prepare.flatten(parquet), [])
    df.loc[:9, ["patch_major", "patch_minor"]] = [16, 17]
    df.loc[10:14, ["patch_major", "patch_minor"]] = [17, 1]   # major bump: not "16.9 > 16.17"
    cut = prepare.patch_cut(df, (16, 16), [])
    assert len(cut) == 45
    assert ((cut.patch_major < 16) | ((cut.patch_major == 16) & (cut.patch_minor <= 16))).all()
    assert len(prepare.patch_cut(df, None, [])) == 60


def test_parse_patch():
    assert prepare.parse_patch("16.16") == (16, 16)
    with pytest.raises(ValueError):
        prepare.parse_patch("16")


# --- vocabularies ----------------------------------------------------------

def test_champion_vocab_reserves_unknown_and_none(prepared):
    vocab = json.loads((prepared / "champion_vocab.json").read_text())
    assert vocab["reserved"] == {"UNKNOWN": UNKNOWN_INDEX, "NONE": NONE_INDEX}
    idx = vocab["riot_id_to_index"]
    assert min(int(v) for v in idx.values()) == 2, "no champion may take a reserved row"
    assert len(set(idx.values())) == len(idx), "vocab indices must be unique"


def test_champion_vocab_appends_and_never_reindexes(tmp_path, id_pool):
    """A champion released later must APPEND. Existing indices may never move —
    a checkpoint's embedding table is indexed by them, and legacy numeric picks
    depend on the order being stable across retrains."""
    id_to_alias = load_id_to_alias()
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()

    old_ids = id_pool[:30]
    df_old = prepare.apply_filters(
        prepare.flatten(make_fixture(tmp_path / "a", old_ids, n=200, both_false_rows=0)), [])
    idx_old, _ = prepare.build_champion_vocab(df_old, id_to_alias, [])

    # A newer champion always carries a higher Riot id (Locke = 805 is the case
    # that motivated Task 0), so the ascending-id order appends it at the end.
    newer = [c for c in sorted(id_to_alias) if c > max(old_ids)][:3]
    assert newer, "fixture pool exhausted the id space"
    df_new = prepare.apply_filters(
        prepare.flatten(make_fixture(tmp_path / "b", old_ids + newer, n=200,
                                     both_false_rows=0, seed=11)), [])
    idx_new, _ = prepare.build_champion_vocab(df_new, id_to_alias, [])

    for cid in old_ids:
        assert idx_new[cid] == idx_old[cid], f"champion {cid} was re-indexed"
    for cid in newer:
        assert idx_new[cid] > max(idx_old.values()), "a new champion must append"


def test_champion_vocab_is_deterministic(tmp_path, id_pool):
    id_to_alias = load_id_to_alias()
    df = prepare.apply_filters(
        prepare.flatten(make_fixture(tmp_path, id_pool, n=200, both_false_rows=0)), [])
    a, _ = prepare.build_champion_vocab(df, id_to_alias, [])
    b, _ = prepare.build_champion_vocab(df, id_to_alias, [])
    assert a == b


def test_role_percentages_sum_to_one(prepared):
    rp = json.loads((prepared / "role_percentages.json").read_text())
    assert rp
    for cid, entry in rp.items():
        assert sum(entry["roles"].values()) == pytest.approx(1.0)
        assert set(entry["roles"]) == set(POSITIONS)
        assert entry["games"] > 0


# --- encoding --------------------------------------------------------------

def test_slot_index_is_canonical_role_order(prepared):
    ds = pd.read_parquet(prepared / "dataset.parquet")
    holdout = pd.read_csv(prepared / "holdout_drafts.csv")
    id_to_alias = load_id_to_alias()
    row = ds[ds.split == "test"].iloc[0]
    h = holdout[holdout.match_id == row.match_id].iloc[0]
    for slot, (tag, pos) in enumerate([(t, p) for t in ("b", "r") for p in POSITIONS]):
        assert h[f"{tag}_{pos}"] == id_to_alias[int(row[f"riot_{slot}"])]


def test_ban_slots_are_none_padded(prepared):
    ds = pd.read_parquet(prepared / "dataset.parquet")
    for k in range(10):
        forfeited = ds[f"ban_riot_{k}"] < 0
        assert (ds.loc[forfeited, f"ban_{k}"] == NONE_INDEX).all()
        assert (ds.loc[~forfeited, f"ban_{k}"] != NONE_INDEX).all()


def test_targets_present_and_finite(prepared):
    ds = pd.read_parquet(prepared / "dataset.parquet")
    for col in ("win", "log_duration", "gold_diff15"):
        assert ds[col].notna().all()
        assert np.isfinite(ds[col].astype(float)).all()
    assert set(ds.win.unique()) <= {0, 1}


# --- splits ----------------------------------------------------------------

def test_split_is_by_time_within_each_region(prepared):
    ds = pd.read_parquet(prepared / "dataset.parquet")
    for region, g in ds.groupby("region"):
        train_end = g[g.split == "train"].game_start.max()
        val = g[g.split.isin(["val_a", "val_b"])]
        test = g[g.split == "test"]
        assert val.game_start.min() >= train_end
        assert test.game_start.min() >= val.game_start.max()


def test_val_halves_are_interleaved_in_time_not_split_by_it(prepared):
    """val-A picks the checkpoint, val-B fits T. If val-B sat entirely nearer
    the test edge it would be a different distribution from val-A."""
    ds = pd.read_parquet(prepared / "dataset.parquet")
    a = ds[ds.split == "val_a"].game_start
    b = ds[ds.split == "val_b"].game_start
    assert abs(len(a) - len(b)) <= len(REGIONS)
    assert a.min() <= b.max() and b.min() <= a.max(), "halves must overlap in time"


def test_every_row_lands_in_exactly_one_split(prepared):
    ds = pd.read_parquet(prepared / "dataset.parquet")
    assert ds.match_id.is_unique
    assert set(ds.split.unique()) == {"train", "val_a", "val_b", "test"}


def test_folds_never_test_on_their_own_training_prefix(prepared):
    ds = pd.read_parquet(prepared / "dataset.parquet")
    folds = pd.read_parquet(prepared / "folds.parquet")
    start = dict(zip(ds.match_id, ds.game_start))
    for (fold, region), g in folds.merge(
        ds[["match_id", "region"]], on="match_id"
    ).groupby(["fold", "region"]):
        tr = [start[m] for m in g[g.role == "train"].match_id]
        te = [start[m] for m in g[g.role == "test"].match_id]
        if tr and te:
            assert max(tr) <= min(te), f"fold {fold}/{region} tests inside its prefix"
        assert not (set(g[g.role == "train"].match_id) & set(g[g.role == "test"].match_id))


# --- sibling sets ----------------------------------------------------------

def test_sibling_sets_contain_the_true_pick_exactly_once(prepared):
    sib = pd.read_parquet(prepared / "sibling_sets.parquet")
    assert len(sib) > 0
    for row in sib.itertuples():
        cands = list(row.candidates)
        assert len(cands) == len(set(cands)), "duplicate candidate"
        assert cands.count(row.true_pick) == 1


def test_sibling_distractors_exclude_picked_and_banned(prepared):
    ds = pd.read_parquet(prepared / "dataset.parquet").set_index("match_id")
    sib = pd.read_parquet(prepared / "sibling_sets.parquet")
    for row in sib.itertuples():
        e = ds.loc[row.match_id]
        picked = {int(e[f"riot_{i}"]) for i in range(10)}
        banned = {int(e[f"ban_riot_{i}"]) for i in range(10) if e[f"ban_riot_{i}"] > 0}
        for c in list(row.candidates)[1:]:
            assert c not in picked, "a distractor is already in the draft"
            assert c not in banned, "a distractor is banned in this game"


def test_sibling_candidates_are_all_evaluable(prepared):
    """Locke and any other champion champion-meta cannot score must never be a
    candidate — the evaluator arm would have no score for it."""
    evaluable, _ = load_evaluable(load_id_to_alias(), load_champion_meta())
    sib = pd.read_parquet(prepared / "sibling_sets.parquet")
    for row in sib.itertuples():
        assert set(row.candidates) <= evaluable


def test_sibling_slot_draw_covers_all_ten_slots(prepared):
    sib = pd.read_parquet(prepared / "sibling_sets.parquet")
    assert set(sib.slot.unique()) == set(range(10))
    assert sib.role.map(lambda r: POSITIONS.index(r)).equals(sib.slot % 5)


# --- masked states ---------------------------------------------------------

def test_masked_states_match_their_leaf_turn_pattern(prepared):
    ms = pd.read_parquet(prepared / "masked_states.parquet")
    assert len(ms) > 0
    for row in ms.itertuples():
        pat = pattern_at(row.leaf_turn)
        vis = list(row.visible_picks)
        assert sum(vis[:5]) == pat["blue_picks"]
        assert sum(vis[5:]) == pat["red_picks"]
        assert 10 - sum(vis) == row.masked_slots == pat["masked_slots"]
        bans = list(row.visible_bans)
        assert sum(bans[:5]) == pat["blue_bans"]
        assert sum(bans[5:]) == pat["red_bans"]


def test_masked_states_only_use_reachable_leaf_turns(prepared):
    """A mid-pair turn is never a search leaf, so it must not appear here."""
    from mask_table import reachable_leaf_turns
    ms = pd.read_parquet(prepared / "masked_states.parquet")
    allowed = set(reachable_leaf_turns(*prepare.MASK_BUCKET))
    assert set(ms.leaf_turn.unique()) <= allowed
    assert 10 not in set(ms.leaf_turn.unique()), "turn 10 is a pair-end, never a leaf"


def test_masked_states_csv_blanks_exactly_the_masked_slots(prepared):
    ms = pd.read_parquet(prepared / "masked_states.parquet").set_index("match_id")
    csv = pd.read_csv(prepared / "masked_states.csv", keep_default_na=False)
    names = [f"{t}_{p}" for t in ("b", "r") for p in POSITIONS]
    for row in csv.itertuples():
        vis = list(ms.loc[row.match_id].visible_picks)
        for slot, name in enumerate(names):
            filled = getattr(row, name) != ""
            assert filled == vis[slot], f"{row.match_id} slot {slot}"


def test_masked_states_are_deterministic(tmp_path, id_pool, prepared):
    """Tasks 2b, 4 and 6 must score the SAME states; a reseed would decouple them."""
    ds = pd.read_parquet(prepared / "dataset.parquet")
    ms1 = pd.read_parquet(prepared / "masked_states.parquet")
    ms2 = prepare.build_masked_states(ds, [])
    pd.testing.assert_frame_equal(
        ms1.reset_index(drop=True), ms2.reset_index(drop=True), check_dtype=False
    )


# --- harness mirrors -------------------------------------------------------

def test_solver_states_covers_val_a_val_b_test_and_fold_one(prepared):
    solver = pd.read_csv(prepared / "solver_states.csv")
    got = set(zip(solver.fold, solver.split))
    assert {(0, "val_a"), (0, "val_b"), (0, "test")} <= got
    assert any(f == 1 for f, _ in got), "fold 1's val must be present for the sweep"


def test_holdout_drafts_is_exactly_the_test_split(prepared):
    ds = pd.read_parquet(prepared / "dataset.parquet")
    holdout = pd.read_csv(prepared / "holdout_drafts.csv")
    assert set(holdout.match_id) == set(ds[ds.split == "test"].match_id)
    assert set(holdout.columns) >= {"win", "evaluable"}


def test_solver_states_cover_every_folds_validation_rows(prepared):
    """train.py selects checkpoints on solver-role val-A; every fold must have
    solver roles for its val or the selection criterion silently differs by fold."""
    solver = pd.read_csv(prepared / "solver_states.csv")
    folds = pd.read_parquet(prepared / "folds.parquet")
    for k in sorted(folds.fold.unique()):
        val = folds[(folds.fold == k) & folds.role.isin(["val_a", "val_b"])]
        if len(val) == 0:
            continue
        got = set(solver[solver.fold == k].match_id)
        assert set(val.match_id) <= got, f"fold {k} val rows missing from solver_states.csv"


def test_pick_frequency_falls_back_to_the_role_table_for_an_unseen_patch():
    train = pd.DataFrame({"patch": ["16.15", "16.15"], **{f"riot_{i}": [10 + i, 10 + i] for i in range(10)}})
    freq, role_freq = prepare.pick_frequency_tables(train)
    assert prepare.popularity_table(freq, role_freq, "TOP", "16.15")[10] == 2
    assert prepare.popularity_table(freq, role_freq, "TOP", "16.99")[10] == 2
