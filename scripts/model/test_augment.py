"""Masking and augmentation invariants.

The augmentations exist to make the training distribution match what the engine
will actually hand the model. If they can produce a state the solver could never
emit, they are training the model on fiction.
"""

import json

import numpy as np
import pytest

from augment import Augmenter, Masker, load_depth_distribution, PREFIX_SHARE
from common import POSITIONS, ROOT
from mask_table import TOTAL_TURNS, TURN_SEQUENCE, pattern_at
from roles import position_factor_table

TRAIN = ROOT / "data/training"
pytestmark = pytest.mark.skipif(
    not (TRAIN / "champion_vocab.json").exists(), reason="run prepare.py first"
)


@pytest.fixture(scope="module")
def bits():
    vocab = json.loads((TRAIN / "champion_vocab.json").read_text())
    i2a = {int(k): v for k, v in vocab["index_to_alias"].items()}
    n = len(i2a) + 2
    rp = json.loads((TRAIN / "role_percentages.json").read_text())
    prior = np.full((n, 5), 0.2, dtype=np.float32)
    for riot_id, e in rp.items():
        prior[vocab["riot_id_to_index"][riot_id]] = [e["roles"][p] for p in POSITIONS]
    return n, position_factor_table(n, i2a, rp), prior


def test_masker_uses_the_measured_depth_distribution():
    from pathlib import Path
    d, src = load_depth_distribution(Path(__file__).resolve().parent / "leaf_eval_stats.json")
    assert src == "measured", "Task 1b-b's measurement is not being used"
    assert abs(sum(d.values()) - 1.0) < 1e-9


def test_prefix_masks_are_reachable_draft_states():
    """The point of the prefix branch. Every (picks, bans) combination it emits
    must correspond to some real turn index — no 'all 10 bans with 1 pick'."""
    d, _ = load_depth_distribution(__import__("pathlib").Path(__file__).resolve().parent
                                   / "leaf_eval_stats.json")
    m = Masker(d, seed=3)
    vp, vb = m.draw(40000)
    reachable = {
        (pattern_at(t)["blue_picks"], pattern_at(t)["red_picks"],
         pattern_at(t)["blue_bans"], pattern_at(t)["red_bans"])
        for t in range(TOTAL_TURNS + 1)
    }
    combos = set(
        zip(vp[:, :5].sum(1), vp[:, 5:].sum(1), vb[:, :5].sum(1), vb[:, 5:].sum(1))
    )
    unreachable = combos - reachable
    # The strategic branch is deliberately free, so some combos are unreachable;
    # they must be a minority consistent with its 30% share.
    frac = np.mean([
        (b, r, bb, rb) not in reachable
        for b, r, bb, rb in zip(vp[:, :5].sum(1), vp[:, 5:].sum(1),
                                vb[:, :5].sum(1), vb[:, 5:].sum(1))
    ])
    assert frac < (1 - PREFIX_SHARE) + 0.05, (
        f"{frac:.1%} of masks are unreachable — the prefix branch is leaking"
    )


def test_bans_never_run_ahead_of_picks_in_the_prefix_branch():
    d, _ = load_depth_distribution(__import__("pathlib").Path(__file__).resolve().parent
                                   / "leaf_eval_stats.json")
    m = Masker(d, seed=5)
    vp, vb = m.draw(40000)
    full_bans = (vb.sum(1) == 10)
    # Reachable states with all 10 bans have >= 3 picks per side (ban phase 2 is
    # TURN_SEQUENCE[12..16], after Pick1). The strategic branch may violate it;
    # it must not be the common case.
    ok = (vp[full_bans, :5].sum(1) >= 3) & (vp[full_bans, 5:].sum(1) >= 3)
    assert ok.mean() > 0.6, f"only {ok.mean():.1%} of full-ban states are reachable"


def test_augmenter_preserves_each_team_as_a_multiset(bits):
    n_champ, factors, prior = bits
    rng = np.random.default_rng(0)
    champ = rng.integers(2, n_champ, size=(500, 10))
    vis = np.ones((500, 10), dtype=bool)
    aug = Augmenter(factors, prior, p=0.5, p_swap=1.0, seed=1)
    out, role = aug.apply(champ, vis)
    for i in range(500):
        assert sorted(out[i, :5]) == sorted(champ[i, :5]), "blue lost or gained a champion"
        assert sorted(out[i, 5:]) == sorted(champ[i, 5:]), "red lost or gained a champion"


def test_transposition_actually_moves_champions(bits):
    n_champ, factors, prior = bits
    rng = np.random.default_rng(0)
    champ = rng.integers(2, n_champ, size=(2000, 10))
    vis = np.ones((2000, 10), dtype=bool)
    none = Augmenter(factors, prior, p=0.0, p_swap=0.0, seed=1).apply(champ, vis)[0]
    swapped = Augmenter(factors, prior, p=0.0, p_swap=1.0, seed=1).apply(champ, vis)[0]
    assert (none == champ).all(), "p_swap=0 must be a no-op on champions"
    moved = (swapped != champ).any(axis=1).mean()
    assert moved > 0.9, f"only {moved:.1%} of rows were transposed at p_swap=1"


def test_role_probs_always_form_distributions(bits):
    n_champ, factors, prior = bits
    rng = np.random.default_rng(2)
    for p, p_swap in ((0.0, 0.0), (0.5, 0.1), (0.75, 0.25), (1.0, 1.0)):
        champ = rng.integers(2, n_champ, size=(400, 10))
        vis = rng.random((400, 10)) < 0.6
        _, role = Augmenter(factors, prior, p=p, p_swap=p_swap, seed=3).apply(champ, vis)
        np.testing.assert_allclose(role.sum(axis=2), 1.0, atol=1e-5)
        assert (role >= -1e-6).all()


def test_role_noise_never_creates_duplicate_or_missing_roles(bits):
    """A per-slot RE-SLOT could put two champions in TOP and leave JUNGLE empty -
    a state the bijective solver can never emit. A SMOOTHING cannot: every slot
    keeps a full distribution and no role is starved to zero across the team."""
    n_champ, factors, prior = bits
    rng = np.random.default_rng(4)
    champ = rng.integers(2, n_champ, size=(300, 10))
    vis = np.ones((300, 10), dtype=bool)
    _, role = Augmenter(factors, prior, p=1.0, p_swap=0.0, seed=5).apply(champ, vis)
    np.testing.assert_allclose(role.sum(axis=2), 1.0, atol=1e-5)
    for side in (slice(0, 5), slice(5, 10)):
        col = role[:, side].sum(axis=1)
        assert (col > 0).all(), "a role was starved to zero mass across the team"


def test_role_noise_does_not_preserve_column_sums_but_the_posterior_does(bits):
    """Recorded because it is a real difference between the augmented inputs and
    the serve-time inputs.

    The solver posterior is a marginal over BIJECTIVE assignments, so its
    columns sum to exactly 1 - each role is filled exactly once. Role noise
    smooths each slot independently toward that champion's population prior,
    which is not bijective, so its columns drift (three mid-laners on one team
    pile mass onto MIDDLE). That is intended: the population prior is one of the
    role inputs the contract explicitly accepts, so the model has to tolerate
    non-bijective role_probs. It does mean the augmented distribution is WIDER
    than the serve distribution, not a subset of it.
    """
    n_champ, factors, prior = bits
    rng = np.random.default_rng(9)
    champ = rng.integers(2, n_champ, size=(300, 10))
    vis = np.ones((300, 10), dtype=bool)

    _, noisy = Augmenter(factors, prior, p=1.0, p_swap=0.0, seed=5).apply(champ, vis)
    noisy_cols = noisy[:, :5].sum(axis=1)
    assert np.abs(noisy_cols - 1.0).max() > 0.2, "role noise unexpectedly bijective"

    # The transposition augmentation, by contrast, uses the solver posterior and
    # therefore DOES preserve the bijection.
    _, swapped = Augmenter(factors, prior, p=0.0, p_swap=1.0, seed=5).apply(champ, vis)
    np.testing.assert_allclose(swapped[:, :5].sum(axis=1), 1.0, atol=1e-5)
    np.testing.assert_allclose(swapped[:, 5:].sum(axis=1), 1.0, atol=1e-5)


def test_masked_slots_become_unknown_with_residual_roles(bits):
    n_champ, factors, prior = bits
    rng = np.random.default_rng(6)
    champ = rng.integers(2, n_champ, size=(300, 10))
    vis = np.zeros((300, 10), dtype=bool)
    vis[:, [0, 1, 5, 6]] = True            # 2 revealed per side
    out, role = Augmenter(factors, prior, p=0.0, p_swap=0.0, seed=7).apply(champ, vis)
    assert (out[~vis] == 0).all(), "a masked slot kept its champion"
    assert (out[vis] != 0).all(), "a visible slot was blanked"
    # Empty slots share the residual: uniform over the team's unfilled roles
    # when the filled ones are one-hot.
    expected = np.array([0, 0, 1 / 3, 1 / 3, 1 / 3], dtype=np.float32)
    for i in range(20):
        for slot in (2, 3, 4):          # the three hidden blue slots
            np.testing.assert_allclose(role[i, slot], expected, atol=1e-6)


def test_augmentation_is_reproducible_from_its_seed(bits):
    n_champ, factors, prior = bits
    rng = np.random.default_rng(8)
    champ = rng.integers(2, n_champ, size=(200, 10))
    vis = rng.random((200, 10)) < 0.7
    a = Augmenter(factors, prior, p=0.5, p_swap=0.25, seed=11).apply(champ, vis)
    b = Augmenter(factors, prior, p=0.5, p_swap=0.25, seed=11).apply(champ, vis)
    np.testing.assert_array_equal(a[0], b[0])
    np.testing.assert_allclose(a[1], b[1])
