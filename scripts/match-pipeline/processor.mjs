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

/**
 * `shouldStop` is polled between items so a SIGTERM drain ends after the
 * in-flight items rather than after the whole batch — a full batch is
 * ~4 rate windows (200 × 2 requests at 100/2min) and systemd's stop timeout
 * is 120s. Unstarted rows keep their `pending` status and are re-claimed.
 */
export async function runProcessorCycle({
  client,
  db,
  config,
  region,
  logger,
  shouldStop = () => false,
}) {
  const claimed = await claimPendingMatches(db, {
    region,
    limit: config.processorBatchSize,
  });
  const counts = { claimed: claimed.length, fetched: 0, skipped: 0, failed: 0 };
  if (claimed.length === 0) return counts;

  const continent = platformToContinent(region);
  const queue = [...claimed];
  // Drain diagnostics: what each worker is on when a stop is requested.
  const inFlight = new Map();
  let stopSeenAt = null;

  const worker = async (slot) => {
    for (let item = queue.shift(); item !== undefined && !shouldStop(); item = queue.shift()) {
      const { match_id: matchId } = item;
      const stage = (s) => inFlight.set(slot, { matchId, stage: s, since: Date.now() });
      try {
        stage("match");
        const matchDto = await client.getMatch(matchId, continent);
        stage("timeline");
        const timelineDto = await client.getMatchTimeline(matchId, continent);
        stage("db");
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
        if (/(key-manager|rate-limiter) aborted/.test(err.message)) {
          // Shutdown while paused on an expired key or waiting for rate budget —
          // leave the row pending so the next run re-claims it instead of
          // burying it as failed.
          break;
        }
        await markMatchFailed(db, matchId, String(err.message).slice(0, 500));
        counts.failed++;
        logger.warn?.(`processor ${region}: ${matchId} failed: ${err.message}`);
      } finally {
        const f = inFlight.get(slot);
        inFlight.delete(slot);
        if (shouldStop() && f) {
          if (!stopSeenAt) {
            // First worker to notice the stop reports what everyone else is on.
            stopSeenAt = Date.now();
            const stages = [...inFlight.values()].map((x) => `${x.stage}:${Date.now() - x.since}ms`);
            logger.info?.(
              `processor ${region}: stop requested, ${inFlight.size} still in flight [${stages.join(" ")}]`,
            );
          }
          logger.info?.(
            `processor ${region}: drain — worker ${slot} left ${f.matchId} at stage ${f.stage} ` +
              `${Date.now() - stopSeenAt}ms after first stop`,
          );
        }
      }
    }
  };

  const workers = Array.from(
    { length: Math.max(1, Math.min(config.processorConcurrency, claimed.length)) },
    (_, slot) => worker(slot),
  );
  await Promise.all(workers);
  return counts;
}
