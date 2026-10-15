// scripts/champion-positions/overrides.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOverrides } from "./overrides.mjs";

const corki = {
  id: "Corki",
  positions: ["MIDDLE", "BOTTOM"],
  positionShares: { TOP: 0.01, JUNGLE: 0, MIDDLE: 0.6, BOTTOM: 0.39, SUPPORT: 0 },
  playable: ["MIDDLE", "BOTTOM"],
  damageProfile: { physical: 0.6, magic: 0.3, true: 0.1 },
};

test("no override returns the entry itself", () => {
  assert.equal(applyOverrides(corki, undefined), corki);
});

test("object fields merge one level deep, _ keys are skipped (today's rule)", () => {
  const out = applyOverrides(corki, { damageProfile: { magic: 0.8 }, _reason: "why" });
  assert.deepEqual(out.damageProfile, { physical: 0.6, magic: 0.8, true: 0.1 });
  assert.equal(out._reason, undefined);
  assert.deepEqual(out.positionShares, corki.positionShares, "untouched fields stay");
  assert.deepEqual(out.playable, ["MIDDLE", "BOTTOM"]);
});

test("a positions override keeps the shares (measured data) and UNIONS the new positions into playable (U4)", () => {
  const out = applyOverrides(corki, { positions: ["BOTTOM", "MIDDLE", "TOP"] });
  assert.deepEqual(out.positions, ["BOTTOM", "MIDDLE", "TOP"]);
  assert.deepEqual(out.positionShares, corki.positionShares, "the shares are not keyed by the list, so a reorder or an addition leaves them alone");
  assert.deepEqual(out.playable, ["TOP", "MIDDLE", "BOTTOM"], "positions ⊆ playable holds after the override; vocabulary order");
  assert.deepEqual(corki.playable, ["MIDDLE", "BOTTOM"], "input is not mutated");
});

test("a positions override on a row WITHOUT playable leaves it absent (the fallback is the positions)", () => {
  const plain = { id: "Zaahen", positions: ["TOP"] };
  const out = applyOverrides(plain, { positions: ["TOP", "JUNGLE"] });
  assert.deepEqual(out.positions, ["TOP", "JUNGLE"]);
  assert.equal(out.positionShares, undefined);
  assert.equal("playable" in out, false);
});

test("a playable override widens, never narrows (U4): the result is the union with what the row had", () => {
  const out = applyOverrides(corki, { playable: ["SUPPORT"] });
  assert.deepEqual(out.playable, ["MIDDLE", "BOTTOM", "SUPPORT"]);
  // An override that tries to drop BOTTOM cannot: Syndra is never "never BOTTOM" through this file.
  const narrow = applyOverrides(corki, { playable: ["MIDDLE"] });
  assert.deepEqual(narrow.playable, ["MIDDLE", "BOTTOM"]);
  // On a row without playable the union starts from the positions.
  const plain = applyOverrides({ id: "Zaahen", positions: ["TOP"] }, { playable: ["JUNGLE"] });
  assert.deepEqual(plain.playable, ["TOP", "JUNGLE"]);
  // Both at once: the new positions and the override are unioned in.
  const both = applyOverrides(corki, { positions: ["MIDDLE"], playable: ["TOP"] });
  assert.deepEqual(both.playable, ["TOP", "MIDDLE", "BOTTOM"]);
});

test("positionShares cannot be overridden — it is measured data (design § 4.1)", () => {
  assert.throws(
    () => applyOverrides(corki, { positionShares: { TOP: 0, JUNGLE: 0, MIDDLE: 1, BOTTOM: 0, SUPPORT: 0 } }),
    /Corki: positionShares is measured data and cannot be overridden/,
  );
});
