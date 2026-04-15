import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { ChampionMetaFile, MatchupDataFile } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");
const META_PATH = join(ROOT, "data", "compiled", "champion-meta.json");
const MATCHUP_PATH = join(ROOT, "data", "compiled", "matchup-data.json");

export function loadChampionMeta(): ChampionMetaFile {
  const raw = readFileSync(META_PATH, "utf-8");
  return JSON.parse(raw) as ChampionMetaFile;
}

export function loadMatchupData(): MatchupDataFile {
  const raw = readFileSync(MATCHUP_PATH, "utf-8");
  return JSON.parse(raw) as MatchupDataFile;
}
