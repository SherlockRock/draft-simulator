// scripts/champion-positions/merge.mjs
// update-champions.mjs must MERGE, not overwrite (design § 5): rebuilding every
// row from DDragon + Meraki would silently revert all position lists to
// Meraki's alphabetical ones and delete the root positionsSource block on the
// next champion release. Pure; the fetches and the write live in the CLI.
import { normalize } from "../lib/fetch-utils.mjs";

/**
 * Display name overrides — when Data Dragon's name differs from what we want
 * to show in the app (e.g. "Nunu & Willump" → "Nunu").
 */
export const DISPLAY_NAME_OVERRIDES = Object.freeze({
  "Nunu & Willump": "Nunu",
});

/**
 * Union the existing rows with DDragon's list.
 * - existing id in DDragon: keep the row (positions, playable, any future
 *   refresh-owned field) — DDragon owns only the display name;
 * - DDragon id not in the file: new row, Meraki positions or [];
 * - existing id DDragon no longer returns: kept and reported (`vanished`) —
 *   an id-casing change reads as add+drop and the caller's unique-name
 *   assertion refuses the file before it is written.
 * @param {{existing: object[], ddragon: Array<{id: string, name: string}>, merakiByName: Map<string, {positions: string[]}>}} input
 */
export function mergeChampionRows({ existing, ddragon, merakiByName }) {
  const ddragonById = new Map(ddragon.map((dd) => [dd.id, dd]));
  const existingIds = new Set(existing.map((row) => row.id));
  const added = [];
  const vanished = [];
  const missingFromMeraki = [];

  const champions = existing.map((row) => {
    const dd = ddragonById.get(row.id);
    if (!dd) {
      vanished.push(row.id);
      return { ...row };
    }
    return { ...row, name: DISPLAY_NAME_OVERRIDES[dd.name] ?? dd.name };
  });

  for (const dd of ddragon) {
    if (existingIds.has(dd.id)) continue;
    const meraki = merakiByName.get(normalize(dd.name));
    const name = DISPLAY_NAME_OVERRIDES[dd.name] ?? dd.name;
    if (!meraki) missingFromMeraki.push(name);
    champions.push({ name, id: dd.id, positions: meraki?.positions ?? [] });
    added.push(dd.id);
  }

  champions.sort((a, b) => a.name.localeCompare(b.name));
  return { champions, added, vanished, missingFromMeraki };
}
