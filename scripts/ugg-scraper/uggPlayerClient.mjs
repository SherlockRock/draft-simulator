// scripts/ugg-scraper/uggPlayerClient.mjs
//
// Scout one Riot id -> canonicalized, versioned champion_stats envelope (§3).
// `role` is a scalar u.gg input, so we make ONE request per role and union the
// per-role champ blocks. Reuses UggFetcher's retry/backoff via postJson.
import { UggFetcher } from "./fetcher.mjs";
import {
  PLAYER_API_URL,
  SEASON_ID,
  QUEUE_LABEL,
  ROLE_IDS,
  buildPlayerStatsQuery,
} from "./playerConstants.mjs";
import { canonicalizeEntries } from "./playerSchema.mjs";
import { loadIdToAlias } from "./championIds.mjs";

export async function scoutPlayer({
  region,
  gameName,
  tagLine,
  fetcher = new UggFetcher(),
  now = new Date(),
  idToAlias = loadIdToAlias(),
  roleIds = ROLE_IDS,
}) {
  const entries = [];
  for (const role of roleIds) {
    const body = buildPlayerStatsQuery({ regionId: region, gameName, tagLine, role });
    const raw = await fetcher.postJson(PLAYER_API_URL, body);
    if (!raw) continue; // 404/403/private for this role
    entries.push(...canonicalizeEntries(raw, { idToAlias }));
  }
  return {
    provider: "ugg",
    schemaVersion: 1,
    fetchedAt: now.toISOString(),
    season: String(SEASON_ID),
    queue: QUEUE_LABEL,
    entries,
  };
}
