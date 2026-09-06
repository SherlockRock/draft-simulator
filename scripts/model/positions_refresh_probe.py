#!/usr/bin/env python
"""Evidence behind docs/designs/champion-meta-positions-refresh-design.md
(exploration tooling; data-dependent, no tests).

    .venv/bin/python positions_refresh_probe.py

Prototypes champion-meta `positions` from play-rate sources and re-measures the
feasibility.rs prune (via fm_explore.role_feasible) over the evaluable holdout
sibling sets. Three parts:

  1. threshold sweep — positions = roles with play rate >= t, ordered by rate;
     sources: the train-split corpus prior (role_percentages.json) and the
     u.gg per-role match counts already in data/compiled/winrates.json
  2. one-patch-forward check — positions from 16.15 games only, states from
     the 16.16 holdout (the honest "next patch" number)
  3. the champion-level diff the consumers will see (primary flips, lost roles)
  4. slice 2 — a lower "playable" floor for the feasibility mask only, plus the
     count of states that are feasible today and become infeasible (the regression
     slice 1 alone ships)

Instrument check: the train rates recomputed from dataset.parquet must equal
role_percentages.json exactly before any per-patch number is printed.
"""
import json
from collections import Counter

import numpy as np
import pandas as pd

from fm_explore import ROOT, TRAIN_DIR, load_meta, role_feasible
from positions_feasibility import load_holdout_sets as load_sets_with_patch, measure

ROLE_ORDER = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"]   # linear-vector order (role_feasible's vocabulary)
META_TO_ORDER = {"TOP": "TOP", "JUNGLE": "JUNGLE", "MIDDLE": "MIDDLE", "BOTTOM": "BOTTOM", "SUPPORT": "UTILITY"}
THRESHOLDS = (0.05, 0.08, 0.10, 0.12, 0.15, 0.20, 0.25)


def derive(rates, t, keep_when_absent=None):
    """rates: alias -> {role: share}. Listed = share >= t ordered by share; the argmax is
    always kept. A champion absent from the source keeps `keep_when_absent[alias]` (or [])."""
    out = {}
    for a, p in rates.items():
        listed = sorted([r for r in ROLE_ORDER if p.get(r, 0.0) >= t], key=lambda r: -p[r])
        out[a] = {"positions": listed or [max(p, key=p.get)]}
    if keep_when_absent:
        for a in keep_when_absent:
            out.setdefault(a, {"positions": list(keep_when_absent[a]["positions"])})
    return out


def feasibility(sets, m):
    r = measure(sets, m)
    return r["opp5"], r["team4True"], r["bothSides"], r["everyCandidate"]


def diff(new, base):
    prim = [(a, base[a]["positions"][:1], new[a]["positions"][:1]) for a in base
            if a in new and base[a]["positions"][:1] != new[a]["positions"][:1]]
    lost = [(a, base[a]["positions"], new[a]["positions"]) for a in base
            if a in new and set(base[a]["positions"]) - set(new[a]["positions"])]
    changed = sum(a in new and set(base[a]["positions"]) != set(new[a]["positions"]) for a in base)
    return changed, prim, lost


def main():
    meta = load_meta()
    sets = load_sets_with_patch()
    rp = {v["alias"]: v for v in json.load(open(TRAIN_DIR / "role_percentages.json")).values()}
    corpus = {a: {r: rp[a]["roles"].get(r, 0.0) for r in ROLE_ORDER} for a in meta if a in rp}
    ugg_raw = json.load(open(ROOT / "data/compiled/winrates.json"))
    ugg = {}
    for a in meta:
        e = ugg_raw["byChampion"].get(a) or {}
        n = {META_TO_ORDER[k]: v["n"] for k, v in e.items()}
        if n:
            tot = sum(n.values()); ugg[a] = {r: n.get(r, 0) / tot for r in ROLE_ORDER}
    cj = {x["id"]: {"positions": [META_TO_ORDER[p] for p in x["positions"]]}
          for x in json.load(open(ROOT / "frontend/src/data/champions.json"))["champions"] if x["id"] in meta}

    n = len(sets)
    print(f"evaluable holdout sets {n}; patches {dict(Counter(s['patch'] for s in sets))}")
    print("\n[1] threshold sweep — feasibility of real states (locked picks only), current vs derived positions")
    print(f"{'positions':30s} {'opp5':>6s} {'team4+true':>10s} {'both':>6s} {'every cand':>10s} | chg primΔ lost | mean#pos")

    def row(name, m):
        o, t, b, e = feasibility(sets, m); chg, prim, lost = diff(m, meta)
        print(f"{name:30s} {o:6.3f} {t:10.3f} {b:6.3f} {e:10.3f} | {chg:3d} {len(prim):5d} {len(lost):4d} | "
              f"{np.mean([len(m[a]['positions']) for a in meta]):.2f}")

    row("current compiled meta", meta)
    row("recompile from champions.json", cj)
    for name, src in (("corpus 16.15+16.16 train", corpus), (f"u.gg {ugg_raw['patch']} {ugg_raw['rank']}", ugg)):
        for t in THRESHOLDS:
            row(f"{name} t>={t:.2f}", derive(src, t, keep_when_absent=meta))
    for t in (0.10, 0.15):
        m = derive(corpus, t, keep_when_absent=meta)
        for a in meta:
            for r in meta[a]["positions"]:
                if r not in m[a]["positions"]:
                    m[a]["positions"].append(r)
        row(f"corpus t>={t:.2f} ∪ current", m)

    print("\n[2] one-patch-forward — positions from ONE patch's games, feasibility on the 16.16 holdout")
    vocab = json.load(open(TRAIN_DIR / "champion_vocab.json"))
    i2a = {int(k): v for k, v in vocab["index_to_alias"].items()}
    r2i = {int(k): int(v) for k, v in vocab["riot_id_to_index"].items()}
    df = pd.read_parquet(TRAIN_DIR / "dataset.parquet", columns=["patch", "split"] + [f"riot_{i}" for i in range(10)])

    def rates_from(sub):
        counts = {}
        for slot in range(10):   # slot % 5 is the canonical role order, both sides (prepare.py)
            for cid, k in sub[f"riot_{slot}"].astype(int).value_counts().items():
                counts.setdefault(int(cid), np.zeros(5))[slot % 5] += k
        return {i2a[r2i[c]]: dict(zip(ROLE_ORDER, arr / arr.sum())) for c, arr in counts.items()
                if r2i.get(c) in i2a and i2a[r2i[c]] in meta}

    train = rates_from(df[df.split == "train"])
    max_delta = max(abs(train[a][r] - corpus[a][r]) for a in corpus for r in ROLE_ORDER)
    assert max_delta < 1e-9, f"slot layout mismatch vs role_percentages.json: {max_delta}"
    print(f"instrument check: train rates recomputed from dataset.parquet == role_percentages.json (max |Δ| {max_delta:.1e})")
    sources = {"16.15 all splits (forward)": rates_from(df[df.patch == "16.15"]),
               "16.16 train only (in-sample)": rates_from(df[(df.patch == "16.16") & (df.split == "train")]),
               "train, both patches (= [1])": train}
    print(f"{'source':34s} " + " ".join(f"t>={t:.2f}" for t in (0.05, 0.10, 0.15)))
    for name, src in sources.items():
        print(f"{name:34s} " + " ".join(f"{feasibility(sets, derive(src, t, keep_when_absent=meta))[2]:7.3f}"
                                        for t in (0.05, 0.10, 0.15)))
    for t in (0.05, 0.10, 0.15):
        a = derive(sources["16.15 all splits (forward)"], t); b = derive(sources["16.16 train only (in-sample)"], t)
        sd = [x for x in a if x in b and set(a[x]["positions"]) != set(b[x]["positions"])]
        pd_ = [x for x in a if x in b and a[x]["positions"][:1] != b[x]["positions"][:1]]
        print(f"  t>={t:.2f}: 16.15 vs 16.16 sets differ for {len(sd)} champions, primary for {len(pd_)}: {pd_}")

    print("\n[3] champion-level diff, corpus t>=0.10 vs current compiled meta")
    m = derive(corpus, 0.10, keep_when_absent=meta)
    chg, prim, lost = diff(m, meta)
    raw = json.load(open(ROOT / "data/compiled/champion-meta.json"))["champions"]   # file vocabulary (SUPPORT), not UTILITY
    multi = [a for a in raw if len(raw[a]["positions"]) > 1]
    alpha = [a for a in multi if raw[a]["positions"] == sorted(raw[a]["positions"])]
    print(f"current multi-position champions: {len(multi)}, listed in alphabetical order: {len(alpha)} "
          f"(positions[0] is therefore the alphabetically-first Meraki role, not a meta primary)")
    reorder_only = [p for p in prim if p[2][0] in meta[p[0]]["positions"]]
    print(f"primary changes: {len(prim)} (of which {len(reorder_only)} are the play-rate leader already in the current list)")
    for p in prim:
        print(f"   {p[0]:14s} {str(p[1]):12s} -> {p[2]}  rates={{{', '.join(f'{r}:{corpus[p[0]][r]:.2f}' for r in ROLE_ORDER if corpus[p[0]][r] >= 0.05)}}}")
    print(f"roles lost: {len(lost)}")
    for a, old, new in lost:
        print(f"   {a:14s} {old} -> {new}")
    bad = Counter()
    for s in sets:
        five = s["team"] + [s["true"]]
        if not role_feasible(five, m):
            for c in five:
                if role_feasible([x for x in five if x != c], m):
                    bad[c] += 1
    print("remaining offenders (removal restores feasibility):", bad.most_common(12))
    band = sum(1 for a in corpus for r in ROLE_ORDER if 0.05 <= corpus[a][r] < 0.15)
    print(f"threshold-sensitive (champion, role) pairs with rate in [0.05, 0.15): {band}")

    print("\n[4] slice 2 — playable floor for the feasibility mask only (listed stays 0.10 elsewhere); regression vs today")
    observed = sum(1 for a in corpus for r in ROLE_ORDER if corpus[a][r] > 0)
    today = [role_feasible(s["opp"], meta) and role_feasible(s["team"] + [s["true"]], meta) for s in sets]
    print(f"observed (champion, role) pairs with >0 games over the {len(corpus)} current meta champions: {observed}")
    print(f"{'playable floor':14s} {'opp5':>6s} {'team4+true':>10s} {'both':>6s} {'every cand':>10s} | mean#playable pairs | feasible today -> infeasible | infeasible today -> feasible")
    for t in (0.10, 0.05, 0.03, 0.02, 0.01):
        m = derive(corpus, t, keep_when_absent=meta)
        o, tr, b, e = feasibility(sets, m)
        new = [role_feasible(s["opp"], m) and role_feasible(s["team"] + [s["true"]], m) for s in sets]
        lost = sum(a and not b_ for a, b_ in zip(today, new)); gained = sum(b_ and not a for a, b_ in zip(today, new))
        pairs = sum(len(m[a]["positions"]) for a in corpus)
        print(f"{t:<14.2f} {o:6.3f} {tr:10.3f} {b:6.3f} {e:10.3f} | {pairs/len(corpus):13.2f} {pairs:5d} | {lost:5d} ({lost/n:.2%}) | {gained}")


if __name__ == "__main__":
    main()
