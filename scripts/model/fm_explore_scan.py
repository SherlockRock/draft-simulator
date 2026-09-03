#!/usr/bin/env python
"""One-off evidence scan behind reports/fm-explore-tour.md §5-6 and the
fine-tuning levers map (exploration tooling; data-dependent, no tests).

    .venv/bin/python fm_explore_scan.py [--sets 4000] [--seed 1]

Prints: role-feasibility of real holdout states under champion-meta positions,
the within-set spread of marginal and its three terms by fill level, the
shipped-rule sibling MRR (must equal the card), linear_expected vs winRate, the
role-vector spread the population rule averages away, and the region biases the
export drops.
"""
import argparse
import csv
from collections import defaultdict

import numpy as np

from fm_explore import ROLE_ORDER, TRAIN_DIR, decompose, load_meta, load_table, role_feasible
from fm_serve import marginal

SLOT_COLS = [f"{t}_{r}" for t in ("b", "r") for r in ROLE_ORDER]
LEVELS = [(0, 0), (0, 2), (1, 1), (2, 2), (2, 3), (3, 3), (3, 4), (4, 4), (4, 5)]


def load_sets():
    with open(TRAIN_DIR / "holdout_drafts.csv", newline="") as fh:
        drafts = {r["match_id"]: r for r in csv.DictReader(fh)}
    sets = []
    with open(TRAIN_DIR / "sibling_sets.csv", newline="") as fh:
        for r in csv.DictReader(fh):
            if r["evaluable"] != "True" or r["match_id"] not in drafts:
                continue
            slot = int(r["slot"])
            picks = [drafts[r["match_id"]][c] for c in SLOT_COLS]
            side = picks[:5] if slot < 5 else picks[5:]
            opp = picks[5:] if slot < 5 else picks[:5]
            k = slot % 5
            sets.append({"team": side[:k] + side[k + 1:], "opp": opp,
                         "cands": r["candidate_aliases"].split(), "true": r["true_alias"], "slot": slot})
    return sets


def feasibility(sets, meta):
    n = len(sets)
    opp_ok = sum(role_feasible(s["opp"], meta) for s in sets)
    true_ok = sum(role_feasible(s["team"] + [s["true"]], meta) for s in sets)
    both = sum(role_feasible(s["opp"], meta) and role_feasible(s["team"] + [s["true"]], meta) for s in sets)
    every = sum(all(role_feasible(s["team"] + [c], meta) for c in s["cands"]) for s in sets)
    print(f"evaluable sets {n}")
    print(f"opp five feasible {opp_ok} ({opp_ok / n:.3f}); team4+true pick feasible {true_ok} ({true_ok / n:.3f}); "
          f"both sides {both} ({both / n:.3f}); team4+every candidate {every} ({every / n:.3f})")
    bad = defaultdict(int)
    for s in sets:
        five = s["team"] + [s["true"]]
        if not role_feasible(five, meta):
            for c in five:
                if role_feasible([x for x in five if x != c], meta):
                    bad[c] += 1
    print("champions whose removal most often restores feasibility:",
          sorted(bad.items(), key=lambda x: -x[1])[:12])
    print("champion-meta entries with no positions:", [a for a in meta if not meta[a]["positions"]])


def spread_by_fill(sets, table, n_sets, seed):
    rng = np.random.default_rng(seed)
    idx = rng.choice(len(sets), size=min(n_sets, len(sets)), replace=False)
    print("\nfill (team,opp) | mean within-set sd of: marginal | lin | syn | ctr | scale×marginal | mean |marginal|")
    for nt, no in LEVELS:
        sd = defaultdict(list)
        for i in idx:
            s = sets[i]
            if not all(c in table.index for c in s["cands"] + s["team"] + s["opp"]):
                continue
            team = list(rng.choice(s["team"], size=nt, replace=False)) if nt else []
            opp = list(rng.choice(s["opp"], size=no, replace=False)) if no else []
            ds = [decompose(table, c, team, opp) for c in s["cands"]]
            for key in ("marginal", "linear_expected", "synergy", "counter"):
                sd[key].append(np.std([d[key] for d in ds]))
            sd["abs"].append(np.mean([abs(d["marginal"]) for d in ds]))
        m = np.mean(sd["marginal"])
        print(f"({nt},{no})  {m:.4f} | {np.mean(sd['linear_expected']):.4f} | {np.mean(sd['synergy']):.4f} | "
              f"{np.mean(sd['counter']):.4f} | {table.scale * m:.4f} | {np.mean(sd['abs']):.4f}   n={len(sd['marginal'])}")


def mrr(sets, table):
    rr = []
    for s in sets:
        if not all(c in table.index for c in s["cands"] + s["team"] + s["opp"]):
            continue
        m = np.array([marginal(table, c, s["team"], s["opp"]) for c in s["cands"]])
        rr.append(1 / (1 + (m > m[0]).sum() + 0.5 * (m[1:] == m[0]).sum()))
    print(f"\nshipped-rule sibling MRR (seed 0 weights): {np.mean(rr):.4f} over {len(rr)} sets (card: 0.3008)")


def linear_stats(art, table, meta):
    common = [a for a in table.aliases if a in meta]
    le = np.array([table.linear_expected[table.index[a]] for a in common])
    wr = np.array([meta[a]["win_rate"] for a in common])
    print(f"corr(linear_expected, champion-meta winRate) = {np.corrcoef(le, wr)[0, 1]:+.3f} over {len(common)} champions; "
          f"sd(linear_expected) {le.std():.4f}  sd(winRate) {wr.std():.4f}")
    W = np.array([art["champions"][a]["linear"] for a in table.aliases])
    prim = [abs(art["champions"][a]["linear"][ROLE_ORDER.index(meta[a]["positions"][0])] - table.linear_expected[table.index[a]])
            for a in common if meta[a]["positions"]]
    print(f"within-champion sd of linear across roles {W.std(1).mean():.4f}; mean |w_primary − linear_expected| {np.mean(prim):.4f}")


def region_bias():
    try:
        import json
        import torch
        sd = torch.load(TRAIN_DIR / "ship_fm_seed0.pt")
        regions = json.loads((TRAIN_DIR / "region_vocab.json").read_text())["region_to_index"]
        b = sd["region_bias"].numpy()
        print("region_bias (dropped at export): " + "  ".join(f"{r}={b[i]:+.4f}" for r, i in regions.items())
              + f"  → p(blue win) {1 / (1 + np.exp(-b.mean())):.4f} at an empty board (mean bias)")
    except Exception as err:   # optional: checkpoint or torch absent
        print(f"region_bias: unavailable ({err})")


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--sets", type=int, default=4000)
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args(argv)
    meta = load_meta()
    art, table = load_table()
    sets = load_sets()
    feasibility(sets, meta)
    spread_by_fill(sets, table, a.sets, a.seed)
    mrr(sets, table)
    linear_stats(art, table, meta)
    region_bias()


if __name__ == "__main__":
    main()
