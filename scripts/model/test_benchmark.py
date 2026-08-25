import json

import numpy as np

import benchmark


def test_mrr_gives_ties_the_mid_rank():
    """A scorer that emits equal scores must not get credit for rank 1."""
    rr, t1, _ = benchmark.mrr_top1([[1.0, 1.0, 0.0]])
    assert rr[0] == 1 / 1.5
    assert t1[0] == 0.0
    rr, _, _ = benchmark.mrr_top1([[0.0, 0.0, 0.0]])
    assert rr[0] == 1 / 2.0


def test_fold_rows_are_paired_by_fold_number_not_list_position():
    bfolds = [{"fold": 2, "rows": [{"name": "antisymmetric FM", "log_loss": 0.5}]},
              {"fold": 3, "rows": [{"name": "antisymmetric FM", "log_loss": 0.6}]}]
    fp = {"fold2": np.array([0.5]), "fold2_y": np.array([1]),
          "fold3": np.array([0.5]), "fold3_y": np.array([1])}
    pairs = benchmark.fold_pairs(bfolds, fp)
    assert [k for k, _, _ in pairs] == [2, 3]
    assert [fm for _, _, fm in pairs] == [0.5, 0.6]


def test_gate5_is_missing_without_a_measured_evaluator_rate(tmp_path):
    report = []
    verdict, _ = benchmark.gate5(report, {}, train_dir=tmp_path)
    assert verdict == "MISSING"
