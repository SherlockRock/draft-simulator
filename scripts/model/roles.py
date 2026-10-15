"""Role posteriors in Python, matching engine-core's `role_solver::solve`.

The augmentation in section B3 needs the solver's posterior for a *transposed*
placement, which is drawn fresh every batch — so it cannot be precomputed the
way Task 2b precomputes val/test. It can be computed exactly instead: a team is
at most 5 champions, `solve` enumerates the 120 orderings and scores each by the
product of per-slot position factors, so the marginal posterior is a small
permanent-like sum that vectorises.

test_roles.py asserts this agrees with the Rust solver's own output on real
states, so the two implementations cannot drift.

Two factor tables (champion-role-shares design U1): `position_factor_table` is
the SOLVER-PARITY table — the share ratio the engine weights with since slice B,
`max(share, ε) / max(shares)` over the compiled 3-dp `positionShares` (the file
the engine reads, never the unrounded corpus) — for test_roles.py and
bucket_role_measure.py; `legacy_position_factor_table` keeps the 1.0 / 0.4 / 0.01
categories for the NN training path (`train.py` through `factor_table_from_prior`,
`test_augment.py`), whose transposition augmentation was swept and recorded under
them and is not re-evaluated here.
"""

import itertools
import json

import numpy as np

from common import META_POS, POSITIONS, ROOT, load_champion_meta, load_id_to_alias

# role_solver.rs: the category factors (a champion whose shares are unknown)
PRIMARY_FACTOR = 1.0
SECONDARY_FACTOR = 0.4
NON_LISTED_FACTOR = 0.01
# role_solver.rs SHARE_EPSILON: the floor under a share before the ratio
SHARE_EPSILON = 0.001
# solver_roles_test.rs; equal to POSITIONS_THRESHOLD in scripts/champion-positions/derive.mjs
SYNTH_ROLE_THRESHOLD = 0.10

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


def synthesised_shares(entry):
    """Mirror of solver_roles_test.rs::synthesise_from's five shares: the corpus
    `meta_roles` as they are (the Rust harness reads the same raw values), aligned
    with META_ROLE_NAMES; None when every share is 0."""
    shares = entry["meta_roles"]
    five = [float(shares.get(r, 0.0)) for r in META_ROLE_NAMES]
    return five if any(s > 0.0 for s in five) else None


def _category_row(positions):
    row = [NON_LISTED_FACTOR] * 5
    for r, name in enumerate(META_ROLE_NAMES):
        if positions and positions[0] == name:
            row[r] = PRIMARY_FACTOR
        elif name in positions:
            row[r] = SECONDARY_FACTOR
    return row


def _ratio_row(five):
    """role_solver.rs position_factor with the shares known: max(share, ε) / max,
    one max then one division, for every role."""
    top = max(five)
    return [max(s, SHARE_EPSILON) / top for s in five]


def _load_prior(role_percentages):
    if role_percentages is None:
        with open(ROOT / "data/training/role_percentages.json", encoding="utf-8") as fh:
            role_percentages = json.load(fh)
    return {v["alias"]: v for v in role_percentages.values()}


def legacy_position_factor_table(vocab_size, index_to_alias, role_percentages=None, meta=None):
    """(vocab_size, 5) of the CATEGORY factors 1.0 / 0.4 / 0.01 over the listed
    positions — what the engine weighted with before champion-role-shares slice B,
    frozen for the NN training path (design U1). Rows 0 (UNKNOWN) and 1 (NONE) are
    left uniform-1: an absent champion expresses no role preference, so the
    team-level residual convention (section B3) decides its slot."""
    meta = load_champion_meta() if meta is None else meta
    by_alias = _load_prior(role_percentages)
    table = np.full((vocab_size, 5), NON_LISTED_FACTOR, dtype=np.float64)
    table[0] = 1.0
    table[1] = 1.0
    for idx, alias in index_to_alias.items():
        entry = meta.get(alias)
        if entry:
            positions = entry["positions"]
        elif alias in by_alias:
            positions = synthesised_positions(by_alias[alias])
        else:
            # In the vocab (a ban, or a val/test-only pick) but in neither
            # champion-meta nor the train prior: no preference, like UNKNOWN.
            table[idx] = 1.0
            continue
        table[idx] = _category_row(positions)
    return table


def position_factor_table(vocab_size, index_to_alias, role_percentages=None, meta=None):
    """(vocab_size, 5) of the engine's factors since slice B: the share ratio
    `max(share, ε) / max(shares)` for every role, from the compiled 3-dp
    `positionShares` of champion-meta.json (five keys; a legacy listed-key map
    reads 0 for its absent roles); the category factors for an entry without
    shares (a hand row) — role_solver.rs's own fallback; for a champion the meta
    lacks, the ratio over the corpus shares the Rust harness synthesises from.
    Rows 0 (UNKNOWN) and 1 (NONE) and a champion in neither table are uniform-1,
    as in the legacy table."""
    meta = load_champion_meta() if meta is None else meta
    by_alias = _load_prior(role_percentages)
    table = np.full((vocab_size, 5), NON_LISTED_FACTOR, dtype=np.float64)
    table[0] = 1.0
    table[1] = 1.0
    for idx, alias in index_to_alias.items():
        entry = meta.get(alias)
        if entry:
            shares = entry.get("positionShares")
            five = [float(shares.get(r, 0.0)) for r in META_ROLE_NAMES] if shares else None
            if five is not None and max(five) > 0.0:
                table[idx] = _ratio_row(five)
            else:
                table[idx] = _category_row(entry["positions"])
        elif alias in by_alias:
            five = synthesised_shares(by_alias[alias])
            if five is not None:
                table[idx] = _ratio_row(five)
            else:
                table[idx] = _category_row(synthesised_positions(by_alias[alias]))
        else:
            table[idx] = 1.0
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


def prior_from_frame(df, n_champ):
    """(n_champ, 5) share of this frame's games each champion spent in each role;
    uniform 0.2 for a champion the frame never shows. Slot index IS the role.
    Built per training frame so a rolling-origin fold's augmentation prior never
    sees that fold's test window."""
    counts = np.zeros((n_champ, 5), dtype=np.float64)
    for slot in range(10):
        ids, n = np.unique(df[f"champ_{slot}"].to_numpy(), return_counts=True)
        counts[ids, slot % 5] += n
    counts[0] = 0.0
    counts[1] = 0.0
    total = counts.sum(axis=1, keepdims=True)
    return np.divide(counts, total, out=np.full_like(counts, 0.2), where=total > 0).astype(np.float32)


def factor_table_from_prior(prior, index_to_alias):
    """legacy_position_factor_table with the synthesised-meta source taken from a
    prior matrix instead of role_percentages.json — the NN training path's table
    (train.py), kept on the category factors (champion-role-shares U1)."""
    role_percentages = {
        str(idx): {"alias": alias,
                   "meta_roles": {n: float(prior[idx, r]) for r, n in enumerate(META_ROLE_NAMES)}}
        for idx, alias in index_to_alias.items()
        if not np.allclose(prior[idx], 0.2)
    }
    return legacy_position_factor_table(prior.shape[0], index_to_alias, role_percentages)
