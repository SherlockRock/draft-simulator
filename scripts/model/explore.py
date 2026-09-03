#!/usr/bin/env python
"""Phase 2 corpus exploration — answers the handoff's questions 2–8 off a parquet export.

    scripts/match-pipeline/export-parquet.sh data/training
    scripts/model/.venv/bin/python scripts/model/explore.py data/training/matches_YYYY-MM-DD.parquet

Read-only over the parquet; never touches the live DB. Flattening is done in
DuckDB (JSON functions), the analysis in pandas. Deliberately not a training
script — the "baselines" section only fits logistic regressions to establish
the floor a real model has to beat.
"""

import json
import sys
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import log_loss

ROOT = Path(__file__).resolve().parents[2]
POSITIONS = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"]
# Riot teamPosition → engine/champion-meta position vocabulary.
META_POS = {"TOP": "TOP", "JUNGLE": "JUNGLE", "MIDDLE": "MIDDLE", "BOTTOM": "BOTTOM", "UTILITY": "SUPPORT"}
HOLDOUT_FRACTION = 0.15  # last 15% of games by game_start


def section(title):
    print(f"\n{'=' * 78}\n{title}\n{'=' * 78}")


def flatten(parquet):
    """One row per match with per-side picks/bans/auxiliaries pulled out of teams_json."""
    cols = []
    for side, tag in (("100", "b"), ("200", "r")):
        cols.append(f"json_extract(teams_json, '$.{side}.win')::BOOLEAN AS {tag}_win")
        cols.append(f"json_extract(teams_json, '$.{side}.bans')::INT[] AS {tag}_bans")
        for pos in POSITIONS:
            base = f"$.{side}.participants.{pos}"
            cols.append(f"json_extract(teams_json, '{base}.championId')::INT AS {tag}_{pos}")
        for ts, label in ((600000, "10"), (900000, "15")):
            cols.append(
                f"json_extract(teams_json, '$.{side}.teamStats.\"{ts}\".totalGold')::INT AS {tag}_gold{label}"
            )
        for obj in ("dragon", "riftHerald", "tower", "horde", "baron", "atakhan"):
            cols.append(f"json_extract(teams_json, '$.{side}.objectives.{obj}.first')::BOOLEAN AS {tag}_first_{obj}")
        cols.append(f"json_extract(teams_json, '$.{side}.platesLost')::INT AS {tag}_plates_lost")
    sql = f"""
        SELECT match_id, region, seed_tier, seed_division, patch_major, patch_minor,
               game_duration, game_start, {", ".join(cols)}
        FROM '{parquet}'
    """
    return duckdb.sql(sql).df()


def load_id_maps():
    cdragon = json.load(open(ROOT / "data/raw/cdragon-champions.json"))["champions"]
    id_to_alias = {c["numericId"]: c["alias"] for c in cdragon.values()}
    meta = json.load(open(ROOT / "data/compiled/champion-meta.json"))["champions"]
    winrates = json.load(open(ROOT / "data/compiled/winrates.json"))["byChampion"]
    counters = json.load(open(ROOT / "data/compiled/counters.json"))["counters"]
    return id_to_alias, meta, winrates, counters


def picks_long(df):
    """(match_id, side, position, championId, win) — one row per participant."""
    frames = []
    for tag, side in (("b", 100), ("r", 200)):
        for pos in POSITIONS:
            frames.append(
                pd.DataFrame(
                    {
                        "match_id": df["match_id"],
                        "side": side,
                        "position": pos,
                        "champion": df[f"{tag}_{pos}"],
                        "win": df[f"{tag}_win"],
                    }
                )
            )
    return pd.concat(frames, ignore_index=True)


def q2_labels_and_hygiene(df):
    section("Q2 — label + split hygiene")
    df["patch"] = df.patch_major.astype(str) + "." + df.patch_minor.astype(str)
    print("blue-side win rate by region × patch (n):")
    g = df.groupby(["region", "patch"]).agg(n=("b_win", "size"), blue_wr=("b_win", "mean"))
    print(g.round(4).to_string())
    print(f"\noverall blue win rate: {df.b_win.mean():.4f}  (n={len(df)})")
    print(f"duplicate match_ids: {df.match_id.duplicated().sum()}")
    print(f"b_win == r_win contradictions: {(df.b_win == df.r_win).sum()}")
    d = df.game_duration
    print(f"\nduration: min={d.min()} p5={d.quantile(.05):.0f} p50={d.median():.0f} p95={d.quantile(.95):.0f} max={d.max()}")
    bins = [900, 960, 1200, 1260, 1500, 1800, 2100, 2400, 3000, 10000]
    print(pd.cut(d, bins, right=False).value_counts(sort=False).rename("games").to_string())
    print(
        "\nsurrender proxy (flags are NOT stored — extractor computes gameEndedInSurrender but the"
        " stored row keeps only record.teams): games ending in [15:00,16:00)="
        f"{((d >= 900) & (d < 960)).mean():.3%}, [20:00,21:00)={((d >= 1200) & (d < 1260)).mean():.3%}"
    )
    print("\ngames per UTC day (recency check):")
    print(df.game_start.dt.tz_convert("UTC").dt.floor("D").value_counts().sort_index().tail(6).to_string())
    print("\nseed tier × region:")
    print(pd.crosstab(df.region, df.seed_tier).to_string())
    print(
        "\nleakage note: player identity is NOT stored (by design), so games-per-summoner cannot be"
        " measured from the corpus. Apex ladders are ~1k players/region; the same players recur in"
        " thousands of games → a random split leaks player-skill signal. Split by TIME."
    )


def q3_champion_coverage(df, id_to_alias, meta):
    section("Q3 — champion coverage")
    long = picks_long(df)
    ids = set(long.champion.unique())
    for tag in ("b", "r"):
        for bans in df[f"{tag}_bans"]:
            ids.update(int(x) for x in bans)
    ids.discard(-1)
    unmapped = sorted(i for i in ids if i not in id_to_alias)
    print(f"distinct champion ids (picks+bans): {len(ids)}; cdragon map size: {len(id_to_alias)}; "
          f"unmapped: {unmapped}")
    aliases = {id_to_alias[i] for i in ids if i in id_to_alias}
    missing_meta = sorted(a for a in aliases if a not in meta)
    print(f"aliases missing from champion-meta.json ({len(meta)} champs): {missing_meta}")
    never_seen = sorted(set(id_to_alias.values()) - aliases)
    print(f"cdragon champions never picked or banned: {never_seen}")

    cells = long.groupby(["champion", "position"]).size().rename("games").reset_index()
    print(f"\n(champion, role) cells with ≥1 game: {len(cells)} of {len(ids) * 5} possible")
    for k in (50, 200, 1000):
        print(f"  cells with < {k:>4} games: {(cells.games < k).sum():>4}   "
              f"(share of all picks in those cells: {cells[cells.games < k].games.sum() / cells.games.sum():.2%})")
    per_champ = long.groupby("champion").size().sort_values()
    print(f"\nchampions by total pick count: min={per_champ.min()} p10={per_champ.quantile(.1):.0f} "
          f"median={per_champ.median():.0f} max={per_champ.max()}")
    print("10 rarest champions (total picks):")
    print("  " + ", ".join(f"{id_to_alias.get(c, c)}={n}" for c, n in per_champ.head(10).items()))
    # Ban counts
    ban_counts = pd.Series(
        [int(x) for tag in ("b", "r") for bans in df[f"{tag}_bans"] for x in bans if int(x) > 0]
    ).value_counts()
    print(f"\nbans: {ban_counts.sum()} total over {len(df)} games "
          f"({ban_counts.sum() / (10 * len(df)):.1%} of 10 slots filled); distinct banned: {len(ban_counts)}")
    print("top 10 bans: " + ", ".join(f"{id_to_alias.get(c, c)}={n}" for c, n in ban_counts.head(10).items()))
    return long


def q4_role_quality(long, id_to_alias, meta):
    section("Q4 — Riot teamPosition vs engine champion-meta positions")
    def cls(row):
        positions = meta.get(id_to_alias.get(row.champion, ""), {}).get("positions", [])
        p = META_POS[row.position]
        if not positions:
            return "no-meta"
        if positions[0] == p:
            return "primary"
        if p in positions:
            return "secondary"
        return "off-meta"
    long = long.copy()
    long["cls"] = long.apply(cls, axis=1)
    print(long.cls.value_counts(normalize=True).round(4).to_string())
    print("\nby position:")
    print(pd.crosstab(long.position, long.cls, normalize="index").round(3).to_string())
    off = long[long.cls == "off-meta"].groupby(["champion", "position"]).size().sort_values(ascending=False)
    print("\nmost common off-meta (champion, Riot position) pairs — flex picks the engine's meta doesn't list:")
    for (c, p), n in off.head(15).items():
        print(f"  {id_to_alias.get(c, c):>12} {p:<8} {n}")
    per_game_off = long.groupby("match_id").cls.apply(lambda s: (s == "off-meta").sum())
    print(f"\ngames with ≥1 off-meta assignment: {(per_game_off >= 1).mean():.1%}; ≥2: {(per_game_off >= 2).mean():.1%}")
    print("\nsample of 12 games with off-meta assignments (for eyeballing):")
    sample = per_game_off[per_game_off >= 1].sample(12, random_state=1).index
    for mid in sample:
        rows = long[(long.match_id == mid) & (long.cls == "off-meta")]
        print(f"  {mid}: " + ", ".join(f"{id_to_alias.get(r.champion, r.champion)}@{r.position}" for r in rows.itertuples()))


def q5_auxiliaries(df):
    section("Q5 — auxiliary targets completeness")
    for col in ("b_gold10", "b_gold15", "r_gold10", "r_gold15"):
        print(f"{col}: null={df[col].isna().mean():.4%}  zero={(df[col] == 0).mean():.4%}")
    df["gold_diff10"] = df.b_gold10 - df.r_gold10
    df["gold_diff15"] = df.b_gold15 - df.r_gold15
    print(f"gold diff @10: mean={df.gold_diff10.mean():.0f} sd={df.gold_diff10.std():.0f}; "
          f"@15: mean={df.gold_diff15.mean():.0f} sd={df.gold_diff15.std():.0f}")
    print(f"corr(gold_diff15, blue win) = {df.gold_diff15.corr(df.b_win.astype(float)):.3f}; "
          f"P(win | gold15 lead) = {df[df.gold_diff15 > 0].b_win.mean():.3f}")
    for obj in ("dragon", "riftHerald", "tower", "horde", "baron", "atakhan"):
        b, r = df[f"b_first_{obj}"], df[f"r_first_{obj}"]
        neither = (~b & ~r).mean()
        both = (b & r).mean()
        print(f"first {obj:<10}: null={b.isna().mean():.3%}  neither={neither:.3%}  both={both:.3%}  "
              f"P(blue win | blue first)={df[b == True].b_win.mean():.3f}")
    print(f"platesLost: null={df.b_plates_lost.isna().mean():.3%} max={max(df.b_plates_lost.max(), df.r_plates_lost.max())}")


def time_split(df):
    df = df.sort_values("game_start").reset_index(drop=True)
    cut = int(len(df) * (1 - HOLDOUT_FRACTION))
    return df.iloc[:cut], df.iloc[cut:]


def ece(p, y, bins=10):
    edges = np.linspace(0, 1, bins + 1)
    idx = np.clip(np.digitize(p, edges) - 1, 0, bins - 1)
    total = 0.0
    for b in range(bins):
        m = idx == b
        if m.any():
            total += m.mean() * abs(p[m].mean() - y[m].mean())
    return total


def report(name, p, y):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    acc = ((p > 0.5) == y).mean()
    print(f"  {name:<44} acc={acc:.4f}  logloss={log_loss(y, p):.4f}  ECE={ece(p, y):.4f}")


def ugg_proxy_score(df, id_to_alias, winrates, counters):
    """Reproduces comp_strength_for() from engine-core/src/evaluator.rs in Python:
    sum over our five picks of (role win rate − counter_risk vs opposing picks), blue minus red.
    Synergy is a stub in the engine too. A proxy, not the engine — see plan for the real harness."""
    wr_lookup = {(a, pos): v["wr"] for a, roles in winrates.items() for pos, v in roles.items()}
    counter_lookup = {(a, b): d for a, m in counters.items() for b, d in m.items()}

    def team_score(df, ours, theirs):
        s = np.zeros(len(df))
        for pos in POSITIONS:
            our_alias = df[f"{ours}_{pos}"].map(id_to_alias)
            keys = pd.Series(list(zip(our_alias, [META_POS[pos]] * len(df))), index=df.index)
            s += keys.map(wr_lookup).fillna(0.5).values
            for opos in POSITIONS:
                opp_alias = df[f"{theirs}_{opos}"].map(id_to_alias)
                pair = pd.Series(list(zip(our_alias, opp_alias)), index=df.index)
                diff = pair.map(counter_lookup).fillna(0.0).values
                s -= np.maximum(-diff, 0.0)
        return s

    return team_score(df, "b", "r") - team_score(df, "r", "b")


def q8_baselines(df, id_to_alias, winrates, counters):
    section("Q8 — baselines on a time-based holdout (last 15% by game_start)")
    train, test = time_split(df)
    train, test = train.copy(), test.copy()
    y_tr, y_te = train.b_win.values.astype(int), test.b_win.values.astype(int)
    print(f"train={len(train)} ({train.game_start.min():%m-%d} → {train.game_start.max():%m-%d}), "
          f"holdout={len(test)} ({test.game_start.min():%m-%d} → {test.game_start.max():%m-%d}); "
          f"holdout blue wr={y_te.mean():.4f}")
    report("constant p=train blue rate", np.full(len(test), y_tr.mean()), y_te)
    report("always red (majority class)", np.full(len(test), 0.0), y_te)
    report("always blue", np.full(len(test), 1.0), y_te)

    # u.gg-evaluator proxy: raw score → logistic calibration fitted on train.
    s_tr = ugg_proxy_score(train, id_to_alias, winrates, counters).reshape(-1, 1)
    s_te = ugg_proxy_score(test, id_to_alias, winrates, counters).reshape(-1, 1)
    lr = LogisticRegression().fit(s_tr, y_tr)
    report("u.gg evaluator proxy (comp_strength, calibrated)", lr.predict_proba(s_te)[:, 1], y_te)

    # Cheap learned floor: logistic regression over one-hot (champion, role, side).
    from sklearn.preprocessing import OneHotEncoder
    feats = [f"{t}_{p}" for t in ("b", "r") for p in POSITIONS]
    enc = OneHotEncoder(handle_unknown="ignore").fit(train[feats].astype(str))
    X_tr, X_te = enc.transform(train[feats].astype(str)), enc.transform(test[feats].astype(str))
    lr2 = LogisticRegression(C=0.3, max_iter=2000).fit(X_tr, y_tr)
    report("logreg one-hot champion×role×side", lr2.predict_proba(X_te)[:, 1], y_te)
    print("\n  (reference: LoLDraftAI reports 56.7% draft-only accuracy on millions of games)")


def q7_size(parquet, df):
    section("Q7 — size / throughput")
    size = Path(parquet).stat().st_size
    print(f"parquet: {size / 1e6:.0f} MB for {len(df)} rows = {size / len(df) / 1e3:.1f} KB/row (zstd)")
    print(f"→ 1M rows ≈ {size / len(df) * 1e6 / 1e9:.1f} GB parquet; flattened training table is ~100 B/row")
    print("export wall time measured separately (see plan): ~90 s for 155k rows over the tailnet")


def main():
    parquet = sys.argv[1] if len(sys.argv) > 1 else sorted((ROOT / "data/training").glob("*.parquet"))[-1]
    print(f"parquet: {parquet}")
    cache = Path(parquet).with_name(Path(parquet).stem + ".flat.parquet")
    if cache.exists():
        df = pd.read_parquet(cache)
        print(f"flat cache: {cache}")
    else:
        df = flatten(parquet)
        df.to_parquet(cache)
    print(f"rows: {len(df)}")
    id_to_alias, meta, winrates, counters = load_id_maps()
    q2_labels_and_hygiene(df)
    long = q3_champion_coverage(df, id_to_alias, meta)
    q4_role_quality(long, id_to_alias, meta)
    q5_auxiliaries(df)
    q7_size(parquet, df)
    q8_baselines(df, id_to_alias, winrates, counters)


if __name__ == "__main__":
    main()
