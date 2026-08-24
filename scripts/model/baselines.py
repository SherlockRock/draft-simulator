#!/usr/bin/env python
"""Task 2 — the floor the model has to clear, refit on the section B2 split.

    .venv/bin/python baselines.py [--folds] [--masked]

Four arms, every one fitted on the SAME train split, tuned on val-A, reported
on test:

  constant            p = the train blue-win rate
  logreg side         one-hot champion x role x side + bans + patch + region
  logreg antisym      the same features with +1 blue / -1 red at the same C
  antisymmetric FM    rank-16, 9,278 parameters (fm.py)

The exploration's 85/15 numbers are NOT the bar; these are. The two logregs are
fitted at the same C on purpose: if the antisymmetric one is not worse on
val-A, the constraint the model's trunk asserts is measured to be free rather
than assumed to be.

--folds  refits every arm on each rolling-origin fold. A paired difference is
         only paired if both arms saw the same training data, so gate 2's
         five-fold comparison needs five fit sets, not one.
--masked refits on the 4-6 masked replica (gate 3), which requires refitting on
         the masking distribution rather than scoring a full-draft fit with zeros.
"""

import argparse
import json
import time
from pathlib import Path

import numpy as np
import pandas as pd
import torch
from sklearn.linear_model import LogisticRegression

import features
import metrics
from common import ROOT
from fm import fit as fm_fit, predict_logit, AntisymmetricFM

C_GRID = [0.03, 0.1, 0.3, 1.0, 3.0]
# The FM's val loss is governed by the learning rate, not by weight decay:
# measured on the main split, wd over a 30x range moves val-A by 1e-5 (AdamW's
# decoupled decay is lr*wd per step, which is negligible at these lrs), while lr
# moves it by 4e-3. Sweeping only wd would have left the floor undertrained, so
# lr is the primary axis.
FM_LR_GRID = [3e-4, 1e-3, 3e-3]
FM_WD_GRID = [1e-2, 1e-1]
FM_EPOCHS = 15


def sigmoid(z):
    return 1.0 / (1.0 + np.exp(-np.asarray(z, dtype=float)))


def load(out_dir):
    ds = pd.read_parquet(out_dir / "dataset.parquet")
    vocab = json.loads((out_dir / "champion_vocab.json").read_text())
    n_champ = len(vocab["riot_id_to_index"]) + 2
    n_patch = len(json.loads((out_dir / "patch_vocab.json").read_text())["patch_to_index"])
    n_region = len(json.loads((out_dir / "region_vocab.json").read_text())["region_to_index"])
    return ds, n_champ, n_patch, n_region


def _design(df, dims, antisymmetric, masks=None):
    n_champ, n_patch, n_region = dims
    vp, vb = (None, None) if masks is None else masks
    return features.build(df, n_champ, n_patch, n_region, antisymmetric=antisymmetric,
                          visible_picks=vp, visible_bans=vb)


def logreg_arm(name, tr, va, te, dims, antisymmetric, masks, report, fixed_C=None):
    X_tr = _design(tr, dims, antisymmetric, masks.get("train"))
    X_va = _design(va, dims, antisymmetric, masks.get("val_a"))
    X_te = _design(te, dims, antisymmetric, masks.get("test"))
    y_tr, y_va, y_te = tr.win.to_numpy(), va.win.to_numpy(), te.win.to_numpy()

    sweep = []
    best = (float("inf"), None, None)
    grid = [fixed_C] if fixed_C is not None else C_GRID
    for C in grid:
        clf = LogisticRegression(C=C, max_iter=3000, solver="lbfgs")
        clf.fit(X_tr, y_tr)
        vl = metrics.log_loss(clf.predict_proba(X_va)[:, 1], y_va)
        sweep.append({"C": C, "val_a_log_loss": vl})
        if vl < best[0]:
            best = (vl, C, clf)
    val_loss, C, clf = best
    p_te = clf.predict_proba(X_te)[:, 1]
    row = metrics.report_row(name, p_te, y_te, with_null=True)
    row.update({"C": C, "val_a_log_loss": val_loss, "sweep": sweep,
                "n_features": X_tr.shape[1]})
    report.append(f"  {name:<26} C={C:<5} val-A {val_loss:.5f}  test {row['log_loss']:.5f}")
    return row, p_te, C


def fm_arm(tr, va, te, dims, masks, report, seed=0):
    n_champ, _, n_region = dims
    def t(df, m, key):
        champ = torch.from_numpy(features.champ_matrix(df)).long()
        region = torch.from_numpy(df.region_idx.to_numpy()).long()
        y = torch.from_numpy(df.win.to_numpy()).float()
        vis = None
        if masks.get(key) is not None:
            vis = torch.from_numpy(masks[key][0]).bool()
        return champ, region, y, vis

    c_tr, r_tr, y_tr, v_tr = t(tr, masks, "train")
    c_va, r_va, y_va, v_va = t(va, masks, "val_a")
    c_te, r_te, y_te, v_te = t(te, masks, "test")

    sweep, best = [], (float("inf"), None, None)
    for lr in FM_LR_GRID:
        for wd in FM_WD_GRID:
            t0 = time.time()
            model, vl, epoch = fm_fit(c_tr, r_tr, y_tr, c_va, r_va, y_va,
                                      n_champ, n_region, visible_tr=v_tr, visible_va=v_va,
                                      weight_decay=wd, lr=lr, epochs=FM_EPOCHS, seed=seed)
            sweep.append({"lr": lr, "weight_decay": wd, "val_a_log_loss": vl,
                          "best_epoch": epoch, "seconds": round(time.time() - t0, 1)})
            report.append(f"    FM lr={lr:<7.0e} wd={wd:<6.0e} val-A {vl:.5f}  "
                          f"(best epoch {epoch}/{FM_EPOCHS}, {time.time() - t0:.0f}s)")
            if vl < best[0]:
                best = (vl, (lr, wd), model)
    val_loss, (lr, wd), model = best
    p_te = sigmoid(predict_logit(model, c_te, r_te, v_te))
    row = metrics.report_row("antisymmetric FM", p_te, y_te, with_null=True)
    early = min(s_["best_epoch"] for s_ in sweep if s_["val_a_log_loss"] == val_loss)
    row.update({"lr": lr, "weight_decay": wd, "val_a_log_loss": val_loss, "sweep": sweep,
                "n_parameters": model.n_parameters(), "best_epoch": early,
                "note": ("best-by-val checkpoint. The FM genuinely overfits after ~3 epochs "
                         "at the winning lr (val rises monotonically to 0.708, past the "
                         "constant baseline), so this is an early-stopped model, not an "
                         "annealed one. Reported that way so the floor is not mistaken "
                         "for a converged fit.")})
    report.append(f"  {'antisymmetric FM':<26} lr={lr:.0e} wd={wd:.0e} val-A {val_loss:.5f}  "
                  f"test {row['log_loss']:.5f}  ({model.n_parameters():,} params, "
                  f"best epoch {early}/{FM_EPOCHS})")
    return row, p_te


def run_split(ds, dims, masks, report, label, seed=0):
    tr = ds[ds.split == "train"]
    va = ds[ds.split == "val_a"]
    te = ds[ds.split == "test"]
    y_te = te.win.to_numpy()
    report.append(f"\n### {label}\n")
    report.append(f"  train {len(tr):,}  val-A {len(va):,}  test {len(te):,}  "
                  f"train blue WR {tr.win.mean():.4f}  test blue WR {y_te.mean():.4f}")

    preds = {}
    rows = []

    p_const = np.full(len(te), tr.win.mean())
    rows.append(metrics.report_row("constant (train blue rate)", p_const, y_te, with_null=True))
    preds["constant"] = p_const
    report.append(f"  {'constant (train blue rate)':<26}       "
                  f"           test {rows[-1]['log_loss']:.5f}")

    row_side, p_side, C = logreg_arm("logreg side-specific", tr, va, te, dims,
                                     False, masks, report)
    rows.append(row_side)
    preds["logreg_side"] = p_side

    # Same C on purpose: this is a test of the CONSTRAINT, not of regularisation.
    row_anti, p_anti, _ = logreg_arm("logreg antisymmetric", tr, va, te, dims,
                                     True, masks, report, fixed_C=C)
    rows.append(row_anti)
    preds["logreg_antisym"] = p_anti

    row_fm, p_fm = fm_arm(tr, va, te, dims, masks, report, seed=seed)
    rows.append(row_fm)
    preds["fm"] = p_fm

    comparisons = []
    names = list(preds)
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            comparisons.append(
                metrics.compare(names[i], preds[names[i]], names[j], preds[names[j]], y_te)
            )

    # The free-constraint test, stated as its own line.
    anti_cost = row_anti["val_a_log_loss"] - row_side["val_a_log_loss"]
    d = metrics.log_loss_rows(p_anti, y_te) - metrics.log_loss_rows(p_side, y_te)
    report.append(
        f"\n  ANTISYMMETRY COST (val-A, same C={C}): {anti_cost:+.5f} nats "
        f"[{row_anti['n_features']:,} features vs {row_side['n_features']:,}]"
    )
    # Sign convention: d = antisym - side, so NEGATIVE means the antisymmetric
    # fit has the LOWER log-loss, i.e. the constraint helps.
    m = metrics.mde(d)
    if abs(d.mean()) < m:
        verdict = "within the MDE: the constraint is measured-free"
    elif d.mean() < 0:
        verdict = ("outside the MDE and NEGATIVE: the constraint does better than pay for "
                   "itself - half the features and a lower test log-loss")
    else:
        verdict = "outside the MDE and positive: the constraint costs something real"
    report.append(f"  on test: {d.mean():+.5f} nats (negative = antisymmetric is better), "
                  f"MDE {m:.5f} -> {verdict}")
    return {"label": label, "n_train": int(len(tr)), "n_test": int(len(te)),
            "rows": rows, "comparisons": comparisons,
            "antisymmetry_cost_val_a": float(anti_cost),
            "antisymmetry_cost_test": float(d.mean()),
            "antisymmetry_cost_test_mde": float(metrics.mde(d))}, preds


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "data/training"))
    ap.add_argument("--folds", action="store_true", help="also refit on the 5 rolling-origin folds")
    ap.add_argument("--masked", action="store_true", help="also refit on the 4-6 masked replica")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    out_dir = Path(args.out)
    ds, n_champ, n_patch, n_region = load(out_dir)
    dims = (n_champ, n_patch, n_region)
    report = ["# Task 2 — baselines (the floor)\n",
              f"vocab {n_champ} champions, {n_patch} patches, {n_region} regions"]

    result = {"main": None, "folds": [], "masked": None}
    main_res, _ = run_split(ds, dims, {}, report, "main 80/10/10 split", seed=args.seed)
    result["main"] = main_res

    if args.masked:
        ms = pd.read_parquet(out_dir / "masked_states.parquet")
        te = ds[ds.split == "test"]
        vp, vb = features.masks_from_masked_states(ms, te.match_id)
        # Gate 3 requires refitting ON the masking distribution. Draw a mask for
        # every train/val row from the same distribution rather than reusing the
        # test masks, which belong to different games.
        from prepare import build_masked_states
        rng_ds = ds.copy()
        rng_ds["split"] = "test"          # build_masked_states operates on the test split
        all_ms = build_masked_states(rng_ds, [])
        vp_all, vb_all = features.masks_from_masked_states(all_ms, ds.match_id)
        by_split = {s: (vp_all[(ds.split == s).to_numpy()], vb_all[(ds.split == s).to_numpy()])
                    for s in ("train", "val_a", "test")}
        by_split["test"] = (vp, vb)
        masked_res, _ = run_split(ds, dims, by_split, report,
                                  "4-6 masked replica (gate 3 floor)", seed=args.seed)
        result["masked"] = masked_res

    if args.folds:
        folds = pd.read_parquet(out_dir / "folds.parquet")
        for k in sorted(folds.fold.unique()):
            roles = dict(zip(folds[folds.fold == k].match_id, folds[folds.fold == k].role))
            sub = ds[ds.match_id.isin(roles)].copy()
            sub["split"] = [roles[m] for m in sub.match_id]
            if not {"train", "val_a", "test"} <= set(sub.split.unique()):
                continue
            fold_res, _ = run_split(sub, dims, {}, report, f"rolling-origin fold {k}",
                                    seed=args.seed)
            result["folds"].append(fold_res)

    (out_dir / "baselines.json").write_text(json.dumps(result, indent=2))
    (out_dir / "baselines_report.md").write_text("\n".join(report) + "\n")
    print("\n".join(report))
    print(f"\nwrote {out_dir}/baselines.json")


if __name__ == "__main__":
    main()
