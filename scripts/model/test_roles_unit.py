"""Data-free tests for roles.py (test_roles.py needs the Task 2b artifacts)."""

import re

import numpy as np
import pandas as pd

import roles
from common import ROOT

RUST = ROOT / "packages/engine-node/src/solver_roles_test.rs"


def test_rust_synth_meta_reads_the_same_json_keys_python_does():
    """prepare.py writes `meta_roles` with champion-meta's vocabulary (BOTTOM,
    not ADC). The Rust harness must index the JSON with the same names or a
    new marksman silently gets no ADC share in its synthesised meta."""
    src = RUST.read_text()
    m = re.search(r"const META_ROLE_NAMES: \[&str; 5\] = \[(.*?)\];", src)
    assert m, "solver_roles_test.rs must declare META_ROLE_NAMES for the JSON lookup"
    names = [s.strip().strip('"') for s in m.group(1).split(",")]
    assert names == roles.META_ROLE_NAMES
    # and the lookup must actually use it
    assert re.search(r"zip\(META_ROLE_NAMES\)", src)


def test_position_factor_table_tolerates_a_champion_with_no_prior():
    """A vocab champion absent from champion-meta AND from train picks (ban-only,
    or picked only in val/test) must not crash the loaders."""
    i2a = {2: "Jayce", 3: "NotInAnyTable"}
    table = roles.position_factor_table(4, i2a, role_percentages={})
    assert table.shape == (4, 5)
    assert np.all(table[3] == 1.0)          # no preference, like UNKNOWN


def test_prior_from_frame_uses_only_that_frame():
    df = pd.DataFrame({f"champ_{i}": [0] * 2 for i in range(10)})
    df["champ_0"] = [5, 5]      # blue TOP twice
    df["champ_6"] = [7, 0]      # red JUNGLE once
    prior = roles.prior_from_frame(df, n_champ=8)
    assert prior.shape == (8, 5)
    assert prior[5].tolist() == [1.0, 0.0, 0.0, 0.0, 0.0]
    assert prior[7].tolist() == [0.0, 1.0, 0.0, 0.0, 0.0]
    assert np.allclose(prior[6], 0.2)       # never seen -> uniform


def test_factor_table_from_prior_synthesises_missing_meta_from_the_prior():
    i2a = {2: "NotInMeta"}
    prior = np.full((3, 5), 0.2)
    prior[2] = [0.0, 0.0, 0.1, 0.9, 0.0]    # a marksman
    table = roles.factor_table_from_prior(prior, i2a)
    assert table[2, 3] == roles.PRIMARY_FACTOR
    assert table[2, 2] == roles.NON_LISTED_FACTOR
