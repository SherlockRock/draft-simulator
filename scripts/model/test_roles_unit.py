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
    prior[2] = [0.0, 0.0, 0.05, 0.95, 0.0]    # a marksman; MIDDLE below the 0.10 threshold
    table = roles.factor_table_from_prior(prior, i2a)
    assert table[2, 3] == roles.PRIMARY_FACTOR
    assert table[2, 2] == roles.NON_LISTED_FACTOR


def test_factor_table_from_prior_lists_a_role_at_exactly_the_threshold_as_secondary():
    """Behavioural pin of SYNTH_ROLE_THRESHOLD = 0.10 (the regex test pins the literal)."""
    i2a = {2: "FlexMarksman"}
    prior = np.full((3, 5), 0.2)
    prior[2] = [0.0, 0.0, 0.10, 0.90, 0.0]
    table = roles.factor_table_from_prior(prior, i2a)
    assert table[2, 3] == roles.PRIMARY_FACTOR
    assert table[2, 2] == roles.SECONDARY_FACTOR


MJS = ROOT / "scripts/champion-positions/derive.mjs"


def test_the_synthesis_thresholds_equal_the_shipped_positions_threshold():
    """Design § 9: one threshold serves the shipped refresh rule (derive.mjs),
    the Rust harness's synthesis for champions missing from champion-meta, and
    the Python mirror. Two of these were 0.15 while the design chose 0.10."""
    rust = re.search(r"const SYNTH_ROLE_THRESHOLD: f64 = ([0-9.]+);", RUST.read_text())
    assert rust, "solver_roles_test.rs must declare SYNTH_ROLE_THRESHOLD"
    mjs = re.search(r"export const POSITIONS_THRESHOLD = ([0-9.]+);", MJS.read_text())
    assert mjs, "derive.mjs must export POSITIONS_THRESHOLD"
    assert float(rust.group(1)) == roles.SYNTH_ROLE_THRESHOLD == float(mjs.group(1)) == 0.10


# --- champion-role-shares slice B (design U1): two tables ---------------------------------------

PANTHEON = {"positions": ["TOP", "SUPPORT"],
            "positionShares": {"TOP": 0.392, "JUNGLE": 0.108, "MIDDLE": 0.112, "BOTTOM": 0.013, "SUPPORT": 0.376}}
# An override reordered the positions: SUPPORT first, TOP's share larger (design § 4.1).
REORDERED = {"positions": ["SUPPORT", "TOP"], "positionShares": PANTHEON["positionShares"]}
LEGACY_KEYS = {"positions": ["MIDDLE", "JUNGLE"], "positionShares": {"MIDDLE": 0.448, "JUNGLE": 0.38}}
HAND_ROW = {"positions": ["MIDDLE", "TOP"]}
ALL_ZERO = {"positions": ["MIDDLE"], "positionShares": {r: 0.0 for r in roles.META_ROLE_NAMES}}
META = {"Pantheon": PANTHEON, "Reordered": REORDERED, "Zyra": LEGACY_KEYS, "Yone": HAND_ROW, "Zero": ALL_ZERO}
I2A = {2: "Pantheon", 3: "Reordered", 4: "Zyra", 5: "Yone", 6: "Zero", 7: "NewMarksman", 8: "NotInAnyTable"}
PRIOR = {"999": {"alias": "NewMarksman", "meta_roles":
                 {"TOP": 0.0, "JUNGLE": 0.0, "MIDDLE": 0.05, "BOTTOM": 0.95, "SUPPORT": 0.0}}}


def ratio(five):
    return [max(s, roles.SHARE_EPSILON) / max(five) for s in five]


def test_position_factor_table_is_the_share_ratio_floored_at_epsilon_for_every_role():
    """role_solver.rs position_factor since slice B: max(share, ε) / max(shares), from the compiled
    3-dp shares, for EVERY role — an unlisted 11% role weighs 0.286, a 1.3% role 0.033, never 0.01."""
    assert roles.SHARE_EPSILON == 0.001
    table = roles.position_factor_table(9, I2A, role_percentages=PRIOR, meta=META)
    assert table.shape == (9, 5)
    assert table[2].tolist() == ratio([0.392, 0.108, 0.112, 0.013, 0.376])
    assert table[2, 0] == 1.0 and table[2, 4] == 0.376 / 0.392 and table[2, 2] == 0.112 / 0.392
    assert table[2, 3] == 0.013 / 0.392 and table[2, 3] != roles.NON_LISTED_FACTOR


def test_the_denominator_is_the_largest_share_not_the_first_listed_position():
    table = roles.position_factor_table(9, I2A, role_percentages=PRIOR, meta=META)
    assert table[3].tolist() == table[2].tolist()          # the reordering changes no weight
    assert table[3, 0] == 1.0 and table[3, 4] < 1.0 and table[3].max() == 1.0


def test_a_legacy_listed_key_map_reads_zero_for_its_absent_roles():
    """The engine's frozen 2026-09-05 table shape (judge I2): absent → 0 → ε / max."""
    table = roles.position_factor_table(9, I2A, role_percentages=PRIOR, meta=META)
    assert table[4].tolist() == ratio([0.0, 0.38, 0.448, 0.0, 0.0])
    assert table[4, 0] == roles.SHARE_EPSILON / 0.448


def test_no_shares_or_all_zero_shares_read_the_category_factors():
    """A hand row and the all-zero row the loaders refuse: role_solver.rs's own fallback."""
    table = roles.position_factor_table(9, I2A, role_percentages=PRIOR, meta=META)
    assert table[5].tolist() == [0.4, 0.01, 1.0, 0.01, 0.01]
    assert table[6].tolist() == [0.01, 0.01, 1.0, 0.01, 0.01]


def test_a_champion_the_meta_lacks_is_the_ratio_over_its_synthesised_corpus_shares():
    """solver_roles_test.rs synthesise_from carries the raw corpus shares into position_shares; the
    Python mirror reads the same values, so the solver parity holds for synthesised champions too."""
    table = roles.position_factor_table(9, I2A, role_percentages=PRIOR, meta=META)
    assert table[7].tolist() == ratio([0.0, 0.0, 0.05, 0.95, 0.0])
    assert np.all(table[8] == 1.0)                           # in neither table: no preference
    assert np.all(table[0] == 1.0) and np.all(table[1] == 1.0)


def test_legacy_position_factor_table_keeps_the_category_factors_for_the_training_path():
    """U1: train.py (through factor_table_from_prior) and test_augment.py read 1.0 / 0.4 / 0.01 over
    the listed positions whatever the shares say — the NN augmentation recipe is unchanged."""
    table = roles.legacy_position_factor_table(9, I2A, role_percentages=PRIOR, meta=META)
    assert table[2].tolist() == [1.0, 0.01, 0.01, 0.01, 0.4]
    assert table[3].tolist() == [0.4, 0.01, 0.01, 0.01, 1.0]   # positions[0] IS the category here
    assert table[4].tolist() == [0.01, 0.4, 1.0, 0.01, 0.01]
    assert table[5].tolist() == [0.4, 0.01, 1.0, 0.01, 0.01]
    assert table[7].tolist() == [0.01, 0.01, 0.01, 1.0, 0.01]  # synthesised positions at ≥ 0.10: BOTTOM alone
    assert np.all(table[8] == 1.0)


def test_the_two_tables_give_the_same_posterior_only_where_every_share_is_a_category():
    """D8: a champion's denominator cancels in the solver, so raw shares and ratios agree; the
    categories do not — Pantheon's support placements carry 0.959 of his top placements' mass
    under the ratio and 0.4 under the categories."""
    ratio_table = roles.position_factor_table(9, I2A, role_percentages=PRIOR, meta=META)
    legacy = roles.legacy_position_factor_table(9, I2A, role_percentages=PRIOR, meta=META)
    post_r = roles.team_posterior(ratio_table[[2, 7]])      # Pantheon + the marksman
    post_l = roles.team_posterior(legacy[[2, 7]])
    assert post_r[0, 4] / post_r[0, 0] > 0.9
    assert post_l[0, 4] / post_l[0, 0] < 0.5
