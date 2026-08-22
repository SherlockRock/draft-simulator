/**
 * Persistence layer for the match collector. Plain SQL via `pg` — this DB
 * (firstpick_matches) is fully independent of the app database.
 *
 * Every helper takes the db handle first and an optional `client` for callers
 * inside a transaction (see withTransaction).
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

export function createDb(databaseUrl) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  return {
    pool,
    query: (text, params) => pool.query(text, params),
    close: () => pool.end(),
  };
}

export async function migrate(db) {
  const sqlPath = fileURLToPath(new URL("./init.sql", import.meta.url));
  const sql = await readFile(sqlPath, "utf8");
  await db.query(sql);
}

/** Run `fn(client)` inside a transaction; rolls back on throw. */
export async function withTransaction(db, fn) {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---- Summoners (ladder loop) ----

/**
 * Batch upsert ladder entries. Updates rank fields on conflict but preserves
 * matches_fetched_at / fetch_errored (they belong to the match-id loop).
 * @param {Array<{puuid: string, tier: string, division: string, leaguePoints: number}>} entries
 */
export async function upsertSummoners(db, region, entries, { chunkSize = 500 } = {}) {
  for (let i = 0; i < entries.length; i += chunkSize) {
    const chunk = entries.slice(i, i + chunkSize);
    await db.query(
      `INSERT INTO summoners (puuid, region, tier, division, league_points, rank_updated_at)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[], $6::timestamptz[])
       ON CONFLICT (puuid) DO UPDATE SET
         region = EXCLUDED.region,
         tier = EXCLUDED.tier,
         division = EXCLUDED.division,
         league_points = EXCLUDED.league_points,
         rank_updated_at = EXCLUDED.rank_updated_at`,
      [
        chunk.map((e) => e.puuid),
        chunk.map(() => region),
        chunk.map((e) => e.tier),
        chunk.map((e) => e.division),
        chunk.map((e) => e.leaguePoints ?? null),
        chunk.map(() => new Date()),
      ],
    );
  }
}

const TIER_ORDER = ["CHALLENGER", "GRANDMASTER", "MASTER", "DIAMOND"];

/**
 * Summoners due a match-id fetch: never fetched or stale, rank still fresh,
 * not errored. Apex-first so freshest-meta players lead.
 */
export async function selectSummonersToFetch(
  db,
  { region, limit, refetchDays = 2, rankFreshDays = 7 },
) {
  const { rows } = await db.query(
    `SELECT puuid, tier, division FROM summoners
     WHERE region = $1
       AND NOT fetch_errored
       AND (matches_fetched_at IS NULL
            OR matches_fetched_at < now() - make_interval(days => $2))
       AND rank_updated_at > now() - make_interval(days => $3)
     ORDER BY array_position($4::text[], tier), matches_fetched_at NULLS FIRST
     LIMIT $5`,
    [region, refetchDays, rankFreshDays, TIER_ORDER, limit],
  );
  return rows;
}

export async function markSummonerMatchesFetched(db, puuid) {
  await db.query("UPDATE summoners SET matches_fetched_at = now() WHERE puuid = $1", [puuid]);
}

export async function markSummonerFetchErrored(db, puuid) {
  await db.query("UPDATE summoners SET fetch_errored = TRUE WHERE puuid = $1", [puuid]);
}

// ---- Matches (match-id + processor loops) ----

/**
 * Queue newly-discovered match ids, stamped with the seed summoner's rank.
 * Dedupes on match_id (first seed wins). Returns the number actually inserted.
 */
export async function insertPendingMatches(db, { region, seedTier, seedDivision, matchIds }) {
  if (matchIds.length === 0) return 0;
  const { rowCount } = await db.query(
    `INSERT INTO matches (match_id, region, seed_tier, seed_division)
     SELECT unnest($1::text[]), $2, $3, $4
     ON CONFLICT (match_id) DO NOTHING`,
    [matchIds, region, seedTier, seedDivision],
  );
  return rowCount;
}

/**
 * Claim a batch of pending matches. FOR UPDATE SKIP LOCKED so a concurrent
 * claimer (a future second worker) never gets the same rows while both hold
 * their transactions. With the single worker per region this is just a read.
 */
export async function claimPendingMatches(db, { region, limit, client }) {
  const runner = client ?? db;
  const { rows } = await runner.query(
    `SELECT match_id FROM matches
     WHERE region = $1 AND status = 'pending'
     ORDER BY created_at
     LIMIT $2
     FOR UPDATE SKIP LOCKED`,
    [region, limit],
  );
  return rows;
}

export async function markMatchFetched(
  db,
  matchId,
  { queueId, gameVersion, patchMajor, patchMinor, gameDuration, gameStart, teams, extractorVersion },
) {
  await db.query(
    `UPDATE matches SET
       status = 'fetched',
       queue_id = $2,
       game_version = $3,
       patch_major = $4,
       patch_minor = $5,
       game_duration = $6,
       game_start = $7,
       teams = $8,
       extractor_version = $9,
       error_detail = NULL,
       updated_at = now()
     WHERE match_id = $1`,
    [matchId, queueId, gameVersion, patchMajor, patchMinor, gameDuration, gameStart, teams, extractorVersion],
  );
}

export async function markMatchSkipped(db, matchId, reason) {
  await db.query(
    "UPDATE matches SET status = 'skipped', error_detail = $2, updated_at = now() WHERE match_id = $1",
    [matchId, reason],
  );
}

export async function markMatchFailed(db, matchId, reason) {
  await db.query(
    "UPDATE matches SET status = 'failed', error_detail = $2, updated_at = now() WHERE match_id = $1",
    [matchId, reason],
  );
}

export async function countMatchesByStatus(db, region) {
  const { rows } = await db.query(
    "SELECT status, count(*)::int AS n FROM matches WHERE region = $1 GROUP BY status",
    [region],
  );
  const counts = { pending: 0, fetched: 0, skipped: 0, failed: 0 };
  for (const { status, n } of rows) counts[status] = n;
  return counts;
}
