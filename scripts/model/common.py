"""Shared loaders and vocabulary rules for the Phase 2 model scripts.

Everything here is read-only over repo data files and the parquet export; no
script in scripts/model/ ever touches the live Postgres (three collectors are
ingesting against it).
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# Canonical role order. The slot index in every champ[10] / role_probs[10,5]
# tensor IS this order: blue TOP..UTILITY then red TOP..UTILITY.
POSITIONS = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"]

# Riot teamPosition → the position vocabulary champion-meta.json uses.
META_POS = {
    "TOP": "TOP",
    "JUNGLE": "JUNGLE",
    "MIDDLE": "MIDDLE",
    "BOTTOM": "BOTTOM",
    "UTILITY": "SUPPORT",
}

# CDragon alias casing drifts from the canonical alias used by champion-meta,
# the engine and the frontend. Mirrors ALIAS_OVERRIDES in
# scripts/ugg-scraper/championIds.mjs — keep the two in sync.
ALIAS_OVERRIDES = {"FiddleSticks": "Fiddlesticks"}

# Dense champion-vocabulary reserved rows. Index 0/1 are never a real champion.
UNKNOWN_INDEX = 0  # masked / not yet picked
NONE_INDEX = 1  # empty ban slot


def load_json(*parts):
    with open(ROOT.joinpath(*parts), encoding="utf-8") as fh:
        return json.load(fh)


def load_id_to_alias():
    """{numericId: canonical alias} from the cdragon snapshot.

    Requires a snapshot new enough to contain Locke (805) — see Task 0.
    """
    champions = load_json("data", "raw", "cdragon-champions.json")["champions"]
    return {c["numericId"]: ALIAS_OVERRIDES.get(c["alias"], c["alias"]) for c in champions.values()}


def load_champion_meta():
    return load_json("data", "compiled", "champion-meta.json")["champions"]


def load_evaluable(id_to_alias=None, meta=None):
    """EVALUABLE — the champion ids the engine's evaluator can score.

    Definition (plan Task 0): an alias present in champion-meta.json. The
    evaluator reads per-champion positions/win rates from that compile, which is
    a separate stale pipeline Task 0 does not refresh — so champions released
    after it (notably Locke, id 805, present in 10.9% of corpus games and the
    corpus's #1 ban) are NOT evaluable.

    Returns (evaluable_ids, unevaluable_ids) over the ids cdragon knows.
    """
    id_to_alias = id_to_alias if id_to_alias is not None else load_id_to_alias()
    meta = meta if meta is not None else load_champion_meta()
    evaluable = {cid for cid, alias in id_to_alias.items() if alias in meta}
    return evaluable, set(id_to_alias) - evaluable


def assert_cdragon_fresh(id_to_alias=None):
    """Fail loudly rather than silently dropping post-April champions."""
    id_to_alias = id_to_alias if id_to_alias is not None else load_id_to_alias()
    missing = [
        f"{cid} ({name})"
        for cid, name in ((805, "Locke"),)
        if id_to_alias.get(cid) != name
    ]
    if missing:
        raise SystemExit(
            f"stale data/raw/cdragon-champions.json — missing {', '.join(missing)}. "
            "Run: node scripts/scrape-cdragon.mjs  (plan Task 0)"
        )
    if "FiddleSticks" in id_to_alias.values():
        raise SystemExit("alias normalisation missing — FiddleSticks should map to Fiddlesticks")
