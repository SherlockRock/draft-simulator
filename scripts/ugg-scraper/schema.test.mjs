import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeRanking } from "./schema.mjs";

test("decodeRanking on Aatrox jungle world_emerald_plus (patch 16_8)", () => {
  // Captured 2026-04-29 from
  //   https://stats2.u.gg/lol/1.5/rankings/16_8/ranked_solo_5x5/266/1.5.0.json
  // at data["12"]["17"]["1"] (region=world, rank=emerald_plus, role=JUNGLE).
  // Verified against SSR HTML at u.gg/lol/champions/aatrox/build:
  //   patch 16_9 world_emerald_plus_jungle: roleWins=760 roleMatches=1483
  //   (the 16_8 fixture below has the larger accumulated sample 11481/22398
  //    but the schema and indices are identical across patches).
  const arr = [
    11481, 22398, 6, 59, 504667161, 287046844, 165827, 167021, 124007, 4431750,
    112000, 1372167.0,
    [
      [33, 94, 169], [427, 86, 159], [35, 248, 459], [143, 60, 112],
      [904, 131, 247], [28, 141, 267], [75, 65, 124], [200, 127, 244],
      [11, 312, 612], [98, 79, 155], [19, 107, 210], [120, 252, 498],
      [245, 240, 477], [950, 381, 760], [56, 421, 841], [62, 122, 244],
      [80, 87, 174], [238, 131, 264], [234, 575, 1160], [9, 146, 296],
    ],
    1252431, 0.7272176027230368, 0.5005881226744564, 174,
    0.5001249326608802, 0.0006369345459210582, 111481,
  ];
  const decoded = decodeRanking(arr);
  assert.equal(decoded.wins, 11481);
  assert.equal(decoded.matches, 22398);
  assert.ok(Math.abs(decoded.winRate - 0.5126) < 0.001);
});

test("decodeRanking returns null on empty / zero-match input", () => {
  assert.equal(decodeRanking(null), null);
  assert.equal(decodeRanking([]), null);
  assert.equal(decodeRanking([1]), null);
  assert.equal(decodeRanking([0, 0]), null);
});
