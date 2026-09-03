"""Shared metrics, calibration diagnostics and power arithmetic.

Used by Task 2 (baselines), Task 4 (evaluation) and Task 6 (the gates), so
every arm of every comparison is measured the same way.

The governing idea: at 15k test rows the log-loss MDE is roughly the size of
the entire Part A signal band (constant -> logreg was 0.0018 nats). Every
number therefore ships with its minimum detectable difference, and a
comparison whose effect sits inside the MDE is reported UNDERPOWERED rather
than "no effect".
"""

import numpy as np

EPS = 1e-6
Z95 = 1.959963984540054


def _clip(p):
    return np.clip(np.asarray(p, dtype=float), EPS, 1 - EPS)


# --- pointwise losses (kept per-row so differences can be PAIRED) ----------

def log_loss_rows(p, y):
    """Per-row negative log-likelihood in nats."""
    p = _clip(p)
    y = np.asarray(y, dtype=float)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def brier_rows(p, y):
    return (_clip(p) - np.asarray(y, dtype=float)) ** 2


def log_loss(p, y):
    return float(log_loss_rows(p, y).mean())


def brier(p, y):
    return float(brier_rows(p, y).mean())


def accuracy(p, y):
    return float(((_clip(p) > 0.5) == np.asarray(y, dtype=bool)).mean())


def auc(p, y):
    """Mann-Whitney U form; ties get the average rank."""
    p = np.asarray(p, dtype=float)
    y = np.asarray(y, dtype=bool)
    n_pos, n_neg = int(y.sum()), int((~y).sum())
    if n_pos == 0 or n_neg == 0:
        return float("nan")
    order = np.argsort(p, kind="mergesort")
    ranks = np.empty(len(p), dtype=float)
    ranks[order] = np.arange(1, len(p) + 1, dtype=float)
    # average ranks within tied groups
    sp = p[order]
    i = 0
    while i < len(sp):
        j = i
        while j + 1 < len(sp) and sp[j + 1] == sp[i]:
            j += 1
        if j > i:
            ranks[order[i : j + 1]] = (i + j + 2) / 2.0
        i = j + 1
    return float((ranks[y].sum() - n_pos * (n_pos + 1) / 2) / (n_pos * n_neg))


def brier_decomposition(p, y, bins=15):
    """Murphy decomposition on equal-mass bins: Brier = reliability - resolution + uncertainty."""
    p, y = _clip(p), np.asarray(y, dtype=float)
    idx = equal_mass_bins(p, bins)
    base = y.mean()
    reliability = resolution = 0.0
    for b in range(bins):
        m = idx == b
        if not m.any():
            continue
        w = m.mean()
        reliability += w * (p[m].mean() - y[m].mean()) ** 2
        resolution += w * (y[m].mean() - base) ** 2
    return {
        "reliability": float(reliability),
        "resolution": float(resolution),
        "uncertainty": float(base * (1 - base)),
    }


# --- calibration ----------------------------------------------------------

def equal_mass_bins(p, bins=15):
    """Bin indices with (near) equal counts. Equal-WIDTH bins are useless here:
    a draft model's predictions concentrate in a narrow band around 0.5, so most
    fixed-width bins would be empty."""
    p = np.asarray(p, dtype=float)
    order = np.argsort(p, kind="mergesort")
    idx = np.empty(len(p), dtype=int)
    edges = np.linspace(0, len(p), bins + 1).astype(int)
    for b in range(bins):
        idx[order[edges[b] : edges[b + 1]]] = b
    return idx


def ece(p, y, bins=15):
    p, y = _clip(p), np.asarray(y, dtype=float)
    idx = equal_mass_bins(p, bins)
    total = 0.0
    for b in range(bins):
        m = idx == b
        if m.any():
            total += m.mean() * abs(p[m].mean() - y[m].mean())
    return float(total)


def sharpness(p):
    """sd of the predictions. A perfectly calibrated constant predictor has
    ECE 0 and sharpness 0 — which is why ECE alone is not a quality metric."""
    p = _clip(p)
    return {"sd": float(p.std()), "min": float(p.min()), "max": float(p.max())}


def ece_null(p, y, bins=15, n_boot=1000, seed=0):
    """Judge ECE against the model's OWN null rather than a fixed threshold.

    Resample y ~ Bernoulli(p_hat) and recompute ECE. If the observed ECE sits
    inside this null's 95th percentile, the model is as calibrated as a
    perfectly calibrated model of this size and sharpness could look. A fixed
    0.02 threshold sits barely above the ~0.012 pure-noise expectation at 15k
    rows, so it mostly measures sample size.
    """
    p = _clip(p)
    rng = np.random.default_rng(seed)
    observed = ece(p, y, bins)
    draws = np.array([ece(p, rng.binomial(1, p), bins) for _ in range(n_boot)])
    return {
        "ece": observed,
        "null_mean": float(draws.mean()),
        "null_p95": float(np.percentile(draws, 95)),
        "inside_null": bool(observed <= np.percentile(draws, 95)),
        "null_percentile": float((draws < observed).mean() * 100),
    }


def fit_temperature(logit, y, lo=0.05, hi=20.0, iters=60):
    """Temperature scaling by ternary search on val-B log-loss.

    T is monotone, so it cannot change any ranking at a fixed mask count. It
    matters for displayed probabilities and for comparing across depths.
    """
    logit, y = np.asarray(logit, dtype=float), np.asarray(y, dtype=float)

    def loss(t):
        return log_loss(1.0 / (1.0 + np.exp(-logit / t)), y)

    for _ in range(iters):
        m1, m2 = lo + (hi - lo) / 3, hi - (hi - lo) / 3
        if loss(m1) < loss(m2):
            hi = m2
        else:
            lo = m1
    return float((lo + hi) / 2)


# --- power and paired comparison -----------------------------------------

def mde(diff_rows):
    """Minimum detectable paired difference at 95%: 1.96 * sd(d) / sqrt(n).

    `diff_rows` is the per-row difference of two scorers' losses on the SAME
    rows. Reporting this next to every estimate is what lets a null result be
    called UNDERPOWERED rather than "no effect".
    """
    d = np.asarray(diff_rows, dtype=float)
    return float(Z95 * d.std(ddof=1) / np.sqrt(len(d)))


def paired_bootstrap(diff_rows, n_boot=1000, seed=0):
    """Resample GAMES (not rows within a game) and recompute the mean difference."""
    d = np.asarray(diff_rows, dtype=float)
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, len(d), size=(n_boot, len(d)))
    means = d[idx].mean(axis=1)
    lo, hi = np.percentile(means, [2.5, 97.5])
    return {
        "mean": float(d.mean()),
        "ci_lo": float(lo),
        "ci_hi": float(hi),
        "excludes_zero": bool(lo > 0 or hi < 0),
        "mde": mde(d),
    }


def compare(name_a, p_a, name_b, p_b, y, n_boot=1000, seed=0):
    """Paired log-loss comparison of two scorers with its CI, MDE and verdict."""
    d = log_loss_rows(p_a, y) - log_loss_rows(p_b, y)
    boot = paired_bootstrap(d, n_boot=n_boot, seed=seed)
    inside_mde = abs(boot["mean"]) < boot["mde"]
    if boot["excludes_zero"] and not inside_mde:
        verdict = "A_BETTER" if boot["mean"] < 0 else "B_BETTER"
    elif inside_mde:
        verdict = "UNDERPOWERED"
    else:
        verdict = "NO_DIFFERENCE"
    return {
        "a": name_a,
        "b": name_b,
        "delta_logloss_a_minus_b": boot["mean"],
        "ci": [boot["ci_lo"], boot["ci_hi"]],
        "mde": boot["mde"],
        "verdict": verdict,
        "n": int(len(d)),
    }


def report_row(name, p, y, bins=15, with_null=False, seed=0):
    """The metric bundle every arm reports."""
    p = _clip(p)
    out = {
        "name": name,
        "n": int(len(y)),
        "log_loss": log_loss(p, y),
        "brier": brier(p, y),
        "auc": auc(p, y),
        # Reported, never gated: SE is ~0.4 pp at 15k rows, larger than the
        # entire effect band the model is competing in.
        "accuracy": accuracy(p, y),
        "ece": ece(p, y, bins),
        "sharpness": sharpness(p),
        "brier_decomposition": brier_decomposition(p, y, bins),
        # SE of the mean log-loss — the width of THIS estimate, distinct from
        # the MDE of a PAIRED difference against another scorer.
        "log_loss_se": float(log_loss_rows(p, y).std(ddof=1) / np.sqrt(len(y))),
    }
    if with_null:
        out["ece_null"] = ece_null(p, y, bins=bins, seed=seed)
    return out


def verdict(boot, lower_is_better=True):
    """PASS / FAIL / UNDERPOWERED from one paired bootstrap. `lower_is_better`
    is not cosmetic: log-loss gates want a negative model - rival difference,
    the MRR gate a positive one."""
    if abs(boot["mean"]) < boot["mde"]:
        return "UNDERPOWERED"
    better = boot["ci_hi"] < 0 if lower_is_better else boot["ci_lo"] > 0
    worse = boot["ci_lo"] > 0 if lower_is_better else boot["ci_hi"] < 0
    if better:
        return "PASS"
    if worse:
        return "FAIL"
    return "UNDERPOWERED"


def aggregate_verdicts(verdicts):
    """A FAIL dominates: an arm whose CI excludes zero on the wrong side is a
    real result, and calling it UNDERPOWERED because a sibling was inconclusive
    would hide it."""
    if not verdicts:
        return "MISSING"
    if "FAIL" in verdicts:
        return "FAIL"
    if all(v == "PASS" for v in verdicts):
        return "PASS"
    return "UNDERPOWERED"


def seed_summary(diff_rows_by_seed, lower_is_better=True, n_boot=1000, seed=0):
    """One paired bootstrap per training seed; the gate reports mean +- spread
    of the effect across seeds and takes the FAIL-dominated verdict over them."""
    boots = [paired_bootstrap(d, n_boot=n_boot, seed=seed) for d in diff_rows_by_seed]
    means = np.array([b["mean"] for b in boots])
    per_seed_verdicts = [verdict(b, lower_is_better) for b in boots]
    return {
        "mean": float(means.mean()),
        "spread": float(means.std()),
        "mde": float(np.mean([b["mde"] for b in boots])),
        "ci_lo": float(np.mean([b["ci_lo"] for b in boots])),
        "ci_hi": float(np.mean([b["ci_hi"] for b in boots])),
        "per_seed": [{**b, "verdict": v} for b, v in zip(boots, per_seed_verdicts)],
        "verdict": aggregate_verdicts(per_seed_verdicts),
    }
