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
