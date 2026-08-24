"""Serve-realistic model inputs: the role solver's output instead of Riot's truth.

Gate 4 scores the model the way Phase 3 would actually call it. That means two
things happen at once, and both come from Task 2b's one `solve` call:

* the max-weight assignment decides WHICH SLOT each champion occupies - the
  solver gets this wrong for 27% of teams, so the champions themselves move;
* the marginal posterior becomes that slot's `role_probs`.

Two arms. `argmax` re-places the champions and passes one-hot roles; `posterior`
re-places them and passes the distribution. The posterior arm is the gated one -
it is the path the soft role input exists for.
"""

import numpy as np

from common import POSITIONS

ROLE_ORDER = ["TOP", "JUNGLE", "MIDDLE", "ADC", "SUPPORT"]
ROLE_INDEX = {r: i for i, r in enumerate(ROLE_ORDER)}
PCOLS = ["p_top", "p_jungle", "p_middle", "p_adc", "p_support"]


def build(ds, solver_roles, index_to_alias, state_kind="full", arm="posterior"):
    """-> (champ (n,10) int64, role_probs (n,10,5) float32) in dataset row order.

    Champions the solver has no row for keep their Riot slot and a one-hot role;
    that only happens if solver_roles.csv is stale relative to dataset.parquet.
    """
    assert arm in ("argmax", "posterior")
    sr = solver_roles[solver_roles.state_kind == state_kind]
    key = {}
    for row in sr.itertuples():
        key[(row.match_id, row.side, row.champion)] = (
            ROLE_INDEX[row.argmax_role],
            np.array([getattr(row, c) for c in PCOLS], dtype=np.float32),
        )

    n = len(ds)
    champ_out = np.zeros((n, 10), dtype=np.int64)
    role_out = np.zeros((n, 10, 5), dtype=np.float32)
    champ_in = np.stack([ds[f"champ_{i}"].to_numpy() for i in range(10)], axis=1)
    match_ids = ds.match_id.to_numpy()

    missing = 0
    for i in range(n):
        for side, base in (("blue", 0), ("red", 5)):
            taken = np.zeros(5, dtype=bool)
            placed = []
            for k in range(5):
                c = champ_in[i, base + k]
                hit = key.get((match_ids[i], side, index_to_alias.get(int(c))))
                if hit is None:
                    missing += 1
                    placed.append((k, c, np.eye(5, dtype=np.float32)[k]))
                    continue
                slot, post = hit
                placed.append((slot, c, post))
            # The argmax assignment is a bijection, so slots collide only when a
            # row is missing; break any collision by first-come, first-served.
            for slot, c, post in placed:
                s = slot if not taken[slot] else int(np.flatnonzero(~taken)[0])
                taken[s] = True
                champ_out[i, base + s] = c
                role_out[i, base + s] = (
                    post if arm == "posterior" else np.eye(5, dtype=np.float32)[s]
                )
    if missing:
        print(f"  serve.build: {missing} champion rows absent from solver_roles.csv "
              "(kept their Riot slot) — regenerate Task 2b if this is not 0")
    return champ_out, role_out


def riot_inputs(ds):
    """The training-time inputs: Riot's own placement, one-hot roles."""
    champ = np.stack([ds[f"champ_{i}"].to_numpy() for i in range(10)], axis=1)
    role = np.zeros((len(ds), 10, 5), dtype=np.float32)
    eye = np.eye(5, dtype=np.float32)
    role[:, :5] = eye
    role[:, 5:] = eye
    return champ, role
