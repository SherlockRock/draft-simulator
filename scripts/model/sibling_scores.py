#!/usr/bin/env python
"""Gate 1 inputs — score every sibling candidate with every scorer.

    .venv/bin/python sibling_scores.py [--checkpoint model_seed0.pt]

For each test game one slot is held out and the true pick is scored against
N-1 distractors drawn proportional to their (role, patch) pick frequency in the
training split. Each scorer sees the SAME candidate sets in the SAME order, with
the true pick at index 0.

Four scorers:
  model        value to the picking side, from the trained network
  FM           the same quantity from the antisymmetric FM (Task 2's floor)
  popularity   train-split (role, patch) pick frequency - the VALIDITY CHECK.
               Frequency-proportional distractors make the true pick and the
               distractors exchangeable in frequency, so this must score at
               chance exactly; if it does not, the candidate sets are biased.
  evaluator    read from evaluator_sibling_scores.csv (Task 5), evaluable rows
"""

import argparse
import json
from collections import defaultdict
from pathlib import Path

import numpy as np
import pandas as pd
import torch

import serve
from common import POSITIONS, ROOT
from fm import AntisymmetricFM
from model import DraftModel
from train import load_all

TRAIN_DIR = ROOT / "data/training"


def build_variants(sib, ds, i2a, vocab):
    """-> (champ (M,10), bans (M,10), patch (M,), region (M,), set_id (M,), slot (M,))

    M = sum of candidate-set sizes. One row per (sibling set, candidate).
    """
    by_id = ds.set_index("match_id")
    riot_to_index = {int(k): v for k, v in vocab["riot_id_to_index"].items()}
    champ_rows, ban_rows, patch, region, set_id, slots, is_true = [], [], [], [], [], [], []
    for si, row in enumerate(sib.itertuples()):
        e = by_id.loc[row.match_id]
        base_champ = np.array([e[f"champ_{k}"] for k in range(10)], dtype=np.int64)
        base_ban = np.array([e[f"ban_{k}"] for k in range(10)], dtype=np.int64)
        for ci, cand in enumerate(row.candidates):
            c = base_champ.copy()
            c[row.slot] = riot_to_index[int(cand)]
            champ_rows.append(c)
            ban_rows.append(base_ban)
            patch.append(e.patch_idx)
            region.append(e.region_idx)
            set_id.append(si)
            slots.append(row.slot)
            is_true.append(ci == 0)
    return (
        np.stack(champ_rows), np.stack(ban_rows),
        np.array(patch, dtype=np.int64), np.array(region, dtype=np.int64),
        np.array(set_id), np.array(slots), np.array(is_true),
    )


@torch.no_grad()
def model_scores(model, champ, bans, patch, region, slots, chunk=16384):
    """Value TO THE PICKING SIDE: the blue-win logit, negated for a red slot."""
    role = np.zeros((len(champ), 10, 5), dtype=np.float32)
    eye = np.eye(5, dtype=np.float32)
    role[:, :5] = eye
    role[:, 5:] = eye
    out = []
    for i in range(0, len(champ), chunk):
        s = slice(i, i + chunk)
        out.append(
            model(
                torch.from_numpy(champ[s]).long(),
                torch.from_numpy(role[s]),
                torch.from_numpy(bans[s]).long(),
                torch.from_numpy(patch[s]).long(),
                torch.from_numpy(region[s]).long(),
            )["win_logit"].numpy()
        )
    logit = np.concatenate(out)
    return np.where(slots < 5, logit, -logit)


@torch.no_grad()
def fm_scores(fm, champ, region, slots, chunk=16384):
    out = []
    for i in range(0, len(champ), chunk):
        s = slice(i, i + chunk)
        out.append(fm(torch.from_numpy(champ[s]).long(),
                      torch.from_numpy(region[s]).long()).numpy())
    logit = np.concatenate(out)
    return np.where(slots < 5, logit, -logit)


def popularity_scores(sib, ds, vocab):
    train = ds[ds.split == "train"]
    freq = defaultdict(lambda: defaultdict(int))
    for slot in range(10):
        role = POSITIONS[slot % 5]
        for (patch, cid), n in train.groupby(["patch", f"riot_{slot}"]).size().items():
            freq[(role, patch)][int(cid)] += int(n)
    out = []
    for row in sib.itertuples():
        table = freq[(row.role, row.patch)]
        out.append(np.array([table.get(int(c), 0) for c in row.candidates], dtype=float))
    return out


def group(scores, set_id, n_sets):
    out = [None] * n_sets
    for s in range(n_sets):
        out[s] = scores[set_id == s]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", default="model_seed0.pt")
    args = ap.parse_args()

    ds, i2a, dims, prior, factors = load_all()
    n_champ, n_patch, n_region = dims
    vocab = json.loads((TRAIN_DIR / "champion_vocab.json").read_text())
    sib = pd.read_parquet(TRAIN_DIR / "sibling_sets.parquet").reset_index(drop=True)

    champ, bans, patch, region, set_id, slots, is_true = build_variants(sib, ds, i2a, vocab)
    print(f"{len(sib):,} sibling sets -> {len(champ):,} draft variants")

    sweep = json.loads((TRAIN_DIR / "sweep_aug.json").read_text())["winner"]
    model = DraftModel(n_champ, n_patch, n_region, width=sweep["width"],
                       dropout=sweep["dropout"])
    model.load_state_dict(torch.load(TRAIN_DIR / args.checkpoint))
    model.eval()

    fm = AntisymmetricFM(n_champ, n_region)
    fm.load_state_dict(torch.load(TRAIN_DIR / "baseline_fm.pt"))
    fm.eval()

    n_sets = len(sib)
    scores = {
        "model": group(model_scores(model, champ, bans, patch, region, slots), set_id, n_sets),
        "fm": group(fm_scores(fm, champ, region, slots), set_id, n_sets),
        "popularity": popularity_scores(sib, ds, vocab),
    }

    # Evaluator arm: evaluable rows only (champion-meta cannot score Locke).
    ev_path = TRAIN_DIR / "evaluator_sibling_scores.csv"
    evaluator = [None] * n_sets
    if ev_path.exists():
        ev = pd.read_csv(ev_path)
        by_match = {m: g for m, g in ev.groupby("match_id")}
        hit = 0
        for si, row in enumerate(sib.itertuples()):
            g = by_match.get(row.match_id)
            if g is None:
                continue
            order = {a: s for a, s in zip(g.candidate, g.score_for_picker)}
            vals = [order.get(a) for a in row.candidate_aliases]
            if any(v is None for v in vals):
                continue
            evaluator[si] = np.array(vals, dtype=float)
            hit += 1
        print(f"evaluator arm: {hit:,} of {n_sets:,} sets scored (evaluable subset)")
    scores["evaluator"] = evaluator

    np.savez(
        TRAIN_DIR / "sibling_scores.npz",
        **{k: np.array([np.asarray(v) if v is not None else np.full(len(sib.candidates.iloc[0]), np.nan)
                        for v in vs], dtype=float) for k, vs in scores.items()},
        has_evaluator=np.array([v is not None for v in evaluator]),
    )
    print(f"wrote {TRAIN_DIR}/sibling_scores.npz")


if __name__ == "__main__":
    main()
