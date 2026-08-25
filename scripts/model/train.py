#!/usr/bin/env python
"""Task 3 — train the model and run the staged sweep.

    .venv/bin/python train.py --stage arch          # 8 architecture configs
    .venv/bin/python train.py --stage aug           # 3x3 p/p_swap at the winner
    .venv/bin/python train.py --stage final         # 3 seeds of the winner
    .venv/bin/python train.py --single --width 256 ...

Selection runs on FOLD 1's val-A, never the main split's: the main split's
val/test windows overlap folds 4-5's test slices, so tuning on them would leak
into the rolling-origin evaluation. The main split's val-A is used only to pick
that run's own checkpoint.

Fixed 30-epoch OneCycle with NO early stopping - early stopping under OneCycle
selects an un-annealed checkpoint - but the best-by-val-A checkpoint is kept.
Whole dataset resident as tensors, batches by randperm indexing: at 140k
parameters a DataLoader's collate is the dominant cost.
"""

import argparse
import json
import time
from pathlib import Path

import numpy as np
import pandas as pd
import torch
from torch import nn

import metrics
import serve
from augment import Augmenter, Masker, load_depth_distribution
from common import ROOT
from model import DraftModel
from roles import factor_table_from_prior, prior_from_frame

TRAIN_DIR = ROOT / "data/training"
LEAF_STATS = Path(__file__).resolve().parent / "leaf_eval_stats.json"
EPOCHS = 30
BATCH = 512
LR = 4e-4
WEIGHT_DECAY = 0.05
CHAMPION_DECAY = 0.2


def load_all():
    ds = pd.read_parquet(TRAIN_DIR / "dataset.parquet")
    vocab = json.loads((TRAIN_DIR / "champion_vocab.json").read_text())
    i2a = {int(k): v for k, v in vocab["index_to_alias"].items()}
    n_champ = len(i2a) + 2
    n_patch = len(json.loads((TRAIN_DIR / "patch_vocab.json").read_text())["patch_to_index"])
    n_region = len(json.loads((TRAIN_DIR / "region_vocab.json").read_text())["region_to_index"])

    # The augmentation prior and solver factors are built PER TRAINING FRAME in
    # train_one (a rolling-origin fold's prior must not see its own test
    # window); these are the main split's, for the scripts that only serve.
    prior = prior_from_frame(ds[ds.split == "train"], n_champ)
    factors = factor_table_from_prior(prior, i2a)
    return ds, i2a, (n_champ, n_patch, n_region), prior, factors


def seed_checkpoints(out_dir):
    """Every deliverable checkpoint, in seed order."""
    return sorted(p.name for p in Path(out_dir).glob("model_seed*.pt"))


def tensors(df):
    return {
        "champ": torch.from_numpy(
            np.stack([df[f"champ_{i}"].to_numpy() for i in range(10)], axis=1)
        ).long(),
        "bans": torch.from_numpy(
            np.stack([df[f"ban_{i}"].to_numpy() for i in range(10)], axis=1)
        ).long(),
        "patch": torch.from_numpy(df.patch_idx.to_numpy().copy()).long(),
        "region": torch.from_numpy(df.region_idx.to_numpy().copy()).long(),
        "win": torch.from_numpy(df.win.to_numpy().copy()).float(),
        "gold": torch.from_numpy(df.gold_diff15.to_numpy().copy()).float(),
        "dur": torch.from_numpy(df.log_duration.to_numpy().copy()).float(),
    }


@torch.no_grad()
def evaluate(model, t, champ, role, chunk=8192):
    model.eval()
    logits = []
    for i in range(0, len(t["win"]), chunk):
        s = slice(i, i + chunk)
        logits.append(
            model(champ[s], role[s], t["bans"][s], t["patch"][s], t["region"][s])["win_logit"]
        )
    logit = torch.cat(logits).numpy()
    y = t["win"].numpy()
    return metrics.log_loss(1 / (1 + np.exp(-logit)), y), logit


def train_one(config, data, log=print):
    ds, i2a, dims, _prior, _factors = data
    n_champ, n_patch, n_region = dims
    split_col = config.get("split_col", "split")
    tr = ds[ds[split_col] == "train"]
    va = ds[ds[split_col] == "val_a"]
    # Prior and factors from THIS frame's train rows only.
    prior = prior_from_frame(tr, n_champ)
    factors = factor_table_from_prior(prior, i2a)

    t_tr, t_va = tensors(tr), tensors(va)
    # Targets standardised on TRAIN statistics only.
    for k in ("gold", "dur"):
        mu, sd = t_tr[k].mean(), t_tr[k].std().clamp(min=1e-6)
        t_tr[k] = (t_tr[k] - mu) / sd
        t_va[k] = (t_va[k] - mu) / sd

    champ_tr = np.stack([tr[f"champ_{i}"].to_numpy() for i in range(10)], axis=1)

    # val-A is scored two ways every epoch: Riot's own placement (the
    # diagnostic) and the solver's posterior (the serve-realistic quantity the
    # augmentation grid is tuned on, so the tuned quantity IS the gated one).
    va_champ_riot, va_role_riot = serve.riot_inputs(va)
    va_riot = (torch.from_numpy(va_champ_riot).long(), torch.from_numpy(va_role_riot))
    va_solver = None
    if config.get("solver_roles") is not None:
        # All-or-nothing: a partially covered val would silently mix solver and
        # Riot placements and make the selection criterion differ by fold.
        cov = serve.coverage(va, config["solver_roles"], i2a)
        if cov == 1.0:
            c, r = serve.build(va, config["solver_roles"], i2a, "full", "posterior")
            va_solver = (torch.from_numpy(c).long(), torch.from_numpy(r))
        else:
            log(f"    WARNING: solver roles cover {cov:.1%} of val-A — selecting on "
                "Riot roles for this run (re-run Task 2b to fix)")

    depth_dist, depth_src = load_depth_distribution(LEAF_STATS)
    masker = Masker(depth_dist, seed=config["seed"])
    aug = Augmenter(factors, prior, p=config["p"], p_swap=config["p_swap"],
                    seed=config["seed"])

    torch.manual_seed(config["seed"])
    model = DraftModel(n_champ, n_patch, n_region, width=config["width"],
                       dropout=config["dropout"])
    opt = torch.optim.AdamW(
        model.parameter_groups(WEIGHT_DECAY, CHAMPION_DECAY), lr=LR
    )
    steps = EPOCHS * (len(tr) // BATCH)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=LR, total_steps=steps,
                                                pct_start=0.2)
    bce = nn.BCEWithLogitsLoss()
    huber = nn.HuberLoss()
    aux = config["aux"]

    history, best = [], (float("inf"), -1, None)
    g = torch.Generator().manual_seed(config["seed"])
    for epoch in range(EPOCHS):
        t0 = time.time()
        # Fresh masks and augmentation every epoch.
        vp, vb = masker.draw(len(tr))
        champ_ep, role_ep = aug.apply(champ_tr, vp)
        champ_t = torch.from_numpy(champ_ep).long()
        role_t = torch.from_numpy(role_ep)
        bans_t = t_tr["bans"].clone()
        bans_t[~torch.from_numpy(vb)] = 1          # NONE for a not-yet-revealed ban

        model.train()
        perm = torch.randperm(len(tr), generator=g)
        diag = []
        for i in range(0, len(tr) - BATCH + 1, BATCH):
            idx = perm[i : i + BATCH]
            opt.zero_grad()
            out = model(champ_t[idx], role_t[idx], bans_t[idx],
                        t_tr["patch"][idx], t_tr["region"][idx], diagnostics=(i == 0))
            loss = bce(out["win_logit"], t_tr["win"][idx])
            if aux > 0:
                loss = loss + aux * (
                    huber(out["gold_diff15"], t_tr["gold"][idx])
                    + huber(out["log_duration"], t_tr["dur"][idx])
                )
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            sched.step()
            with torch.no_grad():
                model.champ_emb.weight[0].zero_()
                model.ban_emb.weight[0].zero_()
                model.ban_emb.weight[1].zero_()
            if i == 0:
                diag = [float(out["cos_h"]), float(out["a_over_s"])]

        ll_riot, _ = evaluate(model, t_va, *va_riot)
        ll_solver = evaluate(model, t_va, *va_solver)[0] if va_solver else None
        row = {
            "epoch": epoch,
            "val_a_log_loss": ll_riot,
            "val_a_log_loss_solver": ll_solver,
            "cos_h": diag[0] if diag else None,
            "a_over_s": diag[1] if diag else None,
            "seconds": round(time.time() - t0, 1),
        }
        history.append(row)
        # Checkpoint selection is on the SERVE-realistic quantity when it is
        # available, so the selected model is the one gate 4 will be judged on.
        criterion = ll_solver if ll_solver is not None else ll_riot
        if criterion < best[0]:
            best = (criterion, epoch, {k: v.clone() for k, v in model.state_dict().items()})
        log(f"    epoch {epoch:>2}  val-A riot {ll_riot:.5f}"
            + (f"  solver {ll_solver:.5f}" if ll_solver else "")
            + f"  |A|/|S| {row['a_over_s']:.4f}  cos {row['cos_h']:+.4f}"
            f"  {row['seconds']:.0f}s")

    model.load_state_dict(best[2])
    model.eval()
    # Per-row val-A losses at the selected checkpoint. The tie-break rule is a
    # PAIRED comparison, so it needs these, not just the mean.
    scoring = va_solver if va_solver is not None else va_riot
    _, logit = evaluate(model, t_va, *scoring)
    rows = metrics.log_loss_rows(1 / (1 + np.exp(-logit)), t_va["win"].numpy())
    return {
        "config": {k: v for k, v in config.items() if k not in ("solver_roles",)},
        "best_val_a": best[0],
        "best_epoch": best[1],
        "selection_criterion": "solver_posterior" if va_solver is not None else "riot",
        "n_parameters": model.n_parameters(),
        "depth_source": depth_src,
        "history": history,
        "_val_a_rows": rows,
    }, model


def fold_frame(ds, folds, k):
    roles = dict(zip(folds[folds.fold == k].match_id, folds[folds.fold == k].role))
    sub = ds[ds.match_id.isin(roles)].copy()
    sub["fold_split"] = [roles[m] for m in sub.match_id]
    return sub


ARCH_GRID = [
    {"width": w, "dropout": d, "aux": a}
    for w in (128, 256) for d in (0.1, 0.3) for a in (0.0, 0.2)
]
AUG_GRID = [{"p": p, "p_swap": s} for p in (0.25, 0.5, 0.75) for s in (0.0, 0.1, 0.25)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", choices=["arch", "aug", "final", "main", "folds"], default="arch")
    ap.add_argument("--out", default=str(TRAIN_DIR))
    ap.add_argument("--epochs", type=int, default=None)
    args = ap.parse_args()
    if args.epochs:
        global EPOCHS
        EPOCHS = args.epochs

    data = load_all()
    ds, i2a, dims, prior, factors = data
    folds = pd.read_parquet(TRAIN_DIR / "folds.parquet")
    solver_roles = pd.read_csv(TRAIN_DIR / "solver_roles.csv")

    # The sweep runs on fold 1 and is FROZEN for every other fold.
    f1 = fold_frame(ds, folds, 1)
    sweep_data = (f1, i2a, dims, prior, factors)
    base = {"split_col": "fold_split", "seed": 0, "solver_roles": solver_roles}

    out_path = Path(args.out) / f"sweep_{args.stage}.json"
    results = []

    if args.stage == "arch":
        # Architecture first, at the plan's augmentation midpoint.
        grid = [dict(base, p=0.5, p_swap=0.1, **g) for g in ARCH_GRID]
    elif args.stage == "aug":
        winner = json.loads((Path(args.out) / "sweep_arch.json").read_text())["winner"]
        grid = [dict(base, **{k: winner[k] for k in ("width", "dropout", "aux")}, **g)
                for g in AUG_GRID]
    elif args.stage == "final":
        winner = json.loads((Path(args.out) / "sweep_aug.json").read_text())["winner"]
        grid = [dict(base, **{k: winner[k] for k in
                              ("width", "dropout", "aux", "p", "p_swap")}, seed=s)
                for s in (0, 1, 2)]
    elif args.stage == "main":
        # The deliverable checkpoints. Tuning is FROZEN at fold 1's winner; the
        # main split's val-A picks this run's own checkpoint and val-B its
        # temperature, and its selection numbers are diagnostic only.
        winner = json.loads((Path(args.out) / "sweep_aug.json").read_text())["winner"]
        cfg = {k: winner[k] for k in ("width", "dropout", "aux", "p", "p_swap")}
        main_base = {"split_col": "split", "solver_roles": solver_roles}
        for seed in (0, 1, 2):
            print(f"\n[main split seed {seed}] {cfg}")
            res, model = train_one(dict(main_base, **cfg, seed=seed), data)
            res.pop("_val_a_rows", None)
            torch.save(model.state_dict(), Path(args.out) / f"model_seed{seed}.pt")
            print(f"  -> main-split val-A {res['best_val_a']:.5f} "
                  f"at epoch {res['best_epoch']}")
            results.append(res)
        (Path(args.out) / "sweep_main.json").write_text(json.dumps(
            {"stage": "main", "frozen_config": cfg, "results": results,
             "mean_val_a": float(np.mean([r["best_val_a"] for r in results])),
             "spread_val_a": float(np.std([r["best_val_a"] for r in results]))},
            indent=2))
        print(f"\nwrote {Path(args.out)}/sweep_main.json and model_seed{{0,1,2}}.pt")
        return

    else:
        # Rolling origin, gate 2. The tuning is FROZEN at fold 1's winner and
        # reused unchanged on every fold: the main split's val/test windows
        # overlap folds 4-5's test slices, so re-tuning per fold would leak.
        winner = json.loads((Path(args.out) / "sweep_aug.json").read_text())["winner"]
        cfg = {k: winner[k] for k in ("width", "dropout", "aux", "p", "p_swap")}
        fold_preds = {}
        for k in sorted(folds.fold.unique()):
            fk = fold_frame(ds, folds, k)
            if not {"train", "val_a", "test"} <= set(fk.fold_split.unique()):
                continue
            per_seed = []
            for seed in (0, 1, 2):
                print(f"\n[fold {k} seed {seed}] {cfg}")
                res, model = train_one(
                    dict(base, **cfg, seed=seed),
                    (fk, i2a, dims, prior, factors),
                )
                res.pop("_val_a_rows", None)
                te = fk[fk.fold_split == "test"].reset_index(drop=True)
                t_te = tensors(te)
                c, r = serve.riot_inputs(te)
                _, lg = evaluate(model, t_te, torch.from_numpy(c).long(),
                                 torch.from_numpy(r))
                per_seed.append(1 / (1 + np.exp(-lg)))
                print(f"  -> fold {k} seed {seed} val-A {res['best_val_a']:.5f}")
            fold_preds[f"fold{k}"] = np.mean(per_seed, axis=0)
            fold_preds[f"fold{k}_ids"] = te.match_id.to_numpy()
            fold_preds[f"fold{k}_y"] = te.win.to_numpy()
        np.savez(Path(args.out) / "model_fold_preds.npz", **fold_preds)
        print(f"\nwrote {Path(args.out)}/model_fold_preds.npz")
        return

    for i, cfg in enumerate(grid):
        label = ", ".join(f"{k}={cfg[k]}" for k in
                          ("width", "dropout", "aux", "p", "p_swap", "seed") if k in cfg)
        print(f"\n[{i + 1}/{len(grid)}] {label}")
        res, model = train_one(cfg, sweep_data)
        results.append(res)
        print(f"  -> best val-A {res['best_val_a']:.5f} at epoch {res['best_epoch']}")
        if args.stage == "final":
            torch.save(model.state_dict(), Path(args.out) / f"model_seed{cfg['seed']}.pt")

    best = min(results, key=lambda r: r["best_val_a"])
    # The plan's tie-break: "configs within the val-A MDE of the best are tied;
    # pick the smallest." The MDE is the minimum detectable PAIRED difference
    # (1.96 * sd(d) / sqrt(n)) against the best config on the SAME val-A rows -
    # not the spread across configs, which is a different and much smaller
    # quantity that would name a winner the data cannot actually distinguish.
    tied = []
    for r in results:
        d = r["_val_a_rows"] - best["_val_a_rows"]
        r["mde_vs_best"] = float(metrics.mde(d)) if d.std() > 0 else 0.0
        r["delta_vs_best"] = float(d.mean())
        if r["delta_vs_best"] <= r["mde_vs_best"]:
            tied.append(r)
    # "Pick the smallest" refers to MODEL SIZE - narrower trunk, then more
    # dropout, then no auxiliary head. It does NOT extend to the augmentation
    # axes: every config in the augmentation grid has identical parameters, so
    # "smallest" is undefined there, and ordering on p_swap would have selected
    # p_swap = 0 - dropping the one augmentation that targets the solver's
    # actual failure mode (27% of teams have a champion in the wrong slot),
    # which is precisely what gate 4 measures. When the capacity axes are equal,
    # fall back to the best val-A, which is the serve-realistic quantity.
    def capacity(r):
        c = r["config"]
        return (c.get("width", 0), -c.get("dropout", 0), c.get("aux", 0))

    smallest = min(capacity(r) for r in tied)
    winner = min(
        (r for r in tied if capacity(r) == smallest),
        key=lambda r: r["best_val_a"],
    )
    print(f"\n{'config':<54}{'val-A':>10}{'d vs best':>11}{'MDE':>9}  tied")
    for r in sorted(results, key=lambda x: x["best_val_a"]):
        c = {k: v for k, v in r["config"].items() if k not in ("split_col", "solver_roles")}
        print(f"  {str(c):<52}{r['best_val_a']:>10.5f}{r['delta_vs_best']:>+11.5f}"
              f"{r['mde_vs_best']:>9.5f}  {'yes' if r in tied else ''}")
    for r in results:
        r.pop("_val_a_rows", None)
    doc = {
        "stage": args.stage,
        "results": results,
        "tie_break_rule": "paired val-A MDE vs the best config; smallest model among the tied",
        "n_tied": len(tied),
        "winner": winner["config"],
        "winner_val_a": winner["best_val_a"],
        "best_val_a": best["best_val_a"],
    }
    out_path.write_text(json.dumps(doc, indent=2))
    print(f"\nwinner: {winner['config']}  val-A {winner['best_val_a']:.5f} "
          f"({len(tied)} of {len(results)} configs statistically tied)")
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
