#!/usr/bin/env node

/**
 * Fetches champion data from Community Dragon.
 * Summary endpoint for ID mapping, individual endpoints for playstyleInfo,
 * tacticalInfo, and championTagInfo.
 *
 * Output: data/raw/cdragon-champions.json
 * Usage: node scripts/scrape-cdragon.mjs
 */

import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { fetchJson, fetchJsonBatch, writeJson } from "./lib/fetch-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, "..", "data", "raw", "cdragon-champions.json");

const CDRAGON_BASE =
  "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1";
const SUMMARY_URL = `${CDRAGON_BASE}/champion-summary.json`;
const CHAMPION_URL = (id) => `${CDRAGON_BASE}/champions/${id}.json`;

function extractChampion(summary, detail) {
  return {
    numericId: summary.id,
    alias: summary.alias,
    name: summary.name,
    roles: summary.roles || [],
    tacticalInfo: detail?.tacticalInfo || null,
    playstyleInfo: detail?.playstyleInfo || null,
    championTagInfo: detail?.championTagInfo || null,
  };
}

async function main() {
  console.log("=== CDragon Champion Scraper ===\n");

  // 1. Fetch champion summary for ID list
  const summaryList = await fetchJson(SUMMARY_URL, "CDragon champion summary");

  // Filter out non-champion entries (id <= 0 or placeholder entries)
  const validSummaries = summaryList.filter((s) => s.id > 0 && s.alias);
  console.log(`  Valid champions in summary: ${validSummaries.length}`);

  // 2. Fetch individual champion data (batched)
  const requests = validSummaries.map((s) => ({
    url: CHAMPION_URL(s.id),
    label: s.alias,
  }));

  console.log(`  Fetching ${requests.length} individual champion pages (10 concurrent)...\n`);
  const detailResults = await fetchJsonBatch(requests, 10);

  // Build lookup by alias
  const detailByAlias = new Map();
  for (const result of detailResults) {
    if (result.data && !result.error) {
      detailByAlias.set(result.label, result.data);
    }
  }

  // 3. Merge summary + detail
  const champions = {};
  const errors = [];
  for (const summary of validSummaries) {
    const detail = detailByAlias.get(summary.alias);
    if (!detail) {
      errors.push(summary.alias);
    }
    champions[summary.alias] = extractChampion(summary, detail);
  }

  const output = {
    scrapedAt: new Date().toISOString(),
    source: CDRAGON_BASE,
    championCount: Object.keys(champions).length,
    champions,
  };

  writeJson(OUTPUT_PATH, output);
  console.log(`\n  Champions scraped: ${output.championCount}`);
  if (errors.length > 0) {
    console.log(`  ⚠ Failed to fetch detail for: ${errors.join(", ")}`);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
