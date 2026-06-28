// scripts/ugg-scraper/championIds.mjs
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CDRAGON_PATH = join(__dirname, "..", "..", "data", "raw", "cdragon-champions.json");

// { [numericId]: alias } — alias is the canonical string id used by the engine
// and the frontend champion catalog.
export function loadIdToAlias(path = CDRAGON_PATH) {
  const cdragon = JSON.parse(readFileSync(path, "utf-8"));
  return Object.fromEntries(
    Object.values(cdragon.champions).map((c) => [c.numericId, c.alias])
  );
}
