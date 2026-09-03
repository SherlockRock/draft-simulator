// scripts/ugg-scraper/championIds.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { loadIdToAlias, canonicalizeAlias } from "./championIds.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const readJson = (...parts) => JSON.parse(readFileSync(join(repoRoot, ...parts), "utf-8"));

test("canonicalizeAlias fixes the CDragon Fiddlesticks casing drift", () => {
  assert.equal(canonicalizeAlias("FiddleSticks"), "Fiddlesticks");
  assert.equal(canonicalizeAlias("Annie"), "Annie");
});

test("loadIdToAlias emits the engine-canonical Fiddlesticks (id 9)", () => {
  const idToAlias = loadIdToAlias();
  assert.equal(idToAlias[9], "Fiddlesticks");
  assert.equal(Object.values(idToAlias).includes("FiddleSticks"), false);
});

test("the cdragon snapshot resolves the champions the match corpus contains", () => {
  const idToAlias = loadIdToAlias();
  // Locke (805) is the #1 ban in the 16.15/16.16 apex corpus and post-dates the
  // April cdragon snapshot; Yunara likewise. Both must resolve after a refresh.
  assert.equal(idToAlias[805], "Locke");
  assert.ok(
    Object.values(idToAlias).includes("Yunara"),
    "Yunara missing — data/raw/cdragon-champions.json is stale, re-run scripts/scrape-cdragon.mjs"
  );
});

test("every numericId maps to exactly one alias", () => {
  const cdragon = readJson("data", "raw", "cdragon-champions.json");
  const ids = Object.values(cdragon.champions).map((c) => c.numericId);
  assert.equal(new Set(ids).size, ids.length, "duplicate numericId in cdragon snapshot");
});

test("EVALUABLE (champion-meta aliases) is a subset of the cdragon aliases", () => {
  // The evaluator benchmark can only score drafts whose champions champion-meta
  // knows. Anything in champion-meta that cdragon cannot resolve is a mapping bug.
  const meta = readJson("data", "compiled", "champion-meta.json");
  const aliases = new Set(Object.values(loadIdToAlias()));
  const missing = Object.keys(meta.champions).filter((a) => !aliases.has(a));
  assert.deepEqual(missing, []);
});
