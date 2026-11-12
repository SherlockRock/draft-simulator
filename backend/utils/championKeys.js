const path = require("path");
const { canonicalizeAlias } = require("./championAlias");

// Built at load from the tracked CDragon snapshot, so a refresh of
// data/raw/cdragon-champions.json updates the map with no generated file.
const CDRAGON_PATH = path.join(__dirname, "..", "..", "data", "raw", "cdragon-champions.json");

// Only aliases the champion catalog knows (the same catalog routes/users.js
// validates picks against). CDragon also lists non-champion entries such as
// the "Jade_*" cosmetics (keys >= 60000); those must not map to anything.
const CATALOG_IDS = new Set(
  require("../../frontend/src/data/champions.json").champions.map((c) => c.id)
);

/** @type {Map<number, string>} Riot numeric key -> canonical alias */
const KEY_TO_ALIAS = new Map(
  Object.values(require(CDRAGON_PATH).champions)
    .map((c) => [c.numericId, canonicalizeAlias(c.alias)])
    .filter(([, alias]) => CATALOG_IDS.has(alias))
);

const CHAMPION_KEY_COUNT = KEY_TO_ALIAS.size;

/**
 * @param {string|number|null|undefined} key Riot numeric champion key ("126" or 126)
 * @returns {string|null} canonical alias, or null when the key is not a known champion
 */
function championAliasForKey(key) {
  if (typeof key === "number") return KEY_TO_ALIAS.get(key) ?? null;
  if (typeof key !== "string" || !/^\d+$/.test(key)) return null;
  return KEY_TO_ALIAS.get(Number(key)) ?? null;
}

module.exports = { championAliasForKey, CHAMPION_KEY_COUNT };
