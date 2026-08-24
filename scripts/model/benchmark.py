#!/usr/bin/env python
"""Task 6 — the six gates and the GO / NO-GO / UNDERPOWERED verdict.

    .venv/bin/python benchmark.py

Every comparison is a paired bootstrap over GAMES (1,000 resamples, 95% CI)
reported next to its MDE. A CI straddling zero with the effect inside the MDE
is UNDERPOWERED - re-run at Task 9's ~500k corpus - never "no effect".

    GO           gates 1, 2, 3, 4 pass and 5 is resolved
    UNDERPOWERED a gate's CI straddles 0 with the effect inside its MDE
    NO-GO        a gate fails; records which, and whether it is data- or
                 method-limited
"""

import json
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

import metrics
from common import ROOT

TRAIN_DIR = ROOT / "data/training"


def mrr_top1(score_sets, valid=None):
    """The true pick is at index 0 of every candidate set by construction."""
    rr, t1, keep = [], [], []
    for i, s in enumerate(score_sets):
        if valid is not None and not valid[i]:
            continue
        s = np.asarray(s, dtype=float)
        if not np.isfinite(s).all():
            continue
        rank = int((s > s[0]).sum()) + 1          # ties favour neither arm
        rr.append(1.0 / rank)
        t1.append(float(rank == 1))
        keep.append(i)
    return np.array(rr), np.array(t1), np.array(keep, dtype=int)


def verdict_from(boot):
    if abs(boot["mean"]) < boot["mde"]:
        return "UNDERPOWERED"
    if boot["ci_lo"] > 0:
        return "PASS"
    if boot["ci_hi"] < 0:
        return "FAIL"
    return "UNDERPOWERED"


def line(report, label, boot):
    v = verdict_from(boot)
    report.append(
        f"| {label} | {boot['mean']:+.5f} | [{boot['ci_lo']:+.5f}, {boot['ci_hi']:+.5f}] | "
        f"{boot['mde']:.5f} | **{v}** |"
    )
    return v


def gate1(report, result):
    report.append("\n## Gate 1 — sibling ranking (primary)\n")
    report.append(
        "*Agreement with apex player choice.* The label is what a player actually "
        "picked — pool, comfort, the meta they were playing — not a counterfactual "
        "win-maximising choice. It is a legitimate RELATIVE discriminative test "
        "between scorers, and is named that way rather than as a measure of "
        "draft quality."
    )
    path = TRAIN_DIR / "sibling_scores.npz"
    if not path.exists():
        report.append("\n_sibling_scores.npz missing — run sibling_scores.py._")
        return "MISSING", {}
    z = np.load(path)
    has_ev = z["has_evaluator"]
    n_cand = z["model"].shape[1]

    rr = {}
    report.append("\n| scorer | MRR | top-1 | n sets |")
    report.append("|---|---|---|---|")
    for arm in ("model", "fm", "popularity", "evaluator"):
        valid = has_ev if arm == "evaluator" else None
        r, t1, keep = mrr_top1(z[arm], valid)
        rr[arm] = (r, keep)
        report.append(f"| {arm} | {r.mean():.4f} | {t1.mean():.4f} | {len(r):,} |")

    # --- validity check ---
    chance = float(np.mean([1 / k for k in range(1, n_cand + 1)]))
    r_pop = rr["popularity"][0]
    se = r_pop.std(ddof=1) / np.sqrt(len(r_pop))
    zscore = (r_pop.mean() - chance) / se
    ok = abs(zscore) < 3
    report.append(
        f"\n**Validity check.** Distractors are drawn ∝ (role, patch) pick frequency, "
        f"which makes the true pick and its distractors exchangeable in frequency, so a "
        f"popularity ranker must score at chance EXACTLY. Chance MRR at N={n_cand} is "
        f"{chance:.4f}; popularity scores {r_pop.mean():.4f} (z = {zscore:+.2f}). "
        + ("The candidate sets are exchangeable as designed."
           if ok else "**NOT exchangeable — gate 1 is invalid as constructed.**")
    )

    out = {"chance_mrr": chance, "popularity_z": float(zscore), "valid": bool(ok),
           "mrr": {a: float(rr[a][0].mean()) for a in rr}}
    report.append("\n| comparison (MRR) | Δ | 95% CI | MDE | verdict |")
    report.append("|---|---|---|---|---|")
    verdicts = []
    for rival in ("fm", "evaluator"):
        common = np.intersect1d(rr["model"][1], rr[rival][1])
        a = rr["model"][0][np.isin(rr["model"][1], common)]
        b = rr[rival][0][np.isin(rr[rival][1], common)]
        boot = metrics.paired_bootstrap(a - b)
        v = line(report, f"model − {rival}", boot)
        out[f"model_vs_{rival}"] = {**boot, "verdict": v, "n": int(len(common))}
        verdicts.append(v)

    # Spearman rho vs the evaluator: Phase 3 needs to know whether this is a
    # drop-in replacement (rho ~ 0.9) or a behaviour change (rho ~ 0.1).
    rhos = [
        stats.spearmanr(z["model"][i], z["evaluator"][i]).statistic
        for i in np.flatnonzero(has_ev)[:3000]
    ]
    rhos = [r for r in rhos if np.isfinite(r)]
    out["spearman_vs_evaluator"] = float(np.mean(rhos))
    report.append(
        f"\n**Spearman ρ vs the current evaluator**, within candidate set: "
        f"{np.mean(rhos):+.3f} (median {np.median(rhos):+.3f}). "
        + ("Near 0.9 would make this a drop-in; near 0 makes Phase 3 a behaviour change."
           if True else "")
    )
    spread = np.nanstd(z["model"], axis=1)
    out["within_set_logit_spread"] = float(np.nanmean(spread))
    report.append(
        f"**Within-sibling logit spread**: {np.nanmean(spread):.4f} mean sd. A spread "
        "below the model's own noise would mean a search dominated by tie-breaks."
    )
    passed = "PASS" if all(v == "PASS" for v in verdicts) else (
        "UNDERPOWERED" if "UNDERPOWERED" in verdicts else "FAIL")
    return passed, out


def _paired(report, label, p_model, p_rival, y):
    d = metrics.log_loss_rows(p_model, y) - metrics.log_loss_rows(p_rival, y)
    boot = metrics.paired_bootstrap(d)
    return line(report, label, boot), boot


def gate2(report, result):
    report.append("\n## Gate 2 — probability quality (full drafts)\n")
    preds = np.load(TRAIN_DIR / "model_test_preds.npy")
    bl = np.load(TRAIN_DIR / "baseline_preds.npz", allow_pickle=True)
    ds = pd.read_parquet(TRAIN_DIR / "dataset.parquet")
    te = ds[ds.split == "test"]
    y = te.win.to_numpy()
    p_model = preds[0]

    report.append("| comparison | Δ log-loss | 95% CI | MDE | verdict |")
    report.append("|---|---|---|---|---|")
    out, verdicts = {}, []
    for rival in ("fm", "logreg_antisym", "logreg_side", "constant"):
        v, boot = _paired(report, f"model − {rival}", p_model, bl[rival], y)
        out[rival] = {**boot, "verdict": v}
        if rival in ("fm", "logreg_antisym"):
            verdicts.append(v)

    # Rolling origin with the >= 4/5 sign rule.
    fold_path = TRAIN_DIR / "model_fold_preds.npz"
    if fold_path.exists():
        fp = np.load(fold_path, allow_pickle=True)
        bfolds = json.loads((TRAIN_DIR / "baselines.json").read_text())["folds"]
        report.append(
            "\n**Rolling origin.** Consecutive folds share ≥80% of their training "
            "data, so the pooled game-level bootstrap understates variance and "
            "'effective n' is not a √5 gain. The binding rule is a CONSISTENT SIGN "
            "in ≥4 of 5 folds."
        )
        report.append("\n| fold | model log-loss | FM log-loss | Δ | sign |")
        report.append("|---|---|---|---|---|")
        signs = []
        for i, f in enumerate(bfolds, start=1):
            key = f"fold{i}"
            if key not in fp:
                continue
            yk = fp[f"{key}_y"]
            pm = fp[key]
            fm_ll = {r["name"]: r["log_loss"] for r in f["rows"]}["antisymmetric FM"]
            m_ll = metrics.log_loss(pm, yk)
            delta = m_ll - fm_ll
            signs.append(np.sign(delta))
            report.append(
                f"| {i} | {m_ll:.5f} | {fm_ll:.5f} | {delta:+.5f} | "
                f"{'model better' if delta < 0 else 'FM better'} |"
            )
        if signs:
            neg = int(sum(1 for s in signs if s < 0))
            out["fold_sign_rule"] = {"folds": len(signs), "model_better": neg,
                                     "passes": bool(neg >= 4)}
            report.append(
                f"\nModel better in **{neg} of {len(signs)}** folds → "
                + ("**sign rule PASSES**" if neg >= 4 else "**sign rule FAILS**")
            )
            if neg < 4:
                verdicts.append("FAIL")
    else:
        report.append("\n_model_fold_preds.npz missing — run `train.py --stage folds`._")

    passed = "PASS" if all(v == "PASS" for v in verdicts) else (
        "UNDERPOWERED" if "UNDERPOWERED" in verdicts else "FAIL")
    return passed, out


def gate3(report, result):
    report.append("\n## Gate 3 — partial drafts (4–6 masked replica)\n")
    report.append(
        "Baselines are REFIT on the masking distribution, not full-draft fits "
        "scored with zeros. *No evaluator arm*: the terminal-`search()` harness "
        "cannot produce a static evaluator score for a partial state, and the "
        "engine does not evaluate there anyway — it searches."
    )
    path = TRAIN_DIR / "model_masked_preds.npy"
    blp = TRAIN_DIR / "baseline_preds_masked.npz"
    if not (path.exists() and blp.exists()):
        report.append("\n_masked predictions missing._")
        return "MISSING", {}
    p_model = np.load(path)
    bl = np.load(blp, allow_pickle=True)
    ds = pd.read_parquet(TRAIN_DIR / "dataset.parquet")
    y = ds[ds.split == "test"].win.to_numpy()
    report.append("\n| comparison | Δ log-loss | 95% CI | MDE | verdict |")
    report.append("|---|---|---|---|---|")
    out, verdicts = {}, []
    for rival in ("fm", "logreg_antisym"):
        v, boot = _paired(report, f"model − {rival}", p_model, bl[rival], y)
        out[rival] = {**boot, "verdict": v}
        verdicts.append(v)
    passed = "PASS" if all(v == "PASS" for v in verdicts) else (
        "UNDERPOWERED" if "UNDERPOWERED" in verdicts else "FAIL")
    return passed, out


def gate4(report, result):
    report.append("\n## Gate 4 — serve realism (solver roles)\n")
    report.append(
        "Two arms: **argmax** placement with one-hot roles, and **posterior** "
        "`role_probs`. The POSTERIOR arm is the gated one — it is the path the "
        "soft role input exists for. All rows, no evaluable restriction (Task 2b's "
        "synthesised meta gives solver roles for Locke too, and there is no "
        "evaluator arm here)."
    )
    preds = np.load(TRAIN_DIR / "model_test_preds.npy")
    bl = np.load(TRAIN_DIR / "baseline_preds.npz", allow_pickle=True)
    ds = pd.read_parquet(TRAIN_DIR / "dataset.parquet")
    y = ds[ds.split == "test"].win.to_numpy()
    report.append("\n| comparison | Δ log-loss | 95% CI | MDE | verdict |")
    report.append("|---|---|---|---|---|")
    out, verdicts = {}, []
    for arm_i, arm in ((1, "argmax"), (2, "posterior")):
        for rival in ("fm", "logreg_antisym"):
            v, boot = _paired(report, f"{arm} − {rival}", preds[arm_i], bl[rival], y)
            out[f"{arm}_vs_{rival}"] = {**boot, "verdict": v}
            if arm == "posterior":
                verdicts.append(v)
    passed = "PASS" if all(v == "PASS" for v in verdicts) else (
        "UNDERPOWERED" if "UNDERPOWERED" in verdicts else "FAIL")
    return passed, out


def gate5(report, result):
    report.append("\n## Gate 5 — throughput\n")
    leaf = json.loads((Path(__file__).resolve().parent / "leaf_eval_stats.json").read_text())
    per_root = leaf["per_root"]
    evals = sorted(r["leaf_evaluations"] for r in per_root)
    median_leaf = evals[len(evals) // 2]
    max_leaf = evals[-1]
    onnx_path = TRAIN_DIR / "onnx_latency.json"
    out = {"median_leaf_evals_per_query": median_leaf, "max_leaf_evals_per_query": max_leaf}

    ev_rate = result.get("evaluator_evals_per_second", 328.0)
    out["evaluator_evals_per_second"] = ev_rate
    report.append(
        f"The current evaluator runs at **{ev_rate:.0f} evaluations/second** "
        f"(Task 5, corroborated independently by Task 1b-b). A query needs a median "
        f"of **{median_leaf:,}** cache-miss leaf evaluations and up to "
        f"**{max_leaf:,}** (Task 1b-b), so leaf evaluation alone costs a median of "
        f"**{median_leaf / ev_rate:.2f} s** and up to **{max_leaf / ev_rate:.1f} s** "
        f"inside a stated 5 s budget."
    )
    if onnx_path.exists():
        lat = json.loads(onnx_path.read_text())
        out["onnx"] = lat
        report.append("\n| batch | model evals/second | vs evaluator |")
        report.append("|---|---|---|")
        for b, rate in sorted(lat.get("evals_per_second", {}).items(), key=lambda kv: int(kv[0])):
            report.append(f"| {b} | {rate:,.0f} | {rate / ev_rate:.1f}× |")
        best = max(lat.get("evals_per_second", {}).values(), default=0)
        covered = best >= ev_rate
        out["covered"] = bool(covered)
        report.append(
            "\n**Resolved: covered.** The model is faster per evaluation than the "
            "evaluator it replaces, so no batched-leaf commitment is required."
            if covered else
            "\n**Resolved by commitment.** Phase 3 must batch leaf evaluation; "
            "recorded here as an explicit decision rather than discovered later."
        )
        return ("PASS" if covered else "RESOLVED_BY_COMMITMENT"), out
    report.append("\n_onnx_latency.json missing — run export_onnx.py._")
    return "MISSING", out


def gate6(report, result):
    report.append("\n## Gate 6 — calibration\n")
    ev = json.loads((TRAIN_DIR / "evaluate.json").read_text())
    report.append(
        "The shipping requirement binds on the **single global T** that v1's "
        "`p_blue_win` actually ships with; the per-bucket table is reported but is "
        "a Phase 3 graph change."
    )
    report.append("\n| bucket | ECE | null p95 | inside null? | sharpness | T |")
    report.append("|---|---|---|---|---|---|")
    out = {"buckets": {}}
    for b, row in ev.get("buckets", {}).items():
        n = row.get("ece_null", {})
        out["buckets"][b] = {"ece": row["ece"], "inside": n.get("inside_null"),
                             "T": ev["temperatures"][b]}
        report.append(
            f"| {b} | {row['ece']:.4f} | {n.get('null_p95', float('nan')):.4f} | "
            f"{'yes' if n.get('inside_null') else 'NO'} | "
            f"{row['sharpness']['sd']:.4f} | {ev['temperatures'][b]:.4f} |"
        )
    g = ev.get("global_temperature", {})
    gm = g.get("metrics", {})
    inside = gm.get("ece_null", {}).get("inside_null")
    out["global"] = {"T": g.get("T"), "ece": gm.get("ece"), "inside_null": inside}
    report.append(
        f"\n**Global T = {g.get('T', float('nan')):.4f}** → test ECE "
        f"{gm.get('ece', float('nan')):.4f}, "
        f"{'inside' if inside else 'OUTSIDE'} its own null. "
        "The model card must state that v1's `p_blue_win` is calibrated at FULL "
        "drafts and that search consumers must use `logit`."
    )
    return ("PASS" if inside else "FAIL"), out


def main():
    report = ["# Task 6 — go / no-go benchmark\n",
              "Paired bootstrap over games, 1,000 resamples, 95% CI, every effect "
              "next to its MDE. Inside the MDE ⇒ **UNDERPOWERED**, never 'no effect'."]
    result = {}
    verdicts = {}
    for name, fn in (("gate1", gate1), ("gate2", gate2), ("gate3", gate3),
                     ("gate4", gate4), ("gate5", gate5), ("gate6", gate6)):
        try:
            v, out = fn(report, result)
        except (FileNotFoundError, KeyError) as e:
            v, out = "MISSING", {"error": str(e)}
            report.append(f"\n_{name} could not run: {e}_")
        verdicts[name] = v
        result[name] = out

    core = [verdicts[g] for g in ("gate1", "gate2", "gate3", "gate4")]
    if any(v == "MISSING" for v in verdicts.values()):
        overall = "INCOMPLETE"
    elif all(v == "PASS" for v in core) and verdicts["gate5"] in ("PASS", "RESOLVED_BY_COMMITMENT"):
        overall = "GO"
    elif any(v == "FAIL" for v in core):
        overall = "NO-GO"
    else:
        overall = "UNDERPOWERED"

    report.insert(2, f"\n## VERDICT: **{overall}**\n")
    report.insert(3, "| gate | verdict |\n|---|---|\n" + "\n".join(
        f"| {k} | {v} |" for k, v in verdicts.items()))
    result["verdicts"] = verdicts
    result["overall"] = overall

    (TRAIN_DIR / "benchmark_report.md").write_text("\n".join(report) + "\n")
    (TRAIN_DIR / "benchmark.json").write_text(json.dumps(result, indent=2, default=float))
    print("\n".join(report))
    print(f"\nVERDICT: {overall}")


if __name__ == "__main__":
    main()
