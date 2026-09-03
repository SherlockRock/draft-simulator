"""The missing measurement: PAIRED production-evaluator vs FM / logreg_antisym.

Nothing in the Phase 2 harness ever paired the production evaluator against the
ship candidates — gate 1's table was unpaired across different row counts, and
gate 2 had no evaluator arm. Two arms, both on identical rows:

  1. Sibling ranking (near-full states): per-set MRR/top-1 diffs on the
     evaluable intersection where the evaluator scored the set, using the
     existing sibling_scores.npz plus a fresh logreg_antisym sibling arm
     (refit at the C baselines.json selected; scored picker-perspective like
     every other arm). Also Spearman rho vs the evaluator per arm — the
     drop-in vs behaviour-change diagnostic that was only ever computed for
     the MLP.

  2. Full-draft log-loss: the evaluator's score_blue_minus_red mapped to a
     probability by 5-fold CROSS-FITTED Platt scaling (each row's probability
     comes from a calibrator fitted on the other folds — the evaluator gets
     the benefit of calibration without fitting on its own eval rows), paired
     against the stored fm / logreg_antisym test predictions on the joined rows.

Read-only over data/training/; writes measure_vs_evaluator.{json,md}.
"""

import json

import numpy as np
import pandas as pd
from scipy import stats
from sklearn.linear_model import LogisticRegression

import features
import metrics
from sibling_scores import TRAIN_DIR, build_variants, group


def load_test_frame():
    ds = pd.read_parquet(TRAIN_DIR / "dataset.parquet")
    return ds, ds[ds.split == "test"].reset_index(drop=True)


def refit_logreg_antisym(ds, dims):
    """Reproduce baselines.py's full-draft logreg_antisym at its selected C."""
    C = json.loads((TRAIN_DIR / "baselines.json").read_text())["main"]["rows"]
    C = next(r["C"] for r in C if r["name"] == "logreg antisymmetric")
    n_champ, n_patch, n_region = dims
    tr = ds[ds.split == "train"]
    X = features.build(tr, n_champ, n_patch, n_region, antisymmetric=True)
    clf = LogisticRegression(C=C, max_iter=3000, solver="lbfgs")
    clf.fit(X, tr.win.to_numpy())
    return clf, C


def logreg_sibling_scores(clf, dims, sib, ds):
    vocab = json.loads((TRAIN_DIR / "champion_vocab.json").read_text())
    champ, bans, patch, region, set_id, slots, _ = build_variants(sib, ds, None, vocab)
    n_champ, n_patch, n_region = dims
    df = pd.DataFrame({f"champ_{i}": champ[:, i] for i in range(10)}
                      | {f"ban_{i}": bans[:, i] for i in range(10)}
                      | {"patch_idx": patch, "region_idx": region})
    X = features.build(df, n_champ, n_patch, n_region, antisymmetric=True)
    logit = X @ clf.coef_[0] + clf.intercept_[0]
    score = np.where(slots < 5, logit, -logit)   # picker perspective, like every arm
    return group(score, set_id, len(sib))


def paired_rank_arm(report, out):
    z = np.load(TRAIN_DIR / "sibling_scores.npz", allow_pickle=True)
    has_ev = z["has_evaluator"]
    ds, _ = load_test_frame()
    sib = pd.read_parquet(TRAIN_DIR / "sibling_sets.parquet")
    dims = dims_of(ds)

    clf, C = refit_logreg_antisym(ds, dims)
    lg = logreg_sibling_scores(clf, dims, sib, ds)

    arms = {"evaluator": z["evaluator"], "fm": z["fm"],
            "popularity": z["popularity"], "logreg_antisym": np.array(lg, dtype=object)}
    # Pairing demands one common index set: evaluator-scored AND finite in
    # every arm (mrr_top1's own finiteness drop would silently misalign arms).
    idx = [i for i in np.flatnonzero(has_ev)
           if all(np.isfinite(np.asarray(sc[i], dtype=float)).all()
                  for sc in arms.values())]
    report.append(f"\n## Arm 1 — paired sibling ranking (evaluable intersection, "
                  f"n = {len(idx):,} identical candidate sets; logreg C = {C})\n")
    rr = {}
    report.append("| scorer | MRR | top-1 |")
    report.append("|---|---|---|")
    for name, sc in arms.items():
        r, t1 = zip(*(rr_top1_of(np.asarray(sc[i], dtype=float)) for i in idx))
        rr[name] = np.array(r)
        report.append(f"| {name} | {rr[name].mean():.4f} | {np.mean(t1):.4f} |")
        out.setdefault("mrr", {})[name] = {"mrr": float(rr[name].mean()), "top1": float(np.mean(t1))}

    report.append("\n| comparison (MRR, + = candidate better) | Δ | 95% CI | MDE | verdict |")
    report.append("|---|---|---|---|---|")
    for cand in ("fm", "logreg_antisym", "popularity"):
        d = rr[cand] - rr["evaluator"]          # higher MRR is better
        boot = metrics.paired_bootstrap(d)
        v = {"PASS": "CANDIDATE_BETTER", "FAIL": "EVALUATOR_BETTER",
             "UNDERPOWERED": "UNDERPOWERED"}[metrics.verdict(boot, lower_is_better=False)]
        report.append(f"| {cand} − evaluator | {boot['mean']:+.5f} | "
                      f"[{boot['ci_lo']:+.5f}, {boot['ci_hi']:+.5f}] | "
                      f"{boot['mde']:.5f} | **{v}** |")
        out.setdefault("rank_paired", {})[cand] = {**boot, "verdict": v}

    report.append("\nSpearman ρ vs the evaluator within candidate set "
                  "(drop-in ≈ 0.9, behaviour change ≈ 0):\n")
    for cand in ("fm", "logreg_antisym", "popularity"):
        rhos = []
        for i in idx:
            a, b = np.asarray(arms[cand][i], float), np.asarray(arms["evaluator"][i], float)
            # a fully tied arm has no ranking to correlate with
            rhos.append(np.nan if a.std() == 0 or b.std() == 0
                        else stats.spearmanr(a, b).statistic)
        rho = float(np.nanmean(rhos))
        report.append(f"- {cand}: {rho:+.3f}")
        out.setdefault("spearman_vs_evaluator", {})[cand] = rho


def rr_top1_of(s):
    """Mid-rank-for-ties reciprocal rank of the true pick (index 0) — same
    convention as benchmark.mrr_top1, without its set-dropping."""
    rank = 1 + float((s > s[0]).sum()) + 0.5 * float((s[1:] == s[0]).sum())
    return 1.0 / rank, float(rank == 1)


def dims_of(ds):
    vocab = json.loads((TRAIN_DIR / "champion_vocab.json").read_text())
    n_patch = len(json.loads((TRAIN_DIR / "patch_vocab.json").read_text())["patch_to_index"])
    n_region = len(json.loads((TRAIN_DIR / "region_vocab.json").read_text())["region_to_index"])
    return len(vocab["riot_id_to_index"]) + 2, n_patch, n_region  # +2: UNKNOWN, NONE (baselines.py:59)


def crossfit_platt(score, y, k=5, seed=0):
    """Out-of-fold calibrated probabilities for a 1-D score."""
    rng = np.random.default_rng(seed)
    fold = rng.integers(0, k, size=len(score))
    p = np.empty(len(score))
    for f in range(k):
        m = fold != f
        cal = LogisticRegression(C=1e6, max_iter=1000)
        cal.fit(score[m, None], y[m])
        p[~m] = cal.predict_proba(score[~m, None])[:, 1]
    return p


def fulldraft_arm(report, out):
    _, te = load_test_frame()
    ev = pd.read_csv(TRAIN_DIR / "evaluator_scores.csv")
    z = np.load(TRAIN_DIR / "baseline_preds.npz", allow_pickle=True)
    preds = pd.DataFrame({"match_id": z["test_ids"],
                          "fm": z["fm"], "logreg_antisym": z["logreg_antisym"]})
    df = te.merge(ev, on="match_id").merge(preds, on="match_id")
    y = df.win.to_numpy()
    p_ev = crossfit_platt(df.score_blue_minus_red.to_numpy(), y)
    report.append(f"\n## Arm 2 — full-draft log-loss (joined rows n = {len(df):,}; "
                  "evaluator calibrated by 5-fold cross-fitted Platt)\n")
    report.append(f"evaluator (calibrated): log-loss {metrics.log_loss(p_ev, y):.5f}, "
                  f"AUC {metrics.auc(p_ev, y):.4f}")
    report.append("\n| comparison (log-loss, lower better) | Δ (cand − evaluator) | 95% CI | MDE | verdict |")
    report.append("|---|---|---|---|---|")
    for cand in ("fm", "logreg_antisym"):
        c = metrics.compare(cand, df[cand].to_numpy(), "evaluator", p_ev, y)
        report.append(f"| {cand} − evaluator | {c['delta_logloss_a_minus_b']:+.5f} | "
                      f"[{c['ci'][0]:+.5f}, {c['ci'][1]:+.5f}] | "
                      f"{c['mde']:.5f} | **{c['verdict']}** |")
        out.setdefault("fulldraft_paired", {})[cand] = c
    out["evaluator_calibrated"] = {"log_loss": float(metrics.log_loss(p_ev, y)),
                                   "auc": float(metrics.auc(p_ev, y))}


def main():
    report = ["# Paired evaluator-vs-candidates measurement",
              "\nThe comparison Phase 2 never ran: production evaluator against the",
              "ship candidates on IDENTICAL rows, both regimes it can score."]
    out = {}
    paired_rank_arm(report, out)
    fulldraft_arm(report, out)
    (TRAIN_DIR / "measure_vs_evaluator.json").write_text(json.dumps(out, indent=2, default=float))
    text = "\n".join(report) + "\n"
    (TRAIN_DIR / "measure_vs_evaluator.md").write_text(text)
    print(text)


if __name__ == "__main__":
    main()
