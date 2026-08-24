"""Role posteriors in Python, matching engine-core's `role_solver::solve`.

The augmentation in section B3 needs the solver's posterior for a *transposed*
placement, which is drawn fresh every batch — so it cannot be precomputed the
way Task 2b precomputes val/test. It can be computed exactly instead: a team is
at most 5 champions, `solve` enumerates the 120 orderings and scores each by the
product of per-slot position factors, so the marginal posterior is a small
permanent-like sum that vectorises.

test_roles.py asserts this agrees with the Rust solver's own output on real
states, so the two implementations cannot drift.
"""

import itertools
import json

import numpy as np

from common import META_POS, POSITIONS, ROOT, load_champion_meta, load_id_to_alias

# role_solver.rs:57-59
PRIMARY_FACTOR = 1.0
SECONDARY_FACTOR = 0.4
NON_LISTED_FACTOR = 0.01
# solver_roles_test.rs
SYNTH_ROLE_THRESHOLD = 0.15

# engine Role order, which is also the canonical slot order.
ROLE_NAMES = ["TOP", "JUNGLE", "MIDDLE", "ADC", "SUPPORT"]
# champion-meta.json spells the ADC role "BOTTOM" (Riot's lane name).
META_ROLE_NAMES = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "SUPPORT"]
_PERMS = np.array(list(itertools.permutations(range(5))), dtype=np.int64)  # (120,5)


def synthesised_positions(entry):
    """Mirror of solver_roles_test.rs::synthesise_missing_meta."""
    shares = entry["meta_roles"]
    ranked = [(r, shares.get(r, 0.0)) for r in META_ROLE_NAMES if shares.get(r, 0.0) >= SYNTH_ROLE_THRESHOLD]
    ranked.sort(key=lambda kv: -kv[1])
    if not ranked:
        best = max(META_ROLE_NAMES, key=lambda r: shares.get(r, 0.0))
        ranked = [(best, 0.0)]
    return [r for r, _ in ranked]


def position_factor_table(vocab_size, index_to_alias, role_percentages=None):
    """(vocab_size, 5) of position factors. Rows 0 (UNKNOWN) and 1 (NONE) are
    left uniform-1: an absent champion expresses no role preference, so the
    team-level residual convention (section B3) decides its slot."""
    meta = load_champion_meta()
    if role_percentages is None:
        with open(ROOT / "data/training/role_percentages.json", encoding="utf-8") as fh:
            role_percentages = json.load(fh)
    by_alias = {v["alias"]: v for v in role_percentages.values()}

    table = np.full((vocab_size, 5), NON_LISTED_FACTOR, dtype=np.float64)
    table[0] = 1.0
    table[1] = 1.0
    for idx, alias in index_to_alias.items():
        entry = meta.get(alias)
        positions = entry["positions"] if entry else synthesised_positions(by_alias[alias])
        for r, name in enumerate(META_ROLE_NAMES):
            if positions and positions[0] == name:
                table[idx, r] = PRIMARY_FACTOR
            elif name in positions:
                table[idx, r] = SECONDARY_FACTOR
    return table


def team_posterior(factors):
    """factors: (..., n, 5) -> (..., n, 5) marginal posterior over roles.

    Enumerates the ordered n-of-5 role selections exactly as `solve` does and
    sums the normalised weights per (champion, role).
    """
    factors = np.asarray(factors, dtype=np.float64)
    n = factors.shape[-2]
    assert 1 <= n <= 5
    perms = np.unique(_PERMS[:, :n], axis=0)                    # (P, n)
    lead = factors.shape[:-2]
    f = factors.reshape(-1, n, 5)                                # (B, n, 5)
    # weight of each permutation = product over champions of factor[champ, role]
    w = np.take_along_axis(
        f[:, None, :, :], perms[None, :, :, None], axis=3
    ).squeeze(-1).prod(axis=2)                                   # (B, P)
    total = w.sum(axis=1, keepdims=True)
    w = np.divide(w, total, out=np.zeros_like(w), where=total > 0)
    out = np.zeros((f.shape[0], n, 5), dtype=np.float64)
    for c in range(n):
        np.add.at(out[:, c, :].T, perms[:, c], w.T)
    return out.reshape(*lead, n, 5)


def team_argmax(factors):
    """Index of the max-weight permutation's role per champion.
    Ties resolve to the FIRST enumerated permutation, matching `solve`."""
    factors = np.asarray(factors, dtype=np.float64)
    n = factors.shape[-2]
    perms = np.unique(_PERMS[:, :n], axis=0)
    f = factors.reshape(-1, n, 5)
    w = np.take_along_axis(
        f[:, None, :, :], perms[None, :, :, None], axis=3
    ).squeeze(-1).prod(axis=2)
    best = w.argmax(axis=1)          # argmax returns the FIRST maximum
    return perms[best].reshape(*factors.shape[:-2], n)


def empty_slot_role_probs(filled_probs):
    """Section B3's empty-slot convention, per team.

    filled_probs: (5,5) with zero rows for empty slots.
    Each empty slot gets normalize(max(0, 1 - sum of filled mass per role)),
    which is uniform over the team's unfilled roles when the filled slots are
    one-hot, and the normalised residual when they are soft.
    """
    filled_probs = np.asarray(filled_probs, dtype=np.float64)
    occupied = filled_probs.sum(axis=0)
    residual = np.maximum(0.0, 1.0 - occupied)
    s = residual.sum()
    if s <= 0:
        residual = np.ones(5)
        s = 5.0
    return residual / s
