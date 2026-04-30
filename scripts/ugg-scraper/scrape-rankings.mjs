#!/usr/bin/env node
// scripts/ugg-scraper/scrape-rankings.mjs
//
// Iterate every champion in cdragon-champions.json, fetch their rankings JSON
// from u.gg, decode the world / emerald+ winrates per role, and write
// data/compiled/winrates.json. Drops cells with fewer than 50 matches as
// noise.

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { UggFetcher } from "./fetcher.mjs";
import { decodeRanking } from "./schema.mjs";
import {
  rankingsUrl,
  REGION_INDEX,
  RANK_INDEX,
  ROLE_INDEX,
  PATCH,
} from "./constants.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const CDRAGON_PATH = join(ROOT, "data", "raw", "cdragon-champions.json");
const OUT_PATH = join(ROOT, "data", "compiled", "winrates.json");

const PRIMARY_REGION = "world";
const PRIMARY_RANK = "emerald_plus";
const MIN_MATCHES = 50;

async function main() {
  const cdragon = JSON.parse(readFileSync(CDRAGON_PATH, "utf-8"));
  const champions = Object.values(cdragon.champions);
  const fetcher = new UggFetcher();

  const byChampion = {};
  let i = 0;
  let hits = 0;
  let misses = 0;
  for (const champ of champions) {
    i += 1;
    process.stdout.write(
      `\r  [${i}/${champions.length}] ${champ.alias}                `,
    );
    const data = await fetcher.getJson(rankingsUrl(champ.numericId));
    if (!data) {
      misses += 1;
      continue;
    }
    const regionBlock = data[REGION_INDEX[PRIMARY_REGION]];
    const rankBlock = regionBlock?.[RANK_INDEX[PRIMARY_RANK]];
    if (!rankBlock) {
      misses += 1;
      continue;
    }
    const champEntry = {};
    for (const [roleName, idx] of Object.entries(ROLE_INDEX)) {
      const arr = rankBlock[idx];
      const decoded = decodeRanking(arr);
      if (decoded && decoded.matches >= MIN_MATCHES) {
        champEntry[roleName] = {
          wr: Number(decoded.winRate.toFixed(4)),
          n: decoded.matches,
        };
      }
    }
    if (Object.keys(champEntry).length > 0) {
      byChampion[champ.alias] = champEntry;
      hits += 1;
    }
  }
  console.log();

  const output = {
    compiledAt: new Date().toISOString(),
    source: "u.gg",
    patch: PATCH,
    region: PRIMARY_REGION,
    rank: PRIMARY_RANK,
    minMatches: MIN_MATCHES,
    championCount: hits,
    byChampion,
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + "\n");
  console.log(`  Wrote ${OUT_PATH}: ${hits} champions (${misses} skipped)`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
