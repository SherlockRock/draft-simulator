#!/usr/bin/env python
"""Task 4 — metrics, calibration and probes for a trained checkpoint.

    .venv/bin/python evaluate.py [--checkpoint model_seed0.pt]

Everything ships with its MDE. At 15,493 test rows the log-loss MDE is roughly
the size of the entire Part A signal band, so a null result here is reported as
UNDERPOWERED, never as "no effect".

Masked-slot buckets are FULL REPLICAS, not a partition: every test row is
scored at each mask level, with one mask drawn per (row, bucket) from the
prefix distribution conditioned on that bucket, a fixed seed, and the same mask
reused by every scorer. All four buckets are reachable as search leaves
(0 -> turn 20; 1-3 -> turns 17,19; 4-6 -> turns 11-16; 7-9 -> turns 7,9).
"""

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
import torch

import metrics
import serve
from common import ROOT
from model import DraftModel
from prepare import build_masked_states
from train import load_all, tensors

TRAIN_DIR = ROOT / "data/training"
BUCKETS = [(0, 0), (1, 3), (4, 6), (7, 9)]


def sigmoid(z):
    return 1.0 / (1.0 + np.exp(-np.asarray(z, dtype=float)))


@torch.no_grad()
def logits(model, t, champ, role, bans=None, chunk=8192):
    model.eval()
    bans = t["bans"] if bans is None else bans
    out = []
    for i in range(0, len(t["win"]), chunk):
        s = slice(i, i + chunk)
        out.append(
            model(champ[s], role[s], bans[s], t["patch"][s], t["region"][s])["win_logit"]
        )
    return torch.cat(out).numpy()


def bucket_replica(ds, split_df, bucket, seed_offset):
    """One mask per row, drawn from the prefix distribution conditioned on
    `bucket`. `build_masked_states` is the same routine prepare.py uses, so the
    4-6 replica reproduces `masked_states.parquet` exactly."""
    frame = split_df.copy()
    frame["split"] = "test"
    return build_masked_states(frame, [], bucket=bucket)


def apply_mask(champ, role, bans, ms, order):
    """Blank the masked pick slots (UNKNOWN + residual roles) and hide bans."""
    from roles import empty_slot_role_probs

    lookup = ms.set_index("match_id")
    vp = np.stack([np.asarray(lookup.loc[m].visible_picks, dtype=bool) for m in order])
    vb = np.stack([np.asarray(lookup.loc[m].visible_bans, dtype=bool) for m in order])
    champ = champ.copy()
    role = role.copy()
    bans = bans.copy()
    for side in (0, 1):
        sl = slice(side * 5, side * 5 + 5)
        hidden = ~vp[:, sl]
        team_role = role[:, sl].copy()
        team_role[hidden] = 0.0
        for i in np.flatnonzero(hidden.any(axis=1)):
            residual = empty_slot_role_probs(team_role[i])
            team_role[i][hidden[i]] = residual
        role[:, sl] = team_role
        champ[:, sl][hidden] = 0
    bans[~vb] = 1                      # NONE
    return champ, role, bans, vp, vb


def score_arm(model, t, champ, role, bans):
    return sigmoid(logits(model, t, torch.from_numpy(champ).long(),
                          torch.from_numpy(role), torch.from_numpy(bans).long()))


def probe_c_rare_champions(model, ds, i2a, report):
    """Probe (c): are the rarest champions' embeddings degenerate?"""
    train = ds[ds.split == "train"]
    counts = pd.Series(
        np.concatenate([train[f"champ_{i}"].to_numpy() for i in range(10)])
    ).value_counts()
    norms = model.champ_emb.weight.detach().norm(dim=1).numpy()
    rare = counts.tail(20).index.tolist()
    common = counts.head(20).index.tolist()
    out = {
        "rarest_20": [
            {"alias": i2a.get(int(c), str(c)), "train_picks": int(counts[c]),
             "emb_norm": float(norms[c])}
            for c in rare
        ],
        "mean_norm_rarest_20": float(np.mean([norms[c] for c in rare])),
        "mean_norm_commonest_20": float(np.mean([norms[c] for c in common])),
        "mean_norm_all": float(np.mean([norms[c] for c in counts.index])),
    }
    report.append(
        f"\n**Probe (c) — rare champions.** mean embedding norm: rarest 20 "
        f"{out['mean_norm_rarest_20']:.4f} vs commonest 20 "
        f"{out['mean_norm_commonest_20']:.4f} (all {out['mean_norm_all']:.4f}). "
        "The champion table carries a higher weight decay precisely to shrink rare "
        "champions toward the population, so a LOWER norm here is the intended "
        "behaviour, not a defect."
    )
    return out


def probe_a_symmetry(model, t, champ, role, bans, region, report):
    """Probe (a) on real rows, including asymmetric role_probs."""
    with torch.no_grad():
        f = model(champ, role, bans, t["patch"], t["region"])["win_logit"]
        b = model(
            torch.cat([champ[:, 5:], champ[:, :5]], 1),
            torch.cat([role[:, 5:], role[:, :5]], 1),
            torch.cat([bans[:, 5:], bans[:, :5]], 1),
            t["patch"], t["region"],
        )["win_logit"]
    resid = (f + b - 2 * model.region_bias[region]).abs().max().item()
    report.append(f"\n**Probe (a) — symmetry.** max |logit(b,r) + logit(r,b) - 2*b_region| "
                  f"= {resid:.2e} over {len(f):,} test rows (exact by construction).")
    return {"max_residual": resid, "n": int(len(f))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", default="model_seed0.pt")
    ap.add_argument("--out", default=str(TRAIN_DIR))
    args = ap.parse_args()
    out_dir = Path(args.out)

    ds, i2a, dims, prior, factors = load_all()
    n_champ, n_patch, n_region = dims
    sweep = json.loads((out_dir / "sweep_aug.json").read_text())["winner"]
    model = DraftModel(n_champ, n_patch, n_region, width=sweep["width"],
                       dropout=sweep["dropout"])
    model.load_state_dict(torch.load(out_dir / args.checkpoint))
    model.eval()

    solver_roles = pd.read_csv(out_dir / "solver_roles.csv")
    test = ds[ds.split == "test"].reset_index(drop=True)
    val_b = ds[ds.split == "val_b"].reset_index(drop=True)
    t_te, t_vb = tensors(test), tensors(val_b)
    y_te = t_te["win"].numpy()

    report = ["# Task 4 — evaluation\n",
              f"checkpoint `{args.checkpoint}`, config {sweep}",
              f"test n = {len(test):,}"]
    result = {"config": sweep, "n_test": int(len(test))}

    # --- arms on full drafts -------------------------------------------
    champ_riot, role_riot = serve.riot_inputs(test)
    bans_te = t_te["bans"].numpy()
    arms = {"riot_roles": (champ_riot, role_riot)}
    for arm in ("argmax", "posterior"):
        arms[f"solver_{arm}"] = serve.build(test, solver_roles, i2a, "full", arm)

    preds = {}
    report.append("\n## Full drafts\n")
    report.append(f"| arm | log-loss | Brier | AUC | acc | ECE | sharpness | ECE null |")
    report.append("|---|---|---|---|---|---|---|---|")
    rows = {}
    for name, (c, r) in arms.items():
        p = score_arm(model, t_te, c, r, bans_te)
        preds[name] = p
        row = metrics.report_row(name, p, y_te, with_null=True)
        rows[name] = row
        report.append(
            f"| {name} | {row['log_loss']:.5f} | {row['brier']:.5f} | {row['auc']:.4f} | "
            f"{row['accuracy']:.4f} | {row['ece']:.4f} | {row['sharpness']['sd']:.4f} | "
            f"{'inside' if row['ece_null']['inside_null'] else 'OUTSIDE'} "
            f"(p{row['ece_null']['null_percentile']:.0f}) |"
        )
    result["full_draft"] = rows

    # The ground-truth-vs-solver delta is a DIAGNOSTIC, not a threshold.
    d = metrics.log_loss_rows(preds["solver_posterior"], y_te) - metrics.log_loss_rows(
        preds["riot_roles"], y_te
    )
    result["serve_gap"] = {"delta": float(d.mean()), "mde": float(metrics.mde(d))}
    report.append(
        f"\n**Serve gap** (solver posterior - Riot truth): {d.mean():+.5f} nats, "
        f"MDE {metrics.mde(d):.5f}. Diagnostic only — gate 4 asks whether the "
        "solver-scored model still beats the baselines, not how close it is to "
        "ground truth (a ratio threshold there is passable by making the model "
        "role-blind)."
    )
    # All-population-prior arm: what the model scores knowing no roles at all.
    role_flat = np.repeat(prior[champ_riot][:, :, :], 1, axis=0).astype(np.float32)
    role_flat = role_flat / role_flat.sum(axis=2, keepdims=True)
    p_prior = score_arm(model, t_te, champ_riot, role_flat, bans_te)
    result["all_population_prior"] = metrics.report_row("all_population_prior", p_prior, y_te)
    report.append(
        f"**All-population-prior roles**: log-loss "
        f"{result['all_population_prior']['log_loss']:.5f} — the floor if role "
        "information were unavailable entirely."
    )

    # --- masked-slot bucket replicas + per-bucket temperature -----------
    report.append("\n## Masked-slot buckets (full replicas, not a partition)\n")
    report.append("| bucket | test log-loss | AUC | acc | ECE | sharpness | T (val-B) |")
    report.append("|---|---|---|---|---|---|---|")
    temperatures, bucket_rows = {}, {}
    for bi, bucket in enumerate(BUCKETS):
        ms_te = bucket_replica(ds, test, bucket, bi)
        c, r, b, _, _ = apply_mask(champ_riot, role_riot, bans_te, ms_te, test.match_id)
        lg = logits(model, t_te, torch.from_numpy(c).long(), torch.from_numpy(r),
                    torch.from_numpy(b).long())

        # Temperature is fitted on a val-B replica at the SAME bucket.
        ms_vb = bucket_replica(ds, val_b, bucket, 100 + bi)
        cv, rv, bv, _, _ = apply_mask(*serve.riot_inputs(val_b), t_vb["bans"].numpy(),
                                      ms_vb, val_b.match_id)
        lg_vb = logits(model, t_vb, torch.from_numpy(cv).long(), torch.from_numpy(rv),
                       torch.from_numpy(bv).long())
        T = metrics.fit_temperature(lg_vb, t_vb["win"].numpy())
        temperatures[f"{bucket[0]}-{bucket[1]}"] = T

        row = metrics.report_row(f"masked {bucket}", sigmoid(lg / T), y_te, with_null=True)
        bucket_rows[f"{bucket[0]}-{bucket[1]}"] = row
        report.append(
            f"| {bucket[0]}-{bucket[1]} | {row['log_loss']:.5f} | {row['auc']:.4f} | "
            f"{row['accuracy']:.4f} | {row['ece']:.4f} | {row['sharpness']['sd']:.4f} | "
            f"{T:.4f} |"
        )
    result["buckets"] = bucket_rows
    result["temperatures"] = temperatures

    # Gate 6 binds on the SINGLE GLOBAL T that v1 actually ships with.
    champ_vb, role_vb = serve.riot_inputs(val_b)
    lg_vb_full = logits(model, t_vb, torch.from_numpy(champ_vb).long(),
                        torch.from_numpy(role_vb), t_vb["bans"])
    T_global = metrics.fit_temperature(lg_vb_full, t_vb["win"].numpy())
    lg_te_full = logits(model, t_te, torch.from_numpy(champ_riot).long(),
                        torch.from_numpy(role_riot), torch.from_numpy(bans_te).long())
    row_global = metrics.report_row("global T (what v1 ships)", sigmoid(lg_te_full / T_global),
                                    y_te, with_null=True)
    result["global_temperature"] = {"T": T_global, "metrics": row_global}
    report.append(
        f"\n**Global temperature** (the one v1's `p_blue_win` ships with): T = "
        f"{T_global:.4f}; test ECE {row_global['ece']:.4f}, "
        f"{'inside' if row_global['ece_null']['inside_null'] else 'OUTSIDE'} its null. "
        "Per-bucket T is reported above but is a Phase 3 graph change; v1's "
        "`p_blue_win` is calibrated at FULL drafts and search consumers must use `logit`."
    )

    # --- probes ---------------------------------------------------------
    result["probe_a"] = probe_a_symmetry(
        model, t_te,
        torch.from_numpy(arms["solver_posterior"][0]).long(),
        torch.from_numpy(arms["solver_posterior"][1]),
        t_te["bans"], t_te["region"], report,
    )
    result["probe_c"] = probe_c_rare_champions(model, ds, i2a, report)

    # Gate 3 scores the model on the CANONICAL masked_states.parquet - the same
    # states Task 2b solved and the same ones the masked baselines were refit on -
    # rather than a freshly drawn 4-6 replica, so the comparison is truly paired.
    ms_shared = pd.read_parquet(out_dir / "masked_states.parquet")
    cm, rm, bm, _, _ = apply_mask(champ_riot, role_riot, bans_te, ms_shared, test.match_id)
    p_masked = score_arm(model, t_te, cm, rm, bm)
    np.save(out_dir / "model_masked_preds.npy", p_masked)
    row_masked = metrics.report_row("model @ shared 4-6 replica", p_masked, y_te,
                                    with_null=True)
    result["masked_shared"] = row_masked
    report.append(
        f"\n**Shared 4–6 masked replica** (gate 3's paired arm): log-loss "
        f"{row_masked['log_loss']:.5f}, AUC {row_masked['auc']:.4f}, "
        f"accuracy {row_masked['accuracy']:.4f}."
    )

    (out_dir / "evaluate.json").write_text(json.dumps(result, indent=2, default=float))
    (out_dir / "evaluate_report.md").write_text("\n".join(report) + "\n")
    np.save(out_dir / "model_test_preds.npy",
            np.stack([preds["riot_roles"], preds["solver_argmax"], preds["solver_posterior"]]))
    print("\n".join(report))
    print(f"\nwrote {out_dir}/evaluate.json")


if __name__ == "__main__":
    main()
