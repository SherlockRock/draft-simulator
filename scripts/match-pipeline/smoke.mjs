#!/usr/bin/env node

/**
 * Live connectivity smoke test. Requires RIOT_API_KEY in env.
 *
 * Usage:
 *   RIOT_API_KEY=RGAPI-... node scripts/match-pipeline/smoke.mjs
 *
 * What it does:
 *   1. Hits League-V4 challenger ladder for NA1
 *   2. Picks the first PUUID
 *   3. Fetches that player's most recent ranked match ID
 *   4. Fetches the full match detail
 *   5. Prints a summary
 *
 * If all four work, the client + rate limiter + auth + routing are wired up correctly.
 */

import { RiotClient } from "./riot-client.mjs";
import { TokenBucket, CompositeRateLimiter } from "./rate-limiter.mjs";

const apiKey = process.env.RIOT_API_KEY;
if (!apiKey) {
  console.error("Missing RIOT_API_KEY env var");
  process.exit(1);
}

// Personal-key default rate limits: 20/1s and 100/2min.
const limiter = new CompositeRateLimiter([
  new TokenBucket(20, 1000),
  new TokenBucket(100, 120_000),
]);

const client = new RiotClient({ apiKey, rateLimiter: limiter });

async function main() {
  console.log("1. Fetching NA1 challenger ladder...");
  const challenger = await client.getApexEntries({
    tier: "CHALLENGER",
    queue: "RANKED_SOLO_5x5",
    platform: "na1",
  });
  console.log(`   ${challenger.entries.length} challenger players`);

  const top = challenger.entries[0];
  console.log(`2. Top player has PUUID ${top.puuid.slice(0, 12)}...`);

  console.log("3. Fetching their last ranked match ID...");
  const ids = await client.getMatchIdsByPuuid(top.puuid, "americas", {
    queue: 420,
    count: 1,
  });
  if (!ids.length) {
    console.log("   No recent ranked matches.");
    return;
  }
  console.log(`   matchId=${ids[0]}`);

  console.log("4. Fetching full match detail...");
  const match = await client.getMatch(ids[0], "americas");
  console.log(
    `   patch=${match.info.gameVersion} duration=${Math.round(match.info.gameDuration / 60)}min participants=${match.info.participants.length}`,
  );

  console.log("\nSmoke test passed.");
}

main().catch((err) => {
  console.error("Smoke test FAILED:", err.message);
  process.exit(1);
});
