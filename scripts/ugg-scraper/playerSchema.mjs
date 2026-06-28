// scripts/ugg-scraper/playerSchema.mjs
//
// Canonicalizes ONE getPlayerStats response (a single role). Numeric championId
// -> string alias; u.gg role id -> engine role. v1 has no per-champ timestamp,
// so lastPlayed/recentWindowGames are always null (see PLAYER_API.md).
import { RANKED_SOLO_QUEUE } from "./playerConstants.mjs";

// u.gg role id -> engine role. 1 JG, 2 SUP, 3 BOTTOM->adc, 4 TOP, 5 MIDDLE->mid.
const ROLE_CANON = {
  1: "jungle",
  2: "support",
  3: "adc",
  4: "top",
  5: "mid",
};

export function canonicalizeRole(roleId) {
  return ROLE_CANON[roleId] ?? null;
}

// Picks the ranked-solo (queueType 420) block; returns its role + raw champ
// records. null when the response carries no solo block.
export function extractRolePerformances(raw) {
  const blocks = raw?.data?.fetchPlayerStatistics;
  if (!Array.isArray(blocks)) return null;
  const solo = blocks.find((b) => b?.queueType === RANKED_SOLO_QUEUE);
  if (!solo) return null;
  const perfs = Array.isArray(solo.basicChampionPerformances)
    ? solo.basicChampionPerformances
    : [];
  return {
    roleId: solo.role,
    records: perfs.map((p) => ({
      numericChampionId: p.championId,
      games: p.totalMatches,
      wins: p.wins,
    })),
  };
}

export function canonicalizeEntries(raw, { idToAlias }) {
  const extracted = extractRolePerformances(raw);
  if (!extracted) return [];
  const role = canonicalizeRole(extracted.roleId);
  if (!role) return [];
  const out = [];
  for (const r of extracted.records) {
    const championId = idToAlias[r.numericChampionId];
    if (!championId) continue; // unknown id: drop
    if (typeof r.games !== "number" || r.games <= 0) continue;
    out.push({
      championId,
      role,
      games: r.games,
      wins: typeof r.wins === "number" ? r.wins : 0,
      lastPlayed: null,
      recentWindowGames: null,
    });
  }
  return out;
}
