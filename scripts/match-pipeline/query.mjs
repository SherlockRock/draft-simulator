#!/usr/bin/env node
/**
 * Spot-check CLI over the collected corpus (runs anywhere with DATABASE_URL):
 *
 *   node query.mjs stats
 *   node query.mjs winrate <championId> <ROLE>
 *   node query.mjs matchup <championId> <opponentId> <ROLE>
 *
 * Roles are Riot vocabulary: TOP/JUNGLE/MIDDLE/BOTTOM/UTILITY. Champion IDs
 * are raw Riot ints (the store never maps to engine indices).
 */

import { createDb } from "./db.mjs";

const sideFilter = (side) => `
  SELECT (teams->'${side}'->>'win')::boolean AS win,
         (teams->'${side}'->'participants'->$2->>'championId')::int AS champ,
         (teams->'${(side === "100" ? "200" : "100")}'->'participants'->$2->>'championId')::int AS opp
  FROM matches WHERE status = 'fetched'`;

export async function computeWinrate(db, { championId, role }) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS games, count(*) FILTER (WHERE win)::int AS wins
     FROM (${sideFilter("100")} UNION ALL ${sideFilter("200")}) sides
     WHERE champ = $1`,
    [championId, role],
  );
  return rows[0];
}

export async function computeMatchup(db, { championId, opponentId, role }) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS games, count(*) FILTER (WHERE win)::int AS wins
     FROM (${sideFilter("100")} UNION ALL ${sideFilter("200")}) sides
     WHERE champ = $1 AND opp = $3`,
    [championId, role, opponentId],
  );
  return rows[0];
}

export async function computeStats(db) {
  const [total, patches, tiers] = await Promise.all([
    db.query("SELECT count(*)::int AS n FROM matches WHERE status = 'fetched'"),
    db.query(
      `SELECT patch_major, patch_minor, count(*)::int AS n FROM matches
       WHERE status = 'fetched' GROUP BY 1, 2 ORDER BY 1, 2`,
    ),
    db.query(
      `SELECT seed_tier, count(*)::int AS n FROM matches
       WHERE status = 'fetched' GROUP BY 1 ORDER BY 1`,
    ),
  ]);
  return {
    fetched: total.rows[0].n,
    byPatch: patches.rows.map((r) => ({ patch: `${r.patch_major}.${r.patch_minor}`, count: r.n })),
    bySeedTier: tiers.rows.map((r) => ({ seedTier: r.seed_tier, count: r.n })),
  };
}

const pct = (wins, games) => (games === 0 ? "n/a" : `${((100 * wins) / games).toFixed(1)}%`);

if (process.argv[1]?.endsWith("query.mjs")) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("query: DATABASE_URL is required");
    process.exit(1);
  }
  const [cmd, ...args] = process.argv.slice(2);
  const db = createDb(url);
  try {
    if (cmd === "stats") {
      const s = await computeStats(db);
      console.log(`fetched: ${s.fetched}`);
      console.log(`by patch:     ${s.byPatch.map((p) => `${p.patch}×${p.count}`).join(", ")}`);
      console.log(`by seed tier: ${s.bySeedTier.map((t) => `${t.seedTier}×${t.count}`).join(", ")}`);
    } else if (cmd === "winrate" && args.length === 2) {
      const r = await computeWinrate(db, { championId: Number(args[0]), role: args[1] });
      console.log(`champion ${args[0]} ${args[1]}: ${r.wins}/${r.games} (${pct(r.wins, r.games)})`);
    } else if (cmd === "matchup" && args.length === 3) {
      const r = await computeMatchup(db, {
        championId: Number(args[0]),
        opponentId: Number(args[1]),
        role: args[2],
      });
      console.log(
        `champion ${args[0]} vs ${args[1]} ${args[2]}: ${r.wins}/${r.games} (${pct(r.wins, r.games)})`,
      );
    } else {
      console.error("usage: query.mjs stats | winrate <champ> <ROLE> | matchup <a> <b> <ROLE>");
      process.exit(1);
    }
  } finally {
    await db.close();
  }
}
