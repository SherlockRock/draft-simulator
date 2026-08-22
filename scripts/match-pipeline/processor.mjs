/**
 * Processor loop: drain pending matches — fetch match + timeline through the
 * shared limiter with bounded concurrency, run the pure extractor, persist.
 *
 * Per-match failures never sink the batch: extraction rejections become
 * `skipped`, fetch errors become `failed`, both with error_detail. Crash
 * mid-batch leaves unmarked rows pending, so restart just re-claims them.
 */

import { platformToContinent } from "./regions.mjs";
import {
  claimPendingMatches,
  markMatchFetched,
  markMatchSkipped,
  markMatchFailed,
} from "./db.mjs";
import { extractMatch, EXTRACTOR_VERSION } from "./extractor.mjs";

export async function runProcessorCycle({ client, db, config, region, logger }) {
  const claimed = await claimPendingMatches(db, {
    region,
    limit: config.processorBatchSize,
  });
  const counts = { claimed: claimed.length, fetched: 0, skipped: 0, failed: 0 };
  if (claimed.length === 0) return counts;

  const continent = platformToContinent(region);
  const queue = [...claimed];

  const worker = async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      const { match_id: matchId } = item;
      try {
        const matchDto = await client.getMatch(matchId, continent);
        const timelineDto = await client.getMatchTimeline(matchId, continent);
        const { record, skipReason } = extractMatch(matchDto, timelineDto);
        if (skipReason) {
          await markMatchSkipped(db, matchId, skipReason);
          counts.skipped++;
        } else {
          await markMatchFetched(db, matchId, {
            queueId: record.queueId,
            gameVersion: record.gameVersion,
            patchMajor: record.patchMajor,
            patchMinor: record.patchMinor,
            gameDuration: record.gameDurationSec,
            gameStart: new Date(record.gameStartTimestampMs),
            teams: record.teams,
            extractorVersion: EXTRACTOR_VERSION,
          });
          counts.fetched++;
        }
      } catch (err) {
        await markMatchFailed(db, matchId, String(err.message).slice(0, 500));
        counts.failed++;
        logger.warn?.(`processor ${region}: ${matchId} failed: ${err.message}`);
      }
    }
  };

  const workers = Array.from(
    { length: Math.max(1, Math.min(config.processorConcurrency, claimed.length)) },
    worker,
  );
  await Promise.all(workers);
  return counts;
}
