"""Train the FM on the SERVING fill distribution and measure it paired.

Review round 2 (Opus F1/F4, Codex #2/#3) established that neither measured FM
fit matches serving: the full-draft fit is wrong deep, the gate-3 refit (4-6
masked band) is wrong shallow, and the paired ship evidence was collected on
the former while rev 2 shipped the latter. This script trains the missing
configuration — masks drawn per train row from augment.Masker (70% reachable
prefix patterns weighted by the measured achieved-depth distribution, 30%
strategic), per-role linear kept — and re-runs the decision measurements:

  1. paired sibling MRR vs the production evaluator (identical sets),
  2. paired full-draft log-loss vs the calibrated evaluator AND logreg_antisym,
  3. per-fill-bucket log-loss (0-0 / 1-3 / 4-6 / 7-9 masked) against the
     full-draft fit, the 4-6 refit and the constant — the fill-coverage table
     review round 2 said was missing.

3 seeds at the winning config; the per-seed spread is the retrain noise floor.
Writes serve_fm_seed{k}.pt and serve_fm_measure.{json,md} to data/training/.
"""

import json

import numpy as np
import pandas as pd
import torch

import metrics
from augment import Masker, load_depth_distribution
from baselines import FM_EPOCHS, FM_LR_GRID, FM_WD_GRID, fm_fit, sigmoid
from features import champ_matrix
from fm import AntisymmetricFM, predict_logit
from measure_vs_evaluator import crossfit_platt, dims_of, rr_top1_of
from prepare import build_masked_states
from sibling_scores import TRAIN_DIR, build_variants, fm_scores, group

BUCKETS = [(0, 0), (1, 3), (4, 6), (7, 9)]
SERVE_MASK_SEED = 20260827


def tensors(df):
    return (torch.from_numpy(champ_matrix(df)).long(),
            torch.from_numpy(df.region_idx.to_numpy()).long(),
            torch.from_numpy(df.win.to_numpy()).float())


def serve_masks(n, seed):
    masker = Masker(load_depth_distribution(TRAIN_DIR / "leaf_eval_stats.json")[0],
                    seed=seed)
    vp, _ = masker.draw(n)   # the FM has no ban input
    return torch.from_numpy(vp).bool()


def train_serve_fm(ds, dims, report):
    n_champ, _, n_region = dims
    tr = ds[ds.split == "train"].reset_index(drop=True)
    va = ds[ds.split == "val_a"].reset_index(drop=True)
    c_tr, r_tr, y_tr = tensors(tr)
    c_va, r_va, y_va = tensors(va)
    v_tr = serve_masks(len(tr), SERVE_MASK_SEED)
    v_va = serve_masks(len(va), SERVE_MASK_SEED + 1)

    report.append("\n## Serving-distribution FM sweep (masked val-A selects)\n")
    sweep, best = [], (float("inf"), None)
    for lr in FM_LR_GRID:
        for wd in FM_WD_GRID:
            _, vl, epoch = fm_fit(c_tr, r_tr, y_tr, c_va, r_va, y_va,
                                  n_champ, n_region, visible_tr=v_tr, visible_va=v_va,
                                  weight_decay=wd, lr=lr, epochs=FM_EPOCHS, seed=0)
            sweep.append({"lr": lr, "weight_decay": wd,
                          "val_a_log_loss": vl, "best_epoch": epoch})
            report.append(f"  lr={lr:<7.0e} wd={wd:<6.0e} masked val-A {vl:.5f} "
                          f"(epoch {epoch}/{FM_EPOCHS})")
            if vl < best[0]:
                best = (vl, (lr, wd))
    _, (lr, wd) = best
    report.append(f"\nselected lr={lr:.0e} wd={wd:.0e}; 3 seeds:")
    models, val_losses = [], []
    for seed in range(3):
        m, vl, _ = fm_fit(c_tr, r_tr, y_tr, c_va, r_va, y_va,
                          n_champ, n_region, visible_tr=v_tr, visible_va=v_va,
                          weight_decay=wd, lr=lr, epochs=FM_EPOCHS, seed=seed)
        torch.save(m.state_dict(), TRAIN_DIR / f"serve_fm_seed{seed}.pt")
        models.append(m)
        val_losses.append(vl)
        report.append(f"  seed {seed}: masked val-A {vl:.5f}")
    return models, {"lr": lr, "weight_decay": wd, "sweep": sweep,
                    "seed_val_losses": val_losses}


def load_fm(path, dims):
    n_champ, _, n_region = dims
    m = AntisymmetricFM(n_champ, n_region)
    m.load_state_dict(torch.load(TRAIN_DIR / path))
    m.eval()
    return m


def sibling_arm(models, ds, report, out):
    z = np.load(TRAIN_DIR / "sibling_scores.npz", allow_pickle=True)
    has_ev, ev = z["has_evaluator"], z["evaluator"]
    sib = pd.read_parquet(TRAIN_DIR / "sibling_sets.parquet")
    vocab = json.loads((TRAIN_DIR / "champion_vocab.json").read_text())
    champ, _, _, region, set_id, slots, _ = build_variants(sib, ds, None, vocab)

    idx = [i for i in np.flatnonzero(has_ev)
           if np.isfinite(np.asarray(ev[i], dtype=float)).all()]
    rr_ev = np.array([rr_top1_of(np.asarray(ev[i], dtype=float))[0] for i in idx])

    report.append(f"\n## Arm 1 — paired sibling MRR vs evaluator (n = {len(idx):,})\n")
    report.append("| seed | serve-FM MRR | Δ vs evaluator | 95% CI | MDE | verdict |")
    report.append("|---|---|---|---|---|---|")
    per_seed = []
    for k, m in enumerate(models):
        sets = group(fm_scores(m, champ, region, slots), set_id, len(sib))
        rr = np.array([rr_top1_of(np.asarray(sets[i], dtype=float))[0] for i in idx])
        boot = metrics.paired_bootstrap(rr - rr_ev)
        v = {"PASS": "CANDIDATE_BETTER", "FAIL": "EVALUATOR_BETTER",
             "UNDERPOWERED": "UNDERPOWERED"}[metrics.verdict(boot, lower_is_better=False)]
        report.append(f"| {k} | {rr.mean():.4f} | {boot['mean']:+.5f} | "
                      f"[{boot['ci_lo']:+.5f}, {boot['ci_hi']:+.5f}] | "
                      f"{boot['mde']:.5f} | **{v}** |")
        per_seed.append({**boot, "verdict": v, "mrr": float(rr.mean())})
    out["sibling_vs_evaluator"] = per_seed


def fulldraft_arm(models, ds, report, out):
    te = ds[ds.split == "test"].reset_index(drop=True)
    ev = pd.read_csv(TRAIN_DIR / "evaluator_scores.csv")
    z = np.load(TRAIN_DIR / "baseline_preds.npz", allow_pickle=True)
    preds = pd.DataFrame({"match_id": z["test_ids"], "logreg_antisym": z["logreg_antisym"]})
    df = te.merge(ev, on="match_id").merge(preds, on="match_id")
    y = df.win.to_numpy()
    p_ev = crossfit_platt(df.score_blue_minus_red.to_numpy(), y)
    c, r, _ = tensors(df)

    report.append(f"\n## Arm 2 — full-draft log-loss (n = {len(df):,})\n")
    report.append("| seed | serve-FM ll | vs evaluator | vs logreg_antisym |")
    report.append("|---|---|---|---|")
    per_seed = []
    for k, m in enumerate(models):
        p = sigmoid(np.asarray(predict_logit(m, c, r)))
        vs_ev = metrics.compare("serve_fm", p, "evaluator", p_ev, y)
        vs_lg = metrics.compare("serve_fm", p, "logreg_antisym",
                                df.logreg_antisym.to_numpy(), y)
        report.append(f"| {k} | {metrics.log_loss(p, y):.5f} | "
                      f"{vs_ev['delta_logloss_a_minus_b']:+.5f} **{vs_ev['verdict']}** | "
                      f"{vs_lg['delta_logloss_a_minus_b']:+.5f} **{vs_lg['verdict']}** |")
        per_seed.append({"log_loss": float(metrics.log_loss(p, y)),
                         "vs_evaluator": vs_ev, "vs_logreg": vs_lg})
    out["fulldraft"] = per_seed


def bucket_arm(models, ds, dims, report, out):
    serve = models[0]
    rivals = {"fulldraft_fm": load_fm("baseline_fm.pt", dims),
              "masked46_fm": load_fm("baseline_fm_masked.pt", dims)}
    te = ds[ds.split == "test"].reset_index(drop=True)
    c_te, r_te, y_t = tensors(te)
    y = te.win.to_numpy()
    base = te.win.mean()

    report.append("\n## Fill-bucket coverage (test replicas; one mask per row/bucket)\n")
    report.append("| bucket | serve-FM | full-draft FM | 4-6 refit FM | constant | "
                  "serve − best rival (MDE) |")
    report.append("|---|---|---|---|---|---|")
    out["buckets"] = {}
    for bucket in BUCKETS:
        ms = build_masked_states(ds, [], bucket=bucket)
        lookup = ms.set_index("match_id")
        vp = np.stack([np.asarray(lookup.loc[m].visible_picks, dtype=bool)
                       for m in te.match_id])
        v = torch.from_numpy(vp).bool()
        row = {}
        losses = {}
        for name, m in {"serve_fm": serve, **rivals}.items():
            p = sigmoid(np.asarray(predict_logit(m, c_te, r_te, visible=v)))
            losses[name] = metrics.log_loss_rows(p, y)
            row[name] = float(np.mean(losses[name]))
        const = float(np.mean(metrics.log_loss_rows(np.full(len(y), base), y)))
        rival = min(("fulldraft_fm", "masked46_fm"), key=lambda n: row[n])
        d = losses["serve_fm"] - losses[rival]
        tag = f"{d.mean():+.5f} vs {rival} (MDE {metrics.mde(d):.5f})"
        report.append(f"| {bucket[0]}-{bucket[1]} | {row['serve_fm']:.5f} | "
                      f"{row['fulldraft_fm']:.5f} | {row['masked46_fm']:.5f} | "
                      f"{const:.5f} | {tag} |")
        out["buckets"][f"{bucket[0]}-{bucket[1]}"] = {**row, "constant": const,
                                                     "serve_minus_best_rival": float(d.mean()),
                                                     "mde": metrics.mde(d)}


def main():
    torch.manual_seed(0)
    ds = pd.read_parquet(TRAIN_DIR / "dataset.parquet")
    dims = dims_of(ds)
    report = ["# Serving-distribution FM — training + paired measurement"]
    out = {}
    models, cfg = train_serve_fm(ds, dims, report)
    out["config"] = cfg
    sibling_arm(models, ds, report, out)
    fulldraft_arm(models, ds, report, out)
    bucket_arm(models, ds, dims, report, out)
    (TRAIN_DIR / "serve_fm_measure.json").write_text(json.dumps(out, indent=2, default=float))
    text = "\n".join(report) + "\n"
    (TRAIN_DIR / "serve_fm_measure.md").write_text(text)
    print(text)


if __name__ == "__main__":
    main()
