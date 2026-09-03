// scripts/ugg-scraper/championIds.mjs
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CDRAGON_PATH = join(__dirname, "..", "..", "data", "raw", "cdragon-champions.json");

// CDragon's alias casing drifts from the canonical alias used by champion-meta.json,
// the engine and the frontend catalog. Normalise the known divergences so every
// consumer of loadIdToAlias emits engine-canonical aliases.
const ALIAS_OVERRIDES = {
  FiddleSticks: "Fiddlesticks",
};

export function canonicalizeAlias(alias) {
  return ALIAS_OVERRIDES[alias] ?? alias;
}

// { [numericId]: alias } — alias is the canonical string id used by the engine
// and the frontend champion catalog.
export function loadIdToAlias(path = CDRAGON_PATH) {
  const cdragon = JSON.parse(readFileSync(path, "utf-8"));
  return Object.fromEntries(
    Object.values(cdragon.champions).map((c) => [c.numericId, canonicalizeAlias(c.alias)])
  );
}
