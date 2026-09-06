#!/usr/bin/env node

/**
 * Validates data/compiled/champion-meta.json and matchup-data.json.
 * Fails (exit 1) if data is incomplete or clearly wrong.
 * Run as the last step of the pipeline.
 *
 * Usage: node scripts/validate-compiled-data.mjs [--meta PATH] [--champions PATH]
 */

import { readFileSync, existsSync } from "fs";
import { parseArgs } from "node:util";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { META_POSITIONS } from "./champion-positions/invariants.mjs";
import { formatPositionsSource } from "./champion-positions/derive.mjs";

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

  const { values } = parseArgs({
    options: {
      meta: { type: "string", default: META_PATH },
      champions: { type: "string", default: CHAMPIONS_PATH },
    },
  });
  const metaPath = values.meta;

  // Check files exist
  if (!existsSync(metaPath)) {
    fail(`Missing ${metaPath}`);
    report();
    return;
  }
  if (!existsSync(MATCHUP_PATH)) {
    fail(`Missing ${MATCHUP_PATH}`);
  }

  const meta = readJson(metaPath);
  const canonical = readJson(values.champions);

  // 1. All canonical champions present
  const metaIds = new Set(Object.keys(meta.champions));
  for (const champ of canonical.champions) {
    if (!metaIds.has(champ.id)) {
      fail(`Missing champion: ${champ.id}`);
    }
  }
  console.log(`  Champions: ${metaIds.size} compiled, ${canonical.champions.length} canonical`);

  // 1b. Count parity both ways (design § 5): never a hard-coded 173.
  if (metaIds.size !== canonical.champions.length) {
    fail(`champion count: ${metaIds.size} compiled vs ${canonical.champions.length} in champions.json`);
  }

  // 1c. Provenance carried VERBATIM (design § 5): the boot log and this
  //     validator say where positions came from, so a stale compile (older
  //     provenance than champions.json's) must fail, not just an absent one.
  const positionsSource = meta.sources?.positions;
  if (canonical.positionsSource && !positionsSource) {
    fail("champions.json carries positionsSource but champion-meta.json sources.positions is missing — recompile");
  } else if (JSON.stringify(canonical.positionsSource ?? null) !== JSON.stringify(positionsSource ?? null)) {
    fail(`champion-meta.json sources.positions differs from champions.json positionsSource — recompile (json: ${JSON.stringify(canonical.positionsSource ?? null)} vs compiled: ${JSON.stringify(positionsSource ?? null)})`);
  }
  console.log(`  Positions source: ${formatPositionsSource(positionsSource)}`);

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

    // Vocabulary + non-empty (design § 7 risk 5): UTILITY fails engine
    // construction, an empty list is a zero feasibility mask.
    if (Array.isArray(champ.positions)) {
      if (champ.positions.length === 0) fail(`${id}: positions is empty`);
      for (const position of champ.positions) {
        if (!META_POSITIONS.includes(position)) {
          fail(`${id}: position ${position} is not one of ${META_POSITIONS.join("/")}`);
        }
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

  // 3b. Compiled positions vs champions.json — overrides apply last in the
  //     compile and would otherwise win over the refresh with no visible diff
  //     (design § 5). Order matters: positions[0] is the primary.
  const canonicalById = new Map(canonical.champions.map((c) => [c.id, c]));
  let differ = 0;
  for (const [id, champ] of Object.entries(meta.champions)) {
    const source = canonicalById.get(id);
    if (!source) continue;
    if (JSON.stringify(champ.positions) !== JSON.stringify(source.positions)) {
      differ += 1;
      warn(`positions differ from champions.json: ${id} compiled [${champ.positions.join(",")}] vs json [${source.positions.join(",")}] (override?)`);
    }
  }
  console.log(`  Positions identical to champions.json: ${metaIds.size - differ}/${metaIds.size}`);

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
