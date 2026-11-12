import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assemblePageData, loadNames } from "./build-review-page.mjs";
import * as LOGIC from "./review-logic.mjs";
import {
  armLabel,
  blindRows,
  buildNameIndex,
  cardDone,
  currentLabel,
  draftRevealState,
  labelMode,
  laterRows,
  newState,
  parseNameInput,
  pickProblem,
  pickText,
  poolTag,
  progress,
  restoreState,
  samePick,
  setLabel,
  setPick,
  shuffleRows,
  sideParts,
  sideText,
  stageTwoOpen,
} from "./review-logic.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const RUN = JSON.parse(fs.readFileSync(path.join(HERE, "testdata/tiny-run.json"), "utf8"));
const NAMES = loadNames(REPO);

function load() {
  return assemblePageData(structuredClone(RUN), { names: NAMES, icons: () => "AAAA" });
}
function draftOf(data, id) {
  return data.drafts.find((d) => d.id === id);
}
function cardOf(data, id) {
  return data.drafts.flatMap((d) => d.cards).find((c) => c.id === id);
}
const A = "2026-10-04-supp-pinch-slot-17-dme";
const B = "2026-09-29-supp-pinch-slot-19-kittens";
const C = "2026-10-04-supp-pinch-slot-19-kittens";
const D = "2026-10-04-top-pinch-slot-19-kittens";
const E = "2026-10-07-synth-dme-adc-pinch-slot-19";
const T1 = "2026-11-10T10:00:00Z";
const T2 = "2026-11-10T10:05:00Z";
const T3 = "2026-11-10T10:09:00Z";

// ---- the shuffle ----

test("the shuffle is stable for one id, differs across ids, and does not depend on the order rows arrive in", () => {
  const ids = ["Aphelios|adc=Aphelios", "Ashe|adc=Ashe", "Jinx|adc=Jinx", "Sivir|adc=Sivir", "Zyra|adc=Zyra"];
  assert.deepEqual(shuffleRows(ids, "card-one"), shuffleRows(ids, "card-one"));
  assert.deepEqual(shuffleRows(ids, "card-one"), shuffleRows([...ids].reverse(), "card-one"));
  const orders = ["card-one", "card-two", "card-three", "card-four"].map((id) => shuffleRows(ids, id).join());
  assert.ok(new Set(orders).size > 1, "four ids gave one and the same order");
  assert.deepEqual([...shuffleRows(ids, "card-one")].sort(), [...ids].sort(), "a shuffle keeps every row");
  const objects = ids.map((id) => ({ id }));
  assert.deepEqual(shuffleRows(objects, "card-one").map((o) => o.id), shuffleRows(ids, "card-one"));
});

test("a row added later does not move the others", () => {
  const ids = ["Aphelios|adc=Aphelios", "Ashe|adc=Ashe", "Jinx|adc=Jinx", "Sivir|adc=Sivir", "Zyra|adc=Zyra"];
  const before = shuffleRows(ids, "card-one");
  const after = shuffleRows([...ids, "Ahri|adc=Ahri"], "card-one").filter((x) => x !== "Ahri|adc=Ahri");
  assert.deepEqual(after, before);
});

test("Zyra is not last on every slot-19 card of the fixture run, and the page never uses Math.random", () => {
  const data = load();
  const slot19 = data.drafts.flatMap((d) => d.cards).filter((c) => c.slot === 19 && blindRows(c).some((o) => o.id.startsWith("Zyra")));
  assert.ok(slot19.length >= 3, "the fixture run needs at least three slot-19 cards with Zyra");
  const lastIsZyra = slot19.map((c) => shuffleRows(blindRows(c), c.id).at(-1).id.startsWith("Zyra"));
  assert.ok(!lastIsZyra.every(Boolean), "alphabetical order would put Zyra last on every one");
  assert.equal(fs.readFileSync(path.join(HERE, "review-logic.mjs"), "utf8").includes("Math.random"), false);
});

test("the shuffle is independent of the engine's rank: the rows of a card are not in rank order", () => {
  const data = load();
  const card = cardOf(data, A);
  const byReach = blindRows(card);
  const shuffled = shuffleRows(byReach, card.id);
  assert.notDeepEqual(shuffled.map((o) => o.id), byReach.map((o) => o.id));
});

// ---- blind and later rows ----

test("blindRows holds the top-5 reach and margin-set rows and excludes ranks 6-10; laterRows holds those", () => {
  const card = cardOf(load(), A);
  const blind = blindRows(card).map((o) => o.id.split("|")[0]).sort();
  assert.deepEqual(blind, ["Amumu+Zilean", "Kaisa+KSante", "Renata+Ziggs", "Syndra+Ziggs"]);
  assert.deepEqual(laterRows(card).map((o) => o.id.split("|")[0]).sort(), ["Alistar+Zyra", "KSante+Leona"]);
  // reach 5 is in; reach 6 without margin is out; reach 6 with margin is in; a non-row (reach 14) is in neither
  assert.equal(card.options.find((o) => o.id.startsWith("Bard+Lulu")).row, null);
});

// ---- reveal state and label mode ----

test("draftRevealState: blind while any blind row is unlabelled, ready when none is, revealed once a scored entry exists", () => {
  const data = load();
  const supp = draftOf(data, "supp");
  const state = newState(data);
  assert.equal(draftRevealState(supp, state), "blind");
  assert.equal(labelMode(supp, state), "blind");
  let t = 0;
  for (const card of supp.cards) {
    for (const [i, o] of blindRows(card).entries()) {
      assert.equal(draftRevealState(supp, state), "blind", "still blind with a row left");
      setLabel(state, supp, card.id, o.id, "play", `2026-11-10T10:00:${String(10 + t++ + i).padStart(2, "0")}Z`);
    }
  }
  assert.equal(draftRevealState(supp, state), "ready");
  assert.equal(labelMode(supp, state), "blind", "ready is still blind");
  state.positions[C].labels[blindRows(cardOf(data, C))[0].id].mode = "scored";
  assert.equal(draftRevealState(supp, state), "revealed", "a scored entry on any card of the draft");
  assert.equal(draftRevealState(draftOf(data, "top"), state), "blind", "the reveal is per draft");
  assert.equal(labelMode(supp, state), "scored");
});

test("a draft the fixtures hold a scored entry for starts revealed, and its new rows are scored", () => {
  const data = load();
  const synth = draftOf(data, "synth-dme-adc");
  const state = newState(data);
  assert.equal(draftRevealState(synth, state), "revealed");
  const card = cardOf(data, E);
  const fresh = blindRows(card).find((o) => state.positions[E].labels[o.id] === undefined);
  assert.ok(fresh);
  assert.equal(setLabel(state, synth, E, fresh.id, "maybe", T1), true);
  const rec = state.positions[E].labels[fresh.id];
  assert.equal(rec.mode, "scored");
  assert.equal(rec.blind, undefined, "a row first labelled after the reveal has no blind value");
  assert.equal(rec.current, "maybe");
});

// ---- changes: mode, time, folds ----

test("a label records the mode and time of its change; a scored change leaves the blind value alone", () => {
  const data = load();
  const supp = draftOf(data, "supp");
  const state = newState(data);
  const rows = blindRows(cardOf(data, B));
  const id = rows[0].id;
  assert.equal(setLabel(state, supp, B, id, "never", T1), true);
  assert.deepEqual(state.positions[B].labels[id], { current: "never", mode: "blind", t: T1, blind: "never" });
  // reveal the draft, then change
  state.positions[B].revealedAt = T2;
  assert.equal(setLabel(state, supp, B, id, "maybe", T3), true);
  assert.deepEqual(state.positions[B].labels[id], { current: "maybe", mode: "scored", t: T3, blind: "never" });
  // back to the blind value: the final value is still the final value, the blind value is still the blind one
  assert.equal(setLabel(state, supp, B, id, "never", T3), true);
  assert.deepEqual(state.positions[B].labels[id], { current: "never", mode: "scored", t: T3, blind: "never" });
});

test("the span of a mode runs from its first change to its last; rev rises with every change and not on a no-op", () => {
  const data = load();
  const supp = draftOf(data, "supp");
  const state = newState(data);
  const [r1, r2] = blindRows(cardOf(data, B));
  assert.equal(state.rev, 0);
  setLabel(state, supp, B, r1.id, "play", T1);
  setLabel(state, supp, B, r2.id, "maybe", T3);
  assert.deepEqual(state.positions[B].span, { blind: { first: T1, last: T3 } });
  assert.equal(state.rev, 2);
  assert.equal(setLabel(state, supp, B, r2.id, "maybe", "2026-11-10T11:00:00Z"), false);
  assert.equal(state.rev, 2, "re-clicking the current label changes nothing");
  assert.deepEqual(state.positions[B].span, { blind: { first: T1, last: T3 } });
  state.positions[B].revealedAt = T3;
  setLabel(state, supp, B, r2.id, "never", "2026-11-10T11:30:00Z");
  assert.deepEqual(state.positions[B].span.scored, { first: "2026-11-10T11:30:00Z", last: "2026-11-10T11:30:00Z" });
  assert.deepEqual(state.positions[B].span.blind, { first: T1, last: T3 });
  assert.equal(state.rev, 3);
});

test("setLabel refuses a value that is not a label and an option the card does not hold", () => {
  const data = load();
  const supp = draftOf(data, "supp");
  const state = newState(data);
  const id = blindRows(cardOf(data, B))[0].id;
  assert.throws(() => setLabel(state, supp, B, id, "yes", T1), /not a label/);
  assert.throws(() => setLabel(state, supp, B, "Nobody|adc=Nobody", "play", T1), /unknown option/);
  assert.equal(state.rev, 0);
});

// ---- the own pick ----

test("\"no view\" is an answer (null), not absence; stage 2 opens only after stage 1 is answered", () => {
  const data = load();
  const supp = draftOf(data, "supp");
  const card = cardOf(data, B);
  const state = newState(data);
  assert.equal(state.positions[B].pick, undefined);
  assert.equal(stageTwoOpen(supp, card, state), false, "no engine row before the pick");
  assert.equal(cardDone(card, state), false);
  assert.equal(setPick(state, supp, B, null, T1), true);
  assert.equal(state.positions[B].pick.blind, null);
  assert.equal(state.positions[B].pick.current, null);
  assert.equal(stageTwoOpen(supp, card, state), true);
  assert.equal(JSON.parse(JSON.stringify(state)).positions[B].pick.blind, null, "null survives storage");
});

test("the blind pick is locked until the reveal; after it a change is scored and the blind pick stays", () => {
  const data = load();
  const supp = draftOf(data, "supp");
  const state = newState(data);
  setPick(state, supp, B, "Aphelios", T1);
  assert.throws(() => setPick(state, supp, B, "Ashe", T2), /locked/);
  assert.equal(setPick(state, supp, B, "Aphelios", T2), false, "the same pick again is not a change");
  state.positions[B].revealedAt = T2;
  assert.equal(setPick(state, supp, B, "Ashe", T3), true);
  assert.deepEqual(state.positions[B].pick, { blind: "Aphelios", current: "Ashe", mode: "scored", t: T3 });
  assert.deepEqual(state.positions[B].span.blind, { first: T1, last: T1 });
});

test("a pair pick is compared as a set, and the blind row it matches is pre-set to play", () => {
  assert.equal(samePick(["Ziggs", "Syndra"], ["Syndra", "Ziggs"]), true);
  assert.equal(samePick(null, null), true);
  assert.equal(samePick(null, "Ashe"), false);
  assert.equal(samePick("Ashe", ["Ashe", "Jinx"]), false);
  const data = load();
  const supp = draftOf(data, "supp");
  const state = newState(data);
  setPick(state, supp, A, ["Ziggs", "Syndra"], T1);
  const row = blindRows(cardOf(data, A)).find((o) => o.id.startsWith("Syndra+Ziggs"));
  assert.deepEqual(state.positions[A].labels[row.id], { current: "play", mode: "blind", t: T1, blind: "play", via: "own-pick" });
  assert.equal(Object.keys(state.positions[A].labels).length, 1);
  assert.equal(state.rev, 1, "the pick and its pre-set are one change");
  // a pick that is not a blind row pre-sets nothing; "no view" pre-sets nothing
  const other = newState(data);
  setPick(other, supp, A, ["Alistar", "Zyra"], T1);
  assert.deepEqual(other.positions[A].labels, {});
  const none = newState(data);
  setPick(none, supp, A, null, T1);
  assert.deepEqual(none.positions[A].labels, {});
});

test("the pre-set does not overwrite a label already given", () => {
  const data = load();
  const supp = draftOf(data, "supp");
  const state = newState(data);
  const row = blindRows(cardOf(data, B)).find((o) => o.id.startsWith("Ashe"));
  state.positions[B].labels[row.id] = { current: "never", mode: null, t: null };
  setPick(state, supp, B, "Ashe", T1);
  assert.equal(currentLabel(state, B, row.id), "never");
});

test("pickProblem: one champion at a single root, two different ones at a pair root, none on the board", () => {
  const data = load();
  assert.equal(pickProblem(cardOf(data, B), ["Ashe"], NAMES), null);
  assert.match(pickProblem(cardOf(data, B), [null], NAMES), /one champion/);
  assert.match(pickProblem(cardOf(data, A), ["Ziggs"], NAMES), /two champions/);
  assert.match(pickProblem(cardOf(data, A), ["Ziggs", "Ziggs"], NAMES), /different/);
  assert.match(pickProblem(cardOf(data, A), ["Ziggs", "Zilean"], NAMES), /Zilean is already banned/);
  assert.match(pickProblem(cardOf(data, A), ["Ziggs", "Vi"], NAMES), /Vi is already picked/);
  assert.equal(pickProblem(cardOf(data, A), ["Ziggs", "Syndra"], NAMES), null);
});

test("names: display names and ids both resolve, ignoring case and punctuation", () => {
  const index = buildNameIndex(NAMES);
  assert.equal(parseNameInput("Wukong", index), "MonkeyKing");
  assert.equal(parseNameInput("monkeyking", index), "MonkeyKing");
  assert.equal(parseNameInput("K'Sante", index), "KSante");
  assert.equal(parseNameInput("lee sin", index), "LeeSin");
  assert.equal(parseNameInput("Kai'Sa", index), "Kaisa");
  assert.equal(parseNameInput("", index), null);
  assert.equal(parseNameInput("toString", index), null);
  assert.equal(pickText(["MonkeyKing", "Galio"], NAMES), "Wukong + Galio");
  assert.equal(pickText(null, NAMES), "no view");
});

// ---- the side in words ----

test("a moved locked pick is stated in neutral words; the tag reads in-pool / off-pool and nothing else", () => {
  const card = cardOf(load(), A);
  const syndra = card.options.find((o) => o.id.startsWith("Syndra+Ziggs"));
  assert.equal(sideText(syndra, NAMES), "Syndra mid · Ziggs adc · Camille top · Wukong jungle · Galio moved to support");
  assert.deepEqual(sideParts(syndra).map((p) => [p.champion, p.moved, p.acting]), [
    ["Syndra", false, true], ["Ziggs", false, true], ["Camille", false, false], ["MonkeyKing", false, false], ["Galio", true, false],
  ]);
  assert.equal(poolTag(syndra), "off", "the moved Galio is outside the pool for support");
  assert.equal(poolTag(card.options.find((o) => o.id.startsWith("Renata+Ziggs"))), "in");
  const bare = card.options.find((o) => o.id === "Amumu+Zilean");
  assert.equal(poolTag(bare), null);
  assert.equal(sideText(bare, NAMES), "Amumu + Zilean");
  for (const p of sideParts(syndra)) assert.deepEqual(Object.keys(p).sort(), ["acting", "champion", "moved", "role"], "no grade and no r reach the row");
});

// ---- progress, seed and storage ----

test("progress counts blind rows and finished cards; a seeded card with a pick and every row labelled is done", () => {
  const data = load();
  const state = newState(data);
  const p = progress(data, state);
  assert.equal(p.blindTotal, 4 + 5 + 5 + 5 + 5);
  assert.equal(p.cardsTotal, 5);
  assert.equal(p.cardsDone, 0);
  assert.equal(p.blindDone, 2, "the two rows the fixtures already hold labels for");
  const synth = draftOf(data, "synth-dme-adc");
  for (const o of blindRows(cardOf(data, E))) if (currentLabel(state, E, o.id) === undefined) setLabel(state, synth, E, o.id, "play", T1);
  assert.equal(cardDone(cardOf(data, E), state), true, "seeded pick Ahri plus all rows");
  assert.equal(progress(data, state).cardsDone, 1);
});

test("the seed carries the fixtures' blind and current values and picks, with no time", () => {
  const data = load();
  const state = newState(data);
  const ids = Object.keys(RUN.positions[4].labels);
  assert.deepEqual(state.positions[E].labels[ids[0]], { blind: "play", current: "maybe", mode: null, t: null });
  assert.deepEqual(state.positions[E].pick, { blind: "Ahri", current: "Ahri", mode: null, t: null });
  assert.equal(state.positions[E].revealedAt, "2026-11-09T14:31:00Z");
  assert.equal(state.positions[B].pick, undefined, "absent means not answered");
});

test("restoreState reads back what was stored, drops what does not fit, and starts again on another run", () => {
  const data = load();
  const supp = draftOf(data, "supp");
  const state = newState(data);
  setPick(state, supp, B, "Ashe", T1);
  setLabel(state, supp, B, blindRows(cardOf(data, B))[2].id, "never", T2);
  const back = restoreState(data, JSON.stringify(state));
  assert.deepEqual(back, state);
  assert.deepEqual(restoreState(data, null), newState(data));
  assert.deepEqual(restoreState(data, "{not json"), newState(data));
  assert.deepEqual(restoreState(data, JSON.stringify({ ...state, run: "some other run" })), newState(data));
  const dirty = structuredClone(state);
  dirty.positions[B].labels["Nobody|adc=Nobody"] = { current: "play", mode: "blind", t: T1 };
  dirty.positions[B].labels[blindRows(cardOf(data, B))[0].id] = { current: "banana", mode: "blind", t: T1 };
  const cleaned = restoreState(data, JSON.stringify(dirty));
  assert.equal(cleaned.positions[B].labels["Nobody|adc=Nobody"], undefined);
  assert.deepEqual(cleaned.positions[B].labels, state.positions[B].labels, "only the two bad entries are dropped");
});

// ---- blind means blind ----

test("no stage 1 or stage 2 render path reads a score, a rank, a reach or a margin", () => {
  const template = fs.readFileSync(path.join(HERE, "page-template.html"), "utf8");
  const start = template.indexOf("// ---- the board and the pool");
  const end = template.indexOf("// ---- cards, drafts, header");
  assert.ok(start > 0 && end > start);
  const renderPath = template.slice(start, end);
  for (const forbidden of ["readings", "reference_ranking", "blobs", "menu", "depth_check", "actual_next", "legacy", "review", "reach", "margin", ".rank", "gain", ".grade", ".r)", ".r,", ".r "]) {
    assert.equal(renderPath.includes(forbidden), false, `the stage 1-2 render path mentions ${forbidden}`);
  }
  const card = cardOf(load(), A);
  for (const o of card.options) assert.deepEqual(Object.keys(o).sort(), ["action", "id", "row", "side"], "a row carries no reach or margin");
});

// ---- slice B, task 5: weighted arms and sealed drafts (design T23, T24) ----

test("T23: armLabel prints the weight on a weighted arm and nothing on a roster arm", () => {
  assert.equal(armLabel({ id: "roster:0.1:0.05", rule: "roster", p: 0.1, q: 0.05 }, "roster:0.1:0.05"), "P 0.1  Q 0.05  (reference)");
  assert.equal(armLabel({ id: "roster:0.1:0.05:w2", rule: "roster", p: 0.1, q: 0.05, w: 2 }, "roster:0.1:0.05"), "P 0.1  Q 0.05  w 2");
  assert.equal(armLabel({ id: "roster:0.1:0.05:w0.5", rule: "roster", p: 0.1, q: 0.05, w: 0.5 }, "x"), "P 0.1  Q 0.05  w 0.5");
  assert.equal(armLabel({ id: "pool_or_roster", rule: "pool_or_roster" }, "x"), "pool or roster");
});

// A run whose supp draft is a holdout draft, built from the tiny run so the logic tests need no Rust output.
function holdoutRun({ open } = {}) {
  const run = structuredClone(RUN);
  for (const p of run.positions) if (p.draft === "supp") p.split = "holdout";
  if (open !== undefined) run.run.holdout_open = open;
  return run;
}
const loadRun = (run) => assemblePageData(structuredClone(run), { names: NAMES, icons: () => "AAAA" });

test("T24: a holdout draft is sealed unless the run says holdout_open is true; a development draft never is", () => {
  for (const open of [undefined, false, null, "true", 1, "open"]) {
    const data = loadRun(holdoutRun({ open }));
    assert.equal(LOGIC.draftSealed(draftOf(data, "supp")), true, `holdout_open ${JSON.stringify(open)}`);
    assert.equal(LOGIC.draftSealed(draftOf(data, "top")), false);
  }
  assert.equal(LOGIC.draftSealed(draftOf(loadRun(holdoutRun({ open: true })), "supp")), false, "an opened run reveals it as any other draft");
  assert.equal(LOGIC.draftSealed(draftOf(load(), "supp")), false, "a run with no holdout position seals nothing");
});

test("T24: a sealed draft is never shown: not revealed, no rows past the blind ones, not on the results tab, whatever the state says", () => {
  const data = loadRun(holdoutRun());
  const supp = draftOf(data, "supp");
  const state = newState(data);
  // A restored state that says revealed: a seeded scored entry, a dated reveal, and a scored label.
  const ps = state.positions[B];
  ps.revealedAt = T1;
  ps.labels[blindRows(cardOf(data, B))[0].id] = { current: "play", mode: "scored", t: T1 };
  assert.equal(draftRevealState(supp, state), "revealed", "the state itself still says revealed: labelMode reads it");
  assert.equal(LOGIC.draftShown(supp, state), false);
  assert.equal(LOGIC.positionVisible(data, state, B), false);
  assert.equal(LOGIC.positionVisible(data, state, A), false);
  assert.equal(LOGIC.positionVisible(data, state, D), false, "an unrevealed development draft stays hidden as before");
  assert.equal(LOGIC.selectionNote({ ...data, drafts: [supp] }, state, 0).includes("No draft is revealed yet"), true, "a sealed draft does not count as revealed for the arm control");
  const opened = loadRun(holdoutRun({ open: true }));
  const so = newState(opened);
  so.positions[B].revealedAt = T1;
  assert.equal(LOGIC.draftShown(draftOf(opened, "supp"), so), true);
  assert.equal(LOGIC.positionVisible(opened, so, B), true);
});

test("T24: revealing a sealed draft does nothing, even with every blind row labelled", () => {
  const data = loadRun(holdoutRun());
  const supp = draftOf(data, "supp");
  const state = newState(data);
  for (const card of supp.cards) {
    setPick(state, supp, card.id, null, T1);
    for (const o of blindRows(card)) setLabel(state, supp, card.id, o.id, "play", T2);
  }
  assert.equal(draftRevealState(supp, state), "ready");
  const before = JSON.stringify(state);
  assert.throws(() => LOGIC.revealDraft(state, supp, T3), /sealed/);
  assert.equal(JSON.stringify(state), before, "no revealedAt, no span, no rev");
});

test("T24: sealed overrides rendering and visibility, not the label mode", () => {
  const data = loadRun(holdoutRun());
  const supp = draftOf(data, "supp");
  const state = newState(data);
  assert.equal(labelMode(supp, state), "blind");
  state.positions[B].revealedAt = T1; // the seed of a holdout fixture that holds a scored entry
  assert.equal(labelMode(supp, state), "scored", "labels follow the fixture's history: apply refuses a blind entry after a scored one");
  const card = cardOf(data, B);
  const row = blindRows(card)[0];
  assert.equal(setLabel(state, supp, B, row.id, "never", T2), true);
  assert.equal(state.positions[B].labels[row.id].mode, "scored");
  assert.equal(LOGIC.draftShown(supp, state), false);
});
