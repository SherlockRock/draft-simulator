import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PLATFORMS,
  CONTINENTS,
  getPlatformHost,
  getContinentHost,
  platformToContinent,
} from "./regions.mjs";

test("PLATFORMS includes na1 mapped to americas", () => {
  assert.equal(PLATFORMS.na1.continent, "americas");
});

test("CONTINENTS contains americas, europe, asia, sea", () => {
  assert.deepEqual([...CONTINENTS].sort(), ["americas", "asia", "europe", "sea"]);
});

test("getPlatformHost returns expected host", () => {
  assert.equal(getPlatformHost("na1"), "na1.api.riotgames.com");
  assert.equal(getPlatformHost("kr"), "kr.api.riotgames.com");
});

test("getContinentHost returns expected host", () => {
  assert.equal(getContinentHost("americas"), "americas.api.riotgames.com");
  assert.equal(getContinentHost("europe"), "europe.api.riotgames.com");
});

test("platformToContinent maps known platforms", () => {
  assert.equal(platformToContinent("na1"), "americas");
  assert.equal(platformToContinent("euw1"), "europe");
  assert.equal(platformToContinent("kr"), "asia");
});

test("getPlatformHost throws for unknown platform", () => {
  assert.throws(() => getPlatformHost("xx9"), /Unknown platform/);
});

test("platformToContinent throws for unknown platform", () => {
  assert.throws(() => platformToContinent("xx9"), /Unknown platform/);
});
