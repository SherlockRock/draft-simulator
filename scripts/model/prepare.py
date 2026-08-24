#!/usr/bin/env python
"""Task 1a — parquet snapshot -> training dataset + every downstream artifact.

    .venv/bin/python prepare.py [matches_YYYY-MM-DD.parquet] [--out data/training]

Read-only over the parquet export; never touches the live Postgres.

Outputs (all under data/training/, which is gitignored):

    dataset.parquet        one row per game: features, targets, split label
    champion_vocab.json    raw Riot id -> dense index (0=UNKNOWN, 1=NONE)
    patch_vocab.json       "major.minor" -> dense index, release order
    region_vocab.json      region -> dense index
    role_percentages.json  per champion, share of train games in each role
    folds.parquet          rolling-origin fold assignments (5 folds)
    holdout_drafts.csv     test split: 10 aliases + label  (Task 5 input)
    sibling_sets.parquet   held-out-slot candidate sets    (gate 1)
    sibling_sets.csv         mirror for the Rust harness
    masked_states.parquet  deterministic 4-6-masked replica of the test split
    masked_states.csv        mirror for the Rust harness
    solver_states.csv      full drafts of val-A/val-B/test + fold 1's val (Task 2b input)
    prepare_report.md      every count, cut and composition table
"""

import argparse
import hashlib
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

from common import (
    META_POS,
    NONE_INDEX,
    POSITIONS,
    ROOT,
    UNKNOWN_INDEX,
    assert_cdragon_fresh,
    load_champion_meta,
    load_evaluable,
    load_id_to_alias,
)
from mask_table import (
    TOTAL_TURNS,
    leaf_turn_distribution,
    pattern_at,
    reachable_leaf_turns,
)

# --- knobs, all recorded in the report -------------------------------------
MIN_DURATION_S = 900          # extractor.mjs:31-51 already enforces this; asserted, not filtered
MIN_EXTRACTOR_VERSION = 3     # v3 and v4 share the `teams` shape; v4 adds teams.meta
RAGGED_TAIL_FRACTION = 0.5    # drop days below 50% of that region's median day
TRAIN_FRAC, VAL_FRAC = 0.80, 0.10   # remainder is test
SIBLING_N = 10                # candidates per sibling set (Task 5 may resize)
MASK_BUCKET = (4, 6)          # the replica Tasks 2b/4/6 consume
SEED = 20260824

# Rolling origin (plan section 5): fold k trains on the first 80k + 15k*(k-1)
# games corpus-wide, tests on the next 15k. Applied proportionally per region.
FOLD_BASE, FOLD_STEP, FOLD_TEST, N_FOLDS = 80_000, 15_000, 15_000, 5


def log(msg, report):
    print(msg)
    report.append(msg)


# ---------------------------------------------------------------------------
# 1. Flatten
# ---------------------------------------------------------------------------

def flatten(parquet):
    """One row per match, picks/bans/auxiliaries pulled out of the teams JSONB.

    Bans stay in Riot's array order, which IS the ban order (the extractor drops
    `pickTurn`; a v4 addition would make that explicit).
    """
    cols = []
    for side, tag in (("100", "b"), ("200", "r")):
        cols.append(f"json_extract(teams_json, '$.{side}.win')::BOOLEAN AS {tag}_win")
        cols.append(f"json_extract(teams_json, '$.{side}.bans')::INT[] AS {tag}_bans")
        for pos in POSITIONS:
            cols.append(
                f"json_extract(teams_json, '$.{side}.participants.{pos}.championId')::INT "
                f"AS {tag}_{pos}"
            )
        cols.append(
            f"json_extract(teams_json, '$.{side}.teamStats.\"900000\".totalGold')::INT "
            f"AS {tag}_gold15"
        )
    sql = f"""
        SELECT match_id, region, seed_tier, patch_major, patch_minor,
               game_duration, game_start, extractor_version, {", ".join(cols)}
        FROM '{parquet}'
    """
    return duckdb.sql(sql).df()


# ---------------------------------------------------------------------------
# 2. Filters
# ---------------------------------------------------------------------------

def apply_filters(df, report):
    n0 = len(df)
    log(f"\n## Filters\n\nrows in parquet: {n0:,}", report)
    log("  (the export already restricts to status='fetched' — "
        "scripts/match-pipeline/export-parquet.sh)", report)

    df = df[df.extractor_version >= MIN_EXTRACTOR_VERSION].copy()
    log(f"  extractor_version >= {MIN_EXTRACTOR_VERSION}: {len(df):,} "
        f"(-{n0 - len(df):,})", report)

    # The only filter v3 does not already enforce.
    n1 = len(df)
    one_winner = df.b_win.astype(bool) ^ df.r_win.astype(bool)
    df = df[one_winner].copy()
    log(f"  exactly one winner (b_win XOR r_win): {len(df):,} (-{n1 - len(df):,}) "
        "— voided/incident games", report)

    # Guaranteed by extractor.mjs:31-51. Assert rather than filter: a violation
    # means the extractor contract changed and prepare.py should fail loudly.
    assert (df.game_duration >= MIN_DURATION_S).all(), "extractor duration contract violated"
    pick_cols = [f"{t}_{p}" for t in ("b", "r") for p in POSITIONS]
    assert df[pick_cols].notna().all().all(), "extractor 10-valid-positions contract violated"
    log(f"  asserted: duration >= {MIN_DURATION_S}s and 10 valid positions (extractor contract)",
        report)
    return df.reset_index(drop=True)


def ragged_tail_cut(df, report):
    """Per region, drop days holding under half that region's median day.

    The corpus is a FIFO backlog snapshot, not a time window: the oldest days
    exist only because low-activity players' 100-game histories reach back that
    far — a skill-correlated subsample, not a random one. Same at the newest
    edge, which is a partially-drained day.
    """
    log("\n## Ragged-tail cut (per region)\n", report)
    df = df.copy()
    df["day"] = pd.to_datetime(df.game_start, utc=True).dt.floor("D")
    keep = pd.Series(False, index=df.index)
    for region, g in df.groupby("region"):
        counts = g.day.value_counts().sort_index()
        threshold = RAGGED_TAIL_FRACTION * counts.median()
        kept_days = counts[counts >= threshold].index
        dropped = counts[counts < threshold]
        keep |= df.region.eq(region) & df.day.isin(kept_days)
        log(f"**{region}** — median day {counts.median():,.0f}, "
            f"threshold {threshold:,.0f}, {len(kept_days)} days kept", report)
        for day, n in dropped.items():
            log(f"    dropped {day:%Y-%m-%d}: {n:,} games", report)
    out = df[keep].drop(columns="day").reset_index(drop=True)
    log(f"\nafter ragged-tail cut: {len(out):,} (-{len(df) - len(out):,})", report)
    return out


# ---------------------------------------------------------------------------
# 3. Vocabularies
# ---------------------------------------------------------------------------

def build_champion_vocab(df, id_to_alias, report):
    """Raw Riot id -> dense index. 0 = UNKNOWN (masked), 1 = NONE (empty ban).

    Ordered by ascending Riot id so a new champion always APPENDS and no
    existing index moves — the same stability rule the engine's champion index
    follows. The vocab ships next to the ONNX model.
    """
    ids = set()
    for t in ("b", "r"):
        for pos in POSITIONS:
            ids.update(df[f"{t}_{pos}"].astype(int).unique().tolist())
        for bans in df[f"{t}_bans"]:
            ids.update(int(x) for x in bans)
    ids.discard(-1)  # -1 is Riot's "no ban"
    unmapped = sorted(i for i in ids if i not in id_to_alias)
    assert not unmapped, (
        f"champion ids absent from the cdragon snapshot: {unmapped}. "
        "Run: node scripts/scrape-cdragon.mjs"
    )
    ordered = sorted(ids)
    vocab = {"UNKNOWN": UNKNOWN_INDEX, "NONE": NONE_INDEX}
    id_to_index = {}
    for i, cid in enumerate(ordered):
        id_to_index[cid] = i + 2
        vocab[str(cid)] = i + 2
    log(f"\n## Vocabularies\n\nchampions: {len(ordered)} + 2 reserved rows "
        f"(UNKNOWN={UNKNOWN_INDEX}, NONE={NONE_INDEX}) = {len(ordered) + 2}", report)
    return id_to_index, {
        "version": 1,
        "reserved": {"UNKNOWN": UNKNOWN_INDEX, "NONE": NONE_INDEX},
        "order": "ascending Riot championId; new champions APPEND, indices never move",
        "riot_id_to_index": {str(k): v for k, v in id_to_index.items()},
        "index_to_alias": {str(v): id_to_alias[k] for k, v in id_to_index.items()},
    }


def build_patch_vocab(df, report):
    patches = sorted({(int(a), int(b)) for a, b in zip(df.patch_major, df.patch_minor)})
    idx = {f"{a}.{b}": i for i, (a, b) in enumerate(patches)}
    log(f"patches: {len(idx)} — {', '.join(idx)}", report)
    return idx, {
        "version": 1,
        "order": "release order; a retrain APPENDS and initialises the new row from the previous",
        "unknown_at_inference": "maps to the latest index",
        "patch_to_index": idx,
    }


def build_region_vocab(df, report):
    idx = {r: i for i, r in enumerate(sorted(df.region.unique()))}
    log(f"regions: {len(idx)} — {', '.join(idx)}", report)
    return idx


def build_role_percentages(train, id_to_alias, report):
    """Per champion, share of TRAIN games in each of the 5 roles.

    Train-only, because this feeds the model as a prior (augmentation source and
    unknown-role fallback) and a corpus-wide count would leak test composition.
    Also the Phase 3 replacement for champion-meta.json's 4-month-stale
    positions, and the source Task 2b synthesises ChampionMeta from.
    """
    counts = defaultdict(lambda: np.zeros(5, dtype=np.int64))
    for slot in range(10):
        role = slot % 5  # slot index IS canonical role order, both sides
        for cid, n in train[f"riot_{slot}"].astype(int).value_counts().items():
            counts[int(cid)][role] += int(n)
    out = {}
    for cid, arr in counts.items():
        total = int(arr.sum())
        out[str(cid)] = {
            "alias": id_to_alias[cid],
            "games": total,
            "roles": {POSITIONS[i]: float(arr[i] / total) for i in range(5)},
            "meta_roles": {META_POS[POSITIONS[i]]: float(arr[i] / total) for i in range(5)},
        }
    rarest = sorted(out.items(), key=lambda kv: kv[1]["games"])[:5]
    log(f"role_percentages: {len(out)} champions; rarest — "
        + ", ".join(f"{v['alias']}={v['games']}" for _, v in rarest), report)
    return out


# ---------------------------------------------------------------------------
# 4. Encode
# ---------------------------------------------------------------------------

def encode(df, id_to_index, patch_idx, region_idx):
    """Wide feature table. Slot index is canonical role order:
    0-4 = blue TOP..UTILITY, 5-9 = red TOP..UTILITY."""
    out = pd.DataFrame(
        {
            "match_id": df.match_id.values,
            "region": df.region.values,
            "region_idx": df.region.map(region_idx).astype("int16").values,
            "patch": (df.patch_major.astype(str) + "." + df.patch_minor.astype(str)).values,
            "game_start": pd.to_datetime(df.game_start, utc=True).values,
            "game_duration": df.game_duration.astype("int32").values,
        }
    )
    out["patch_idx"] = out.patch.map(patch_idx).astype("int16")
    for slot, (tag, pos) in enumerate(
        [(t, p) for t in ("b", "r") for p in POSITIONS]
    ):
        raw = df[f"{tag}_{pos}"].astype(int)
        out[f"champ_{slot}"] = raw.map(id_to_index).astype("int16").values
        out[f"riot_{slot}"] = raw.astype("int32").values

    # Bans: 5 per side in Riot's array order, NONE-padded. -1 means the team
    # forfeited a ban (95.7% of slots are filled corpus-wide).
    for side, tag in enumerate(("b", "r")):
        arrs = df[f"{tag}_bans"].values
        for k in range(5):
            col = np.full(len(df), NONE_INDEX, dtype=np.int16)
            raw = np.full(len(df), -1, dtype=np.int32)
            for i, bans in enumerate(arrs):
                if k < len(bans) and int(bans[k]) > 0:
                    col[i] = id_to_index[int(bans[k])]
                    raw[i] = int(bans[k])
            out[f"ban_{side * 5 + k}"] = col
            out[f"ban_riot_{side * 5 + k}"] = raw

    # Targets.
    out["win"] = df.b_win.astype(bool).astype("int8").values
    out["log_duration"] = np.log(df.game_duration.astype(float).values)
    out["gold_diff15"] = (df.b_gold15.astype(float) - df.r_gold15.astype(float)).values
    # v1 has no elo input (Q6: the corpus is 100% apex, so a `diamond` row would
    # never receive a gradient). The column is emitted so the ONNX contract's
    # reserved `elo` input has a training-side counterpart the day it is real.
    out["elo_idx"] = np.zeros(len(df), dtype="int16")
    out["seed_tier"] = df.seed_tier.values
    return out


def mark_evaluable(enc, evaluable_ids, report):
    pick_riot = enc[[f"riot_{i}" for i in range(10)]].values
    ok = np.isin(pick_riot, list(evaluable_ids)).all(axis=1)
    enc["evaluable"] = ok
    log(f"\n## EVALUABLE\n\ngames all of whose 10 picks champion-meta can score: "
        f"{ok.sum():,} of {len(enc):,} ({ok.mean():.2%}); "
        f"{(~ok).sum():,} dropped ({(~ok).mean():.2%})", report)
    log("Those are exactly the newest-champion games — where a corpus-trained model "
        "would most beat a stale evaluator — so the evaluator arms are measured on the "
        "subset that flatters the evaluator. Reported, not corrected.", report)
    return enc


# ---------------------------------------------------------------------------
# 5. Splits
# ---------------------------------------------------------------------------

def per_region_time_split(enc, report):
    """Each region's timeline cut 80/10/10 independently, then unioned.

    Staggered per-region patch rollouts and a ~2 pp regional side-prior gap make
    a pooled cut skew the test mix. Val is halved into val-A (model selection)
    and val-B (temperature) by alternating time rank, so the two halves are
    identically distributed in time rather than one sitting nearer the test edge.
    """
    log("\n## Split — per region, by time\n", report)
    enc = enc.sort_values(["region", "game_start", "match_id"]).reset_index(drop=True)
    split = pd.Series("train", index=enc.index, dtype=object)
    for region, g in enc.groupby("region", sort=True):
        n = len(g)
        i_train = int(n * TRAIN_FRAC)
        i_val = int(n * (TRAIN_FRAC + VAL_FRAC))
        idx = g.index.to_numpy()
        val_idx = idx[i_train:i_val]
        split.loc[val_idx[0::2]] = "val_a"
        split.loc[val_idx[1::2]] = "val_b"
        split.loc[idx[i_val:]] = "test"
        log(f"**{region}**: n={n:,}  train={i_train:,}  "
            f"val_a={len(val_idx[0::2]):,}  val_b={len(val_idx[1::2]):,}  "
            f"test={n - i_val:,}  |  train ends {g.game_start.iloc[i_train - 1]:%m-%d %H:%M}, "
            f"test starts {g.game_start.iloc[i_val]:%m-%d %H:%M}", report)
    enc["split"] = split.values
    log("\nsplit totals: " + ", ".join(
        f"{k}={v:,}" for k, v in enc.split.value_counts().items()), report)
    log("\nregion x patch composition per split:", report)
    comp = enc.groupby(["split", "region", "patch"]).size().rename("n").reset_index()
    log("\n```\n" + comp.to_string(index=False) + "\n```", report)
    log("\nblue win rate per split: " + ", ".join(
        f"{k}={v:.4f}" for k, v in enc.groupby("split").win.mean().items()), report)
    log("\nA time split separates *games*, not *players*: the same apex regulars appear "
        "on both sides of the cut. The test metric estimates performance on the same "
        "population next week — the product's actual target — not on unseen players.", report)
    return enc


def build_folds(enc, report):
    """Rolling origin: fold k trains on the first FOLD_BASE + FOLD_STEP*(k-1)
    games corpus-wide, carves the last 10% of that prefix as its own val-A/val-B,
    and tests on the next FOLD_TEST. Cut points are applied proportionally per
    region (each region holds only ~1/3 of the corpus) and unioned."""
    log("\n## Rolling-origin folds\n", report)
    rows = []
    total = len(enc)
    ordered = {r: g.sort_values(["game_start", "match_id"]).index.to_numpy()
               for r, g in enc.groupby("region", sort=True)}
    shares = {r: len(ix) / total for r, ix in ordered.items()}
    for k in range(1, N_FOLDS + 1):
        prefix_target = FOLD_BASE + FOLD_STEP * (k - 1)
        used, test_n = 0, 0
        for region, idx in ordered.items():
            p_end = min(int(round(prefix_target * shares[region])), len(idx))
            t_end = min(p_end + int(round(FOLD_TEST * shares[region])), len(idx))
            val_start = int(p_end * 0.9)
            val_idx = idx[val_start:p_end]
            for i in idx[:val_start]:
                rows.append((enc.match_id.iloc[i], k, "train"))
            for j, i in enumerate(val_idx):
                rows.append((enc.match_id.iloc[i], k, "val_a" if j % 2 == 0 else "val_b"))
            for i in idx[p_end:t_end]:
                rows.append((enc.match_id.iloc[i], k, "test"))
            used += p_end
            test_n += t_end - p_end
        crosses = "?"
        log(f"fold {k}: prefix {used:,} (target {prefix_target:,}), test {test_n:,}", report)
    folds = pd.DataFrame(rows, columns=["match_id", "fold", "role"])
    # Tag each fold's test slice with whether it crosses the 16.15 -> 16.16
    # boundary: fold 1 trains on near-pure 16.15 and tests across it, later folds
    # are within-patch, so a fold-1 outlier is the cross-patch effect, not noise.
    patch_of = dict(zip(enc.match_id, enc.patch))
    log("\nfold test-slice patch mix (cross-patch tag):", report)
    for k in range(1, N_FOLDS + 1):
        te = folds[(folds.fold == k) & (folds.role == "test")].match_id
        mix = pd.Series([patch_of[m] for m in te]).value_counts(normalize=True)
        tag = "CROSS-PATCH" if len(mix) > 1 and mix.min() > 0.05 else "within-patch"
        log(f"  fold {k}: " + ", ".join(f"{p}={v:.1%}" for p, v in mix.items()) + f"  -> {tag}",
            report)
    return folds


# ---------------------------------------------------------------------------
# 6. Sibling sets (gate 1)
# ---------------------------------------------------------------------------

def build_sibling_sets(enc, train, evaluable_ids, id_to_alias, report, n_candidates=SIBLING_N):
    """For each test game hold out one slot; score the true pick against N-1
    distractors drawn PROPORTIONAL TO their (role, patch) pick frequency in the
    training split.

    Frequency-proportional draws make the true pick and its distractors
    exchangeable in frequency, so the validity check — "rank by pick frequency"
    — scores at chance exactly. (Decile matching was measured and rejected:
    within a decile, popularity still beats a uniform distractor 58.6% of the
    time, because deciles span 2.6-2.8x at the head.)
    """
    log("\n## Sibling sets (gate 1)\n", report)
    rng = np.random.default_rng(SEED)
    test = enc[enc.split == "test"].reset_index(drop=True)

    # (role, patch) -> (champion riot ids, pick counts) from TRAIN only.
    freq = defaultdict(lambda: defaultdict(int))
    for slot in range(10):
        role = POSITIONS[slot % 5]
        for (patch, cid), n in (
            train.groupby(["patch", f"riot_{slot}"]).size().items()
        ):
            freq[(role, patch)][int(cid)] += int(n)
    role_freq = defaultdict(lambda: defaultdict(int))
    for (role, _patch), d in freq.items():
        for cid, n in d.items():
            role_freq[role][cid] += n

    held = rng.integers(0, 10, size=len(test))
    pick_riot = test[[f"riot_{i}" for i in range(10)]].values
    ban_riot = test[[f"ban_riot_{i}" for i in range(10)]].values

    rows, achievable = [], []
    for i in range(len(test)):
        slot = int(held[i])
        role = POSITIONS[slot % 5]
        patch = test.patch.iloc[i]
        true_pick = int(pick_riot[i, slot])
        table = freq.get((role, patch)) or role_freq[role]
        blocked = set(pick_riot[i].tolist()) | {int(b) for b in ban_riot[i] if b > 0}
        cand = [c for c, _ in table.items()
                if c not in blocked and c in evaluable_ids]
        achievable.append(len(cand))
        if len(cand) < n_candidates - 1:
            continue
        w = np.array([table[c] for c in cand], dtype=float)
        w /= w.sum()
        picked = rng.choice(len(cand), size=n_candidates - 1, replace=False, p=w)
        distractors = [cand[j] for j in picked]
        rows.append(
            {
                "match_id": test.match_id.iloc[i],
                "slot": slot,
                "role": role,
                "side": "blue" if slot < 5 else "red",
                "patch": patch,
                "true_pick": true_pick,
                "true_alias": id_to_alias[true_pick],
                # true pick first; every scorer must shuffle or ignore order.
                "candidates": [true_pick] + distractors,
                "candidate_aliases": [id_to_alias[c] for c in [true_pick] + distractors],
                # The evaluator arm can only score a set whose held-out true pick
                # champion-meta knows; the rest of the draft is already evaluable
                # by construction only when this flag says so.
                "evaluable": bool(test.evaluable.iloc[i]),
            }
        )
    sib = pd.DataFrame(rows)
    log(f"sibling sets built: {len(sib):,} of {len(test):,} test games "
        f"(N={n_candidates} candidates each)", report)
    log(f"achievable N (distractor pool after exclusions): min {min(achievable)}, "
        f"median {int(np.median(achievable))}, max {max(achievable)}", report)
    log(f"evaluable sibling sets (evaluator arm of gate 1): {int(sib.evaluable.sum()):,} "
        f"({sib.evaluable.mean():.2%})", report)
    log("held-out slot distribution: " + ", ".join(
        f"{k}={v}" for k, v in sorted(sib.slot.value_counts().items())), report)
    return sib



LEAF_STATS = Path(__file__).resolve().parent / "leaf_eval_stats.json"


def measured_leaf_turn_weights(turns):
    """P(leaf turn | turn in this bucket), from Task 1b-b's measured depths.

    Falls back to uniform (loudly) when the measurement has not been run, so a
    missing artifact can never silently become a different experiment.
    """
    if not LEAF_STATS.exists():
        return (np.full(len(turns), 1.0 / len(turns)),
                f"UNIFORM FALLBACK — {LEAF_STATS.name} missing, run "
                "`cargo test --release --test leaf_eval_stats -- --ignored` (Task 1b-b)")
    doc = json.loads(LEAF_STATS.read_text())
    depth_dist = {int(k): float(v) for k, v in doc["achieved_depth_distribution"].items()}
    full = leaf_turn_distribution(depth_dist)
    w = np.array([full.get(t, 0.0) for t in turns], dtype=float)
    if w.sum() <= 0:
        return (np.full(len(turns), 1.0 / len(turns)),
                "UNIFORM FALLBACK — measured distribution puts no mass in this bucket")
    return w / w.sum(), (
        f"measured (Task 1b-b achieved depths {sorted(depth_dist)}), "
        f"renormalised within the bucket"
    )


# ---------------------------------------------------------------------------
# 7. Masked-state replica (gates 3 and 4)
# ---------------------------------------------------------------------------

def build_masked_states(enc, report, bucket=MASK_BUCKET):
    """Deterministic replica of the test split at 4-6 masked pick slots.

    The mask pattern is drawn from the reachable (root turn, depth) table with a
    fixed seed, so Tasks 2b, 4 and 6 all score exactly the same states: the
    solver roles Task 2b emits are for the states Task 4/6 score.

    Two stated assumptions enter here (both recorded in the model card):
    the leaf turn is drawn uniformly over the reachable turns in the bucket
    (the root-turn assumption), and WHICH roles are filled is uniform over role
    subsets of the required size (Riot's data carries no pick order).
    """
    log("\n## Masked-state replica (4-6 masked pick slots)\n", report)
    rng = np.random.default_rng(SEED + 1)
    test = enc[enc.split == "test"].reset_index(drop=True)

    # reachable_leaf_turns() drops the mid-pair states: expand_pair covers both
    # halves of a pair in one ply, so a search can never STOP between them
    # (it can start there — a user may open the Navigator mid-pair).
    turns = reachable_leaf_turns(*bucket)
    log(f"reachable leaf turns in bucket {bucket[0]}-{bucket[1]}: {turns}", report)
    unreachable = [t for t in range(TOTAL_TURNS + 1)
                   if bucket[0] <= pattern_at(t)["masked_slots"] <= bucket[1]
                   and t not in turns]
    if unreachable:
        log(f"excluded as mid-pair (never a search leaf): {unreachable}", report)

    # Draw the leaf turn from the MEASURED leaf distribution restricted to this
    # bucket, not uniformly: Task 1b-b recorded what depth the engine actually
    # reaches inside AB_COMPUTE_BUDGET_MS, and that is the second factor of the
    # mask table. Without it the replica would be a guess about the engine.
    weights, source = measured_leaf_turn_weights(turns)
    log(f"leaf-turn draw: {source}", report)
    log("  " + ", ".join(f"t{t}={w:.4f}" for t, w in zip(turns, weights)), report)
    for t in turns:
        p = pattern_at(t)
        log(f"  turn {t}: picks b{p['blue_picks']}/r{p['red_picks']}  "
            f"bans b{p['blue_bans']}/r{p['red_bans']}  masked={p['masked_slots']}", report)

    chosen = rng.choice(turns, size=len(test), p=weights)
    rows = []
    for i in range(len(test)):
        t = int(chosen[i])
        pat = pattern_at(t)
        visible = np.zeros(10, dtype=bool)
        for side, tag in ((0, "blue"), (1, "red")):
            k = pat[f"{tag}_picks"]
            # Uniform over role subsets of size k — the stated assumption.
            roles = rng.choice(5, size=k, replace=False)
            for r in roles:
                visible[side * 5 + int(r)] = True
        ban_visible = np.zeros(10, dtype=bool)
        ban_visible[: pat["blue_bans"]] = True
        ban_visible[5 : 5 + pat["red_bans"]] = True
        rows.append(
            {
                "match_id": test.match_id.iloc[i],
                "leaf_turn": t,
                "masked_slots": int(pat["masked_slots"]),
                "visible_picks": visible.tolist(),
                "visible_bans": ban_visible.tolist(),
            }
        )
    ms = pd.DataFrame(rows)
    log(f"\nmasked states: {len(ms):,} (one per test game)", report)
    log("masked-slot counts: " + ", ".join(
        f"{k}={v:,}" for k, v in sorted(ms.masked_slots.value_counts().items())), report)
    return ms


# ---------------------------------------------------------------------------
# 8. CSV mirrors for the Rust harnesses
# ---------------------------------------------------------------------------

def alias_frame(enc, id_to_alias):
    out = pd.DataFrame({"match_id": enc.match_id.values})
    for slot, (tag, pos) in enumerate([(t, p) for t in ("b", "r") for p in POSITIONS]):
        out[f"{tag}_{pos}"] = [id_to_alias[c] for c in enc[f"riot_{slot}"]]
    out["win"] = enc.win.values
    out["evaluable"] = enc.evaluable.values
    return out


def write_csv_mirrors(enc, folds, sib, ms, id_to_alias, out_dir, report):
    """engine-node has no Arrow/Parquet dependency, so every artifact a Rust
    harness reads gets a CSV mirror. Aliases, not ids — the engine keys on
    aliases throughout."""
    log("\n## CSV mirrors for the Rust harnesses\n", report)

    holdout = alias_frame(enc[enc.split == "test"], id_to_alias)
    holdout.to_csv(out_dir / "holdout_drafts.csv", index=False)
    log(f"holdout_drafts.csv: {len(holdout):,} rows "
        f"({int(holdout.evaluable.sum()):,} evaluable) — Task 5 input", report)

    # Task 2b scores full drafts of the main split's val-A/val-B/test AND fold
    # 1's val, identified by split/fold columns.
    main = enc[enc.split.isin(["val_a", "val_b", "test"])]
    solver = alias_frame(main, id_to_alias)
    solver.insert(1, "split", main.split.values)
    solver.insert(2, "fold", 0)
    f1_val = folds[(folds.fold == 1) & (folds.role.isin(["val_a", "val_b"]))]
    f1 = enc[enc.match_id.isin(set(f1_val.match_id))]
    if len(f1):
        f1_roles = dict(zip(f1_val.match_id, f1_val.role))
        extra = alias_frame(f1, id_to_alias)
        extra.insert(1, "split", [f1_roles[m] for m in f1.match_id])
        extra.insert(2, "fold", 1)
        solver = pd.concat([solver, extra], ignore_index=True)
    solver.to_csv(out_dir / "solver_states.csv", index=False)
    log(f"solver_states.csv: {len(solver):,} rows — Task 2b input "
        f"(fold 0 = main split, fold 1 = rolling-origin fold 1's val)", report)
    log("  " + ", ".join(f"{k}={v:,}" for k, v in
                         solver.groupby(['fold', 'split']).size().items()), report)

    sib_csv = sib.copy()
    sib_csv["candidates"] = sib_csv.candidates.map(lambda v: " ".join(map(str, v)))
    sib_csv["candidate_aliases"] = sib_csv.candidate_aliases.map(" ".join)
    sib_csv.to_csv(out_dir / "sibling_sets.csv", index=False)
    log(f"sibling_sets.csv: {len(sib_csv):,} rows", report)

    # masked_states.csv carries the visible aliases directly so the Rust harness
    # needs no join: an empty cell is a masked slot.
    by_id = enc.set_index("match_id")
    ms_csv = {"match_id": [], "leaf_turn": [], "masked_slots": []}
    slot_names = [f"{t}_{p}" for t in ("b", "r") for p in POSITIONS]
    for name in slot_names:
        ms_csv[name] = []
    for k in range(10):
        ms_csv[f"ban_{k}"] = []
    for row in ms.itertuples():
        e = by_id.loc[row.match_id]
        ms_csv["match_id"].append(row.match_id)
        ms_csv["leaf_turn"].append(row.leaf_turn)
        ms_csv["masked_slots"].append(row.masked_slots)
        for slot, name in enumerate(slot_names):
            ms_csv[name].append(
                id_to_alias[int(e[f"riot_{slot}"])] if row.visible_picks[slot] else ""
            )
        for k in range(10):
            raw = int(e[f"ban_riot_{k}"])
            ms_csv[f"ban_{k}"].append(
                id_to_alias[raw] if (row.visible_bans[k] and raw > 0) else ""
            )
    pd.DataFrame(ms_csv).to_csv(out_dir / "masked_states.csv", index=False)
    log(f"masked_states.csv: {len(ms):,} rows — Task 2b + Task 4/6 read the SAME states", report)


# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("parquet", nargs="?", default=None)
    ap.add_argument("--out", default=str(ROOT / "data/training"))
    ap.add_argument("--sibling-n", type=int, default=SIBLING_N)
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    parquet = args.parquet or str(
        sorted(p for p in (ROOT / "data/training").glob("matches_*.parquet")
               if ".flat." not in p.name)[-1]
    )

    report = [f"# prepare.py report\n",
              f"generated {datetime.now(timezone.utc).isoformat()}",
              f"source parquet: `{Path(parquet).name}`",
              f"seed: {SEED}"]

    id_to_alias = load_id_to_alias()
    assert_cdragon_fresh(id_to_alias)
    evaluable_ids, _ = load_evaluable(id_to_alias, load_champion_meta())

    df = flatten(parquet)
    df = apply_filters(df, report)
    df = ragged_tail_cut(df, report)

    id_to_index, champ_vocab = build_champion_vocab(df, id_to_alias, report)
    patch_idx, patch_vocab = build_patch_vocab(df, report)
    region_idx = build_region_vocab(df, report)

    enc = encode(df, id_to_index, patch_idx, region_idx)
    enc = mark_evaluable(enc, evaluable_ids, report)
    enc = per_region_time_split(enc, report)
    train = enc[enc.split == "train"]

    role_pct = build_role_percentages(train, id_to_alias, report)
    folds = build_folds(enc, report)
    sib = build_sibling_sets(enc, train, evaluable_ids, id_to_alias, report,
                             n_candidates=args.sibling_n)
    ms = build_masked_states(enc, report)

    enc.to_parquet(out_dir / "dataset.parquet", index=False)
    folds.to_parquet(out_dir / "folds.parquet", index=False)
    sib.to_parquet(out_dir / "sibling_sets.parquet", index=False)
    ms.to_parquet(out_dir / "masked_states.parquet", index=False)
    (out_dir / "champion_vocab.json").write_text(json.dumps(champ_vocab, indent=2))
    (out_dir / "patch_vocab.json").write_text(json.dumps(patch_vocab, indent=2))
    (out_dir / "region_vocab.json").write_text(json.dumps(
        {"version": 1, "region_to_index": region_idx}, indent=2))
    (out_dir / "role_percentages.json").write_text(json.dumps(role_pct, indent=2))
    write_csv_mirrors(enc, folds, sib, ms, id_to_alias, out_dir, report)

    digest = hashlib.sha256(
        pd.util.hash_pandas_object(enc[[f"champ_{i}" for i in range(10)] + ["win"]],
                                   index=False).values.tobytes()
    ).hexdigest()[:16]
    log(f"\n## Reproducibility\n\ndataset hash: `{digest}`  "
        f"(champ slots + label; recorded next to every checkpoint)", report)
    log(f"rows written: {len(enc):,}", report)

    (out_dir / "prepare_report.md").write_text("\n".join(report) + "\n")
    print(f"\nwrote {out_dir}/dataset.parquet and artifacts; report at "
          f"{out_dir}/prepare_report.md")


if __name__ == "__main__":
    main()
