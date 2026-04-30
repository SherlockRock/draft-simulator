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
