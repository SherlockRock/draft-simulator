#!/usr/bin/env python
"""Phase 3 — train the shipped FM and write every artifact the engine and the
release need (design §1, §3 'scale', §5 'Python').

    .venv/bin/python ship_fm.py                       # train 3 seeds, export, card
    .venv/bin/python ship_fm.py --checkpoints a,b,c   # skip training, reuse state_dicts

Recipe: baselines.fm_arm verbatim on the standard main split (no masks) — the
sweep over FM_LR_GRID x FM_WD_GRID selects on val-A; seeds 1 and 2 refit at the
winning (lr, wd); seed 0 ships, the other two feed the noise floor and the card.
"""
import argparse
import csv
import datetime as dt
import json
import subprocess
from collections import defaultdict
from pathlib import Path

import numpy as np
import pandas as pd
import torch

import metrics
from baselines import FM_EPOCHS, fm_arm, load
from features import champ_matrix
from fm import AntisymmetricFM, fit as fm_fit, predict_logit
from fm_export import build_artifact, linear_expected, role_prior_vector, write_json
from fm_serve import ROLE_ORDER, ServingTable, marginal, allocation, within_set_sd, scale_statistic
from measure_vs_evaluator import rr_top1_of
from common import ROOT

TRAIN_DIR = ROOT / "data/training"
COMPILED = ROOT / "data/compiled"
REPORTS = Path(__file__).parent / "reports"
SLOT_COLS = [f"{t}_{r}" for t in ("b", "r") for r in ROLE_ORDER]
FIXTURE_SEED = 20260901


def version_string(day, git_short):
    return f"fm-{day}-{git_short}"


def git_short():
    return subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, text=True).strip()


# ---- training ---------------------------------------------------------------

def train_three_seeds(ds, dims):
    tr = ds[ds.split == "train"].reset_index(drop=True)
    va = ds[ds.split == "val_a"].reset_index(drop=True)
    te = ds[ds.split == "test"].reset_index(drop=True)
    report = []
    row, _, model0 = fm_arm(tr, va, te, dims, {}, report, seed=0)
    lr, wd = row["lr"], row["weight_decay"]
    n_champ, _, n_region = dims

    def t(df):
        return (torch.from_numpy(champ_matrix(df)).long(),
                torch.from_numpy(df.region_idx.to_numpy()).long(),
                torch.from_numpy(df.win.to_numpy()).float())

    c_tr, r_tr, y_tr = t(tr)
    c_va, r_va, y_va = t(va)
    models, info = [model0], [{"seed": 0, "lr": lr, "weight_decay": wd,
                               "best_epoch": row["best_epoch"], "val_a_log_loss": row["val_a_log_loss"]}]
    for seed in (1, 2):
        m, vl, epoch = fm_fit(c_tr, r_tr, y_tr, c_va, r_va, y_va, n_champ, n_region,
                              weight_decay=wd, lr=lr, epochs=FM_EPOCHS, seed=seed)
        models.append(m)
        info.append({"seed": seed, "lr": lr, "weight_decay": wd, "best_epoch": epoch, "val_a_log_loss": vl})
    return models, info, "\n".join(report)


def load_checkpoints(paths, dims):
    out = []
    for p in paths:
        m = AntisymmetricFM(dims[0], dims[2])
        m.load_state_dict(torch.load(p))
        m.eval()
        out.append(m)
    return out


def test_log_loss(model, te):
    p = 1 / (1 + np.exp(-predict_logit(model, torch.from_numpy(champ_matrix(te)).long(),
                                       torch.from_numpy(te.region_idx.to_numpy()).long())))
    return float(metrics.log_loss(p, te.win.to_numpy()))


# ---- sibling sets under the shipped rule ------------------------------------

def load_sibling_sets():
    """-> list of dicts {match_id, slot, team (4 aliases), opp (5 aliases),
    candidates (aliases, true pick first)} over EVALUABLE sets."""
    drafts = {}
    with open(TRAIN_DIR / "holdout_drafts.csv", newline="") as fh:
        for r in csv.DictReader(fh):
            drafts[r["match_id"]] = [r[c] for c in SLOT_COLS]
    sets = []
    with open(TRAIN_DIR / "sibling_sets.csv", newline="") as fh:
        for r in csv.DictReader(fh):
            if r["evaluable"] != "True" or r["match_id"] not in drafts:
                continue
            slot = int(r["slot"])
            d = drafts[r["match_id"]]
            side = d[:5] if slot < 5 else d[5:]
            opp = d[5:] if slot < 5 else d[:5]
            k = slot % 5
            sets.append({"match_id": r["match_id"], "slot": slot,
                         "team": side[:k] + side[k + 1:], "opp": list(opp),
                         "candidates": r["candidate_aliases"].split()})
    return sets


def sibling_marginals(table, sets):
    """Per set: np.array of marginal() per candidate (NaN if any candidate is unknown)."""
    out = []
    for s in sets:
        if all(c in table.index for c in s["candidates"]):
            out.append(np.array([marginal(table, c, s["team"], s["opp"]) for c in s["candidates"]]))
        else:
            out.append(None)
    return out


def sibling_mrr(scores):
    rr = [rr_top1_of(sc)[0] for sc in scores if sc is not None]
    return float(np.mean(rr)), np.array(rr)


def compute_scale(table, sets):
    """design §3: identical evaluable sets; legacy sd from Task 1's comp_strength column."""
    legacy = defaultdict(dict)
    with open(TRAIN_DIR / "evaluator_sibling_scores.csv", newline="") as fh:
        rd = csv.DictReader(fh)
        assert "comp_strength" in rd.fieldnames, "re-run the Task 5 harness (Task 1 of the plan)"
        for r in rd:
            legacy[(r["match_id"], int(r["slot"]))][r["candidate"]] = float(r["comp_strength"])
    l_sds, f_sds, n = [], [], 0
    for s in sets:
        key = (s["match_id"], s["slot"])
        if key not in legacy or not all(c in table.index and c in legacy[key] for c in s["candidates"]):
            continue
        l_sds.append(within_set_sd([legacy[key][c] for c in s["candidates"]]))
        f_sds.append(within_set_sd([marginal(table, c, s["team"], s["opp"]) for c in s["candidates"]]))
        n += 1
    assert n > 1000, f"only {n} paired sets — legacy CSV and sibling sets disagree"
    return scale_statistic(l_sds, f_sds), {"legacy_mean_sd": float(np.mean(l_sds)),
                                           "fm_mean_sd": float(np.mean(f_sds)), "n_sets": n}


# ---- parity fixtures (design §1(b)) -----------------------------------------

def generate_parity_fixtures(table, drafts, n=50, seed=FIXTURE_SEED):
    """drafts: iterable of (blue5, red5) alias lists. Fill pattern cycles
    full / 1-3 / 4-6 / 7-9 masked champions; every fixture is clamp-free under
    the artifact's scale so the Rust test can invert the 0.5 + scale x mapping."""
    rng = np.random.default_rng(seed)
    masks = [(0, 0), (1, 3), (4, 6), (7, 9)]
    out, i = [], 0
    for blue, red in drafts:
        if len(out) == n:
            break
        lo, hi = masks[i % 4]
        k = int(rng.integers(lo, hi + 1))
        drop = set(rng.choice(10, size=k, replace=False).tolist())
        b = [c for j, c in enumerate(blue) if j not in drop and c in table.index]
        r = [c for j, c in enumerate(red) if j + 5 not in drop and c in table.index]
        if any(abs(table.scale * allocation(table, c, b, r)) >= 0.49 for c in b) or \
           any(abs(table.scale * allocation(table, c, r, b)) >= 0.49 for c in r):
            continue
        bs = sum(allocation(table, c, b, r) for c in b)
        rs = sum(allocation(table, c, r, b) for c in r)
        out.append({"blue": b, "red": r, "blue_allocation_sum": bs,
                    "red_allocation_sum": rs, "logit": bs - rs})
        i += 1
    assert len(out) == n, f"only {len(out)} clamp-free fixtures found"
    return out


# ---- role tax (design §5, Evidence §3) ----------------------------------------

def role_tax(model, vocab, role_pct, te):
    W = model.linear.weight.detach().numpy()
    prior_by_alias = {e["alias"]: e for e in role_pct.values()}
    exp_lin = np.zeros(W.shape[0])
    missing = []
    for k, alias in vocab["index_to_alias"].items():
        e = prior_by_alias.get(alias)
        if e is None:
            missing.append(alias)
            continue
        exp_lin[int(k)] = linear_expected(W[int(k)], role_prior_vector(e))
    assert not missing, f"role-prior coverage gap (fail-on-missing): {missing}"
    champ = champ_matrix(te)
    logit = np.asarray(predict_logit(model, torch.from_numpy(champ).long(),
                                     torch.from_numpy(te.region_idx.to_numpy()).long()))
    adj = np.zeros(len(te))
    slot_role = np.arange(10) % 5
    for s in range(10):
        ids = champ[:, s]
        delta = exp_lin[ids] - W[ids, slot_role[s]]
        delta[ids < 2] = 0.0
        adj += (1.0 if s < 5 else -1.0) * delta
    sig = lambda z: 1 / (1 + np.exp(-z))
    y = te.win.to_numpy()
    c = metrics.compare("population_expected", sig(logit + adj), "truth_slots", sig(logit), y)
    return {"delta": c["delta_logloss_a_minus_b"], "ci": c["ci"], "mde": c["mde"], "verdict": c["verdict"]}


# ---- main ---------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoints", default=None, help="comma-separated state_dicts for seeds 0,1,2")
    args = ap.parse_args()
    REPORTS.mkdir(exist_ok=True)

    ds, n_champ, n_patch, n_region = load(TRAIN_DIR)
    dims = (n_champ, n_patch, n_region)
    te = ds[ds.split == "test"].reset_index(drop=True)
    vocab = json.loads((TRAIN_DIR / "champion_vocab.json").read_text())
    role_pct = json.loads((TRAIN_DIR / "role_percentages.json").read_text())

    if args.checkpoints:
        models = load_checkpoints(args.checkpoints.split(","), dims)
        info, sweep_report = [{"seed": k} for k in range(3)], "(checkpoints reused)"
    else:
        models, info, sweep_report = train_three_seeds(ds, dims)
        for k, m in enumerate(models):
            torch.save(m.state_dict(), TRAIN_DIR / f"ship_fm_seed{k}.pt")

    # drift vs the measured checkpoint (Evidence §4 measured baseline_fm.pt)
    base = TRAIN_DIR / "baseline_fm.pt"
    drift = None
    if base.exists():
        ref = torch.load(base)
        drift = max(float((models[0].state_dict()[k] - ref[k]).abs().max()) for k in ref)

    day = dt.date.today().isoformat()
    version = version_string(day, git_short())
    patches = sorted(ds.patch.unique().tolist())
    trained_on_base = {"parquet": "dataset.parquet (prepare.py output)", "patches": patches,
                       "n_train": int((ds.split == "train").sum()), "git": git_short()}

    # export at scale 1 first to get the serving table, compute scale, re-export
    sets = load_sibling_sets()
    tables, artifacts, scales, scale_inputs = [], [], [], None
    for k, m in enumerate(models):
        art = build_artifact(m, vocab, role_pct, version, 1.0, {**trained_on_base, **info[k]})
        sc, inputs = compute_scale(ServingTable(art), sets)
        art = build_artifact(m, vocab, role_pct, version, sc, {**trained_on_base, **info[k],
                                                                 "test_log_loss": test_log_loss(m, te)})
        artifacts.append(art)
        tables.append(ServingTable(art))
        scales.append(sc)
        if k == 0:
            scale_inputs = inputs

    write_json(COMPILED / "fm-weights.json", artifacts[0])
    for k in (1, 2):
        write_json(TRAIN_DIR / f"fm-weights-seed{k}.json", artifacts[k])

    # parity fixtures from the WRITTEN (rounded) seed-0 artifact
    table0 = ServingTable(json.loads((COMPILED / "fm-weights.json").read_text()))
    holdout = pd.read_csv(TRAIN_DIR / "holdout_drafts.csv")
    holdout = holdout[holdout.evaluable == True]  # noqa: E712
    drafts = [([r[c] for c in SLOT_COLS[:5]], [r[c] for c in SLOT_COLS[5:]])
              for _, r in holdout.head(400).iterrows()]
    fixtures = generate_parity_fixtures(table0, drafts)
    write_json(COMPILED / "fm-parity.json", {"version": version, "tolerance": 1e-6, "fixtures": fixtures})

    # card numbers
    seed_ll = [test_log_loss(m, te) for m in models]
    mrr_by_seed, rr0 = [], None
    for k, t in enumerate(tables):
        mrr, rr = sibling_mrr(sibling_marginals(t, sets))
        mrr_by_seed.append(mrr)
        if k == 0:
            rr0 = rr
    contrib = np.concatenate([scales[0] * m for m in sibling_marginals(table0, sets) if m is not None])
    quant = {"p0_1": float(np.percentile(contrib, 0.1)), "p50": float(np.percentile(contrib, 50)),
             "p99_9": float(np.percentile(contrib, 99.9)),
             "frac_outside_clamp": float(np.mean(np.abs(contrib) >= 0.5))}
    tax = role_tax(models[0], vocab, role_pct, te)

    card = {
        "version": version, "patches": patches, "n_train": trained_on_base["n_train"],
        "recipe": info, "seed_test_log_loss": seed_ll,
        "seed_test_log_loss_spread": float(max(seed_ll) - min(seed_ll)),
        "seed_sibling_mrr": mrr_by_seed,
        "seed_sibling_mrr_spread": float(max(mrr_by_seed) - min(mrr_by_seed)),
        "scale": scales[0], "scale_inputs": scale_inputs, "scale_by_seed": scales,
        "contribution_quantiles": quant, "role_tax": tax,
        "max_abs_delta_vs_baseline_fm_pt": drift,
        "spearman_vs_previous_weights": None,   # first ship; fm_retrain_gate.py fills this on retrains
        "fill_level_sd_drift_note": ("Opus round-1 probe: legacy compStrength sd grows 0.014→0.074 "
                                     "empty→full while FM contribution sd grows 0.027→0.095; global "
                                     "scale is v1, per-fill scale is a follow-up if the A/B shows "
                                     "early-draft imbalance (design §3)."),
        "fallback_note": ("A champion missing from the table scores clamp(win_rate): sd ~0.014 vs FM "
                          "~5x wider at full states, so it is structurally mid-pack until the retrain "
                          "(design §3)."),
    }
    write_json(REPORTS / "fm-weights-card.json", card)
    (REPORTS / "fm-weights-card.md").write_text(render_card(card, sweep_report), encoding="utf-8")
    print(json.dumps({k: v for k, v in card.items() if k not in ("recipe",)}, indent=1))


def render_card(card, sweep_report):
    L = [f"# FM weights card — {card['version']}\n",
         f"patches {', '.join(card['patches'])} · train rows {card['n_train']:,}\n",
         "## Recipe (baselines.fm_arm, main split, no masks)\n", "```", sweep_report, "```",
         "| seed | lr | wd | best epoch | val-A ll | test ll |", "|---|---|---|---|---|---|"]
    for r, ll in zip(card["recipe"], card["seed_test_log_loss"]):
        L.append(f"| {r['seed']} | {r.get('lr')} | {r.get('weight_decay')} | {r.get('best_epoch')} | "
                 f"{r.get('val_a_log_loss', float('nan')):.5f} | {ll:.5f} |")
    L += [f"\n3-seed test log-loss spread (retrain noise floor, log-loss units): "
          f"{card['seed_test_log_loss_spread']:.5f}",
          f"\n## Scale\n\nscale = {card['scale']:.6g} = legacy mean within-set sd "
          f"{card['scale_inputs']['legacy_mean_sd']:.5f} / FM {card['scale_inputs']['fm_mean_sd']:.5f} "
          f"over {card['scale_inputs']['n_sets']:,} identical sibling sets. "
          f"Per seed: {['%.4g' % s for s in card['scale_by_seed']]}.",
          f"\n{card['fill_level_sd_drift_note']}",
          "\n## Contribution (scale × marginal) quantiles over sibling candidates\n",
          f"p0.1 {card['contribution_quantiles']['p0_1']:+.4f} · p50 {card['contribution_quantiles']['p50']:+.4f} · "
          f"p99.9 {card['contribution_quantiles']['p99_9']:+.4f} · outside clamp "
          f"{card['contribution_quantiles']['frac_outside_clamp']:.4%}",
          "\n## Shipped-rule sibling MRR per seed\n",
          f"{['%.4f' % m for m in card['seed_sibling_mrr']]} · spread {card['seed_sibling_mrr_spread']:.5f} "
          f"(the retrain gate's spread term)",
          "\n## Serve-role tax (population linear_expected vs unattainable truth slots, full test drafts)\n",
          f"Δ log-loss {card['role_tax']['delta']:+.5f} CI [{card['role_tax']['ci'][0]:+.5f}, "
          f"{card['role_tax']['ci'][1]:+.5f}] MDE {card['role_tax']['mde']:.5f} {card['role_tax']['verdict']} "
          f"(coverage asserted, fail-on-missing)",
          f"\n## Drift vs baseline_fm.pt (the measured checkpoint)\n\nmax |Δ weight| = {card['max_abs_delta_vs_baseline_fm_pt']}",
          f"\n## Notes\n\n- {card['fallback_note']}",
          "- Spearman ρ vs previous weights: n/a (first ship).",
          ]
    return "\n".join(L) + "\n"


if __name__ == "__main__":
    main()
