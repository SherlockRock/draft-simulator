"""Fill-bucket comparison of the three FM fits under a serving rule.

--rule solver     : frozen-teammates solver posterior (rev 3)
--rule population : export-baked expected linear from role_percentages (rev 4)

Codex round-3 blocker 2: serve_fm_measure.py's bucket table used truth-slot
roles; rev 3 serves solver-posterior linears (frozen-teammates rule: one
posterior per visible side via roles.team_posterior). This re-scores every
bucket with that exact rule for all three fits, so the dominance claim and the
role tax are measured under serving semantics, per fit, per fill level.

Fails hard on any coverage gap; writes bucket_role_measure.{json,md}.
"""
import argparse
import json

import numpy as np
import pandas as pd
import torch

import metrics
from features import champ_matrix
from fm import AntisymmetricFM, predict_logit
from measure_vs_evaluator import dims_of
from prepare import build_masked_states
from roles import position_factor_table, team_posterior
from sibling_scores import TRAIN_DIR

BUCKETS = [(0, 0), (1, 3), (4, 6), (7, 9)]
FITS = {"fulldraft_fm": "baseline_fm.pt", "serve_fm": "serve_fm_seed0.pt",
        "masked46_fm": "baseline_fm_masked.pt"}

sig = lambda z: 1 / (1 + np.exp(-z))

ap = argparse.ArgumentParser()
ap.add_argument("--rule", choices=["solver", "population"], default="solver")
RULE = ap.parse_args().rule

ds = pd.read_parquet(TRAIN_DIR / "dataset.parquet")
te = ds[ds.split == "test"].reset_index(drop=True)
dims = dims_of(ds)
vocab = json.loads((TRAIN_DIR / "champion_vocab.json").read_text())
factors = position_factor_table(dims[0], {int(k): v for k, v in vocab["index_to_alias"].items()})

role_pct_raw = json.loads((TRAIN_DIR / "role_percentages.json").read_text())
ROLE_KEYS = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"]
POP = np.zeros((dims[0], 5))
alias_to_idx = {a: int(k) for k, a in vocab["index_to_alias"].items()}
for e in role_pct_raw.values():
    i = alias_to_idx.get(e["alias"])
    if i is not None:
        POP[i] = [e["roles"].get(k, 0.0) for k in ROLE_KEYS]
missing_pop = [vocab["index_to_alias"][str(i)] for i in range(2, dims[0]) if POP[i].sum() == 0]
assert not missing_pop, f"champions without role prior: {missing_pop}"

champ = champ_matrix(te)
c_t = torch.from_numpy(champ).long()
r_t = torch.from_numpy(te.region_idx.to_numpy()).long()
y = te.win.to_numpy()
sign10 = np.where(np.arange(10) < 5, 1.0, -1.0)
slot_role = np.arange(10) % 5

models = {}
for name, path in FITS.items():
    m = AntisymmetricFM(dims[0], dims[2])
    m.load_state_dict(torch.load(TRAIN_DIR / path))
    m.eval()
    models[name] = m


def solver_linear_adjustment(W, vp):
    """Per-row logit adjustment: replace truth-slot linear with the visible
    side's team_posterior-weighted linear, frozen-teammates rule. Grouped by
    visibility pattern so team_posterior is vectorised per group."""
    adj = np.zeros(len(te))
    for side in (0, 1):
        sl = slice(side * 5, side * 5 + 5)
        vis = vp[:, sl]
        pats = {}
        for i, v in enumerate(map(tuple, vis)):
            if any(v):
                pats.setdefault(v, []).append(i)
        for v, rows in pats.items():
            slots = np.flatnonzero(np.array(v))
            ids = champ[np.ix_(rows, slots.copy() + side * 5)]
            assert (ids >= 2).all(), "masked/NONE slot leaked into visible set"
            if RULE == "solver":
                post = team_posterior(factors[ids])        # (B, n, 5)
            else:
                post = POP[ids]                            # (B, n, 5) state-independent
            w = W[ids]                                     # (B, n, 5)
            truth = np.take_along_axis(
                w, np.broadcast_to(slot_role[slots + side * 5][None, :, None],
                                   (len(rows), len(slots), 1)), axis=2).squeeze(-1)
            solver = (post * w).sum(-1)
            adj[rows] += sign10[side * 5] * (solver - truth).sum(-1)
    return adj


report = [f"# Fill buckets under serving rule: {RULE}\n",
          "| bucket | " + " | ".join(FITS) + " | constant | fulldraft − serve (MDE) | role tax fulldraft |",
          "|---|---|---|---|---|---|---|"]
out = {}
base = ds[ds.split == 'train'].win.mean()   # train-fitted constant (N8)
const = float(np.mean(metrics.log_loss_rows(np.full(len(y), base), y)))
for bucket in BUCKETS:
    ms = build_masked_states(ds, [], bucket=bucket)
    lookup = ms.set_index("match_id")
    vp = np.stack([np.asarray(lookup.loc[m].visible_picks, dtype=bool) for m in te.match_id])
    v = torch.from_numpy(vp).bool()
    row, losses, tax = {}, {}, {}
    for name, m in models.items():
        W = m.linear.weight.detach().numpy()
        logit_truth = np.asarray(predict_logit(m, c_t, r_t, visible=v))
        adj = solver_linear_adjustment(W, vp)
        p = sig(logit_truth + adj)
        losses[name] = metrics.log_loss_rows(p, y)
        row[name] = float(np.mean(losses[name]))
        tax[name] = float(np.mean(losses[name]) -
                          metrics.log_loss(sig(logit_truth), y))
    d = losses["fulldraft_fm"] - losses["serve_fm"]
    key = f"{bucket[0]}-{bucket[1]}"
    report.append(f"| {key} | " +
                  " | ".join(f"{row[n]:.5f}" for n in FITS) +
                  f" | {const:.5f} | {d.mean():+.5f} (MDE {metrics.mde(d):.5f}) | "
                  f"{tax['fulldraft_fm']:+.5f} |")
    out[key] = {**row, "constant": const,
                "fulldraft_minus_serve": float(d.mean()), "mde": metrics.mde(d),
                "role_tax": tax}

(TRAIN_DIR / f"bucket_role_measure_{RULE}.json").write_text(json.dumps(out, indent=2))
text = "\n".join(report) + "\n"
(TRAIN_DIR / f"bucket_role_measure_{RULE}.md").write_text(text)
print(text)
