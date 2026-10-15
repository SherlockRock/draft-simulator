# scripts/model/test_positions_feasibility.py
"""Data-free tests for positions_feasibility.py (the holdout-dependent path is
exercised by the probe and by refresh-champion-positions.mjs at run time)."""
import json
import subprocess
import sys
from pathlib import Path

import positions_feasibility as pf

HERE = Path(__file__).resolve().parent


def _sets():
    # one set: team of four + true pick, opp five, two candidates
    return [{"patch": "16.16", "side": "red",
             "team": ["Gnar", "Sejuani", "Ahri", "Jinx"], "true": "Thresh",
             "opp": ["Jax", "LeeSin", "Syndra", "Kaisa", "Leona"],
             "cands": ["Thresh", "Sylas"]}]


def _meta(**positions):
    return {alias: {"positions": roles} for alias, roles in positions.items()}


def test_positions_from_champions_json_maps_support_to_utility_and_keeps_order():
    doc = {"champions": [{"id": "Lulu", "name": "Lulu", "positions": ["SUPPORT", "MIDDLE"]}]}
    assert pf.positions_from_champions_json(doc) == {"Lulu": {"positions": ["UTILITY", "MIDDLE"]}}


def test_positions_from_meta_json_reads_the_champions_object():
    doc = {"champions": {"Lulu": {"id": "Lulu", "positions": ["SUPPORT"]}}}
    assert pf.positions_from_meta_json(doc) == {"Lulu": {"positions": ["UTILITY"]}}


# champion-role-shares design § 4.2 hop 5: `--field playable` (the default) measures the engine's
# legality set, falling back to the positions for a row without it; `--field positions` measures
# the listed roles. The field actually measured is reported beside the numbers.

def test_the_playable_field_is_projected_by_default_and_a_row_without_it_falls_back_to_its_positions():
    doc = {"champions": [
        {"id": "Kaisa", "name": "Kai'Sa", "positions": ["BOTTOM"], "playable": ["TOP", "BOTTOM"]},
        {"id": "Lulu", "name": "Lulu", "positions": ["SUPPORT", "MIDDLE"]},
    ]}
    assert pf.positions_from_champions_json(doc) == {"Kaisa": {"positions": ["TOP", "BOTTOM"]},
                                                     "Lulu": {"positions": ["UTILITY", "MIDDLE"]}}
    assert pf.positions_from_champions_json(doc, field="positions") == {"Kaisa": {"positions": ["BOTTOM"]},
                                                                        "Lulu": {"positions": ["UTILITY", "MIDDLE"]}}
    meta = {"champions": {"Kaisa": {"positions": ["BOTTOM"], "playable": ["TOP", "BOTTOM"]},
                          "Lulu": {"positions": ["SUPPORT", "MIDDLE"]}}}
    assert pf.positions_from_meta_json(meta) == {"Kaisa": {"positions": ["TOP", "BOTTOM"]},
                                                 "Lulu": {"positions": ["UTILITY", "MIDDLE"]}}
    assert pf.positions_from_meta_json(meta, field="positions")["Kaisa"] == {"positions": ["BOTTOM"]}


def test_fallback_rows_counts_the_rows_the_playable_rule_read_through_the_positions():
    rows = [{"id": "Kaisa", "positions": ["BOTTOM"], "playable": ["TOP", "BOTTOM"]},
            {"id": "Lulu", "positions": ["SUPPORT"]}]
    assert pf.fallback_rows(rows, "playable") == 1
    assert pf.fallback_rows(rows[1:], "playable") == 1     # a table from before the field (or --source ugg): every row
    assert pf.fallback_rows(rows, "positions") == 0
    assert pf.fallback_rows([], "playable") == 0


def test_measure_counts_both_sides_and_every_candidate():
    meta = _meta(Gnar=["TOP"], Sejuani=["JUNGLE"], Ahri=["MIDDLE"], Jinx=["BOTTOM"], Thresh=["UTILITY"],
                 Jax=["TOP"], LeeSin=["JUNGLE"], Syndra=["MIDDLE"], Kaisa=["BOTTOM"], Leona=["UTILITY"],
                 Sylas=["MIDDLE"])
    m = pf.measure(_sets(), meta)
    assert m == {"sets": 1, "opp5": 1.0, "team4True": 1.0, "bothSides": 1.0, "everyCandidate": 0.0}


def test_measure_reports_an_infeasible_side():
    meta = _meta(Gnar=["TOP"], Sejuani=["JUNGLE"], Ahri=["MIDDLE"], Jinx=["BOTTOM"], Thresh=["UTILITY"],
                 Jax=["TOP"], LeeSin=["JUNGLE"], Syndra=["MIDDLE"], Kaisa=["MIDDLE"], Leona=["UTILITY"],
                 Sylas=["MIDDLE", "UTILITY"])
    m = pf.measure(_sets(), meta)
    assert m["opp5"] == 0.0 and m["team4True"] == 1.0 and m["bothSides"] == 0.0
    assert m["everyCandidate"] == 1.0   # Sylas can take UTILITY, Thresh too


def test_cli_prints_one_json_object(tmp_path):
    doc = {"champions": [{"id": "Ahri", "name": "Ahri", "positions": ["MIDDLE"]}]}
    path = tmp_path / "champions.json"
    path.write_text(json.dumps(doc))
    sets_dir = tmp_path / "training"
    sets_dir.mkdir()
    (sets_dir / "holdout_drafts.csv").write_text(
        "match_id,b_TOP,b_JUNGLE,b_MIDDLE,b_BOTTOM,b_UTILITY,r_TOP,r_JUNGLE,r_MIDDLE,r_BOTTOM,r_UTILITY,win,evaluable\n"
        "m1,Jax,LeeSin,Syndra,Kaisa,Leona,Gnar,Sejuani,Ahri,Jinx,Thresh,1,True\n")
    (sets_dir / "sibling_sets.csv").write_text(
        "match_id,slot,role,side,patch,true_pick,true_alias,candidates,candidate_aliases,evaluable\n"
        "m1,7,MIDDLE,red,16.16,103,Ahri,103 517,Ahri Sylas,True\n")
    out = subprocess.run([sys.executable, str(HERE / "positions_feasibility.py"),
                          "--champions", str(path), "--train-dir", str(sets_dir)],
                         capture_output=True, text=True, check=True)
    result = json.loads(out.stdout)
    assert result["sets"] == 1
    assert result["team4True"] == 0.0     # only Ahri has positions in this table
    assert result["field"] == "playable"   # the rule asked for — what the engines read — even though every row fell back
    assert result["fallbackRows"] == 1
    # With playable on file the default measures it, and --field positions the listed roles.
    doc = {"champions": [{"id": alias, "name": alias, "positions": [pos], "playable": [pos, "MIDDLE"]}
                         for alias, pos in [("Gnar", "TOP"), ("Sejuani", "JUNGLE"), ("Jinx", "BOTTOM"), ("Thresh", "SUPPORT")]]
           + [{"id": "Ahri", "name": "Ahri", "positions": ["TOP"]}]}
    path.write_text(json.dumps(doc))
    for args, field, fallback, team in [([], "playable", 1, 1.0), (["--field", "playable"], "playable", 1, 1.0), (["--field", "positions"], "positions", 0, 0.0)]:
        out = subprocess.run([sys.executable, str(HERE / "positions_feasibility.py"),
                              "--champions", str(path), "--train-dir", str(sets_dir), *args],
                             capture_output=True, text=True, check=True)
        result = json.loads(out.stdout)
        assert result["field"] == field, args
        assert result["fallbackRows"] == fallback, args   # Ahri has no playable
        assert result["team4True"] == team, args   # Ahri (TOP only) completes the red team only when a teammate is playable MIDDLE


def test_load_holdout_sets_keeps_the_held_out_side(tmp_path):
    (tmp_path / "holdout_drafts.csv").write_text(
        "match_id,b_TOP,b_JUNGLE,b_MIDDLE,b_BOTTOM,b_UTILITY,r_TOP,r_JUNGLE,r_MIDDLE,r_BOTTOM,r_UTILITY,win,evaluable\n"
        "m1,Jax,LeeSin,Syndra,Kaisa,Leona,Gnar,Sejuani,Ahri,Jinx,Thresh,1,True\n")
    (tmp_path / "sibling_sets.csv").write_text(
        "match_id,slot,role,side,patch,true_pick,true_alias,candidates,candidate_aliases,evaluable\n"
        "m1,7,MIDDLE,red,16.16,103,Ahri,103 517,Ahri Sylas,True\n"
        "m1,2,MIDDLE,blue,16.16,134,Syndra,134 517,Syndra Sylas,False\n")
    sets = pf.load_holdout_sets(tmp_path)
    assert len(sets) == 1                      # the evaluable=False row is skipped
    assert sets[0]["side"] == "red"
    assert sets[0]["slot"] == 7
    assert sets[0]["match_id"] == "m1"
    assert sets[0]["team"] == ["Gnar", "Sejuani", "Jinx", "Thresh"]
    assert sets[0]["opp"] == ["Jax", "LeeSin", "Syndra", "Kaisa", "Leona"]
    assert sets[0]["true"] == "Ahri"
