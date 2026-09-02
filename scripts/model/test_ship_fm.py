"""Data-free tests for the FM ship path (design §5 'Python')."""
import json

import numpy as np
import pytest
import torch

import fm_export
import fm_serve
from fm import AntisymmetricFM

V, R = 12, 3          # tiny vocab (0 = UNKNOWN, 1 = NONE, 2.. real), 3 regions


def _model(seed=0):
    torch.manual_seed(seed)
    m = AntisymmetricFM(V, R)
    with torch.no_grad():
        for emb in (m.synergy, m.counter_a, m.counter_b, m.linear):
            emb.weight.normal_(0, 0.1)      # small enough that scale 0.7 × allocation stays clamp-free
            emb.weight[0].zero_()
        m.region_bias.normal_(0, 0.1)
    m.eval()
    return m


def _vocab():
    aliases = ["Annie", "Olaf", "Galio", "TwistedFate", "XinZhao", "Urgot",
               "Leblanc", "Vladimir", "FiddleSticks", "Kayle"]
    return {"index_to_alias": {str(i + 2): a for i, a in enumerate(aliases)}}


def _role_pct(vocab, skip=()):
    out = {}
    for k, alias in vocab["index_to_alias"].items():
        if alias in skip:
            continue
        p = np.random.default_rng(int(k)).dirichlet(np.ones(5))
        out[k] = {"alias": alias, "games": 100,
                  "roles": dict(zip(fm_serve.ROLE_ORDER, map(float, p)))}
    return out


def _artifact(seed=0, scale=0.7):
    vocab = _vocab()
    return fm_export.build_artifact(_model(seed), vocab, _role_pct(vocab),
                                    version="test", scale=scale, trained_on={})


# ---- export -----------------------------------------------------------------

def test_alias_keys_use_champion_meta_spelling():
    art = _artifact()
    assert "Fiddlesticks" in art["champions"] and "FiddleSticks" not in art["champions"]
    assert fm_export.alias_key("FiddleSticks") == "Fiddlesticks"
    assert fm_export.alias_key("Ahri") == "Ahri"


def test_artifact_schema_and_rounding():
    art = _artifact()
    assert art["rank"] == 16 and art["clamp"] == [0, 1]
    assert art["linear_roles"] == fm_serve.ROLE_ORDER
    c = art["champions"]["Annie"]
    assert set(c) == {"linear_expected", "linear", "synergy", "counter_a", "counter_b"}
    assert len(c["linear"]) == 5 and len(c["synergy"]) == 16
    for x in c["synergy"] + c["linear"] + [c["linear_expected"], art["scale"]]:
        assert x == fm_export.round6(x)
    assert fm_export.round6(0.123456789) == 0.123457
    assert fm_export.round6(-1234.56789) == -1234.57


def test_linear_expected_is_recomputable_from_the_vector_and_the_prior():
    vocab = _vocab()
    rp = _role_pct(vocab)
    art = fm_export.build_artifact(_model(), vocab, rp, "test", 1.0, {})
    for k, alias in vocab["index_to_alias"].items():
        c = art["champions"][fm_export.alias_key(alias)]
        prior = fm_export.role_prior_vector(rp[k])
        # recomputed from the ROUNDED 5-vector, so allow rounding slack
        assert abs(fm_export.linear_expected(np.array(c["linear"]), prior)
                   - c["linear_expected"]) < 5e-6


def test_export_fails_when_a_vocab_champion_has_no_role_prior():
    vocab = _vocab()
    with pytest.raises(fm_export.MissingRolePrior, match="Olaf"):
        fm_export.build_artifact(_model(), vocab, _role_pct(vocab, skip={"Olaf"}),
                                 "test", 1.0, {})


# ---- algebra: slot-role decomposition == forward() − region bias (design §1(a)) ----

def test_slot_allocation_decomposition_reproduces_forward_minus_region_bias():
    m = _model()
    W = m.linear.weight.detach().numpy()
    S = m.synergy.weight.detach().numpy()
    A = m.counter_a.weight.detach().numpy()
    B = m.counter_b.weight.detach().numpy()
    rng = np.random.default_rng(1)
    for trial in range(50):
        champ = rng.choice(np.arange(2, V), size=10, replace=False)
        # mask a random subset of slots with UNKNOWN (0), including fully empty sides
        n_mask = rng.integers(0, 10)
        champ[rng.choice(10, size=n_mask, replace=False)] = 0
        region = int(rng.integers(0, R))
        with torch.no_grad():
            want = float(m(torch.from_numpy(champ[None].copy()).long(), torch.tensor([region]))[0]
                         - m.region_bias[region])
        got = fm_serve.slot_role_logit(W, S, A, B, champ)
        assert abs(got - want) < 1e-5, (trial, got, want)


# ---- serving identities on a written artifact -------------------------------

def test_allocation_sums_difference_to_the_structural_logit_and_marginal_is_the_delta():
    table = fm_serve.ServingTable(_artifact())
    blue = ["Annie", "Olaf", "Galio"]
    red = ["Urgot", "Leblanc", "Vladimir", "Kayle"]
    logit = fm_serve.structural_logit(table, blue, red)
    assert abs(logit - (sum(fm_serve.allocation(table, c, blue, red) for c in blue)
                        - sum(fm_serve.allocation(table, c, red, blue) for c in red))) < 1e-12
    # adding TwistedFate to blue changes the logit by exactly marginal()
    after = fm_serve.structural_logit(table, blue + ["TwistedFate"], red)
    assert abs((after - logit) - fm_serve.marginal(table, "TwistedFate", blue, red)) < 1e-10
    # ...and from red's side the same function applies with the sides swapped
    after_r = fm_serve.structural_logit(table, blue, red + ["TwistedFate"])
    assert abs((logit - after_r) - fm_serve.marginal(table, "TwistedFate", red, blue)) < 1e-10


def test_self_exclusion_on_a_non_empty_team():
    table = fm_serve.ServingTable(_artifact())
    team, opp = ["Annie", "Olaf"], ["Urgot", "Leblanc"]
    as_candidate = fm_serve.marginal(table, "Galio", team, opp)
    as_member = fm_serve.marginal(table, "Galio", team + ["Galio"], opp)
    assert abs(as_candidate - as_member) < 1e-12
    # and the naive (no exclusion) version differs by ||s_c||^2, so the test has teeth
    s = table.synergy[table.index["Galio"]]
    assert float(s @ s) > 1e-3


def test_unknown_teammates_and_opponents_contribute_nothing():
    table = fm_serve.ServingTable(_artifact())
    a = fm_serve.marginal(table, "Galio", ["Annie"], ["Urgot"])
    b = fm_serve.marginal(table, "Galio", ["Annie", "Zzz_new_champion"], ["Urgot", "Zzz_other"])
    assert a == b


def test_scale_statistic_on_a_synthetic_fixture():
    legacy = [fm_serve.within_set_sd([0.40, 0.50, 0.60])] * 3      # sd 0.0816…
    fmv = [fm_serve.within_set_sd([-1.0, 0.0, 1.0])] * 3            # sd 0.8165
    assert abs(fm_serve.scale_statistic(legacy, fmv) - 0.1) < 1e-12
    assert fm_serve.within_set_sd([1.0, 1.0]) == 0.0


import ship_fm


def test_parity_fixtures_are_clamp_free_and_self_consistent():
    art = _artifact(scale=0.7)
    table = fm_serve.ServingTable(art)
    rng = np.random.default_rng(3)
    names = table.aliases
    drafts = [(list(rng.choice(names, 5, replace=False)), list(rng.choice(names, 5, replace=False)))
              for _ in range(80)]
    fx = ship_fm.generate_parity_fixtures(table, drafts, n=20, seed=0)
    assert len(fx) == 20
    fills = {len(f["blue"]) + len(f["red"]) for f in fx}
    assert min(fills) < 10 <= max(fills), "fixtures must span partial and full drafts"
    for f in fx:
        assert abs(f["logit"] - (f["blue_allocation_sum"] - f["red_allocation_sum"])) < 1e-12
        for side, opp in (("blue", "red"), ("red", "blue")):
            for c in f[side]:
                assert abs(table.scale * fm_serve.allocation(table, c, f[side], f[opp])) < 0.49


def test_version_string_is_date_plus_sha():
    assert ship_fm.version_string("2026-09-01", "abc1234") == "fm-2026-09-01-abc1234"


def test_recipe_round_trips_and_missing_path_raises(tmp_path):
    info = [{"seed": 0, "lr": 0.01, "weight_decay": 0.0001, "best_epoch": 7, "val_a_log_loss": 0.69},
            {"seed": 1, "lr": 0.01, "weight_decay": 0.0001, "best_epoch": 5, "val_a_log_loss": 0.70},
            {"seed": 2, "lr": 0.01, "weight_decay": 0.0001, "best_epoch": 6, "val_a_log_loss": 0.70}]
    path = tmp_path / "ship_fm_recipe.json"
    ship_fm.write_recipe(path, info)
    assert ship_fm.read_recipe(path) == info
    with pytest.raises(FileNotFoundError):
        ship_fm.read_recipe(tmp_path / "missing_recipe.json")


import fm_retrain_gate


def test_retrain_gate_blocks_only_a_regression_beyond_both_the_mde_and_the_seed_spread():
    # design §5: block when Δ(new − previous) < 0 AND |Δ| > MDE AND |Δ| > 3-seed spread
    assert fm_retrain_gate.decide(-0.010, mde=0.004, spread=0.002)[0] == "BLOCK"
    assert fm_retrain_gate.decide(-0.003, mde=0.004, spread=0.002)[0] == "PASS"   # inside MDE
    assert fm_retrain_gate.decide(-0.005, mde=0.004, spread=0.006)[0] == "PASS"   # inside seed spread
    assert fm_retrain_gate.decide(+0.010, mde=0.004, spread=0.002)[0] == "PASS"   # improvement
