#!/usr/bin/env node

/**
 * Validates data/compiled/champion-meta.json and matchup-data.json.
 * Fails (exit 1) if data is incomplete or clearly wrong.
 * Run as the last step of the pipeline.
 *
 * Usage: node scripts/validate-compiled-data.mjs
 */

import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const META_PATH = join(ROOT, "data", "compiled", "champion-meta.json");
const MATCHUP_PATH = join(ROOT, "data", "compiled", "matchup-data.json");
const CHAMPIONS_PATH = join(ROOT, "frontend", "src", "data", "champions.json");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

const errors = [];
const warnings = [];

function fail(msg) {
  errors.push(msg);
}
function warn(msg) {
  warnings.push(msg);
}

function main() {
  console.log("=== Validate Compiled Data ===\n");

  // Check files exist
  if (!existsSync(META_PATH)) {
    fail(`Missing ${META_PATH}`);
    report();
    return;
  }
  if (!existsSync(MATCHUP_PATH)) {
    fail(`Missing ${MATCHUP_PATH}`);
  }

  const meta = readJson(META_PATH);
  const canonical = readJson(CHAMPIONS_PATH);

  // 1. All canonical champions present
  const metaIds = new Set(Object.keys(meta.champions));
  for (const champ of canonical.champions) {
    if (!metaIds.has(champ.id)) {
      fail(`Missing champion: ${champ.id}`);
    }
  }
  console.log(`  Champions: ${metaIds.size} compiled, ${canonical.champions.length} canonical`);

  // 2. Every champion has all required fields (no nulls, no undefined)
  const requiredFields = [
    "id", "name", "positions", "damageProfile", "scalingProfile",
    "ccProfile", "tags", "blindability",
  ];
  const numericFields = ["blindability", "pickRate", "banRate", "winRate"];

  for (const [id, champ] of Object.entries(meta.champions)) {
    for (const field of requiredFields) {
      if (champ[field] === undefined || champ[field] === null) {
        fail(`${id}: missing field '${field}'`);
      }
    }

    // Damage profile sums to ~1.0
    const dp = champ.damageProfile;
    if (dp) {
      const sum = dp.physical + dp.magic + dp.true;
      if (sum < 0.95 || sum > 1.05) {
        warn(`${id}: damageProfile sums to ${sum.toFixed(3)} (expected ~1.0)`);
      }
    }

    // Scaling profile values in 0-1
    const sp = champ.scalingProfile;
    if (sp) {
      for (const [k, v] of Object.entries(sp)) {
        if (v < 0 || v > 1) {
          fail(`${id}: scalingProfile.${k} = ${v} (must be 0-1)`);
        }
      }
    }

    // Tags structure
    if (champ.tags) {
      if (!Array.isArray(champ.tags.archetype)) {
        fail(`${id}: tags.archetype must be an array`);
      }
      if (!Array.isArray(champ.tags.synergy)) {
        fail(`${id}: tags.synergy must be an array`);
      }
    }

    // Numeric fields are numbers
    for (const field of numericFields) {
      if (typeof champ[field] !== "number") {
        fail(`${id}: ${field} must be a number, got ${typeof champ[field]}`);
      }
    }
  }

  // 3. Spot checks — directional correctness
  const spotChecks = [
    {
      id: "Aatrox",
      check: (c) => c.damageProfile.physical > c.damageProfile.magic,
      msg: "Aatrox should be primarily physical",
    },
    {
      id: "Ahri",
      check: (c) => c.damageProfile.magic > c.damageProfile.physical,
      msg: "Ahri should be primarily magic",
    },
    {
      id: "Thresh",
      check: (c) => c.ccProfile.hasCc === true,
      msg: "Thresh should have CC",
    },
    {
      id: "Jinx",
      check: (c) => c.positions.includes("BOTTOM"),
      msg: "Jinx should have BOTTOM position",
    },
  ];

  for (const { id, check, msg } of spotChecks) {
    const champ = meta.champions[id];
    if (!champ) {
      warn(`Spot check skipped — ${id} not found`);
      continue;
    }
    if (!check(champ)) {
      warn(`Spot check FAILED: ${msg}`);
    }
  }

  // 4. Matchup data
  if (existsSync(MATCHUP_PATH)) {
    const matchup = readJson(MATCHUP_PATH);
    if (!matchup.synergyRules || !Array.isArray(matchup.synergyRules)) {
      fail("matchup-data.json: synergyRules must be an array");
    } else {
      console.log(`  Synergy rules: ${matchup.synergyRules.length}`);
    }
  }

  report();
}

function report() {
  console.log("");
  if (warnings.length > 0) {
    console.log(`  ⚠ Warnings (${warnings.length}):`);
    for (const w of warnings) console.log(`    - ${w}`);
  }
  if (errors.length > 0) {
    console.log(`\n  ✗ Errors (${errors.length}):`);
    for (const e of errors) console.log(`    - ${e}`);
    console.log("\n  VALIDATION FAILED");
    process.exit(1);
  } else {
    console.log("\n  ✓ Validation passed");
  }
}

main();
