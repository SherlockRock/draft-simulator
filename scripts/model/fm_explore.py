#!/usr/bin/env python
"""Interactive scorer for the shipped FM evaluator — exploration tooling only.

Scores every candidate for one draft state exactly the way the Navigator's
`fm_comp_strength` does (design §2/§3): `marginal` for a candidate,
`allocation` for the leaf share it would hold once picked, and
`compStrength = clamp(0.5 + scale × marginal, 0, 1)`. The legacy evaluator
(`clamp(winRate − Σ max(−counter, 0))`, synergy stub = 0) is printed alongside
so the behaviour change is visible per candidate.

    P=.venv/bin/python
    $P fm_explore.py --blue Jax,Graves,Diana,Tristana,Blitzcrank --red Malphite,Zed,Syndra,Qiyana
    $P fm_explore.py --blue ... --red ... --candidates Kaisa,Jinx,Jhin --explain Kaisa
    $P fm_explore.py --champion Kaisa                 # weights tour for one champion
    $P fm_explore.py --blue ... --red ... --engine    # cross-check vs the Rust path (index.node)

Side defaults to whichever side the draft turn order says picks next for the given
pick counts; `--side` overrides (the FM has no turn concept — only team/opp lists).
`--action ban` scores with the same "fits the banning side" semantics `score_pick`
uses for bans, i.e. the numbers do not change; the flag only labels the output.
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

from common import ALIAS_OVERRIDES, ROOT
from fm_serve import RANK, ROLE_ORDER, ServingTable, allocation, marginal, side_sums, structural_logit

COMPILED = ROOT / "data/compiled"
TRAIN_DIR = ROOT / "data/training"
PROBE = Path(__file__).with_name("fm_engine_probe.cjs")

# champion-meta positions → linear_roles vocabulary (engine: "ADC"|"BOTTOM" → Role::Adc)
POS_TO_ROLE = {"TOP": "TOP", "JUNGLE": "JUNGLE", "MIDDLE": "MIDDLE", "BOTTOM": "BOTTOM",
               "ADC": "BOTTOM", "SUPPORT": "UTILITY", "UTILITY": "UTILITY"}
DISPLAY_KEY = {"TOP": "TOP", "JUNGLE": "JUNGLE", "MIDDLE": "MIDDLE", "BOTTOM": "ADC", "UTILITY": "SUPPORT"}

# engine-core draft_state::TURN_SEQUENCE (side, action, phase); a pair ply = two consecutive picks.
TURN_SEQUENCE = (
    [("blue", "ban", "ban1"), ("red", "ban", "ban1")] * 3
    + [("blue", "pick", "pick1"), ("red", "pick", "pick1"), ("red", "pick", "pick1"),
       ("blue", "pick", "pick1"), ("blue", "pick", "pick1"), ("red", "pick", "pick1")]
    + [("red", "ban", "ban2"), ("blue", "ban", "ban2"), ("red", "ban", "ban2"), ("blue", "ban", "ban2")]
    + [("red", "pick", "pick2"), ("blue", "pick", "pick2"), ("blue", "pick", "pick2"), ("red", "pick", "pick2")]
)


# ---- data ---------------------------------------------------------------------

def load_table(path=COMPILED / "fm-weights.json"):
    artifact = json.loads(Path(path).read_text())
    return artifact, ServingTable(artifact)


def load_meta(path=COMPILED / "champion-meta.json"):
    """alias → {positions (linear_roles vocabulary), win_rate}; win_rate defaults to 0.5
    like the engine's serde default (design §3)."""
    raw = json.loads(Path(path).read_text())["champions"]
    return {alias: {"positions": [POS_TO_ROLE[p] for p in e.get("positions", [])],
                    "win_rate": float(e.get("winRate", 0.5))}
            for alias, e in raw.items()}


def load_counters(path=COMPILED / "matchup-data.json"):
    return json.loads(Path(path).read_text()).get("counters", {})


def load_role_prior(path=TRAIN_DIR / "role_percentages.json"):
    """alias → 5-vector over ROLE_ORDER (train-split play rates), or {} when the
    corpus artifact is absent (linear_expected is already baked into the weights)."""
    if not Path(path).exists():
        return {}
    out = {}
    for e in json.loads(Path(path).read_text()).values():
        roles = e["roles"]
        p = np.array([roles.get(r, 0.0) for r in ROLE_ORDER], float)
        if p.sum() > 0:
            out[ALIAS_OVERRIDES.get(e["alias"], e["alias"])] = p / p.sum()
    return out


def canon(name):
    return ALIAS_OVERRIDES.get(name, name)


def parse_list(s):
    return [canon(x.strip()) for x in (s or "").split(",") if x.strip()]


# ---- scoring ------------------------------------------------------------------

def legacy_comp_strength(c, opp, meta, counters, counter_multiplier=1.0):
    """evaluator.rs legacy_comp_strength: clamp(win_rate + 1.0·0 − mult·Σ_opp max(−diff, 0)).
    None when the champion is not in champion-meta (the engine would use 0.5)."""
    if c not in meta:
        return None
    risk = 0.0
    row = counters.get(c, {})
    for o in opp:
        if o in row:
            risk += max(-row[o], 0.0)
    return float(min(1.0, max(0.0, meta[c]["win_rate"] - counter_multiplier * risk)))


def legacy_risk_terms(c, opp, counters):
    row = counters.get(c, {})
    return [(o, row.get(o), max(-row[o], 0.0) if o in row else None) for o in opp]


def comp_strength(table, contribution):
    raw = 0.5 + table.scale * contribution
    return float(min(1.0, max(0.0, raw))), raw


def decompose(table, c, team, opp):
    """Every term behind marginal()/allocation() for candidate `c` (c ∉ team), plus
    per-teammate synergy and per-opponent counter contributions."""
    i = table.index[c]
    S, _, _ = side_sums(table, team)
    _, A_opp, B_opp = side_sums(table, opp)
    lin = float(table.linear_expected[i])
    syn = float(table.synergy[i] @ S)
    ctr = float(table.counter_a[i] @ B_opp - table.counter_b[i] @ A_opp)
    per_mate = [(m, float(table.synergy[i] @ table.synergy[table.index[m]])) for m in team if m in table.index]
    per_opp = [(o, float(table.counter_a[i] @ table.counter_b[table.index[o]]
                         - table.counter_b[i] @ table.counter_a[table.index[o]]))
               for o in opp if o in table.index]
    marg = lin + syn + ctr
    alloc = lin + 0.5 * syn + 0.5 * ctr
    comp, raw = comp_strength(table, marg)
    assert abs(marg - marginal(table, c, team, opp)) < 1e-12
    assert abs(alloc - allocation(table, c, team + [c], opp)) < 1e-12   # leaf share once picked
    return {"champion": c, "linear_expected": lin, "synergy": syn, "counter": ctr,
            "marginal": marg, "allocation": alloc, "comp_strength": comp, "comp_raw": raw,
            "clamped": raw != comp, "per_teammate": per_mate, "per_opponent": per_opp}


def rank_candidates(table, meta, counters, team, opp, candidates):
    rows = []
    for c in candidates:
        if c in table.index:
            d = decompose(table, c, team, opp)
        else:   # design §3 fallback: clamp(win_rate), structurally mid-pack
            wr = meta.get(c, {}).get("win_rate", 0.5)
            d = {"champion": c, "linear_expected": None, "synergy": None, "counter": None,
                 "marginal": None, "allocation": None, "comp_strength": float(min(1.0, max(0.0, wr))),
                 "comp_raw": None, "clamped": False, "per_teammate": [], "per_opponent": [],
                 "fallback": True}
        d["legacy"] = legacy_comp_strength(c, opp, meta, counters)
        rows.append(d)
    rows.sort(key=lambda r: -r["comp_strength"])
    for k, r in enumerate(rows, 1):
        r["fm_rank"] = k
    legacy_sorted = sorted([r for r in rows if r["legacy"] is not None], key=lambda r: -r["legacy"])
    for k, r in enumerate(legacy_sorted, 1):
        r["legacy_rank"] = k
    return rows


def default_candidates(table, meta, team, opp):
    taken = set(team) | set(opp)
    names = set(table.aliases) | set(meta)
    return sorted(n for n in names if n not in taken)


# ---- turn logic + feasibility ---------------------------------------------------

def find_turn(n_blue, n_red, side):
    """Turn index t whose action is a pick by `side` with exactly (n_blue, n_red)
    picks made before it, or None (e.g. blue with 3/3 — that is never blue's move)."""
    b = r = 0
    for t, (s, action, _) in enumerate(TURN_SEQUENCE):
        if action == "pick":
            if (b, r) == (n_blue, n_red) and s == side:
                return t
            if s == "blue":
                b += 1
            else:
                r += 1
    return None


def next_side(n_blue, n_red):
    for side in ("blue", "red"):
        if find_turn(n_blue, n_red, side) is not None:
            return side
    return None


def _max_matching(masks):
    role_to_champ = [None] * 5

    def augment(ci, visited):
        for ri in range(5):
            if not (masks[ci] >> ri) & 1 or visited[ri]:
                continue
            visited[ri] = True
            if role_to_champ[ri] is None or augment(role_to_champ[ri], visited):
                role_to_champ[ri] = ci
                return True
        return False

    return sum(1 for ci in range(len(masks)) if augment(ci, [False] * 5))


def role_feasible(picks, meta):
    """feasibility.rs on the LOCKED picks only (a full roster can always fill the
    rest): every listed champion-meta position counts as playable (factor ≥ 0.4)."""
    masks = []
    for c in picks:
        mask = 0
        for pos in meta.get(c, {}).get("positions", []):
            mask |= 1 << ROLE_ORDER.index(pos)
        masks.append(mask)
    return _max_matching(masks) == len(picks)


# ---- engine cross-check (Rust path through the prebuilt index.node) ------------------

def build_engine_request(blue, red, side, meta, our_side, bans=None):
    """Flat weights (comp 1 / info 0 / coverage 0), zero pool penalties, full roster
    pools, depth 1: each child's `composite` for `our_side` is then
    0.5·n_picks + scale × Σ allocation over that side at the child state — the same
    inversion tests/fm_parity.rs uses. Bans are padded so the turn index lands on
    `side`'s pick."""
    t = find_turn(len(blue), len(red), side)
    if t is None:
        raise ValueError(f"no pick turn for {side} with picks blue={len(blue)} red={len(red)}")
    n_bans = t - len(blue) - len(red)
    if bans is None:
        reserve = [c for c in sorted(meta) if c not in blue and c not in red]
        bans = reserve[:n_bans]
    if len(bans) != n_bans:
        raise ValueError(f"turn {t} needs exactly {n_bans} bans, got {len(bans)}")
    ban_slots = [i for i, (_, a, _) in enumerate(TURN_SEQUENCE) if a == "ban"][:n_bans]
    pick_slots = {"blue": [], "red": []}
    for i, (s, a, _) in enumerate(TURN_SEQUENCE):
        if a == "pick":
            pick_slots[s].append(i)
    flat = {"comp": 1.0, "info": 0.0, "coverage": 0.0}
    phases = {p: dict(flat) for p in ("ban1", "pick1", "ban2", "pick2")}
    display = {k: [] for k in ("TOP", "JUNGLE", "MIDDLE", "ADC", "SUPPORT")}
    for alias, e in meta.items():
        for pos in e["positions"]:
            display[DISPLAY_KEY[pos]].append(alias)
    pool = {"display": display, "search": sorted(meta)}
    return {
        "protocolVersion": "1.1.0",
        "draftState": {
            "format": "standard",
            "bans": [{"championId": c, "side": TURN_SEQUENCE[s][0], "slot": s} for c, s in zip(bans, ban_slots)],
            "picks": [{"championId": c, "side": "blue", "slot": pick_slots["blue"][k]} for k, c in enumerate(blue)]
                   + [{"championId": c, "side": "red", "slot": pick_slots["red"][k]} for k, c in enumerate(red)],
            "currentPhase": TURN_SEQUENCE[t][2],
            "currentSlot": t,
            "currentSide": side,
        },
        "pools": {"ourSide": our_side, "blue": pool, "red": pool, "crossGameExclusions": []},
        "opponentModel": {"type": "meta", "weights": {}},
        "playerModel": {"championTiers": {"core": [], "playable": [], "emergency": []}, "weights": {}},
        "config": {
            "search": {"branchWidth": 400, "pairBranchWidth": 25, "singlePairTopK": 32, "maxDepth": 1,
                       "broadDepth": 1, "extensionTurnThreshold": 8, "latencyBudgetMs": 60000},
            "weights": {"phaseWeights": {"blue": phases, "red": phases},
                        "penalties": {"outOfRole": 0.0, "outOfPool": 0.0},
                        "synergyMultiplier": 1.0, "counterMultiplier": 1.0,
                        "flexRetentionWeight": 1.0, "revealCostWeight": 1.0},
            "profile": "firstpick-default-v1",
            "forcedBranches": [],
        },
    }


def run_engine(request, env=None):
    proc = subprocess.run(["node", str(PROBE)], input=json.dumps(request), capture_output=True, text=True, env=env)
    if proc.returncode != 0:
        raise RuntimeError(f"engine probe failed:\n{proc.stderr}")
    status = [l for l in proc.stderr.splitlines() if "[fm_engine_probe]" in l]
    return json.loads(proc.stdout), (status[0] if status else "")


def engine_children(response):
    """{tuple(championIds sorted): composite} for the root's children."""
    return {tuple(sorted(ch["championIds"])): float(ch["scores"]["composite"]) for ch in response["tree"]["children"]}


def invert_side_sum(composite, n_picks, scale):
    return (composite - 0.5 * n_picks) / scale


def engine_cross_check(table, meta, blue, red, side):
    """Two depth-1 requests (ourSide blue, then red) → per child: engine blue/red
    allocation sums vs fm_serve, child logit, and logit(S+c) − logit(S) vs marginal(c)."""
    responses = {}
    status = ""
    for our in ("blue", "red"):
        responses[our], status = run_engine(build_engine_request(blue, red, side, meta, our))
    kids_b, kids_r = engine_children(responses["blue"]), engine_children(responses["red"])
    keys = sorted(set(kids_b) & set(kids_r))
    root_logit = structural_logit(table, blue, red)
    rows = []
    for key in keys:
        add = list(key)
        b2 = blue + add if side == "blue" else blue
        r2 = red + add if side == "red" else red
        eng_b = invert_side_sum(kids_b[key], len(b2), table.scale)
        eng_r = invert_side_sum(kids_r[key], len(r2), table.scale)
        py_b = sum(allocation(table, c, b2, r2) for c in b2 if c in table.index)
        py_r = sum(allocation(table, c, r2, b2) for c in r2 if c in table.index)
        team, opp = (blue, red) if side == "blue" else (red, blue)
        marg = (marginal(table, add[0], team, opp) if len(add) == 1 and add[0] in table.index else None)
        # the structural logit is blue − red; the MOVER's logit gain flips sign for red
        sign = 1.0 if side == "blue" else -1.0
        rows.append({"champions": add, "engine_blue_sum": eng_b, "python_blue_sum": py_b,
                     "engine_red_sum": eng_r, "python_red_sum": py_r,
                     "engine_logit": eng_b - eng_r, "python_logit": py_b - py_r,
                     "engine_mover_delta": sign * ((eng_b - eng_r) - root_logit), "marginal": marg,
                     "engine_composite_for_mover": kids_b[key] if side == "blue" else kids_r[key]})
    return {"status": status, "root_logit": root_logit, "n_children": len(keys), "rows": rows,
            "missing_on_one_side": sorted(set(kids_b) ^ set(kids_r))}


# ---- champion tour ------------------------------------------------------------------

def champion_report(table, meta, role_prior, alias, top=5):
    i = table.index[alias]
    s, a, b = table.synergy[i], table.counter_a[i], table.counter_b[i]
    others = [o for o in table.aliases if o != alias]
    syn = sorted(((o, float(s @ table.synergy[table.index[o]])) for o in others), key=lambda x: -x[1])
    ctr = sorted(((o, float(a @ table.counter_b[table.index[o]] - b @ table.counter_a[table.index[o]]))
                  for o in others), key=lambda x: -x[1])
    lin_by_role = dict(zip(ROLE_ORDER, [float(x) for x in np.asarray(table_linear(table, alias), float)]))
    prior = role_prior.get(alias)
    return {"champion": alias, "in_champion_meta": alias in meta,
            "meta_positions": meta.get(alias, {}).get("positions"), "win_rate": meta.get(alias, {}).get("win_rate"),
            "linear_by_role": lin_by_role, "role_prior": None if prior is None else dict(zip(ROLE_ORDER, map(float, prior))),
            "linear_expected": float(table.linear_expected[i]),
            "linear_expected_recomputed": None if prior is None else float(np.array(list(lin_by_role.values())) @ prior),
            "norms": {"synergy": float(np.linalg.norm(s)), "counter_a": float(np.linalg.norm(a)), "counter_b": float(np.linalg.norm(b))},
            "self_synergy": float(s @ s),
            "best_synergy": syn[:top], "worst_synergy": syn[-top:][::-1],
            "counters_best_against": ctr[:top], "countered_by": ctr[-top:][::-1],
            "vectors": {"synergy": s.tolist(), "counter_a": a.tolist(), "counter_b": b.tolist()}}


def table_linear(table, alias):
    """The provenance 5-vector is not on ServingTable; read it from the artifact."""
    return table.linear_by_alias[alias]


# ---- printing -------------------------------------------------------------------------

def fmt(x, w=8, d=4):
    return " " * w if x is None else f"{x:+{w}.{d}f}"


def print_ranking(rows, side, action, team, opp, scale, top):
    print(f"state  team({side}) = {', '.join(team) or '—'}   opp = {', '.join(opp) or '—'}   action = {action}   scale = {scale:.6g}")
    print(f"{'#':>3} {'champion':<14} {'lin_exp':>8} {'synergy':>8} {'counter':>8} {'marginal':>9} {'alloc':>8} "
          f"{'compFM':>7} {'legacy':>7} {'lg#':>4} {'Δ#':>4}")
    for r in rows[:top]:
        lg = r.get("legacy")
        lgr = r.get("legacy_rank")
        d = "" if lgr is None else f"{lgr - r['fm_rank']:+d}"
        tag = " (fallback: clamp(winRate))" if r.get("fallback") else (" CLAMPED" if r["clamped"] else "")
        print(f"{r['fm_rank']:>3} {r['champion']:<14} {fmt(r['linear_expected'])} {fmt(r['synergy'])} {fmt(r['counter'])} "
              f"{fmt(r['marginal'], 9)} {fmt(r['allocation'])} {r['comp_strength']:7.4f} "
              f"{'   n/a' if lg is None else f'{lg:7.4f}'} {'' if lgr is None else lgr:>4} {d:>4}{tag}")


def print_explain(d, meta, counters, opp, scale):
    print(f"\n== {d['champion']} ==")
    print(f"linear_expected            {d['linear_expected']:+.5f}")
    for m, v in d["per_teammate"]:
        print(f"  synergy ⟨s_c, s_{m}⟩ {v:+.5f}")
    print(f"synergy   Σ                {d['synergy']:+.5f}")
    for o, v in d["per_opponent"]:
        print(f"  counter ⟨a_c,b_{o}⟩−⟨b_c,a_{o}⟩ {v:+.5f}")
    print(f"counter   Σ                {d['counter']:+.5f}")
    print(f"marginal  = lin+syn+ctr    {d['marginal']:+.5f}   → compStrength = clamp(0.5 + {scale:.6g}×marginal) = {d['comp_strength']:.5f}")
    print(f"allocation = lin+½syn+½ctr {d['allocation']:+.5f}   (this champion's leaf share once it is on the team)")
    lg = legacy_comp_strength(d["champion"], opp, meta, counters)
    if lg is None:
        print("legacy: not in champion-meta")
    else:
        wr = meta[d["champion"]]["win_rate"]
        print(f"legacy    winRate {wr:.4f}", end="")
        for o, diff, risk in legacy_risk_terms(d["champion"], opp, counters):
            print(f"  − risk[{o}]={'—' if risk is None else f'{risk:.4f}'}", end="")
        print(f"  → {lg:.4f}")


def print_champion(rep):
    print(f"== {rep['champion']} ==  champion-meta positions {rep['meta_positions']}  winRate {rep['win_rate']}")
    print("linear by role   " + "  ".join(f"{r}={v:+.4f}" for r, v in rep["linear_by_role"].items()))
    if rep["role_prior"]:
        print("role prior p(r|c) " + "  ".join(f"{r}={v:.3f}" for r, v in rep["role_prior"].items()))
        print(f"linear_expected  {rep['linear_expected']:+.5f}  (recomputed Σ p·w = {rep['linear_expected_recomputed']:+.5f})")
    else:
        print(f"linear_expected  {rep['linear_expected']:+.5f}  (role_percentages.json absent — prior not shown)")
    n = rep["norms"]
    print(f"‖synergy‖ {n['synergy']:.4f}  ‖counter_a‖ {n['counter_a']:.4f}  ‖counter_b‖ {n['counter_b']:.4f}  ⟨s,s⟩ {rep['self_synergy']:.4f}")
    for label, key in (("best synergy partners", "best_synergy"), ("worst synergy partners", "worst_synergy"),
                       ("counters best (c vs o)", "counters_best_against"), ("countered by", "countered_by")):
        print(f"{label:<24} " + "  ".join(f"{o} {v:+.4f}" for o, v in rep[key]))


def print_engine(check):
    print(f"\n{check['status']}")
    print(f"root structural logit (python) {check['root_logit']:+.6f}   children compared: {check['n_children']}")
    if check["missing_on_one_side"]:
        print(f"children the wire kept in only one of the two requests (TREE_DISPLAY_WIDTH=32 per requesting side): "
              f"{len(check['missing_on_one_side'])} skipped")
    print(f"{'child':<22} {'eng blueΣ':>10} {'py blueΣ':>10} {'eng redΣ':>10} {'py redΣ':>10} {'|Δ|':>9} {'moverΔ':>9} {'marginal':>9}")
    worst = 0.0
    for r in check["rows"]:
        err = max(abs(r["engine_blue_sum"] - r["python_blue_sum"]), abs(r["engine_red_sum"] - r["python_red_sum"]))
        worst = max(worst, err)
        print(f"{'+'.join(r['champions']):<22} {r['engine_blue_sum']:+10.6f} {r['python_blue_sum']:+10.6f} "
              f"{r['engine_red_sum']:+10.6f} {r['python_red_sum']:+10.6f} {err:9.2e} "
              f"{r['engine_mover_delta']:+9.5f} {fmt(r['marginal'], 9, 5)}")
    print(f"max |engine − python| over allocation sums: {worst:.2e}   "
          f"(moverΔ = engine logit(S+c) − logit(S) from the mover's side; equals marginal(c) for a single pick)")


# ---- main ---------------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--blue", default="", help="comma-separated blue picks")
    ap.add_argument("--red", default="", help="comma-separated red picks")
    ap.add_argument("--side", choices=["blue", "red"], default=None, help="side to score for (default: turn order)")
    ap.add_argument("--action", choices=["pick", "ban"], default="pick")
    ap.add_argument("--candidates", default="", help="comma-separated; default = every champion not yet picked")
    ap.add_argument("--top", type=int, default=25)
    ap.add_argument("--explain", default="", help="comma-separated candidates to decompose term by term")
    ap.add_argument("--champion", default="", help="weights tour for one champion (no state needed)")
    ap.add_argument("--engine", action="store_true", help="cross-check allocation sums against index.node")
    ap.add_argument("--weights", default=str(COMPILED / "fm-weights.json"))
    ap.add_argument("--json", action="store_true", help="emit JSON instead of tables")
    a = ap.parse_args(argv)

    artifact, table = load_table(a.weights)
    table.linear_by_alias = {k: v["linear"] for k, v in artifact["champions"].items()}
    meta, counters, role_prior = load_meta(), load_counters(), load_role_prior()

    if a.champion:
        rep = champion_report(table, meta, role_prior, canon(a.champion))
        print(json.dumps(rep, indent=1) if a.json else "", end="")
        if not a.json:
            print_champion(rep)
        return 0

    blue, red = parse_list(a.blue), parse_list(a.red)
    unknown = [c for c in blue + red if c not in table.index]
    if unknown:
        print(f"note: not in the FM table (padded as UNKNOWN, contributes nothing): {unknown}", file=sys.stderr)
    side = a.side or next_side(len(blue), len(red)) or "blue"
    team, opp = (blue, red) if side == "blue" else (red, blue)
    for label, picks in (("blue", blue), ("red", red)):
        if picks and not role_feasible(picks, meta):
            print(f"warning: {label} picks are role-infeasible under champion-meta positions — the Navigator "
                  f"would prune every candidate here (pre-existing, not the FM)", file=sys.stderr)

    candidates = parse_list(a.candidates) or default_candidates(table, meta, team, opp)
    rows = rank_candidates(table, meta, counters, team, opp, candidates)
    out = {"side": side, "action": a.action, "team": team, "opp": opp, "scale": table.scale, "rows": rows}

    if a.engine:
        if find_turn(len(blue), len(red), side) is None:
            print(f"--engine: no pick turn for {side} at picks blue={len(blue)} red={len(red)}; "
                  f"the Rust cross-check needs a real pick turn (single-pick turns: blue 0/0; red 3/2, 3/3, 5/4).",
                  file=sys.stderr)
            return 2
        out["engine"] = engine_cross_check(table, meta, blue, red, side)

    if a.json:
        print(json.dumps(out, indent=1))
        return 0
    print_ranking(rows, side, a.action, team, opp, table.scale, a.top)
    for c in parse_list(a.explain):
        d = next((r for r in rows if r["champion"] == c), None)
        if d is None or d.get("fallback"):
            print(f"\n== {c} == not scorable by the FM (not a candidate here, or not in the table)")
        else:
            print_explain(d, meta, counters, opp, table.scale)
    if a.engine:
        print_engine(out["engine"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
