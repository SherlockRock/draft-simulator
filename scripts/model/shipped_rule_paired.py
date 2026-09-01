"""The shipped configuration's OWN paired decision numbers, committed.

Configuration: full-draft FM fit, linear served as the export-baked population
expectation (linear_expected). Codex round 4: these numbers were previously
only a reviewer's calculation; the decision needs a committed reproducible arm.

Arm 1: paired sibling MRR vs the production evaluator on identical sets. The
variants in a set share all teammates, so the population rule shifts each
candidate's score by sign * (linear_expected[c] - w[c, slot_role]) on top of
the truth-slot logit — exact, no re-forward needed.
Arm 2: full-draft log-loss vs the cross-fitted-Platt evaluator and vs
logreg_antisym (noting the logreg's own role-indexed serve tax is unmeasured).

Fails on any coverage gap. Writes reports/shipped_rule_paired.{json,md}
(tracked) and the same into data/training/.
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd
import torch

import metrics
from features import champ_matrix
from fm import AntisymmetricFM, predict_logit
from measure_vs_evaluator import crossfit_platt, dims_of, rr_top1_of
from sibling_scores import TRAIN_DIR, build_variants, group

REPORTS = Path(__file__).parent / "reports"
REPORTS.mkdir(exist_ok=True)
ROLE_KEYS = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"]

sig = lambda z: 1 / (1 + np.exp(-z))

ds = pd.read_parquet(TRAIN_DIR / "dataset.parquet")
te = ds[ds.split == "test"].reset_index(drop=True)
dims = dims_of(ds)
vocab = json.loads((TRAIN_DIR / "champion_vocab.json").read_text())

m = AntisymmetricFM(dims[0], dims[2])
m.load_state_dict(torch.load(TRAIN_DIR / "baseline_fm.pt"))
m.eval()
W = m.linear.weight.detach().numpy()

role_pct = {e["alias"]: e["roles"]
            for e in json.loads((TRAIN_DIR / "role_percentages.json").read_text()).values()}
exp_lin = np.zeros(dims[0])
missing = []
for k, alias in vocab["index_to_alias"].items():
    p = role_pct.get(alias)
    if p is None:
        missing.append(alias)
        continue
    exp_lin[int(k)] = np.array([p.get(r, 0.0) for r in ROLE_KEYS]) @ W[int(k)]
assert not missing, f"champions without role prior: {missing}"

report = ["# Shipped-rule paired measurement (full-draft fit + linear_expected)\n"]
out = {}

# ---- arm 1 ----------------------------------------------------------------
z = np.load(TRAIN_DIR / "sibling_scores.npz", allow_pickle=True)
has_ev, ev = z["has_evaluator"], z["evaluator"]
sib = pd.read_parquet(TRAIN_DIR / "sibling_sets.parquet")
champ, _, _, region, set_id, slots, _ = build_variants(sib, ds, None, vocab)
c_t = torch.from_numpy(champ).long()
r_t = torch.from_numpy(region).long()
logit = np.asarray(predict_logit(m, c_t, r_t))
side_sign = np.where(slots < 5, 1.0, -1.0)
# shift every visible champion's linear to the expectation (state-independent)
adj = np.zeros(len(champ))
slot_role = np.arange(10) % 5
for s in range(10):
    ids = champ[:, s]
    delta = exp_lin[ids] - W[ids, slot_role[s]]
    delta[ids < 2] = 0.0
    adj += (1.0 if s < 5 else -1.0) * delta
score = side_sign * (logit + adj)     # picker perspective
sets = group(score, set_id, len(sib))

idx = [i for i in np.flatnonzero(has_ev)
       if np.isfinite(np.asarray(ev[i], dtype=float)).all()]
rr_ev = np.array([rr_top1_of(np.asarray(ev[i], dtype=float))[0] for i in idx])
rr_fm = np.array([rr_top1_of(np.asarray(sets[i], dtype=float))[0] for i in idx])
boot = metrics.paired_bootstrap(rr_fm - rr_ev)
v = {"PASS": "CANDIDATE_BETTER", "FAIL": "EVALUATOR_BETTER",
     "UNDERPOWERED": "UNDERPOWERED"}[metrics.verdict(boot, lower_is_better=False)]
report += [f"## Arm 1 — sibling MRR vs evaluator (n = {len(idx):,})\n",
           f"shipped-rule FM MRR {rr_fm.mean():.4f} vs evaluator {rr_ev.mean():.4f}",
           f"Δ {boot['mean']:+.5f}  CI [{boot['ci_lo']:+.5f}, {boot['ci_hi']:+.5f}]  "
           f"MDE {boot['mde']:.5f}  **{v}**"]
out["arm1"] = {**boot, "verdict": v, "mrr": float(rr_fm.mean()),
               "mrr_evaluator": float(rr_ev.mean())}

# ---- arm 2 ----------------------------------------------------------------
evd = pd.read_csv(TRAIN_DIR / "evaluator_scores.csv")
zb = np.load(TRAIN_DIR / "baseline_preds.npz", allow_pickle=True)
preds = pd.DataFrame({"match_id": zb["test_ids"], "logreg_antisym": zb["logreg_antisym"]})
df = te.merge(evd, on="match_id").merge(preds, on="match_id")
y = df.win.to_numpy()
p_ev = crossfit_platt(df.score_blue_minus_red.to_numpy(), y)
champ_f = champ_matrix(df)
lg = np.asarray(predict_logit(m, torch.from_numpy(champ_f).long(),
                              torch.from_numpy(df.region_idx.to_numpy()).long()))
adj_f = np.zeros(len(df))
for s in range(10):
    ids = champ_f[:, s]
    delta = exp_lin[ids] - W[ids, slot_role[s]]
    delta[ids < 2] = 0.0
    adj_f += (1.0 if s < 5 else -1.0) * delta
p_fm = sig(lg + adj_f)
c_ev = metrics.compare("shipped_fm", p_fm, "evaluator", p_ev, y)
c_lg = metrics.compare("shipped_fm", p_fm, "logreg_antisym",
                       df.logreg_antisym.to_numpy(), y)
report += [f"\n## Arm 2 — full-draft log-loss (n = {len(df):,})\n",
           f"shipped-rule FM {metrics.log_loss(p_fm, y):.5f} · calibrated evaluator "
           f"{metrics.log_loss(p_ev, y):.5f}",
           f"vs evaluator: Δ {c_ev['delta_logloss_a_minus_b']:+.5f} "
           f"CI [{c_ev['ci'][0]:+.5f}, {c_ev['ci'][1]:+.5f}] MDE {c_ev['mde']:.5f} "
           f"**{c_ev['verdict']}**",
           f"vs logreg_antisym (truth-slot logreg — its own serve tax unmeasured): "
           f"Δ {c_lg['delta_logloss_a_minus_b']:+.5f} "
           f"CI [{c_lg['ci'][0]:+.5f}, {c_lg['ci'][1]:+.5f}] MDE {c_lg['mde']:.5f} "
           f"**{c_lg['verdict']}**"]
out["arm2"] = {"log_loss": float(metrics.log_loss(p_fm, y)),
               "vs_evaluator": c_ev, "vs_logreg": c_lg}

text = "\n".join(report) + "\n"
for base in (REPORTS, TRAIN_DIR):
    (base / "shipped_rule_paired.json").write_text(json.dumps(out, indent=2, default=float))
    (base / "shipped_rule_paired.md").write_text(text)
print(text)
