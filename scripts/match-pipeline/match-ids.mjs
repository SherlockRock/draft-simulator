/**
 * Match-id loop: turn ranked summoners into a queue of pending match ids.
 *
 * Backlog-aware — when the region's pending count is past the threshold the
 * cycle no-ops, yielding the shared rate budget to the processor loop.
 */

import { platformToContinent } from "./regions.mjs";
import {
  selectSummonersToFetch,
  markSummonerMatchesFetched,
  markSummonerFetchErrored,
  insertPendingMatches,
  countMatchesByStatus,
} from "./db.mjs";

const APEX_TIERS = new Set(["CHALLENGER", "GRANDMASTER", "MASTER"]);

/**
 * One polling cycle: claim a batch of due summoners, fetch their recent ranked
 * match ids, queue the new ones.
 */
export async function runMatchIdCycle({
  client,
  db,
  config,
  region,
  logger,
  shouldStop = () => false,
}) {
  const { pending } = await countMatchesByStatus(db, region);
  if (pending > config.backlogPauseThreshold) {
    logger.info?.(`match-ids ${region}: backlog ${pending} > ${config.backlogPauseThreshold}, pausing`);
    return { paused: true, summonersProcessed: 0, discovered: 0 };
  }

  const continent = platformToContinent(region);
  const summoners = await selectSummonersToFetch(db, {
    region,
    limit: config.matchIdBatchSize,
    refetchDays: config.summonerRefetchDays,
    rankFreshDays: config.rankFreshDays,
  });

  let discovered = 0;
  let processed = 0;
  for (const summoner of summoners) {
    // Polled between summoners so a SIGTERM drain doesn't wait on the whole batch.
    if (shouldStop()) break;
    processed++;
    const maxPages = APEX_TIERS.has(summoner.tier)
      ? config.apexMatchIdPages
      : config.diamondMatchIdPages;
    try {
      const ids = [];
      for (let page = 0; page < maxPages; page++) {
        const pageIds = await client.getMatchIdsByPuuid(summoner.puuid, continent, {
          queue: config.queueId,
          startTime: config.startTime,
          count: config.matchIdsPerPage,
          start: page * config.matchIdsPerPage,
        });
        ids.push(...pageIds);
        if (pageIds.length < config.matchIdsPerPage) break;
      }
      discovered += await insertPendingMatches(db, {
        region,
        seedTier: summoner.tier,
        seedDivision: summoner.division,
        matchIds: ids,
      });
      await markSummonerMatchesFetched(db, summoner.puuid);
    } catch (err) {
      if (/Riot API 400\b/.test(err.message)) {
        // Deleted/transferred account — never retry.
        await markSummonerFetchErrored(db, summoner.puuid);
        logger.warn?.(`match-ids ${region}: 400 for ${summoner.puuid}, marked errored`);
      } else {
        // Transient — leave the summoner unstamped so a later cycle retries.
        logger.warn?.(`match-ids ${region}: ${summoner.puuid} failed: ${err.message}`);
      }
    }
  }

  return { paused: false, summonersProcessed: processed, discovered };
}
