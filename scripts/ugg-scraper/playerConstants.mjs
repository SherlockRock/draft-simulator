// scripts/ugg-scraper/playerConstants.mjs
//
// u.gg per-player GraphQL contract. DIFFERENT API from constants.mjs (which
// hits the static stats2.u.gg positional JSON). Decoded 2026-06-28 against live
// u.gg (profile aeon#na3); see PLAYER_API.md for the field map + GO verdict.
//
// Key findings that shape this module:
//   - `role` is a SCALAR input (role 1..5). The per-role pool therefore needs
//     FIVE requests (one per role); each returns only the champs played in that
//     role, with totalMatches/wins scoped to that role (flex champs split).
//   - `regionId` is a passthrough STRING ("na1"), NOT a numeric id — no mapping.
//   - `seasonId` is a scalar int (current season). Bump each season, like PATCH.
//   - No per-champ timestamp exists → recency is not derivable here (deferred).

export const PLAYER_API_URL = "https://u.gg/api";
export const OPERATION_NAME = "getPlayerStats";

// Current season. Bump each season cycle (the API rejects nothing, but stale
// seasonId silently returns last season's aggregates).
export const SEASON_ID = 26;

// Ranked Solo/Duo. We request only this queue for v1 (design picked ranked_solo).
export const RANKED_SOLO_QUEUE = 420;
export const QUEUE_TYPES = [RANKED_SOLO_QUEUE];
// Canonical queue label stored in the envelope (matches the meta scraper's QUEUE).
export const QUEUE_LABEL = "ranked_solo_5x5";

// u.gg role ids for the scalar `role` input. Identical enum to constants.mjs
// ROLE_INDEX: 1 JUNGLE, 2 SUPPORT, 3 BOTTOM(adc), 4 TOP, 5 MIDDLE (7 = all,
// unused here). Verified 2026-06-28 by cross-referencing match-summary roles.
export const ROLE_IDS = [1, 2, 3, 4, 5];

// Minimal selection set — a subset of u.gg's captured query (GraphQL allows
// requesting fewer fields). We only need championId/totalMatches/wins per champ,
// plus the block-level role/queueType so the extractor can disambiguate blocks.
const PLAYER_STATS_QUERY = `query getPlayerStats($queueType: [Int!], $regionId: String!, $role: Int!, $seasonId: Int!, $riotUserName: String!, $riotTagLine: String!) {
  fetchPlayerStatistics(queueType: $queueType, riotUserName: $riotUserName, riotTagLine: $riotTagLine, regionId: $regionId, role: $role, seasonId: $seasonId) {
    basicChampionPerformances { championId totalMatches wins }
    queueType
    role
    seasonId
  }
}`;

// Builds the GraphQL POST body for ONE role. u.gg's own client lowercases the
// Riot id parts and region, so we do too (Riot ids are case-insensitive).
export function buildPlayerStatsQuery({
  regionId,
  gameName,
  tagLine,
  role,
  seasonId = SEASON_ID,
  queueType = QUEUE_TYPES,
}) {
  return {
    operationName: OPERATION_NAME,
    query: PLAYER_STATS_QUERY,
    variables: {
      riotUserName: String(gameName).toLowerCase(),
      riotTagLine: String(tagLine).toLowerCase(),
      regionId: String(regionId).toLowerCase(),
      role,
      seasonId,
      queueType,
    },
  };
}
