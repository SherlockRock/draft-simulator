"""NumPy serving reimplementation of the shipped FM — design §1(b), §2, §3.

Deliberately NOT `fm.forward()`: serving replaces the slot-role linear with the
export-baked `linear_expected` and has no slot concept (champion lists per side).
`slot_role_logit` is the algebra bridge back to `forward()` for the §1(a) test.
"""
import numpy as np

ROLE_ORDER = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"]   # linear-vector order
RANK = 16


class ServingTable:
    """Alias-keyed rows read from a WRITTEN artifact (rounded weights)."""

    def __init__(self, artifact):
        champs = artifact["champions"]
        self.aliases = sorted(champs)
        self.index = {a: i for i, a in enumerate(self.aliases)}
        self.linear_expected = np.array([champs[a]["linear_expected"] for a in self.aliases], float)
        self.synergy = np.array([champs[a]["synergy"] for a in self.aliases], float)
        self.counter_a = np.array([champs[a]["counter_a"] for a in self.aliases], float)
        self.counter_b = np.array([champs[a]["counter_b"] for a in self.aliases], float)
        self.scale = float(artifact["scale"])
        assert self.synergy.shape[1] == RANK


def side_sums(table, aliases):
    """(S, A, B) over the aliases present in the table; absent ones contribute
    nothing (training's UNKNOWN padding row is all zeros)."""
    idx = [table.index[a] for a in aliases if a in table.index]
    if not idx:
        z = np.zeros(RANK)
        return z, z.copy(), z.copy()
    return table.synergy[idx].sum(0), table.counter_a[idx].sum(0), table.counter_b[idx].sum(0)


def _terms(table, c, team, opp):
    i = table.index[c]
    S, _, _ = side_sums(table, team)
    _, A_opp, B_opp = side_sums(table, opp)
    syn = float(table.synergy[i] @ S)
    if c in team:
        syn -= float(table.synergy[i] @ table.synergy[i])
    ctr = float(table.counter_a[i] @ B_opp - table.counter_b[i] @ A_opp)
    return float(table.linear_expected[i]), syn, ctr


def marginal(table, c, team, opp):
    lin, syn, ctr = _terms(table, c, team, opp)
    return lin + syn + ctr


def allocation(table, c, team, opp):
    lin, syn, ctr = _terms(table, c, team, opp)
    return lin + 0.5 * syn + 0.5 * ctr


def structural_logit(table, blue, red):
    return (sum(allocation(table, c, blue, red) for c in blue if c in table.index)
            - sum(allocation(table, c, red, blue) for c in red if c in table.index))


def slot_role_logit(W_lin, S, A, B, champ):
    """Blue − red allocation sums with the SLOT-role linear (slot i → role i % 5).
    Equals AntisymmetricFM.forward() minus region_bias for any visibility pattern
    (index 0 = masked)."""
    champ = np.asarray(champ)
    vis = (champ != 0).astype(float)
    role = np.arange(10) % 5
    lin = W_lin[champ, role] * vis
    s = S[champ] * vis[:, None]
    a = A[champ] * vis[:, None]
    b = B[champ] * vis[:, None]
    blue, red = slice(0, 5), slice(5, 10)

    def side_alloc(me, other):
        S_me = s[me].sum(0)
        A_ot, B_ot = a[other].sum(0), b[other].sum(0)
        syn = s[me] @ S_me - (s[me] * s[me]).sum(1)          # ⟨s_c, S − s_c⟩
        ctr = a[me] @ B_ot - b[me] @ A_ot
        return lin[me] + 0.5 * syn + 0.5 * ctr

    return float(side_alloc(blue, red).sum() - side_alloc(red, blue).sum())


def within_set_sd(values):
    return float(np.std(np.asarray(values, float), ddof=0))


def scale_statistic(legacy_sds, fm_sds):
    """design §3: mean within-set sd (legacy) / mean within-set sd (FM), identical sets."""
    return float(np.mean(legacy_sds) / np.mean(fm_sds))
