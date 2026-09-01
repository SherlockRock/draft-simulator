"""FM serve-role gap: truth slots vs solver posterior vs population expectation.

Only the FM's linear term depends on role, so each alternative is an exact
adjustment to the truth-slot logit: subtract w[c][slot_role], add the weighted
average. Paired log-loss on the full test drafts (the states solver_roles.csv
covers), per alternative, with MDE.
"""
import json
import numpy as np
import pandas as pd
import torch

import metrics
from features import champ_matrix
from fm import AntisymmetricFM, predict_logit
from measure_vs_evaluator import dims_of
from sibling_scores import TRAIN_DIR

ROLE_COLS = ["p_top", "p_jungle", "p_middle", "p_adc", "p_support"]

ds = pd.read_parquet(TRAIN_DIR / "dataset.parquet")
te = ds[ds.split == "test"].reset_index(drop=True)
dims = dims_of(ds)
vocab = json.loads((TRAIN_DIR / "champion_vocab.json").read_text())
alias_of = {int(k): a for k, a in vocab["index_to_alias"].items()}  # dense idx -> alias

m = AntisymmetricFM(dims[0], dims[2])
m.load_state_dict(torch.load(TRAIN_DIR / "baseline_fm.pt"))
m.eval()
W = m.linear.weight.detach().numpy()          # (V,5)

# population role prior per alias
role_pct_raw = json.loads((TRAIN_DIR / "role_percentages.json").read_text())
role_pct = {e["alias"]: e["roles"] for e in role_pct_raw.values()}
ROLE_KEYS = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"]

# solver posterior per (match, champion), test full states
sr = pd.read_csv(TRAIN_DIR / "solver_roles.csv")
sr = sr[(sr.split == "test") & (sr.state_kind == "full")]
post = {(r.match_id, r.champion): np.array([getattr(r, c) for c in ROLE_COLS])
        for r in sr.itertuples()}

champ = champ_matrix(te)                      # (N,10) dense indices, slot=role order
c_t = torch.from_numpy(champ).long()
r_t = torch.from_numpy(te.region_idx.to_numpy()).long()
y = te.win.to_numpy()
logit_truth = np.asarray(predict_logit(m, c_t, r_t))

sign = np.where(np.arange(10) < 5, 1.0, -1.0)
slot_role = np.arange(10) % 5
adj_solver = np.zeros(len(te))
adj_pop = np.zeros(len(te))
miss_solver = 0
for i, (mid, row) in enumerate(zip(te.match_id, champ)):
    for s in range(10):
        c = row[s]
        w = W[c]
        truth_l = w[slot_role[s]]
        alias = alias_of.get(int(c))
        p = post.get((mid, alias))
        if p is None:
            miss_solver += 1
            solver_l = truth_l
        else:
            solver_l = float(p @ w)
        pd_ = role_pct.get(alias) or {}
        pop = np.array([pd_.get(k, 0.0) for k in ROLE_KEYS])
        pop_l = float(pop @ w) if pop.sum() > 0 else truth_l
        adj_solver[i] += sign[s] * (solver_l - truth_l)
        adj_pop[i] += sign[s] * (pop_l - truth_l)

print(f"solver rows missing: {miss_solver} of {len(te)*10}")
sig = lambda z: 1 / (1 + np.exp(-z))
p_truth = sig(logit_truth)
for name, adj in (("solver_posterior", adj_solver), ("population_expected", adj_pop)):
    p_alt = sig(logit_truth + adj)
    c = metrics.compare(name, p_alt, "truth_slots", p_truth, y)
    print(f"{name}: ll {metrics.log_loss(p_alt, y):.5f}  "
          f"delta vs truth {c['delta_logloss_a_minus_b']:+.5f} "
          f"CI [{c['ci'][0]:+.5f},{c['ci'][1]:+.5f}] MDE {c['mde']:.5f} {c['verdict']}")
print(f"truth_slots: ll {metrics.log_loss(p_truth, y):.5f}")
