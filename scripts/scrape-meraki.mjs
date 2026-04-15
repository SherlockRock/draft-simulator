#!/usr/bin/env node

/**
 * Fetches champion data from Meraki Analytics CDN.
 * Extracts: stats, adaptiveType, positions, roles, attributeRatings,
 * per-ability damageType, attackType.
 *
 * Output: data/raw/meraki-champions.json
 * Usage: node scripts/scrape-meraki.mjs
 */

import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { fetchJson, writeJson } from "./lib/fetch-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, "..", "data", "raw", "meraki-champions.json");

const MERAKI_URL =
  "https://cdn.merakianalytics.com/riot/lol/resources/latest/en-US/champions.json";

/**
 * Extract the fields we need from a Meraki champion entry.
 * Drops skins, lore, icons, and other irrelevant fields to keep raw data small.
 */
function extractChampion(champ) {
  // Collect per-ability damage types
  const abilityDamageTypes = {};
  for (const [key, abilities] of Object.entries(champ.abilities || {})) {
    if (abilities && abilities.length > 0) {
      abilityDamageTypes[key] = abilities[0].damageType || null;
    }
  }

  return {
    id: champ.id,
    key: champ.key,
    name: champ.name,
    attackType: champ.attackType,
    adaptiveType: champ.adaptiveType,
    positions: champ.positions || [],
    roles: champ.roles || [],
    attributeRatings: champ.attributeRatings || {},
    stats: {
      health: extractStat(champ.stats?.health),
      healthRegen: extractStat(champ.stats?.healthRegen),
      mana: extractStat(champ.stats?.mana),
      manaRegen: extractStat(champ.stats?.manaRegen),
      armor: extractStat(champ.stats?.armor),
      magicResistance: extractStat(champ.stats?.magicResistance),
      attackDamage: extractStat(champ.stats?.attackDamage),
      attackSpeed: extractStat(champ.stats?.attackSpeed),
      attackRange: extractStat(champ.stats?.attackRange),
      movespeed: extractStat(champ.stats?.movespeed),
    },
    abilityDamageTypes,
  };
}

function extractStat(stat) {
  if (!stat) return { flat: 0, perLevel: 0 };
  return { flat: stat.flat || 0, perLevel: stat.perLevel || 0 };
}

async function main() {
  console.log("=== Meraki Champion Scraper ===\n");

  const merakiData = await fetchJson(MERAKI_URL, "Meraki Analytics bulk champions");
  const champions = {};
  let count = 0;

  for (const [name, champ] of Object.entries(merakiData)) {
    champions[name] = extractChampion(champ);
    count++;
  }

  const output = {
    scrapedAt: new Date().toISOString(),
    source: MERAKI_URL,
    championCount: count,
    champions,
  };

  writeJson(OUTPUT_PATH, output);
  console.log(`\n  Champions scraped: ${count}`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
