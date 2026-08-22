/**
 * Ladder loop: refresh the summoner pool for one region.
 *
 * Apex tiers (CHALLENGER/GRANDMASTER/MASTER) come from the single-page league
 * lists; upper Diamond comes from the paged entries endpoint, capped so the
 * pool stays bounded. Runs once at collector start, then every 24h.
 */

import { upsertSummoners } from "./db.mjs";

/** @returns {Promise<number>} summoners upserted */
export async function runLadderOnce({ client, db, config, region, logger }) {
  let total = 0;

  for (const tier of config.apexTiers) {
    const list = await client.getApexEntries({
      tier,
      queue: config.leagueQueue,
      platform: region,
    });
    const entries = (list.entries ?? [])
      .filter((e) => e.puuid)
      .map((e) => ({
        puuid: e.puuid,
        tier,
        division: e.rank ?? "I",
        leaguePoints: e.leaguePoints,
      }));
    await upsertSummoners(db, region, entries);
    total += entries.length;
    logger.info?.(`ladder ${region}: ${tier} ${entries.length} entries`);
  }

  for (const division of config.diamondDivisions) {
    for (let page = 1; page <= config.diamondPageCap; page++) {
      const dtos = await client.getLeagueEntries({
        queue: config.leagueQueue,
        tier: "DIAMOND",
        division,
        page,
        platform: region,
      });
      if (dtos.length === 0) break;
      const entries = dtos
        .filter((e) => e.puuid)
        .map((e) => ({
          puuid: e.puuid,
          tier: "DIAMOND",
          division: e.rank ?? division,
          leaguePoints: e.leaguePoints,
        }));
      await upsertSummoners(db, region, entries);
      total += entries.length;
    }
    logger.info?.(`ladder ${region}: DIAMOND ${division} paged`);
  }

  return total;
}
