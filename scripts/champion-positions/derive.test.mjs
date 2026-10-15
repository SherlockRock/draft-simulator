// scripts/champion-positions/derive.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  POSITIONS_THRESHOLD, MAX_PRIMARY_FLIPS, MAX_FEASIBILITY_DROP, MIN_PICKS, RECENCY_RULE,
  PLAYABLE_MIN_PICK_RATE, PLAYABLE_MIN_PICKS, THIN_PATCH_GAMES,
  derivePositions, ratesFromCorpus, ratesFromUgg, refreshPositions, diffPositions, playableRoles,
  buildProvenance, formatPositionsSource, evaluateGate, carryForward, formatDiff, parsePatch, comparePatches,
} from "./derive.mjs";

test("the constants are the design's", () => {
  assert.equal(POSITIONS_THRESHOLD, 0.10);
  assert.equal(MAX_PRIMARY_FLIPS, 10);
  assert.equal(MAX_FEASIBILITY_DROP, 0.02);
  assert.equal(MIN_PICKS, 300);
  assert.equal(RECENCY_RULE, "latest-patch");
  // champion-role-shares design § 4.1 (D3): 10 picks per 10,000 train games of the deciding patch,
  // never fewer than 50 picks; the refresh warns under 50,000 deciding-patch games.
  assert.equal(PLAYABLE_MIN_PICK_RATE, 10 / 10_000);
  assert.equal(PLAYABLE_MIN_PICKS, 50);
  assert.equal(THIN_PATCH_GAMES, 50_000);
});

test("patches compare numerically on (major, minor), never as strings", () => {
  assert.deepEqual(parsePatch("16.17"), [16, 17]);
  assert.throws(() => parsePatch("16_8"), /MAJOR\.MINOR/);
  assert.throws(() => parsePatch("16"), /MAJOR\.MINOR/);
  assert.ok(comparePatches("16.9", "16.17") < 0, "16.9 is older than 16.17 (a string sort says otherwise)");
  assert.ok(comparePatches("17.1", "16.19") > 0, "a major bump is newer");
  assert.equal(comparePatches("16.16", "16.16"), 0);
  assert.deepEqual(["16.17", "16.9", "17.1", "16.16"].sort(comparePatches), ["16.9", "16.16", "16.17", "17.1"]);
});

test("derivePositions lists roles at or above the threshold, ordered by share", () => {
  const vayne = { TOP: 0.5677, JUNGLE: 0.0113, MIDDLE: 0.0344, BOTTOM: 0.3842, SUPPORT: 0.0024 };
  assert.deepEqual(derivePositions(vayne), ["TOP", "BOTTOM"]);
  const lux = { TOP: 0.005, JUNGLE: 0.0, MIDDLE: 0.34, BOTTOM: 0.26, SUPPORT: 0.39 };
  assert.deepEqual(derivePositions(lux), ["SUPPORT", "MIDDLE", "BOTTOM"]);
});

test("derivePositions keeps the argmax alone when nothing reaches the threshold", () => {
  const spread = { TOP: 0.09, JUNGLE: 0.09, MIDDLE: 0.09, BOTTOM: 0.09, SUPPORT: 0.09 };
  assert.deepEqual(derivePositions(spread, 0.5), ["TOP"]);
});

test("derivePositions breaks exact ties in canonical vocabulary order (deterministic output)", () => {
  const tie = { TOP: 0.3, JUNGLE: 0.0, MIDDLE: 0.3, BOTTOM: 0.4, SUPPORT: 0.0 };
  assert.deepEqual(derivePositions(tie), ["BOTTOM", "TOP", "MIDDLE"]);
});

test("derivePositions treats a missing role key as zero and includes exactly-threshold shares", () => {
  assert.deepEqual(derivePositions({ MIDDLE: 0.9, JUNGLE: 0.1 }), ["MIDDLE", "JUNGLE"]);
});

// A two-patch corpus in prepare.py's shape. Camille is the recency case: pooled
// SUPPORT-first, newest patch TOP-first. Nilah is thin on the newest patch and
// falls back to the previous one; Zaahen is thin everywhere and falls back to
// the pooled shares. Picks per patch sum to the pooled `games`, and across
// champions each patch's picks are a multiple of ten.
function corpusDoc() {
  return {
    "164": {
      alias: "Camille", games: 1000,
      roles: { TOP: 0.29, JUNGLE: 0, MIDDLE: 0, BOTTOM: 0, UTILITY: 0.71 },
      meta_roles: { TOP: 0.29, JUNGLE: 0, MIDDLE: 0, BOTTOM: 0, SUPPORT: 0.71 },
      by_patch: {
        "16.15": { games: 500, meta_roles: { TOP: 0.02, JUNGLE: 0, MIDDLE: 0, BOTTOM: 0, SUPPORT: 0.98 } },
        "16.16": { games: 500, meta_roles: { TOP: 0.56, JUNGLE: 0, MIDDLE: 0, BOTTOM: 0, SUPPORT: 0.44 } },
      },
    },
    "895": {
      alias: "Nilah", games: 2600,
      roles: { TOP: 0, JUNGLE: 0, MIDDLE: 0.1, BOTTOM: 0.9, UTILITY: 0 },
      meta_roles: { TOP: 0, JUNGLE: 0, MIDDLE: 0.1, BOTTOM: 0.9, SUPPORT: 0 },
      by_patch: {
        "16.15": { games: 2400, meta_roles: { TOP: 0, JUNGLE: 0, MIDDLE: 0.05, BOTTOM: 0.95, SUPPORT: 0 } },
        "16.16": { games: 200, meta_roles: { TOP: 0, JUNGLE: 0, MIDDLE: 0.7, BOTTOM: 0.3, SUPPORT: 0 } },
      },
    },
    "999": {
      alias: "Zaahen", games: 400,
      roles: { TOP: 0.6, JUNGLE: 0.4, MIDDLE: 0, BOTTOM: 0, UTILITY: 0 },
      meta_roles: { TOP: 0.6, JUNGLE: 0.4, MIDDLE: 0, BOTTOM: 0, SUPPORT: 0 },
      by_patch: {
        "16.15": { games: 100, meta_roles: { TOP: 0.1, JUNGLE: 0.9, MIDDLE: 0, BOTTOM: 0, SUPPORT: 0 } },
        "16.16": { games: 300, meta_roles: { TOP: 0.9, JUNGLE: 0.1, MIDDLE: 0, BOTTOM: 0, SUPPORT: 0 } },
      },
    },
  };
}

test("ratesFromCorpus scores each champion on the newest patch with at least MIN_PICKS picks, and says which patch decided", () => {
  const out = ratesFromCorpus(corpusDoc());
  assert.equal(out.kind, "corpus");
  assert.equal(out.games, 400);                 // 4,000 pooled picks / 10
  assert.deepEqual(out.patches, ["16.15", "16.16"]);
  assert.equal(out.decidingPatch, "16.16");
  assert.equal(out.decidingGames, 100);         // 500 + 200 + 300 picks on 16.16
  assert.equal(out.minPicks, MIN_PICKS);
  // Camille: the newest patch decides — TOP-first, where the pooled shares said SUPPORT-first.
  assert.deepEqual(out.rates.get("Camille"), { TOP: 0.56, JUNGLE: 0, MIDDLE: 0, BOTTOM: 0, SUPPORT: 0.44 });
  assert.deepEqual(out.pooled.get("Camille"), { TOP: 0.29, JUNGLE: 0, MIDDLE: 0, BOTTOM: 0, SUPPORT: 0.71 });
  assert.equal(out.chosen.get("Camille"), "16.16");
  // Zaahen has exactly MIN_PICKS on the newest patch: the floor is inclusive.
  assert.equal(out.chosen.get("Zaahen"), "16.16");
  assert.equal(out.rates.get("Zaahen").TOP, 0.9);
  // Nilah has 200 picks on the newest patch, under the floor: the previous patch decides, and she is listed.
  assert.equal(out.chosen.get("Nilah"), "16.15");
  assert.deepEqual(out.fallback, { Nilah: "16.15" });
  // The playable floor's inputs (champion-role-shares design § 4.2 hop 1): the DECIDING patch's picks
  // of the champion and that patch's OWN train games — the newest patch for Camille and Zaahen
  // (1,000 picks on 16.16 = 100 games), the older one for Nilah (3,000 picks on 16.15 = 300 games).
  assert.equal(out.picks.get("Camille"), 500);
  assert.equal(out.trainGames.get("Camille"), 100);
  assert.equal(out.picks.get("Zaahen"), 300);
  assert.equal(out.trainGames.get("Zaahen"), 100);
  assert.equal(out.picks.get("Nilah"), 2400);
  assert.equal(out.trainGames.get("Nilah"), 300);
});

test("ratesFromCorpus gives a pooled-fallback champion the window's picks and train games (the third denominator)", () => {
  const out = ratesFromCorpus(corpusDoc(), { minPicks: 301 });
  assert.equal(out.chosen.get("Zaahen"), "pooled");
  assert.equal(out.picks.get("Zaahen"), 400);        // all of Zaahen's picks in the window
  assert.equal(out.trainGames.get("Zaahen"), 400);   // the window's 4,000 picks / 10
  assert.equal(out.trainGames.get("Nilah"), 300, "an older-patch champion keeps that patch's games");
});

// ---- the playable floor (champion-role-shares design § 4.1, D2/D3) ----

test("playableRoles is the listed roles plus every role whose picks reach the rate floor, in vocabulary order", () => {
  // Kai'Sa-shaped: 1.9% top of 47,500 picks on a 277,103-game patch = 902 picks >= 277.1 (the rate floor).
  const shares = { TOP: 0.019, JUNGLE: 0.002, MIDDLE: 0.004, BOTTOM: 0.975, SUPPORT: 0 };
  assert.deepEqual(playableRoles(["BOTTOM"], shares, 47500, 277103), ["TOP", "BOTTOM"]);
  // The floor is inclusive: 0.25 × 400 = 100 picks on a 100,000-game patch (rate floor 100).
  assert.deepEqual(playableRoles(["TOP"], { TOP: 0.75, JUNGLE: 0.25 }, 400, 100000), ["TOP", "JUNGLE"]);
  assert.deepEqual(playableRoles(["TOP"], { TOP: 0.75, JUNGLE: 0.2475 }, 400, 100000), ["TOP"]);
  // The role's picks are an integer count the share only encodes (count / total, prepare.py): the float
  // product can fall short of it by an ulp — (1/49) × 49 = 0.9999999999999999 — so it is ROUNDED before
  // the comparison, or a pair at exactly an integer floor could be dropped (judge M4).
  assert.deepEqual(playableRoles(["TOP"], { TOP: 48 / 49, JUNGLE: 1 / 49 }, 49, 0, { minPickRate: 0, minPicks: 1 }), ["TOP", "JUNGLE"]);
});

test("playableRoles keeps a listed role below the floor (the union is the construction, not a check)", () => {
  // 20 picks on a 10,000-game patch: the rate floor is 10 but the absolute floor is 50; TOP has 18 picks.
  assert.deepEqual(playableRoles(["TOP"], { TOP: 0.9, JUNGLE: 0.1 }, 20, 10000), ["TOP"]);
  // A listed role with a share of 0 (an override put it there) is still playable.
  assert.deepEqual(playableRoles(["MIDDLE", "TOP"], { MIDDLE: 1 }, 1000, 100000), ["TOP", "MIDDLE"]);
});

test("playableRoles applies the absolute minimum under a thin deciding patch", () => {
  // 20,000 games: the rate floor would be 20 picks; PLAYABLE_MIN_PICKS = 50 applies instead.
  assert.deepEqual(playableRoles(["TOP"], { TOP: 0.7, JUNGLE: 0.3 }, 100, 20000), ["TOP"]);          // 30 < 50
  assert.deepEqual(playableRoles(["TOP"], { TOP: 0.4, JUNGLE: 0.6 }, 100, 20000), ["TOP", "JUNGLE"]); // 60 >= 50
  // The knobs are parameters, so a test can move them.
  assert.deepEqual(playableRoles(["TOP"], { TOP: 0.7, JUNGLE: 0.3 }, 100, 20000, { minPicks: 30 }), ["TOP", "JUNGLE"]);
  assert.deepEqual(playableRoles(["TOP"], { TOP: 0.7, JUNGLE: 0.3 }, 100, 20000, { minPickRate: 0.002, minPicks: 0 }), ["TOP"]); // 40 > 30
});

test("ratesFromCorpus falls back patch by patch, then to the pooled shares, and lists every champion the newest patch did not decide", () => {
  const out = ratesFromCorpus(corpusDoc(), { minPicks: 301 });
  // Nilah: 200 picks on 16.16 is under the floor; 16.15 decides.
  assert.equal(out.chosen.get("Nilah"), "16.15");
  assert.equal(out.rates.get("Nilah").BOTTOM, 0.95);
  // Zaahen: 300 on 16.16 and 100 on 16.15 are both under 301; the pooled shares decide.
  assert.equal(out.chosen.get("Zaahen"), "pooled");
  assert.deepEqual(out.rates.get("Zaahen"), out.pooled.get("Zaahen"));
  assert.equal(out.rates.get("Zaahen").TOP, 0.6);
  assert.deepEqual(out.fallback, { Nilah: "16.15", Zaahen: "pooled" });
  assert.equal(out.chosen.get("Camille"), "16.16");
});

test("ratesFromCorpus orders patches numerically so 16.9 never outranks 16.17", () => {
  const doc = corpusDoc();
  for (const entry of Object.values(doc)) {
    entry.by_patch = { "16.17": entry.by_patch["16.16"], "16.9": entry.by_patch["16.15"] };
  }
  const out = ratesFromCorpus(doc);
  assert.deepEqual(out.patches, ["16.9", "16.17"]);
  assert.equal(out.decidingPatch, "16.17");
  assert.equal(out.chosen.get("Camille"), "16.17");
});

test("ratesFromCorpus refuses a file without the meta_roles block (the roles block says UTILITY)", () => {
  const doc = { "67": { alias: "Vayne", games: 10, roles: { UTILITY: 1 } } };
  assert.throws(() => ratesFromCorpus(doc), /meta_roles/);
});

test("ratesFromCorpus refuses a file without the by_patch block (an old prepare.py output cannot feed the recency rule)", () => {
  const doc = { "67": { alias: "Vayne", games: 10, roles: { TOP: 1 }, meta_roles: { TOP: 1 } } };
  assert.throws(() => ratesFromCorpus(doc), /by_patch/);
  const empty = { "67": { alias: "Vayne", games: 10, roles: { TOP: 1 }, meta_roles: { TOP: 1 }, by_patch: {} } };
  assert.throws(() => ratesFromCorpus(empty), /by_patch/);
});

test("ratesFromCorpus refuses a by_patch block that does not partition the pooled picks, or a bad patch key", () => {
  const doc = corpusDoc();
  doc["164"].by_patch["16.16"].games = 400;
  assert.throws(() => ratesFromCorpus(doc), /partition/);
  const bad = corpusDoc();
  bad["164"].by_patch["16_16"] = bad["164"].by_patch["16.16"];
  delete bad["164"].by_patch["16.16"];
  assert.throws(() => ratesFromCorpus(bad), /MAJOR\.MINOR/);
});

test("ratesFromCorpus refuses a pick total that is not a multiple of ten", () => {
  const doc = { "67": { alias: "Vayne", games: 7, roles: {}, meta_roles: { TOP: 1 }, by_patch: { "16.16": { games: 7, meta_roles: { TOP: 1 } } } } };
  assert.throws(() => ratesFromCorpus(doc), /multiple of 10/);
});

test("ratesFromUgg turns per-role match counts into shares and sums the counts", () => {
  const doc = { patch: "16_8", byChampion: {
    Vayne: { BOTTOM: { wr: 0.5, n: 300 }, TOP: { wr: 0.5, n: 100 } },
    Ahri: { MIDDLE: { wr: 0.5, n: 50 } },
  } };
  const { rates, games, kind } = ratesFromUgg(doc);
  assert.equal(kind, "ugg");
  assert.equal(games, 450);
  assert.deepEqual(rates.get("Vayne"), { TOP: 0.25, JUNGLE: 0, MIDDLE: 0, BOTTOM: 0.75, SUPPORT: 0 });
  assert.equal(rates.has("Nobody"), false);
});

test("refreshPositions rewrites only positions, keeps order and other fields, and keeps absent champions", () => {
  const rows = [
    { name: "Ahri", id: "Ahri", positions: ["MIDDLE"], extra: 1 },
    { name: "Vayne", id: "Vayne", positions: ["BOTTOM", "TOP"] },
    { name: "Zaahen", id: "Zaahen", positions: ["TOP", "JUNGLE"] },
  ];
  const rates = new Map([
    ["Ahri", { MIDDLE: 0.93, TOP: 0.04, BOTTOM: 0.03 }],
    ["Vayne", { TOP: 0.57, BOTTOM: 0.38, MIDDLE: 0.03 }],
  ]);
  const { rows: out, kept } = refreshPositions(rows, rates);
  assert.deepEqual(out.map((r) => r.id), ["Ahri", "Vayne", "Zaahen"]);
  // Re-pinned for champion-role-shares § 4.1: a refreshed row carries ALL FIVE roles' shares (0 is legal).
  assert.deepEqual(out[0], {
    name: "Ahri", id: "Ahri", positions: ["MIDDLE"], extra: 1,
    positionShares: { TOP: 0.04, JUNGLE: 0, MIDDLE: 0.93, BOTTOM: 0.03, SUPPORT: 0 },
  });
  assert.deepEqual(out[1].positions, ["TOP", "BOTTOM"]);
  assert.deepEqual(out[2].positions, ["TOP", "JUNGLE"]);
  assert.deepEqual(kept, ["Zaahen"]);
  assert.deepEqual(rows[1].positions, ["BOTTOM", "TOP"], "input is not mutated");
});

test("refreshPositions writes positionShares for all five roles, 3 dp, in vocabulary order; a kept row keeps whatever it had", () => {
  const rows = [
    { name: "Vayne", id: "Vayne", positions: ["BOTTOM"] },
    { name: "Zaahen", id: "Zaahen", positions: ["TOP"], positionShares: { TOP: 0.5 } },
    { name: "Locke", id: "Locke", positions: ["MIDDLE"] },
  ];
  const rates = new Map([
    ["Vayne", { TOP: 0.56774, BOTTOM: 0.38425, MIDDLE: 0.0344, JUNGLE: 0.0113, SUPPORT: 0.0024 }],
  ]);
  const { rows: out } = refreshPositions(rows, rates);
  assert.deepEqual(out[0].positions, ["TOP", "BOTTOM"]);
  assert.deepEqual(out[0].positionShares, { TOP: 0.568, JUNGLE: 0.011, MIDDLE: 0.034, BOTTOM: 0.384, SUPPORT: 0.002 });
  assert.deepEqual(Object.keys(out[0].positionShares), ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "SUPPORT"], "keyed in vocabulary order, not the positions' — no ordering invariant on a stored row");
  assert.deepEqual(out[1].positionShares, { TOP: 0.5 }, "a kept row keeps its shares (the legacy listed-key shape)");
  assert.equal(out[2].positionShares, undefined, "a kept row without shares stays without");
});

test("refreshPositions rounds a share to 3 dp and keeps a below-threshold argmax's share", () => {
  const rows = [{ name: "Spread", id: "Spread", positions: ["TOP"] }];
  const rates = new Map([["Spread", { TOP: 0.0995, JUNGLE: 0.09, MIDDLE: 0.09, BOTTOM: 0.09, SUPPORT: 0.09 }]]);
  const { rows: out } = refreshPositions(rows, rates, 0.5);
  assert.deepEqual(out[0].positions, ["TOP"]);
  assert.deepEqual(out[0].positionShares, { TOP: 0.1, JUNGLE: 0.09, MIDDLE: 0.09, BOTTOM: 0.09, SUPPORT: 0.09 });
});

test("refreshPositions writes playable from the corpus floor (positions ∪ count-passing roles) and omits it without a floor", () => {
  const rows = [
    { name: "Kaisa", id: "Kaisa", positions: ["BOTTOM"], playable: ["BOTTOM", "MIDDLE"] },
    { name: "Heimerdinger", id: "Heimerdinger", positions: ["MIDDLE"] },
    { name: "Zaahen", id: "Zaahen", positions: ["TOP"], playable: ["TOP", "JUNGLE"] },
  ];
  const rates = new Map([
    ["Kaisa", { TOP: 0.019, JUNGLE: 0.002, MIDDLE: 0.004, BOTTOM: 0.975, SUPPORT: 0 }],
    ["Heimerdinger", { TOP: 0.3, JUNGLE: 0, MIDDLE: 0.68, BOTTOM: 0, SUPPORT: 0.02 }],
  ]);
  const floor = {
    picks: new Map([["Kaisa", 47500], ["Heimerdinger", 2000]]),
    trainGames: new Map([["Kaisa", 277103], ["Heimerdinger", 277103]]),
  };
  const { rows: out } = refreshPositions(rows, rates, POSITIONS_THRESHOLD, floor);
  assert.deepEqual(out[0].positions, ["BOTTOM"]);
  assert.deepEqual(out[0].playable, ["TOP", "BOTTOM"], "Kai'Sa top: 902 picks >= 277; the stale MIDDLE is gone");
  assert.deepEqual(out[1].positions, ["MIDDLE", "TOP"]);
  assert.deepEqual(out[1].playable, ["TOP", "MIDDLE"], "SUPPORT at 40 picks is below the floor; TOP is listed");
  assert.deepEqual(out[2].playable, ["TOP", "JUNGLE"], "a kept row keeps its playable");
  // Without a floor (the ugg source has no train games — design § 4.1 M4) playable is OMITTED, and a
  // stale one from an earlier corpus run is DROPPED, so `positions ⊆ playable` cannot break when the
  // positions move.
  const { rows: ugg } = refreshPositions(rows, rates);
  assert.equal("playable" in ugg[0], false);
  assert.equal("playable" in ugg[1], false);
  assert.deepEqual(ugg[2].playable, ["TOP", "JUNGLE"], "a kept row is untouched either way");
  assert.deepEqual(rows[0].playable, ["BOTTOM", "MIDDLE"], "input is not mutated");
});

test("refreshPositions honours the floor's knobs and the three denominators through ratesFromCorpus", () => {
  const corpus = ratesFromCorpus(corpusDoc(), { minPicks: 301 });
  const rows = [
    { name: "Camille", id: "Camille", positions: ["SUPPORT"] },
    { name: "Nilah", id: "Nilah", positions: ["BOTTOM"] },
    { name: "Zaahen", id: "Zaahen", positions: ["TOP"] },
  ];
  // Rate floor at 10/10k: Camille 100 games → 0.1 picks, Nilah 300 games → 0.3, Zaahen (pooled) 400 → 0.4;
  // the absolute minimum 50 governs all three. Camille SUPPORT 220 picks, TOP 280; Nilah MIDDLE 120,
  // BOTTOM 2280; Zaahen TOP 240, JUNGLE 160 — every role with picks passes, so the knobs decide.
  const floor = { picks: corpus.picks, trainGames: corpus.trainGames };
  const { rows: out } = refreshPositions(rows, corpus.rates, POSITIONS_THRESHOLD, floor);
  assert.deepEqual(out.map((r) => r.playable), [["TOP", "SUPPORT"], ["MIDDLE", "BOTTOM"], ["TOP", "JUNGLE"]]);
  const strict = refreshPositions(rows, corpus.rates, POSITIONS_THRESHOLD, { ...floor, minPicks: 200 }).rows;
  assert.deepEqual(strict.map((r) => r.playable), [["TOP", "SUPPORT"], ["BOTTOM"], ["TOP", "JUNGLE"]], "minPicks 200 drops Nilah MIDDLE (120); Zaahen JUNGLE (160) is listed and stays");
  // A rate of 0.35 picks per game: Nilah's floor is 105 on HER deciding patch's 300 games, so MIDDLE (120)
  // passes — against the window's 400 games (floor 140) or the newest patch's 100 (floor 35) it would not
  // be the same answer, which is what makes the per-champion denominator observable.
  const rate = refreshPositions(rows, corpus.rates, POSITIONS_THRESHOLD, { ...floor, minPickRate: 0.35, minPicks: 0 }).rows;
  assert.deepEqual(rate.map((r) => r.playable), [["TOP", "SUPPORT"], ["MIDDLE", "BOTTOM"], ["TOP", "JUNGLE"]], "each champion against its OWN deciding patch's games");
  const window = refreshPositions(rows, corpus.rates, POSITIONS_THRESHOLD, { ...floor, trainGames: new Map([["Camille", 400], ["Nilah", 400], ["Zaahen", 400]]), minPickRate: 0.35, minPicks: 0 }).rows;
  assert.deepEqual(window[1].playable, ["BOTTOM"], "the same shares against the window's games drop Nilah MIDDLE");
  // Two floors of the same magnitude, named apart (design § 4.1): the corpus result's own `minPicks` is
  // the RECENCY floor (301 here), so the result itself is refused as a playable floor — it would read
  // 301 as the playable minimum and drop Nilah MIDDLE and Zaahen JUNGLE for the wrong reason.
  assert.throws(() => refreshPositions(rows, corpus.rates, POSITIONS_THRESHOLD, corpus), /not ratesFromCorpus's result, whose minPicks is the recency floor/);
});

test("diffPositions reports primary flips, lost and gained pairs, changed sets and means", () => {
  const before = [
    { id: "Vayne", positions: ["BOTTOM", "TOP"] },
    { id: "Ashe", positions: ["BOTTOM", "SUPPORT"] },
    { id: "Sylas", positions: ["MIDDLE", "TOP"] },
    { id: "Zaahen", positions: [] },
  ];
  const after = [
    { id: "Vayne", positions: ["TOP", "BOTTOM"] },
    { id: "Ashe", positions: ["BOTTOM"] },
    { id: "Sylas", positions: ["MIDDLE", "JUNGLE", "SUPPORT"] },
    { id: "Zaahen", positions: ["TOP"] },
  ];
  const d = diffPositions(before, after);
  assert.deepEqual(d.primaryFlips, [{ id: "Vayne", from: "BOTTOM", to: "TOP" }, { id: "Zaahen", from: null, to: "TOP" }]);
  assert.deepEqual(d.lost, [{ id: "Ashe", role: "SUPPORT" }, { id: "Sylas", role: "TOP" }]);
  assert.deepEqual(d.gained, [{ id: "Sylas", role: "JUNGLE" }, { id: "Sylas", role: "SUPPORT" }, { id: "Zaahen", role: "TOP" }]);
  assert.equal(d.changedSets, 3);
  assert.equal(d.meanBefore, 1.5);
  assert.equal(d.meanAfter, 1.75);
  // playable: a row without the field counts as its positions (the engine's fallback), so the first
  // run that writes playable reports every count-admitted pair as gained and nothing as lost.
  assert.deepEqual(d.playableGained, [{ id: "Sylas", role: "JUNGLE" }, { id: "Sylas", role: "SUPPORT" }, { id: "Zaahen", role: "TOP" }]);
  assert.deepEqual(d.playableLost, [{ id: "Ashe", role: "SUPPORT" }, { id: "Sylas", role: "TOP" }]);
});

test("diffPositions reports playable pairs gained and lost, reading absent playable as the positions", () => {
  const before = [
    { id: "Kaisa", positions: ["BOTTOM"] },
    { id: "Jhin", positions: ["BOTTOM"], playable: ["TOP", "BOTTOM"] },
  ];
  const after = [
    { id: "Kaisa", positions: ["BOTTOM"], playable: ["TOP", "BOTTOM"] },
    { id: "Jhin", positions: ["BOTTOM"], playable: ["BOTTOM"] },
  ];
  const d = diffPositions(before, after);
  assert.deepEqual(d.primaryFlips, []);
  assert.deepEqual(d.lost, []);
  assert.deepEqual(d.gained, []);
  assert.deepEqual(d.playableGained, [{ id: "Kaisa", role: "TOP" }]);
  assert.deepEqual(d.playableLost, [{ id: "Jhin", role: "TOP" }]);
});

test("diffPositions refuses misaligned inputs (the refresh never adds, removes or reorders)", () => {
  assert.throws(() => diffPositions([{ id: "A", positions: ["TOP"] }], [{ id: "B", positions: ["TOP"] }]), /aligned/);
});

test("buildProvenance writes the block in the documented key order and omits an absent feasibility", () => {
  const p = buildProvenance({ kind: "corpus", patches: ["16.15", "16.16"], games: 300885, threshold: 0.1,
                              generatedAt: "2026-09-05T00:00:00.000Z", feasibility: undefined });
  assert.deepEqual(Object.keys(p), ["kind", "patches", "games", "threshold", "generatedAt"]);
  const q = buildProvenance({ kind: "corpus", patches: ["16.16"], games: 1, threshold: 0.1,
                              generatedAt: "x", feasibility: { sets: 10, bothSides: 0.5 } });
  assert.deepEqual(q.feasibility, { sets: 10, bothSides: 0.5 });
  const u = buildProvenance({ kind: "ugg", patches: ["16_8"], games: 450, gamesUnit: "champion-matches", unmeasuredAtParity: true, threshold: 0.1, generatedAt: "x" });
  assert.deepEqual(Object.keys(u), ["kind", "patches", "games", "gamesUnit", "unmeasuredAtParity", "threshold", "generatedAt"]);
  // The recency rule's fields sit between the source and the threshold; an absent fallback is written as {}.
  const r = buildProvenance({ kind: "corpus", patches: ["16.18", "16.19"], games: 200000, rule: "latest-patch", minPicks: 300,
                              decidingPatch: "16.19", decidingGames: 120000, threshold: 0.1, generatedAt: "x", feasibility: { sets: 1, bothSides: 0.8 } });
  assert.deepEqual(Object.keys(r), ["kind", "patches", "games", "rule", "minPicks", "decidingPatch", "decidingGames", "fallback", "threshold", "generatedAt", "feasibility"]);
  assert.deepEqual(r.fallback, {});
  assert.equal(r.decidingPatch, "16.19");
  const s = buildProvenance({ kind: "corpus", patches: ["16.19"], games: 1, rule: "latest-patch", minPicks: 300, decidingPatch: "16.19", decidingGames: 1,
                              fallback: { Nilah: "pooled" }, threshold: 0.1, generatedAt: "x" });
  assert.deepEqual(s.fallback, { Nilah: "pooled" });
  // The playable rule (champion-role-shares § 4.1) sits after the recency fields; the feasibility block
  // carries the FIELD it was measured on, separately from the rule (Codex R2).
  const t = buildProvenance({ kind: "corpus", patches: ["16.18", "16.19"], games: 816793, rule: "latest-patch", minPicks: 300,
                              decidingPatch: "16.19", decidingGames: 277103, fallback: {},
                              playableRule: { minPickRate: 0.001, minPicks: 50, decidingPatch: "16.19", decidingGames: 277103 },
                              threshold: 0.1, generatedAt: "x", feasibility: { sets: 102100, bothSides: 0.976, field: "playable" } });
  assert.deepEqual(Object.keys(t), ["kind", "patches", "games", "rule", "minPicks", "decidingPatch", "decidingGames", "fallback", "playableRule", "threshold", "generatedAt", "feasibility"]);
  assert.deepEqual(t.playableRule, { minPickRate: 0.001, minPicks: 50, decidingPatch: "16.19", decidingGames: 277103 });
  assert.deepEqual(t.feasibility, { sets: 102100, bothSides: 0.976, field: "playable" });
  // --source ugg has no train games: no playableRule, as before.
  const v = buildProvenance({ kind: "ugg", patches: ["16_8"], games: 450, gamesUnit: "champion-matches", unmeasuredAtParity: true, threshold: 0.1, generatedAt: "x",
                              feasibility: { sets: 10, bothSides: 0.6, field: "positions" } });
  assert.equal("playableRule" in v, false);
  assert.equal(v.feasibility.field, "positions");
});

test("formatPositionsSource renders every field an operator needs, including a carried-forward feasibility", () => {
  assert.equal(formatPositionsSource(undefined), "none recorded (Meraki verbatim)");
  assert.equal(
    formatPositionsSource({ kind: "corpus", patches: ["16.15", "16.16"], games: 300885, threshold: 0.1, generatedAt: "2026-09-05T10:00:00.000Z", feasibility: { sets: 34159, bothSides: 0.785 } }),
    "corpus patches=16.15,16.16 threshold=0.1 generated=2026-09-05T10:00:00.000Z feasibility=0.785",
  );
  assert.equal(
    formatPositionsSource({ kind: "corpus", patches: ["16.17"], games: 1, threshold: 0.1, generatedAt: "2026-10-01T00:00:00.000Z",
                            feasibility: { sets: 34159, bothSides: 0.785, carriedFrom: { generatedAt: "2026-09-05T10:00:00.000Z", kind: "corpus" } } }),
    "corpus patches=16.17 threshold=0.1 generated=2026-10-01T00:00:00.000Z feasibility=0.785 (carried from 2026-09-05T10:00:00.000Z)",
  );
  assert.equal(
    formatPositionsSource({ kind: "ugg", patches: ["16_8"], games: 450, gamesUnit: "champion-matches", unmeasuredAtParity: true, threshold: 0.1, generatedAt: "x" }),
    "ugg patches=16_8 threshold=0.1 generated=x feasibility=unmeasured [source unmeasured at parity]",
  );
  // a corpus block with no feasibility (first run with --skip-feasibility): "unmeasured" must not depend on the parity flag
  assert.equal(
    formatPositionsSource({ kind: "corpus", patches: ["16.15", "16.16"], games: 300885, threshold: 0.1, generatedAt: "x" }),
    "corpus patches=16.15,16.16 threshold=0.1 generated=x feasibility=unmeasured",
  );
  // the recency rule: name it and its deciding patch; count the champions decided otherwise, only when there are any.
  // Same strings as backend/tests/navigator/navigator_engine_boot_line.test.js (the backend keeps a verbatim CJS copy).
  const block = { kind: "corpus", patches: ["16.18", "16.19"], games: 200000, rule: "latest-patch", minPicks: 300, decidingPatch: "16.19",
    decidingGames: 120000, fallback: {}, threshold: 0.1, generatedAt: "2026-10-06T00:00:00.000Z", feasibility: { sets: 40000, bothSides: 0.8 } };
  assert.equal(
    formatPositionsSource(block),
    "corpus patches=16.18,16.19 rule=latest-patch deciding=16.19 threshold=0.1 generated=2026-10-06T00:00:00.000Z feasibility=0.8",
  );
  assert.equal(
    formatPositionsSource({ ...block, fallback: { Nilah: "16.18", Zaahen: "pooled" } }),
    "corpus patches=16.18,16.19 rule=latest-patch deciding=16.19 fallback=2 threshold=0.1 generated=2026-10-06T00:00:00.000Z feasibility=0.8",
  );
  // The field the feasibility was measured on (champion-role-shares § 4.2 hop 5) prints after the number —
  // a block from before the field prints as before. Same string in the backend's CJS copy.
  assert.equal(
    formatPositionsSource({ ...block, feasibility: { sets: 102100, bothSides: 0.976, field: "playable" } }),
    "corpus patches=16.18,16.19 rule=latest-patch deciding=16.19 threshold=0.1 generated=2026-10-06T00:00:00.000Z feasibility=0.976 field=playable",
  );
  assert.equal(
    formatPositionsSource({ kind: "corpus", patches: ["16.19"], games: 1, threshold: 0.1, generatedAt: "x",
                            feasibility: { sets: 1, bothSides: 0.976, field: "playable", carriedFrom: { generatedAt: "2026-10-09T00:00:00.000Z", kind: "corpus" } } }),
    "corpus patches=16.19 threshold=0.1 generated=x feasibility=0.976 (carried from 2026-10-09T00:00:00.000Z) field=playable",
  );
});

test("evaluateGate is not armed on the first run, whatever the flip count", () => {
  const g = evaluateGate({ previous: undefined, primaryFlips: 37, feasibility: { sets: 1, bothSides: 0.785 }, force: false });
  assert.deepEqual(g, { armed: false, abort: false, reasons: [] });
});

test("evaluateGate aborts a recurring run on more than MAX_PRIMARY_FLIPS flips", () => {
  const previous = { kind: "corpus", feasibility: { sets: 1, bothSides: 0.785 } };
  const g = evaluateGate({ previous, primaryFlips: 11, feasibility: { sets: 1, bothSides: 0.79 }, force: false });
  assert.equal(g.armed, true);
  assert.equal(g.abort, true);
  assert.match(g.reasons[0], /11 primary flips > 10/);
  assert.equal(evaluateGate({ previous, primaryFlips: 10, feasibility: { sets: 1, bothSides: 0.79 }, force: false }).abort, false);
});

test("evaluateGate aborts a recurring run on a feasibility drop of more than MAX_FEASIBILITY_DROP", () => {
  const previous = { kind: "corpus", feasibility: { sets: 1, bothSides: 0.785 } };
  const g = evaluateGate({ previous, primaryFlips: 3, feasibility: { sets: 1, bothSides: 0.76 }, force: false });
  assert.equal(g.abort, true);
  assert.match(g.reasons[0], /0.760 is 0.025 below the previous 0.785/);
  assert.equal(evaluateGate({ previous, primaryFlips: 3, feasibility: { sets: 1, bothSides: 0.766 }, force: false }).abort, false);
});

test("evaluateGate cannot compare feasibility when the PREVIOUS run lacks it, and says so", () => {
  const previous = { kind: "corpus" };
  const g = evaluateGate({ previous, primaryFlips: 3, feasibility: { sets: 1, bothSides: 0.5 }, force: false });
  assert.equal(g.abort, false);
  assert.match(g.reasons[0], /not compared/);
});

test("evaluateGate refuses a recurring run that cannot measure feasibility when the previous run could (the gate must not silently disarm)", () => {
  const previous = { kind: "corpus", generatedAt: "2026-09-05T00:00:00.000Z", feasibility: { sets: 34159, bothSides: 0.785 } };
  const g = evaluateGate({ previous, primaryFlips: 3, feasibility: undefined, force: false });
  assert.equal(g.abort, true);
  assert.match(g.reasons[0], /feasibility unmeasured on this run while the previous run recorded 0\.785/);
  const forced = evaluateGate({ previous, primaryFlips: 3, feasibility: undefined, force: true });
  assert.equal(forced.abort, false);
  assert.match(forced.reasons.join("\n"), /overridden by --force/);
});

test("evaluateGate says when the number it is comparing against was carried forward, never measured", () => {
  const previous = { kind: "corpus", generatedAt: "2026-10-01T00:00:00.000Z",
                     feasibility: { sets: 1, bothSides: 0.785, carriedFrom: { generatedAt: "2026-09-05T10:00:00.000Z", kind: "corpus" } } };
  const g = evaluateGate({ previous, primaryFlips: 0, feasibility: { sets: 1, bothSides: 0.70 }, force: false });
  assert.equal(g.abort, true);
  assert.match(g.reasons[0], /carried from 2026-09-05T10:00:00.000Z, never measured for that table/);
});

test("evaluateGate arms the drop clause only when both runs measured the same field (champion-role-shares § 4.2 hop 5)", () => {
  // The previous run measured on positions (0.738); this run on playable (0.976): no comparison, no abort,
  // a line that says so — and the flip clause still works.
  const previous = { kind: "corpus", feasibility: { sets: 102100, bothSides: 0.738, field: "positions" } };
  const g = evaluateGate({ previous, primaryFlips: 0, feasibility: { sets: 102100, bothSides: 0.976, field: "playable" }, force: false });
  assert.deepEqual(g, { armed: true, abort: false, reasons: ["feasibility drop clause unarmed: previous run measured positions (0.738), this run measured playable (0.976)"] });
  // A block from before the field is "unknown"; a drop on a different field is NOT a violation either way.
  const legacy = { kind: "corpus", feasibility: { sets: 102100, bothSides: 0.976 } };
  const h = evaluateGate({ previous: legacy, primaryFlips: 0, feasibility: { sets: 102100, bothSides: 0.738, field: "positions" }, force: false });
  assert.equal(h.abort, false);
  assert.match(h.reasons[0], /unarmed: previous run measured unknown \(0\.976\), this run measured positions \(0\.738\)/);
  // The same field: the drop clause is armed as always.
  const same = { kind: "corpus", feasibility: { sets: 102100, bothSides: 0.976, field: "playable" } };
  const k = evaluateGate({ previous: same, primaryFlips: 0, feasibility: { sets: 102100, bothSides: 0.95, field: "playable" }, force: false });
  assert.equal(k.abort, true);
  assert.match(k.reasons[0], /0\.950 is 0\.026 below the previous 0\.976/);
  // The flip clause is independent of the field.
  const flips = evaluateGate({ previous, primaryFlips: 11, feasibility: { sets: 1, bothSides: 0.976, field: "playable" }, force: false });
  assert.equal(flips.abort, true);
  assert.match(flips.reasons[0], /11 primary flips/);
  assert.match(flips.reasons[1], /unarmed/);
});

test("carryForward records the measured block, or under --force carries the previous one WITH its field across a source-kind change", () => {
  const measured = { sets: 102100, bothSides: 0.976, field: "playable" };
  const corpusRun = { kind: "corpus", generatedAt: "2026-10-10T00:00:00.000Z", feasibility: measured };
  assert.deepEqual(carryForward({ feasibility: measured, previous: corpusRun, force: true }), measured, "a measured run records itself");
  // A forced UNMEASURED ugg run after a measured corpus run: the corpus number travels, with its field,
  // marked with the run it came from — across the kind change (design § 4.2 hop 5: a measured corpus
  // run → a forced unmeasured ugg run → a corpus run must not lose the first measurement).
  const carried = carryForward({ feasibility: undefined, previous: corpusRun, force: true });
  assert.deepEqual(carried, { sets: 102100, bothSides: 0.976, field: "playable", carriedFrom: { generatedAt: "2026-10-10T00:00:00.000Z", kind: "corpus" } });
  // A chain of carries keeps pointing at the run that measured.
  const uggRun = { kind: "ugg", generatedAt: "2026-10-11T00:00:00.000Z", feasibility: carried };
  assert.deepEqual(carryForward({ feasibility: undefined, previous: uggRun, force: true }).carriedFrom, carried.carriedFrom);
  // The third run (corpus, measured) compares against the carried number: a 0.076 drop aborts.
  const third = evaluateGate({ previous: uggRun, primaryFlips: 0, feasibility: { sets: 102100, bothSides: 0.9, field: "playable" }, force: false });
  assert.equal(third.abort, true);
  assert.match(third.reasons[0], /0\.900 is 0\.076 below the previous 0\.976 \(limit 0\.02\) \(previous number carried from 2026-10-10T00:00:00.000Z, never measured for that table\)/);
  // Without --force nothing is carried (the gate refused the run unless forced); without a previous number, nothing either.
  assert.equal(carryForward({ feasibility: undefined, previous: corpusRun, force: false }), undefined);
  assert.equal(carryForward({ feasibility: undefined, previous: { kind: "corpus" }, force: true }), undefined);
  assert.equal(carryForward({ feasibility: undefined, previous: undefined, force: true }), undefined);
});

test("evaluateGate reports but does not abort under --force", () => {
  const previous = { kind: "corpus", feasibility: { sets: 1, bothSides: 0.785 } };
  const g = evaluateGate({ previous, primaryFlips: 40, feasibility: { sets: 1, bothSides: 0.5 }, force: true });
  assert.equal(g.abort, false);
  assert.equal(g.reasons.length, 3);   // flips, feasibility drop, the override note
  assert.match(g.reasons.join("\n"), /overridden by --force/);
});

test("formatDiff counts the champions with and without positionShares when given the rows", () => {
  const diff = { primaryFlips: [], lost: [], gained: [], changedSets: 0, meanBefore: 1, meanAfter: 1 };
  const rows = [
    { id: "Ahri", positions: ["MIDDLE"], positionShares: { MIDDLE: 0.93 } },
    { id: "Zaahen", positions: ["TOP"] },
  ];
  const text = formatDiff(diff, new Map(), ["Zaahen"], undefined, rows);
  assert.match(text, /champions with positionShares: 1; without \(no source data, kept as they were\): 1 \(Zaahen\)/);
  assert.doesNotMatch(formatDiff(diff, new Map(), ["Zaahen"]), /positionShares/, "without rows the line is not printed");
});

test("formatDiff prints the playable pairs with the gained and lost ones when given the rows", () => {
  const diff = {
    primaryFlips: [], lost: [], gained: [], changedSets: 0, meanBefore: 1, meanAfter: 1,
    playableGained: [{ id: "Kaisa", role: "TOP" }, { id: "Jhin", role: "TOP" }], playableLost: [{ id: "Taric", role: "JUNGLE" }],
  };
  const rows = [
    { id: "Kaisa", positions: ["BOTTOM"], playable: ["TOP", "BOTTOM"] },
    { id: "Jhin", positions: ["BOTTOM"], playable: ["TOP", "BOTTOM"] },
    { id: "Taric", positions: ["SUPPORT"], playable: ["SUPPORT"] },
    { id: "Zaahen", positions: ["TOP"] },
  ];
  const text = formatDiff(diff, new Map(), ["Zaahen"], undefined, rows);
  assert.match(text, /^playable pairs: 6 \(absent playable counts as the positions\); gained \(2\): Kaisa TOP, Jhin TOP; lost \(1\): Taric JUNGLE$/m);
  // A diff from before the field (no playable keys) prints the count alone.
  const old = { primaryFlips: [], lost: [], gained: [], changedSets: 0, meanBefore: 1, meanAfter: 1 };
  assert.match(formatDiff(old, new Map(), [], undefined, rows), /^playable pairs: 6 \(absent playable counts as the positions\); gained \(0\): ; lost \(0\): $/m);
  assert.doesNotMatch(formatDiff(diff, new Map(), ["Zaahen"]), /playable/, "without rows the line is not printed");
});

test("formatDiff names each flip with its rates, the lost and gained pairs, and the kept champions", () => {
  const diff = {
    primaryFlips: [{ id: "Vayne", from: "BOTTOM", to: "TOP" }],
    lost: [{ id: "Ashe", role: "SUPPORT" }],
    gained: [{ id: "Sylas", role: "JUNGLE" }],
    changedSets: 3, meanBefore: 1.4, meanAfter: 1.72,
  };
  const rates = new Map([["Vayne", { TOP: 0.5677, BOTTOM: 0.3842, MIDDLE: 0.0344, JUNGLE: 0.0113, SUPPORT: 0.0024 }]]);
  const text = formatDiff(diff, rates, ["Zaahen"]);
  assert.match(text, /primary flips \(1\)/);
  assert.match(text, /Vayne +BOTTOM +-> TOP +\(TOP 0\.57, BOTTOM 0\.38\)$/m);
  assert.doesNotMatch(text, /pooled/);
  assert.match(text, /roles lost \(1\): Ashe SUPPORT/);
  assert.match(text, /roles gained \(1\): Sylas JUNGLE/);
  assert.match(text, /kept \(no source data\) \(1\): Zaahen/);
  assert.match(text, /mean positions per champion 1\.40 -> 1\.72/);
  // With the pooled map (corpus source) each flip also shows the pooled-window shares.
  const pooled = new Map([["Vayne", { TOP: 0.3, BOTTOM: 0.65, MIDDLE: 0.05, JUNGLE: 0, SUPPORT: 0 }]]);
  assert.match(formatDiff(diff, rates, [], pooled), /Vayne +BOTTOM +-> TOP +\(TOP 0\.57, BOTTOM 0\.38\) \| pooled \(BOTTOM 0\.65, TOP 0\.30, MIDDLE 0\.05\)/);
});
