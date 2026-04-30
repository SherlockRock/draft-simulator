// scripts/ugg-scraper/schema.mjs
//
// u.gg's rankings + matchups endpoints return data as positional arrays.
// Field positions are decoded by cross-referencing against u.gg's SSR HTML,
// which carries the same data with named fields. If u.gg bumps API_VERSION
// past 1.5 the schema may shift — re-decode with the same method.
//
// Decoded 2026-04-29 against patch 16_8 / 16_9 Aatrox + Caitlyn data.

// Field positions in the rankings array (the leaf at [region][rank][role]).
// Only positions 0 and 1 are needed for the engine's solo-winrate signal.
// Other positions carry pick rate, ban rate, opponent histograms, and a
// per-champion build summary — intentionally unmapped (YAGNI).
export const RANKINGS_FIELDS = {
  wins: 0,
  matches: 1,
};

export function decodeRanking(arr) {
  if (!Array.isArray(arr) || arr.length < 2) return null;
  const wins = arr[RANKINGS_FIELDS.wins];
  const matches = arr[RANKINGS_FIELDS.matches];
  if (typeof wins !== "number" || typeof matches !== "number" || matches === 0) {
    return null;
  }
  return {
    wins,
    matches,
    winRate: wins / matches,
  };
}

// Field positions in a single matchup record. Decoded 2026-04-29 by aligning
// every Aatrox jungle record against u.gg's SSR `counters: [{champion_id,
// wins, matches, win_rate}, ...]` array — all 10 spot-checks agreed.
// Position 0 carries the *opponent's* champion ID; positions 3+ are stat
// deltas (gold diff, xp diff, kills diff, ...) that we don't need.
export const MATCHUP_FIELDS = {
  championId: 0,
  wins: 1,
  matches: 2,
};

export function decodeMatchup(arr) {
  if (!Array.isArray(arr) || arr.length < 3) return null;
  const championId = arr[MATCHUP_FIELDS.championId];
  const wins = arr[MATCHUP_FIELDS.wins];
  const matches = arr[MATCHUP_FIELDS.matches];
  if (
    typeof championId !== "number" ||
    typeof wins !== "number" ||
    typeof matches !== "number" ||
    matches === 0
  ) {
    return null;
  }
  return {
    championId,
    wins,
    matches,
    winRate: wins / matches,
  };
}

// The leaf at [region][rank][role] in the matchups endpoint is a 2-tuple:
// [recordsArray, lastUpdatedTimestamp]. This helper extracts the records.
export function extractMatchupRecords(leaf) {
  if (!Array.isArray(leaf) || leaf.length === 0) return null;
  const records = leaf[0];
  if (!Array.isArray(records)) return null;
  return records;
}
