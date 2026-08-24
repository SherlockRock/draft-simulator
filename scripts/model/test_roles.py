"""The Python role solver must agree with engine-core's Rust one, or the
augmentation trains the model on a different serve path than gate 4 measures."""

import json

import numpy as np
import pandas as pd
import pytest

import roles
from common import ROOT

TRAIN = ROOT / "data/training"
pytestmark = pytest.mark.skipif(
    not (TRAIN / "solver_roles.csv").exists(),
    reason="run prepare.py and the Task 2b emitter first",
)


@pytest.fixture(scope="module")
def table():
    vocab = json.loads((TRAIN / "champion_vocab.json").read_text())
    i2a = {int(k): v for k, v in vocab["index_to_alias"].items()}
    return roles.position_factor_table(len(i2a) + 2, i2a), i2a


@pytest.fixture(scope="module")
def rust_full():
    sr = pd.read_csv(TRAIN / "solver_roles.csv")
    return sr[sr.state_kind == "full"]


def test_python_posterior_matches_the_rust_solver(table, rust_full, ):
    """The load-bearing cross-implementation check."""
    factors, i2a = table
    a2i = {a: i for i, a in i2a.items()}
    ds = pd.read_parquet(TRAIN / "dataset.parquet")
    sample = ds[ds.split == "test"].head(300)
    rust = rust_full.set_index(["match_id", "side", "champion"])
    pcols = ["p_top", "p_jungle", "p_middle", "p_adc", "p_support"]

    checked = 0
    for row in sample.itertuples():
        for side, base in (("blue", 0), ("red", 5)):
            idx = [getattr(row, f"champ_{base + k}") for k in range(5)]
            post = roles.team_posterior(factors[idx])
            for k in range(5):
                key = (row.match_id, side, i2a[idx[k]])
                if key not in rust.index:
                    continue
                np.testing.assert_allclose(
                    post[k], rust.loc[key, pcols].to_numpy(dtype=float), atol=2e-6
                )
                checked += 1
    assert checked > 1000, f"only {checked} comparisons — the join is not matching"


def test_python_argmax_matches_the_rust_solver(table, rust_full):
    factors, i2a = table
    ds = pd.read_parquet(TRAIN / "dataset.parquet")
    sample = ds[ds.split == "test"].head(300)
    rust = rust_full.set_index(["match_id", "side", "champion"])
    checked = 0
    for row in sample.itertuples():
        for side, base in (("blue", 0), ("red", 5)):
            idx = [getattr(row, f"champ_{base + k}") for k in range(5)]
            am = roles.team_argmax(factors[idx])
            for k in range(5):
                key = (row.match_id, side, i2a[idx[k]])
                if key not in rust.index:
                    continue
                assert roles.ROLE_NAMES[am[k]] == rust.loc[key, "argmax_role"]
                checked += 1
    assert checked > 1000


def test_posterior_rows_and_columns_both_sum_to_one(table):
    factors, _ = table
    rng = np.random.default_rng(0)
    idx = rng.integers(2, len(factors), size=(50, 5))
    post = roles.team_posterior(factors[idx])
    np.testing.assert_allclose(post.sum(axis=2), 1.0, atol=1e-9)
    # The assignment is a bijection, so each ROLE is filled exactly once too.
    np.testing.assert_allclose(post.sum(axis=1), 1.0, atol=1e-9)


def test_partial_teams_still_give_distributions(table):
    factors, _ = table
    rng = np.random.default_rng(1)
    for n in (1, 2, 3, 4):
        idx = rng.integers(2, len(factors), size=(20, n))
        post = roles.team_posterior(factors[idx])
        assert post.shape == (20, n, 5)
        np.testing.assert_allclose(post.sum(axis=2), 1.0, atol=1e-9)


def test_empty_slot_convention_is_uniform_over_unfilled_roles():
    filled = np.zeros((5, 5))
    filled[0, 0] = 1.0   # TOP taken
    filled[1, 1] = 1.0   # JUNGLE taken
    probs = roles.empty_slot_role_probs(filled)
    np.testing.assert_allclose(probs, [0, 0, 1 / 3, 1 / 3, 1 / 3], atol=1e-12)


def test_empty_slot_convention_handles_soft_filled_rows():
    filled = np.zeros((5, 5))
    filled[0] = [0.6, 0.4, 0, 0, 0]
    probs = roles.empty_slot_role_probs(filled)
    assert probs.sum() == pytest.approx(1.0)
    assert probs[0] < probs[2], "a partly-claimed role must carry less residual mass"
