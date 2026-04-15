/**
 * Champion data loader interface.
 *
 * MVP: reads from local compiled JSON files.
 * Future: can swap to external API fetch without changing consumers.
 *
 * Usage:
 *   import { loadChampionMeta, loadMatchupData } from './lib/champion-data-loader.mjs';
 *   const meta = loadChampionMeta();
 *   const matchups = loadMatchupData();
 */

import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

const META_PATH = join(ROOT, "data", "compiled", "champion-meta.json");
const MATCHUP_PATH = join(ROOT, "data", "compiled", "matchup-data.json");

/**
 * Load compiled champion metadata.
 * Throws if compiled data is missing — run `pnpm update-champion-meta` first.
 * @returns {{ version: string, patch: string, compiledAt: string, sources: object, champions: Record<string, object> }}
 */
export function loadChampionMeta() {
  if (!existsSync(META_PATH)) {
    throw new Error(
      `Champion meta not found at ${META_PATH}. Run 'pnpm update-champion-meta' to generate.`
    );
  }
  return JSON.parse(readFileSync(META_PATH, "utf-8"));
}

/**
 * Load compiled matchup data.
 * Throws if compiled data is missing.
 * @returns {{ counters: object, synergyRules: Array<object> }}
 */
export function loadMatchupData() {
  if (!existsSync(MATCHUP_PATH)) {
    throw new Error(
      `Matchup data not found at ${MATCHUP_PATH}. Run 'pnpm update-champion-meta' to generate.`
    );
  }
  return JSON.parse(readFileSync(MATCHUP_PATH, "utf-8"));
}
