#!/usr/bin/env node
/**
 * Status CLI — runs anywhere with a DATABASE_URL (dev machine over the
 * tailnet, or on forge). Surfaces the numbers that make a silently dead day
 * visible: per-region counts, fetched-last-24h, patch mix, and a key-expiry
 * heuristic (backlog present but nothing fetched in 30 min).
 */

import { createDb, countMatchesByStatus } from "./db.mjs";

export async function collectStatus(db, { regions, staleMinutes = 30 }) {
  const out = { generatedAt: new Date().toISOString(), regions: {} };
  for (const region of regions) {
    const [summonerRows, matches, recent, patchRows] = await Promise.all([
      db.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE fetch_errored)::int AS errored
         FROM summoners WHERE region = $1`,
        [region],
      ),
      countMatchesByStatus(db, region),
      db.query(
        `SELECT
           count(*) FILTER (WHERE updated_at > now() - interval '24 hours')::int AS last24h,
           count(*) FILTER (WHERE updated_at > now() - make_interval(mins => $2))::int AS lastStale
         FROM matches WHERE region = $1 AND status = 'fetched'`,
        [region, staleMinutes],
      ),
      db.query(
        `SELECT patch_major, patch_minor, count(*)::int AS n
         FROM matches WHERE region = $1 AND status = 'fetched'
         GROUP BY patch_major, patch_minor ORDER BY patch_major, patch_minor`,
        [region],
      ),
    ]);
    const fetchedRecently = recent.rows[0].laststale > 0;
    out.regions[region] = {
      summoners: summonerRows.rows[0].total,
      summonersErrored: summonerRows.rows[0].errored,
      matches,
      fetchedLast24h: recent.rows[0].last24h,
      patchMix: patchRows.rows.map((r) => ({
        patch: `${r.patch_major}.${r.patch_minor}`,
        count: r.n,
      })),
      likelyKeyExpired: matches.pending > 0 && !fetchedRecently,
    };
  }
  return out;
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (invokedDirectly && process.argv[1].endsWith("status.mjs")) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("status: DATABASE_URL is required");
    process.exit(1);
  }
  const regions = (process.env.COLLECTOR_REGIONS ?? "na1,euw1,kr").split(",").map((r) => r.trim());
  const db = createDb(url);
  try {
    const status = await collectStatus(db, { regions });
    console.log(`# collector status @ ${status.generatedAt}\n`);
    for (const [region, s] of Object.entries(status.regions)) {
      const m = s.matches;
      console.log(`## ${region}`);
      console.log(`  summoners: ${s.summoners} (${s.summonersErrored} errored)`);
      console.log(
        `  matches:   pending=${m.pending} fetched=${m.fetched} skipped=${m.skipped} failed=${m.failed}`,
      );
      console.log(`  last 24h:  ${s.fetchedLast24h} fetched`);
      console.log(
        `  patches:   ${s.patchMix.map((p) => `${p.patch}×${p.count}`).join(", ") || "(none)"}`,
      );
      if (s.likelyKeyExpired) {
        console.log("  ⚠ KEY LIKELY EXPIRED — backlog present but nothing fetched in 30 min");
      }
      console.log("");
    }
  } finally {
    await db.close();
  }
}
