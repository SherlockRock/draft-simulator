// scripts/champion-positions/overrides.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOverrides } from "./overrides.mjs";

const corki = {
  id: "Corki",
  positions: ["MIDDLE", "BOTTOM"],
  positionShares: { MIDDLE: 0.6, BOTTOM: 0.4 },
  damageProfile: { physical: 0.6, magic: 0.3, true: 0.1 },
};

test("no override returns the entry itself", () => {
  assert.equal(applyOverrides(corki, undefined), corki);
});

test("object fields merge one level deep, _ keys are skipped (today's rule)", () => {
  const out = applyOverrides(corki, { damageProfile: { magic: 0.8 }, _reason: "why" });
  assert.deepEqual(out.damageProfile, { physical: 0.6, magic: 0.8, true: 0.1 });
  assert.equal(out._reason, undefined);
  assert.deepEqual(out.positionShares, { MIDDLE: 0.6, BOTTOM: 0.4 }, "untouched fields stay");
});

test("a positions override without positionShares FAILS on a row that carries shares, naming both keys", () => {
  assert.throws(
    () => applyOverrides(corki, { positions: ["BOTTOM", "MIDDLE"] }),
    (err) => {
      assert.match(err.message, /Corki/);
      assert.match(err.message, /positions/);
      assert.match(err.message, /positionShares/);
      return true;
    },
  );
});

test("a positions override WITH positionShares substitutes the shares whole — a merge would keep the stale MIDDLE key", () => {
  const out = applyOverrides(corki, { positions: ["BOTTOM"], positionShares: { BOTTOM: 1 } });
  assert.deepEqual(out.positions, ["BOTTOM"]);
  assert.deepEqual(out.positionShares, { BOTTOM: 1 });
  assert.equal("MIDDLE" in out.positionShares, false);
});

test("a positions override on a row WITHOUT shares is today's plain replacement", () => {
  const plain = { id: "Zaahen", positions: ["TOP"] };
  const out = applyOverrides(plain, { positions: ["TOP", "JUNGLE"] });
  assert.deepEqual(out.positions, ["TOP", "JUNGLE"]);
  assert.equal(out.positionShares, undefined);
});
