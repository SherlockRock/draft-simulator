#!/usr/bin/env node
// scripts/ugg-scraper/scrape-matchups.mjs
//
// Iterate every champion in cdragon-champions.json, fetch their matchups JSON
// from u.gg, decode the world / emerald+ matchup records per role, then call
// buildCounters() to flatten into the engine's expected shape and write
// data/compiled/counters.json.

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { UggFetcher } from "./fetcher.mjs";
import { decodeMatchup, extractMatchupRecords } from "./schema.mjs";
import {
  matchupsUrl,
  REGION_INDEX,
  RANK_INDEX,
  ROLE_INDEX,
  PATCH,
} from "./constants.mjs";
import { buildCounters } from "./aggregate.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const CDRAGON_PATH = join(ROOT, "data", "raw", "cdragon-champions.json");
const WINRATES_PATH = join(ROOT, "data", "compiled", "winrates.json");
const OUT_PATH = join(ROOT, "data", "compiled", "counters.json");

const PRIMARY_REGION = "world";
const PRIMARY_RANK = "emerald_plus";
const MIN_MATCHES = 30;

async function main() {
  const cdragon = JSON.parse(readFileSync(CDRAGON_PATH, "utf-8"));
  const winrates = JSON.parse(readFileSync(WINRATES_PATH, "utf-8"));
  const fetcher = new UggFetcher();
  const champions = Object.values(cdragon.champions);
  const idToAlias = Object.fromEntries(
    champions.map((c) => [c.numericId, c.alias]),
  );

  const matchupsByChampion = {};
  let i = 0;
  let hits = 0;
  let misses = 0;
  for (const champ of champions) {
    i += 1;
    process.stdout.write(
      `\r  [${i}/${champions.length}] ${champ.alias}                `,
    );
    const data = await fetcher.getJson(matchupsUrl(champ.numericId));
    if (!data) {
      misses += 1;
      continue;
    }
    const rankBlock =
      data[REGION_INDEX[PRIMARY_REGION]]?.[RANK_INDEX[PRIMARY_RANK]];
    if (!rankBlock) {
      misses += 1;
      continue;
    }

    const champRecord = {};
    for (const [roleName, idx] of Object.entries(ROLE_INDEX)) {
      const records = extractMatchupRecords(rankBlock[idx]);
      if (!records) continue;
      const decoded = records.map(decodeMatchup).filter(Boolean);
      if (decoded.length > 0) {
        champRecord[roleName] = decoded;
      }
    }
    if (Object.keys(champRecord).length > 0) {
      matchupsByChampion[champ.numericId] = champRecord;
      hits += 1;
    }
  }
  console.log();

  const counters = buildCounters(
    matchupsByChampion,
    winrates.byChampion,
    idToAlias,
    { minMatches: MIN_MATCHES },
  );

  const output = {
    compiledAt: new Date().toISOString(),
    source: "u.gg",
    patch: PATCH,
    region: PRIMARY_REGION,
    rank: PRIMARY_RANK,
    minMatches: MIN_MATCHES,
    championCount: Object.keys(counters).length,
    counters,
  };

  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + "\n");
  console.log(
    `  Wrote ${OUT_PATH}: ${output.championCount} champions with counter entries (${hits} fetched, ${misses} skipped)`,
  );
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
