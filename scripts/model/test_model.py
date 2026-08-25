"""Probe (a) and the architecture invariants.

Under the antisymmetric trunk,
    logit p(A blue, B red) + logit p(B blue, A red) == 2 * b_region
exactly, for ANY h. That makes it a unit test rather than a diagnostic.

The probe must include rows with asymmetric role_probs and asymmetric ban
counts: on ordinary full-draft rows both teams' role_probs blocks are the
identity, so a forgotten role_probs swap would sail through a symmetric-row
probe.
"""

import pytest
import torch

from model import DraftModel

VOCAB, N_PATCH, N_REGION = 175, 2, 3


def make(width=256, dropout=0.2, seed=0):
    torch.manual_seed(seed)
    m = DraftModel(VOCAB, N_PATCH, N_REGION, width=width, dropout=dropout)
    # Random non-trivial weights: a freshly zeroed head would pass anything.
    with torch.no_grad():
        for p in m.parameters():
            if p.ndim >= 1:
                p.normal_(0, 0.3)
        m.champ_emb.weight[0].zero_()
        m.ban_emb.weight[0].zero_()
        m.ban_emb.weight[1].zero_()
    return m


def batch(n=64, seed=1, symmetric_roles=True, symmetric_bans=True):
    g = torch.Generator().manual_seed(seed)
    champ = torch.randint(2, VOCAB, (n, 10), generator=g)
    role = torch.zeros(n, 10, 5)
    for s in range(10):
        role[:, s, s % 5] = 1.0
    if not symmetric_roles:
        # Blue stays one-hot; red is smoothed toward a population prior. This is
        # the row shape that catches a forgotten role_probs swap.
        prior = torch.rand(n, 5, 5, generator=g)
        prior = prior / prior.sum(-1, keepdim=True)
        lam = 0.6
        role[:, 5:] = (1 - lam) * role[:, 5:] + lam * prior
    bans = torch.randint(2, VOCAB, (n, 10), generator=g)
    if not symmetric_bans:
        bans[:, 3:5] = 1      # blue forfeited 2 bans; red kept all 5
    patch = torch.randint(0, N_PATCH, (n,), generator=g)
    region = torch.randint(0, N_REGION, (n,), generator=g)
    return champ, role, bans, patch, region


def swap(champ, role, bans):
    return (
        torch.cat([champ[:, 5:], champ[:, :5]], 1),
        torch.cat([role[:, 5:], role[:, :5]], 1),
        torch.cat([bans[:, 5:], bans[:, :5]], 1),
    )


@pytest.mark.parametrize(
    "sym_roles,sym_bans",
    [(True, True), (False, True), (True, False), (False, False)],
    ids=["plain", "asym-roles", "asym-bans", "asym-both"],
)
def test_probe_a_symmetry_is_exact(sym_roles, sym_bans):
    m = make().eval()
    champ, role, bans, patch, region = batch(
        symmetric_roles=sym_roles, symmetric_bans=sym_bans
    )
    with torch.no_grad():
        f = m(champ, role, bans, patch, region)["win_logit"]
        b = m(*swap(champ, role, bans), patch, region)["win_logit"]
    c = f + b
    expected = 2 * m.region_bias[region]
    assert torch.allclose(c, expected, atol=1e-4), (c - expected).abs().max()


def test_probe_a_holds_in_train_mode_via_the_shared_dropout_mask():
    """Antisymmetry must survive dropout, or half of training pushes against it."""
    m = make()
    m.train()
    champ, role, bans, patch, region = batch(symmetric_roles=False, symmetric_bans=False)
    torch.manual_seed(99)
    f = m(champ, role, bans, patch, region)["win_logit"]
    torch.manual_seed(99)
    b = m(*swap(champ, role, bans), patch, region)["win_logit"]
    assert torch.allclose(f + b, 2 * m.region_bias[region], atol=1e-4)


def test_role_probs_actually_change_the_prediction():
    """If the role input were ignored, probe (a) would still pass and gate 4
    would be measuring nothing."""
    m = make().eval()
    champ, role, bans, patch, region = batch()
    flat = torch.full_like(role, 0.2)
    with torch.no_grad():
        a = m(champ, role, bans, patch, region)["win_logit"]
        b = m(champ, flat, bans, patch, region)["win_logit"]
    assert (a - b).abs().mean() > 1e-3


def test_bans_use_a_masked_mean_not_a_sum():
    """With a sum, forfeiting bans would change the magnitude of the ban term
    and the model would read 'number of empty slots' as signal."""
    m = make().eval()
    champ, role, bans, patch, region = batch()
    bans_all_same = bans.clone()
    bans_all_same[:, :5] = bans[:, 0:1]                 # blue: 5 copies of one champion
    fewer = bans_all_same.clone()
    fewer[:, 2:5] = 1                                   # same champion, 2 slots instead of 5
    with torch.no_grad():
        a = m(champ, role, bans_all_same, patch, region)["win_logit"]
        b = m(champ, role, fewer, patch, region)["win_logit"]
    assert torch.allclose(a, b, atol=1e-5), "the ban term is sensitive to slot COUNT"


def test_unknown_champion_contributes_nothing_of_its_own():
    m = make().eval()
    champ, role, bans, patch, region = batch()
    assert torch.allclose(m.champ_emb.weight[0], torch.zeros(32))
    assert torch.allclose(m.ban_emb.weight[1], torch.zeros(8))


def test_duration_head_is_symmetric_and_win_head_is_not():
    """Duration reads S, so it must be INVARIANT under a side swap; the win head
    reads A, so it must flip."""
    m = make().eval()
    champ, role, bans, patch, region = batch(symmetric_roles=False)
    with torch.no_grad():
        f = m(champ, role, bans, patch, region)
        b = m(*swap(champ, role, bans), patch, region)
    assert torch.allclose(f["log_duration"], b["log_duration"], atol=1e-4)
    assert torch.allclose(f["gold_diff15"], -b["gold_diff15"], atol=1e-4)
    assert not torch.allclose(f["win_logit"], b["win_logit"], atol=1e-2)


def test_no_layernorm_on_the_final_trunk_layer():
    m = make()
    assert isinstance(m.norms[-1], torch.nn.Identity)
    assert all(isinstance(n, torch.nn.LayerNorm) for n in m.norms[:-1])


def test_parameter_groups_exclude_norms_and_biases_from_decay():
    m = make()
    groups = m.parameter_groups(weight_decay=0.05, champion_decay=0.2)
    assert [g["weight_decay"] for g in groups] == [0.05, 0.2, 0.0]
    assert sum(len(g["params"]) for g in groups) == len(list(m.parameters()))
    decayed = {id(p) for p in groups[0]["params"]}
    for name, p in m.named_parameters():
        if p.ndim == 1:
            assert id(p) not in decayed, f"{name} is 1-d and must not be decayed"


def test_parameter_count_is_about_140k_with_90k_in_the_first_layer():
    m = DraftModel(VOCAB, N_PATCH, N_REGION, width=256)
    assert 130_000 < m.n_parameters() < 150_000
    assert m.layers[0].weight.numel() > 85_000


def test_diagnostics_report_the_antisymmetry_ratio():
    m = make().eval()
    champ, role, bans, patch, region = batch()
    with torch.no_grad():
        out = m(champ, role, bans, patch, region, diagnostics=True)
    assert "cos_h" in out and "a_over_s" in out
    assert torch.isfinite(out["cos_h"]) and torch.isfinite(out["a_over_s"])


def test_region_minus_one_averages_the_side_bias():
    m = make()
    m.eval()
    champ, role, bans, patch, _region = batch(8)
    with torch.no_grad():
        m.region_bias.copy_(torch.tensor([0.1, -0.3, 0.5]))
        r0 = m(champ, role, bans, patch, torch.zeros(8, dtype=torch.long))["win_logit"]
        r_avg = m(champ, role, bans, patch, torch.full((8,), -1, dtype=torch.long))["win_logit"]
    expected = r0 - 0.1 + torch.tensor([0.1, -0.3, 0.5]).mean()
    assert torch.allclose(r_avg, expected, atol=1e-6)
