"""metrics.py is the measuring instrument for every gate. Validate it against
cases whose answer is known in closed form before trusting any verdict."""

import numpy as np
import pytest

import metrics


@pytest.fixture
def calibrated():
    rng = np.random.default_rng(0)
    p = rng.beta(5, 5, 20000)
    return p, rng.binomial(1, p)


def test_log_loss_matches_the_closed_form_for_a_constant_predictor():
    y = np.array([1, 1, 0, 0, 1, 0, 1, 0, 1, 1])
    q = y.mean()
    expected = -(q * np.log(q) + (1 - q) * np.log(1 - q))
    assert metrics.log_loss(np.full(len(y), q), y) == pytest.approx(expected)


def test_perfect_predictions_reach_the_clip_floor():
    y = np.array([1, 0, 1, 0])
    assert metrics.log_loss(y.astype(float), y) == pytest.approx(-np.log(1 - metrics.EPS), abs=1e-9)


def test_auc_is_one_for_a_perfect_ranker_and_half_for_a_constant():
    y = np.array([0, 0, 1, 1])
    assert metrics.auc(np.array([0.1, 0.2, 0.8, 0.9]), y) == pytest.approx(1.0)
    assert metrics.auc(np.array([0.9, 0.8, 0.2, 0.1]), y) == pytest.approx(0.0)
    assert metrics.auc(np.full(4, 0.5), y) == pytest.approx(0.5)


def test_equal_mass_bins_are_equal_mass():
    p = np.random.default_rng(1).random(1500)
    idx = metrics.equal_mass_bins(p, 15)
    counts = np.bincount(idx, minlength=15)
    assert counts.min() >= 99 and counts.max() <= 101


def test_ece_is_zero_when_every_bin_is_perfectly_calibrated():
    # 0.25 in half the rows with a 25% hit rate, 0.75 with 75%.
    p = np.repeat([0.25, 0.75], 400)
    y = np.concatenate([np.repeat([1, 0], [100, 300]), np.repeat([1, 0], [300, 100])])
    assert metrics.ece(p, y, bins=2) == pytest.approx(0.0, abs=1e-12)


def test_ece_catches_a_systematically_overconfident_model(calibrated):
    p, y = calibrated
    logit = np.log(p / (1 - p))
    overconfident = 1 / (1 + np.exp(-2.5 * logit))
    assert metrics.ece(overconfident, y) > 5 * metrics.ece(p, y)


def test_ece_null_accepts_a_calibrated_model_and_rejects_a_skewed_one(calibrated):
    p, y = calibrated
    assert metrics.ece_null(p, y, n_boot=200)["inside_null"]
    logit = np.log(p / (1 - p))
    skewed = 1 / (1 + np.exp(-(logit + 0.5)))
    assert not metrics.ece_null(skewed, y, n_boot=200)["inside_null"]


def test_sharpness_separates_a_constant_predictor_from_a_useful_one(calibrated):
    p, y = calibrated
    const = np.full(len(y), y.mean())
    # A constant predictor is perfectly calibrated BY CONSTRUCTION. Only
    # sharpness tells it apart from a useful model, which is why gate 6 reports
    # both and never gates on ECE alone.
    assert metrics.sharpness(const)["sd"] == pytest.approx(0.0)
    assert metrics.sharpness(p)["sd"] > 0.1
    assert metrics.brier_decomposition(const, y)["resolution"] == pytest.approx(0.0, abs=1e-3)
    assert metrics.brier_decomposition(p, y)["resolution"] > 0.01


def test_ece_null_has_the_coverage_it_claims():
    """The null must accept a correctly-specified model ~95% of the time.

    Two facts this pins down, both of which matter for reading gate 6:
    a perfectly calibrated CONSTANT predictor still shows a raw ECE around
    0.016 on 15 equal-mass bins (that is binning noise, not miscalibration —
    which is why a fixed 0.02 threshold would mostly measure the row count),
    and ECE on 15 bins is noisy enough that roughly 1 draw in 20 lands outside
    its own null by chance. A single failing seed is not evidence.
    """
    inside, raw = [], []
    for seed in range(20):
        rng = np.random.default_rng(seed)
        p = rng.beta(5, 5, 20000)
        y = rng.binomial(1, p)
        const = np.full(len(y), y.mean())
        raw.append(metrics.ece(const, y))
        inside.append(metrics.ece_null(const, y, n_boot=200, seed=seed)["inside_null"])
    assert sum(inside) >= 17, f"null coverage too low: {sum(inside)}/20"
    assert np.mean(raw) > 0.008, "the equal-mass binning noise floor is real"


def test_temperature_recovers_a_known_miscalibration(calibrated):
    p, y = calibrated
    logit = np.log(p / (1 - p))
    assert metrics.fit_temperature(logit, y) == pytest.approx(1.0, abs=0.05)
    assert metrics.fit_temperature(2.0 * logit, y) == pytest.approx(2.0, abs=0.1)
    assert metrics.fit_temperature(0.5 * logit, y) == pytest.approx(0.5, abs=0.05)


def test_temperature_never_changes_a_ranking(calibrated):
    p, _ = calibrated
    logit = np.log(p / (1 - p))
    for t in (0.3, 1.0, 3.0):
        assert (np.argsort(logit) == np.argsort(logit / t)).all()


def test_mde_shrinks_as_sqrt_n():
    rng = np.random.default_rng(2)
    small = metrics.mde(rng.normal(0, 1, 1000))
    big = metrics.mde(rng.normal(0, 1, 100000))
    assert small / big == pytest.approx(10.0, rel=0.15)


def test_compare_reports_underpowered_when_the_effect_is_below_the_mde():
    """The verdict that matters: a tiny true difference on few rows must come
    back UNDERPOWERED, not 'no difference'."""
    rng = np.random.default_rng(3)
    y = rng.binomial(1, 0.5, 400)
    p_a = np.full(400, 0.5)
    p_b = np.full(400, 0.5005)
    assert metrics.compare("a", p_a, "b", p_b, y)["verdict"] == "UNDERPOWERED"


def test_compare_detects_a_real_difference_on_enough_rows(calibrated):
    p, y = calibrated
    out = metrics.compare("true", p, "constant", np.full(len(y), y.mean()), y)
    assert out["verdict"] == "A_BETTER"
    assert out["delta_logloss_a_minus_b"] < 0
    assert out["ci"][1] < 0


def test_compare_is_antisymmetric_in_its_arguments(calibrated):
    p, y = calibrated
    const = np.full(len(y), y.mean())
    ab = metrics.compare("a", p, "b", const, y)
    ba = metrics.compare("b", const, "a", p, y)
    assert ab["delta_logloss_a_minus_b"] == pytest.approx(-ba["delta_logloss_a_minus_b"])
    assert {ab["verdict"], ba["verdict"]} == {"A_BETTER", "B_BETTER"}


def test_brier_decomposition_reconstructs_the_brier_score(calibrated):
    p, y = calibrated
    d = metrics.brier_decomposition(p, y)
    rebuilt = d["reliability"] - d["resolution"] + d["uncertainty"]
    assert rebuilt == pytest.approx(metrics.brier(p, y), abs=2e-3)


def test_paired_bootstrap_ci_covers_the_true_mean():
    rng = np.random.default_rng(4)
    d = rng.normal(0.01, 0.5, 20000)
    boot = metrics.paired_bootstrap(d, n_boot=400)
    assert boot["ci_lo"] <= 0.01 <= boot["ci_hi"]
    assert boot["excludes_zero"]


def test_seed_summary_reports_mean_spread_and_a_fail_dominated_verdict():
    rng = np.random.default_rng(0)
    worse = [rng.normal(0.01, 0.05, 4000) for _ in range(2)]      # model worse, clearly
    null = [rng.normal(0.0, 0.05, 4000)]
    out = metrics.seed_summary(worse + null, lower_is_better=True)
    assert len(out["per_seed"]) == 3
    assert abs(out["mean"] - np.mean([d.mean() for d in worse + null])) < 1e-12
    assert out["spread"] > 0
    assert out["verdict"] == "FAIL"
    better = [rng.normal(-0.01, 0.05, 4000) for _ in range(3)]
    assert metrics.seed_summary(better, lower_is_better=True)["verdict"] == "PASS"
