"""Feature construction shared by the baselines (Task 2), the masked refits
(gate 3) and the serve-realistic arms (gate 4).

Everything is mask-aware from the start. Gate 3 requires the linear baselines
to be REFIT on the masking distribution rather than fitted on full drafts and
scored with zeros, and that is only honest if the same builder produces both.
"""

import numpy as np
from scipy import sparse

N_SLOTS = 10
N_ROLES = 5


def _visible(mask, n, width=N_SLOTS):
    if mask is None:
        return np.ones((n, width), dtype=bool)
    m = np.asarray(mask, dtype=bool)
    assert m.shape == (n, width), f"mask shape {m.shape} != {(n, width)}"
    return m


def champion_role_side(champ, vocab_size, visible_picks=None):
    """One-hot over (slot, champion). The slot index IS (side, role), so this is
    champion x role x side with no further encoding."""
    n = len(champ)
    vis = _visible(visible_picks, n)
    rows, cols = np.nonzero(vis)
    data = np.ones(len(rows), dtype=np.float32)
    idx = cols * vocab_size + champ[rows, cols]
    return sparse.csr_matrix((data, (rows, idx)), shape=(n, N_SLOTS * vocab_size))


def champion_role_antisymmetric(champ, vocab_size, visible_picks=None):
    """One-hot over (role, champion) with +1 on blue and -1 on red.

    This is the antisymmetric CONSTRAINT the model's trunk asserts, expressed in
    a linear model: blue-TOP-Ahri and red-TOP-Ahri share one weight with
    opposite signs. Fitting both this and the side-specific version at the same
    C measures whether the constraint costs anything, instead of assuming it.
    """
    n = len(champ)
    vis = _visible(visible_picks, n)
    rows, cols = np.nonzero(vis)
    sign = np.where(cols < 5, 1.0, -1.0).astype(np.float32)
    idx = (cols % N_ROLES) * vocab_size + champ[rows, cols]
    return sparse.csr_matrix((sign, (rows, idx)), shape=(n, N_ROLES * vocab_size))


def bans_side_specific(bans, vocab_size, visible_bans=None):
    n = len(bans)
    vis = _visible(visible_bans, n)
    rows, cols = np.nonzero(vis)
    data = np.ones(len(rows), dtype=np.float32)
    idx = (cols // 5) * vocab_size + bans[rows, cols]
    return sparse.csr_matrix((data, (rows, idx)), shape=(n, 2 * vocab_size))


def bans_antisymmetric(bans, vocab_size, visible_bans=None):
    n = len(bans)
    vis = _visible(visible_bans, n)
    rows, cols = np.nonzero(vis)
    sign = np.where(cols < 5, 1.0, -1.0).astype(np.float32)
    return sparse.csr_matrix((sign, (rows, bans[rows, cols])), shape=(n, vocab_size))


def one_hot(values, width):
    n = len(values)
    return sparse.csr_matrix(
        (np.ones(n, dtype=np.float32), (np.arange(n), np.asarray(values, dtype=int))),
        shape=(n, width),
    )


def build(df, vocab_size, n_patches, n_regions, antisymmetric=False,
          visible_picks=None, visible_bans=None):
    """The full design matrix: picks + bans + patch + region.

    Patch and region stay plain one-hots in both variants. Region is what
    carries the per-region side prior (blue win rate differs ~2 pp across
    regions), and a side prior is not antisymmetric — it is the intercept the
    antisymmetry is measured against.
    """
    champ = np.stack([df[f"champ_{i}"].to_numpy() for i in range(N_SLOTS)], axis=1)
    bans = np.stack([df[f"ban_{i}"].to_numpy() for i in range(N_SLOTS)], axis=1)
    if antisymmetric:
        picks_x = champion_role_antisymmetric(champ, vocab_size, visible_picks)
        bans_x = bans_antisymmetric(bans, vocab_size, visible_bans)
    else:
        picks_x = champion_role_side(champ, vocab_size, visible_picks)
        bans_x = bans_side_specific(bans, vocab_size, visible_bans)
    return sparse.hstack(
        [
            picks_x,
            bans_x,
            one_hot(df.patch_idx.to_numpy(), n_patches),
            one_hot(df.region_idx.to_numpy(), n_regions),
        ],
        format="csr",
    )


def champ_matrix(df):
    return np.stack([df[f"champ_{i}"].to_numpy() for i in range(N_SLOTS)], axis=1)


def ban_matrix(df):
    return np.stack([df[f"ban_{i}"].to_numpy() for i in range(N_SLOTS)], axis=1)


def masks_from_masked_states(ms, order):
    """(visible_picks, visible_bans) aligned to `order` (a match_id sequence)."""
    ms = ms.set_index("match_id")
    vp = np.stack([np.asarray(ms.loc[m].visible_picks, dtype=bool) for m in order])
    vb = np.stack([np.asarray(ms.loc[m].visible_bans, dtype=bool) for m in order])
    return vp, vb
