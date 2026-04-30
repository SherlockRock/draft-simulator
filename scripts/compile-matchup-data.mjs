#!/usr/bin/env node

/**
 * Compiles matchup-data.json from manual synergy rules and (future) counter data.
 *
 * Output: data/compiled/matchup-data.json
 * Usage: node scripts/compile-matchup-data.mjs
 */

import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { writeJson } from "./lib/fetch-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const SYNERGY_PATH = join(ROOT, "data", "overrides", "synergy-tags.json");
const COUNTERS_PATH = join(ROOT, "data", "compiled", "counters.json");
const OUTPUT_PATH = join(ROOT, "data", "compiled", "matchup-data.json");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

async function main() {
  console.log("=== Compile Matchup Data ===\n");

  if (!existsSync(SYNERGY_PATH)) throw new Error(`Missing ${SYNERGY_PATH}`);
  const synergyTags = readJson(SYNERGY_PATH);

  // Synergy rules — tag pair → bonus value
  // These are hand-authored. The engine evaluator checks whether a team's
  // combined synergy tags satisfy any rule.
  const synergyRules = [
    {
      tags: ["engage_initiator", "follow_up_cc"],
      bonus: 0.3,
      description: "Hard engage + reliable follow-up CC creates kill pressure in teamfights",
    },
    {
      tags: ["adc", "peel_support"],
      bonus: 0.25,
      description: "Protected ADC can DPS safely in teamfights",
    },
    {
      tags: ["adc", "shield_heal"],
      bonus: 0.2,
      description: "Enchanter + ADC amplifies sustained damage output",
    },
    {
      tags: ["engage_initiator", "backline_carry"],
      bonus: 0.2,
      description: "Frontline engage gives backline carries space to deal damage",
    },
    {
      tags: ["frontline", "backline_carry"],
      bonus: 0.15,
      description: "Front-to-back teamfight comp with clear threat hierarchy",
    },
    {
      tags: ["pick_threat", "follow_up_cc"],
      bonus: 0.2,
      description: "Pick comp with CC chaining to lock down caught targets",
    },
    {
      tags: ["splitpush", "disengage"],
      bonus: 0.15,
      description: "Split push threat + disengage lets team stall 4v5 while split pusher pressures",
    },
    {
      tags: ["engage_initiator", "ap_threat"],
      bonus: 0.1,
      description: "AP follow-up on engage prevents opponents from stacking armor",
    },
  ];

  // Counter matrix — populated from data/compiled/counters.json (built by
  // scripts/ugg-scraper/scrape-matchups.mjs). Empty if the file is missing,
  // so the compile step still runs in environments without the scrape data.
  let counters = {};
  let counterSource = "none — awaiting data pipeline";
  if (existsSync(COUNTERS_PATH)) {
    const compiled = readJson(COUNTERS_PATH);
    counters = compiled.counters ?? {};
    if (compiled.source && compiled.patch && compiled.rank) {
      counterSource = `${compiled.source} ${compiled.rank} ${compiled.patch}`;
    }
    console.log(`  Loaded counters: ${Object.keys(counters).length} champions (${counterSource})`);
  } else {
    console.log(`  ! ${COUNTERS_PATH} not found — counters map will be empty`);
  }

  const output = {
    compiledAt: new Date().toISOString(),
    counters,
    synergyRules,
    _meta: {
      counterSource,
      synergyRuleCount: synergyRules.length,
      vocabularySize: synergyTags._vocabulary?.length || 0,
    },
  };

  writeJson(OUTPUT_PATH, output);
  console.log(`  Synergy rules: ${synergyRules.length}`);
  console.log(`  Counter entries: ${Object.keys(counters).length}`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
