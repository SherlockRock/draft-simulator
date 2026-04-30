#!/usr/bin/env node

/**
 * Merges raw Meraki + CDragon data with manual overrides to produce
 * data/compiled/champion-meta.json.
 *
 * Derivation logic:
 *   damageProfile  — from Meraki adaptiveType + per-ability damageType
 *   scalingProfile — from Meraki stat growth rates
 *   ccProfile      — from manual CC mapping + Meraki attributeRatings.control
 *   tags.archetype — from Meraki roles
 *   tags.synergy   — from manual synergy-tags.json
 *   blindability   — defaults to 0.5 (needs counter data for proper computation)
 *   pickRate/banRate/winRate — defaults to 0 (no source available yet)
 *
 * Usage: node scripts/compile-champion-meta.mjs
 */

import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { writeJson, normalize } from "./lib/fetch-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// Inputs
const MERAKI_PATH = join(ROOT, "data", "raw", "meraki-champions.json");
const CDRAGON_PATH = join(ROOT, "data", "raw", "cdragon-champions.json");
const CHAMPIONS_PATH = join(ROOT, "frontend", "src", "data", "champions.json");
const CC_MAPPING_PATH = join(ROOT, "data", "overrides", "cc-mapping.json");
const SYNERGY_PATH = join(ROOT, "data", "overrides", "synergy-tags.json");
const OVERRIDES_PATH = join(ROOT, "data", "overrides", "champion-overrides.json");
const WINRATES_PATH = join(ROOT, "data", "compiled", "winrates.json");

// Output
const OUTPUT_PATH = join(ROOT, "data", "compiled", "champion-meta.json");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

// ── Derivation functions ──────────────────────────────────────────

/**
 * Derive damage profile from Meraki adaptiveType + per-ability damageType.
 * Returns { physical, magic, true } summing to ~1.0
 */
function deriveDamageProfile(meraki) {
  if (!meraki) return { physical: 0.5, magic: 0.4, true: 0.1 };

  // Count ability damage types
  const types = Object.values(meraki.abilityDamageTypes || {});
  let physCount = 0;
  let magicCount = 0;
  for (const t of types) {
    if (t === "PHYSICAL_DAMAGE") physCount++;
    else if (t === "MAGIC_DAMAGE") magicCount++;
  }
  const total = physCount + magicCount || 1;

  // Base from adaptiveType, adjust with ability distribution
  const isPhysical = meraki.adaptiveType === "PHYSICAL_DAMAGE";
  const abilityPhysRatio = physCount / total;
  const abilityMagicRatio = magicCount / total;

  let physical, magic;
  if (isPhysical) {
    // Physical champion — abilities shift the ratio
    physical = 0.6 + 0.3 * abilityPhysRatio;
    magic = 0.3 * abilityMagicRatio;
  } else {
    // Magic champion
    magic = 0.6 + 0.3 * abilityMagicRatio;
    physical = 0.3 * abilityPhysRatio;
  }

  // True damage is the remainder (always small for heuristic)
  const trueDmg = Math.max(0.05, 1 - physical - magic);
  const sum = physical + magic + trueDmg;

  return {
    physical: round(physical / sum),
    magic: round(magic / sum),
    true: round(trueDmg / sum),
  };
}

/**
 * Derive scaling profile from stat growth rates.
 * High base + low growth = early. High growth = late.
 */
function deriveScalingProfile(meraki) {
  if (!meraki?.stats) return { early: 0.5, mid: 0.5, late: 0.5 };

  // Key combat stats for scaling assessment
  const stats = ["health", "armor", "magicResistance", "attackDamage"];
  let growthRatioSum = 0;
  let count = 0;

  for (const statName of stats) {
    const stat = meraki.stats[statName];
    if (!stat || !stat.flat) continue;
    // Ratio of level-18 growth to total stat at level 18
    const totalAt18 = stat.flat + stat.perLevel * 17;
    if (totalAt18 <= 0) continue;
    const growthRatio = (stat.perLevel * 17) / totalAt18;
    growthRatioSum += growthRatio;
    count++;
  }

  const avgGrowthRatio = count > 0 ? growthRatioSum / count : 0.5;

  // Map growth ratio to scaling curve
  // Low growth ratio (0.3) = strong early, weaker late
  // High growth ratio (0.6) = weak early, strong late
  const early = round(1 - avgGrowthRatio * 1.2);
  const late = round(avgGrowthRatio * 1.5);
  const mid = round((early + late) / 2 + 0.15); // Mid is usually decent for everyone

  return {
    early: clamp(early),
    mid: clamp(mid),
    late: clamp(late),
  };
}

/**
 * Derive CC profile from manual CC mapping + Meraki attributeRatings.
 */
function deriveCcProfile(champId, ccMapping, meraki) {
  const ccTypes = ccMapping[champId] || [];
  const hasCc = ccTypes.length > 0;
  const control = meraki?.attributeRatings?.control || 0;
  const mobility = meraki?.attributeRatings?.mobility || 0;
  const utility = meraki?.attributeRatings?.utility || 0;

  // If not in CC mapping, infer hasCc from control rating
  const effectiveHasCc = hasCc || control >= 4;

  // Engage quality: control + mobility (gap closers help engage)
  const engageQuality = round(clamp((control * 0.7 + mobility * 0.3) / 10));

  // Peel quality: control + utility (shields/heals help peel)
  const peelQuality = round(clamp((control * 0.6 + utility * 0.4) / 10));

  return {
    hasCc: effectiveHasCc,
    ccTypes: ccTypes,
    engageQuality,
    peelQuality,
  };
}

/**
 * Derive archetype tags from Meraki roles.
 */
function deriveArchetypeTags(meraki, cdragon) {
  const tags = new Set();
  const roleMap = {
    FIGHTER: "bruiser",
    JUGGERNAUT: "juggernaut",
    TANK: "frontline",
    MAGE: "mage",
    ASSASSIN: "assassin",
    MARKSMAN: "marksman",
    SUPPORT: "enchanter",
    CATCHER: "catcher",
    SPECIALIST: "specialist",
    VANGUARD: "vanguard",
    WARDEN: "warden",
    BURST: "burst",
    BATTLEMAGE: "battlemage",
    ARTILLERY: "artillery",
    DIVER: "diver",
    SKIRMISHER: "skirmisher",
  };

  for (const role of meraki?.roles || []) {
    const mapped = roleMap[role.toUpperCase()];
    if (mapped) tags.add(mapped);
  }

  // Supplement from CDragon championTagInfo
  const tagMap = {
    "Sustained Damage": "sustained_damage",
    "Burst Damage": "burst",
    "Self Healing": "drain_tank",
    "Crowd Control": "cc_heavy",
    Tankiness: "frontline",
    Poke: "poke",
    Waveclear: "waveclear",
    "Split Pushing": "splitpush",
  };

  if (cdragon?.championTagInfo) {
    for (const key of ["championTagPrimary", "championTagSecondary"]) {
      const val = cdragon.championTagInfo[key];
      if (val && tagMap[val]) tags.add(tagMap[val]);
    }
  }

  return [...tags];
}

// ── Helpers ───────────────────────────────────────────────────────

function round(n) {
  return Math.round(n * 100) / 100;
}

function clamp(n, min = 0, max = 1) {
  return Math.min(max, Math.max(min, n));
}

/**
 * Deep merge override fields onto a champion entry.
 * Only specified fields are overridden. Skips keys starting with "_".
 */
function applyOverrides(champion, overrides) {
  if (!overrides) return champion;
  const result = { ...champion };
  for (const [key, value] of Object.entries(overrides)) {
    if (key.startsWith("_")) continue;
    if (typeof value === "object" && !Array.isArray(value) && value !== null) {
      result[key] = { ...result[key], ...value };
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  console.log("=== Compile Champion Meta ===\n");

  if (!existsSync(MERAKI_PATH)) throw new Error(`Missing ${MERAKI_PATH} — run scrape-meraki.mjs first`);
  if (!existsSync(CDRAGON_PATH)) throw new Error(`Missing ${CDRAGON_PATH} — run scrape-cdragon.mjs first`);

  const merakiRaw = readJson(MERAKI_PATH);
  const cdragonRaw = readJson(CDRAGON_PATH);
  const canonicalChamps = readJson(CHAMPIONS_PATH);
  const ccMapping = readJson(CC_MAPPING_PATH);
  const synergyTags = readJson(SYNERGY_PATH);
  const overrides = readJson(OVERRIDES_PATH);
  const winratesRaw = existsSync(WINRATES_PATH) ? readJson(WINRATES_PATH) : null;
  if (!winratesRaw) {
    console.log(`  ! ${WINRATES_PATH} not found — winRate will be 0 for all champions`);
  } else {
    console.log(
      `  Loaded u.gg winrates: ${winratesRaw.championCount} champions (patch ${winratesRaw.patch})`,
    );
  }
  const winratesByNorm = new Map();
  if (winratesRaw) {
    for (const [alias, byRole] of Object.entries(winratesRaw.byChampion)) {
      winratesByNorm.set(normalize(alias), byRole);
    }
  }
  const lookupWinrate = (canonical) => {
    if (!winratesByNorm.size) return 0;
    const byRole = winratesByNorm.get(normalize(canonical.id));
    if (!byRole) return 0;
    // Prefer the champion's declared positions in order. Falls back to any
    // role with data so off-meta picks still get a non-zero number.
    for (const pos of canonical.positions ?? []) {
      const entry = byRole[pos];
      if (entry) return entry.wr;
    }
    const fallback = Object.values(byRole)[0];
    return fallback?.wr ?? 0;
  };

  // Build lookup maps by normalized name
  const merakiByNorm = new Map();
  for (const [name, champ] of Object.entries(merakiRaw.champions)) {
    merakiByNorm.set(normalize(name), champ);
  }
  const cdragonByNorm = new Map();
  for (const [alias, champ] of Object.entries(cdragonRaw.champions)) {
    cdragonByNorm.set(normalize(alias), champ);
  }

  // Compile each canonical champion
  const champions = {};
  const warnings = [];

  for (const canonical of canonicalChamps.champions) {
    const norm = normalize(canonical.name);
    const meraki = merakiByNorm.get(norm) || merakiByNorm.get(normalize(canonical.id));
    const cdragon = cdragonByNorm.get(norm) || cdragonByNorm.get(normalize(canonical.id));

    if (!meraki) warnings.push(`No Meraki data for ${canonical.id}`);

    let entry = {
      id: canonical.id,
      name: canonical.name,
      positions: canonical.positions,
      damageProfile: deriveDamageProfile(meraki),
      scalingProfile: deriveScalingProfile(meraki),
      ccProfile: deriveCcProfile(canonical.id, ccMapping, meraki),
      tags: {
        archetype: deriveArchetypeTags(meraki, cdragon),
        synergy: synergyTags[canonical.id] || [],
      },
      blindability: 0.5,
      pickRate: 0,
      banRate: 0,
      winRate: lookupWinrate(canonical),
    };

    // Apply overrides last
    entry = applyOverrides(entry, overrides[canonical.id]);

    champions[canonical.id] = entry;
  }

  const output = {
    version: canonicalChamps.version,
    patch: canonicalChamps.version,
    compiledAt: new Date().toISOString(),
    sources: {
      cdragonScrapedAt: cdragonRaw.scrapedAt,
      merakiScrapedAt: merakiRaw.scrapedAt,
    },
    champions,
  };

  writeJson(OUTPUT_PATH, output);

  console.log(`\n  Compiled: ${Object.keys(champions).length} champions`);
  if (warnings.length > 0) {
    console.log("  Warnings:");
    for (const w of warnings) console.log(`    - ${w}`);
  }

  const aatrox = champions.Aatrox;
  if (aatrox) {
    console.log("\n  Sanity check — Aatrox:");
    console.log(`    damageProfile: ${JSON.stringify(aatrox.damageProfile)}`);
    console.log(`    scalingProfile: ${JSON.stringify(aatrox.scalingProfile)}`);
    console.log(`    ccProfile: hasCc=${aatrox.ccProfile.hasCc}, types=${aatrox.ccProfile.ccTypes}`);
    console.log(`    tags.archetype: ${aatrox.tags.archetype}`);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
