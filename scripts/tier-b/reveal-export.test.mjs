// Task 6: the reveal and the export. The tests use the hand-made run in testdata/ and the assembled page data;
// nothing here is read from the stand-in label files or the real fixtures.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assemblePageData, loadNames } from "./build-review-page.mjs";
import {
  blindRows,
  buildExport,
  cardDone,
  draftRevealState,
  earlierView,
  cardSettled,
  currentLineVerdict,
  currentNote,
  depthNote,
  exportWithProblems,
  laterRows,
  lineText,
  newState,
  ownPickPlace,
  referenceTop,
  restoreState,
  revealDraft,
  revealRows,
  setLabel,
  setLineVerdict,
  setNote,
  setPick,
} from "./review-logic.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const RUN = JSON.parse(fs.readFileSync(path.join(HERE, "testdata/tiny-run.json"), "utf8"));
const NAMES = loadNames(REPO);

const A = "2026-10-04-supp-pinch-slot-17-dme"; // pair root, slot 17
const B = "2026-09-29-supp-pinch-slot-19-kittens"; // single root
const C = "2026-10-04-supp-pinch-slot-19-kittens";
const D = "2026-10-04-top-pinch-slot-19-kittens";
const E = "2026-10-07-synth-dme-adc-pinch-slot-19"; // the fixtures already hold a scored entry
const T0 = "2026-11-10T10:00:00Z";
const T1 = "2026-11-10T10:01:00Z";
const T2 = "2026-11-10T10:05:00Z";
const T3 = "2026-11-10T10:09:00Z";
const T4 = "2026-11-10T10:20:00Z";

function load(mutate) {
  const run = structuredClone(RUN);
  if (mutate) mutate(run);
  return assemblePageData(run, { names: NAMES, icons: () => "AAAA" });
}
const draftOf = (data, id) => data.drafts.find((d) => d.id === id);
const cardOf = (data, id) => data.drafts.flatMap((d) => d.cards).find((c) => c.id === id);

// Every blind row of the supp draft labelled "play", the pick answered "no view", one change a minute.
function labelSupp(data, state, label = "play") {
  const supp = draftOf(data, "supp");
  let minute = 10;
  for (const card of supp.cards) {
    setPick(state, supp, card.id, null, `2026-11-10T10:${String(minute++).padStart(2, "0")}:00Z`);
    for (const o of blindRows(card)) setLabel(state, supp, card.id, o.id, label, `2026-11-10T10:${String(minute++).padStart(2, "0")}:00Z`);
  }
  return supp;
}

// ---- the shape and the stamps ----

test("an export before the reveal has the schema, the run, rev, the data stamps, base, a dated blind object, and no scored one", () => {
  const data = load();
  const supp = draftOf(data, "supp");
  const state = newState(data);
  setPick(state, supp, B, null, T0);
  const [r1, r2] = blindRows(cardOf(data, B));
  setLabel(state, supp, B, r1.id, "play", T1);
  setLabel(state, supp, B, r2.id, "never", T2);
  const x = buildExport(state, data);
  assert.equal(x.schema, "tier-b-verdicts/1");
  assert.equal(x.run, data.run.id);
  assert.equal(x.rev, state.rev);
  assert.deepEqual(x.data, { fm_version: data.run.data.fm_version, positions_patch: data.run.data.positions_patch });
  assert.ok(x.data.fm_version && x.data.positions_patch, "never null");
  assert.deepEqual(Object.keys(x.positions), [B], "a position with nothing recorded is left out");
  const p = x.positions[B];
  assert.equal(p.base, cardOf(data, B).base);
  assert.deepEqual(p.blind, { started: T0, finished: T2, would_pick: null, labels: { [r1.id]: "play", [r2.id]: "never" } });
  assert.equal(p.revealed, false);
  assert.equal(p.scored, undefined, "no scored object before the reveal");
});

test("timestamps are wall-clock bounds: successive exports repeat the same start; finished only moves forward", () => {
  const data = load();
  const supp = draftOf(data, "supp");
  const state = newState(data);
  const [r1, r2] = blindRows(cardOf(data, B));
  setLabel(state, supp, B, r1.id, "play", T1);
  const first = buildExport(state, data);
  setLabel(state, supp, B, r2.id, "maybe", T3);
  const second = buildExport(state, data);
  assert.equal(second.positions[B].blind.started, first.positions[B].blind.started);
  assert.equal(first.positions[B].blind.finished, T1);
  assert.equal(second.positions[B].blind.finished, T3);
  assert.ok(second.rev > first.rev);
  // a clock that steps back does not shorten the span
  setLabel(state, supp, B, r1.id, "never", T0);
  assert.equal(buildExport(state, data).positions[B].blind.finished, T3);
  for (const t of [first.positions[B].blind.started, second.positions[B].blind.finished]) assert.match(t, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
});

test("an export is refused when the run carries no data stamp", () => {
  const data = load();
  data.run.data.positions_patch = null;
  assert.throws(() => buildExport(newState(data), data), /positions_patch/);
  data.run.data = { fm_version: "", positions_patch: "16.19" };
  assert.throws(() => buildExport(newState(data), data), /fm_version/);
});

// ---- revealDraft ----

test("an empty reveal is dated: every card of the draft gets a scored span at the reveal time and rev rises once", () => {
  const data = load();
  const state = newState(data);
  const supp = labelSupp(data, state);
  assert.equal(draftRevealState(supp, state), "ready");
  const before = state.rev;
  assert.equal(revealDraft(state, supp, T4), true);
  assert.equal(state.rev, before + 1, "one rev for the whole reveal");
  assert.equal(draftRevealState(supp, state), "revealed");
  const x = buildExport(state, data);
  for (const card of supp.cards) {
    const p = x.positions[card.id];
    assert.equal(p.revealed, true, card.id);
    assert.deepEqual(p.scored, { started: T4, finished: T4, labels: {} }, "an empty reveal still has a dated scored object");
    assert.ok(p.blind, "the blind object stays");
  }
  assert.equal(x.positions[D], undefined, "the reveal is per draft: the top draft is untouched");
});

test("revealDraft refuses a draft that still has blind rows and does nothing to one already revealed", () => {
  const data = load();
  const state = newState(data);
  const supp = draftOf(data, "supp");
  assert.throws(() => revealDraft(state, supp, T4), /still has blind rows/);
  assert.equal(state.rev, 0);
  labelSupp(data, state);
  assert.equal(revealDraft(state, supp, T4), true);
  const rev = state.rev;
  assert.equal(revealDraft(state, supp, "2026-11-10T11:00:00Z"), false);
  assert.equal(state.rev, rev);
  assert.equal(state.positions[B].revealedAt, T4, "the reveal time is the first one");
});

test("a reveal that is exported without a change still holds the blind labels it came after, and a later change widens the same span", () => {
  const data = load();
  const state = newState(data);
  const supp = labelSupp(data, state);
  revealDraft(state, supp, T4);
  const id = blindRows(cardOf(data, B))[0].id;
  setLabel(state, supp, B, id, "maybe", "2026-11-10T10:30:00Z");
  const p = buildExport(state, data).positions[B];
  assert.deepEqual(p.scored, { started: T4, finished: "2026-11-10T10:30:00Z", labels: { [id]: "maybe" } });
  assert.equal(p.blind.labels[id], "play", "blind keeps the blind value");
});

// ---- blind and scored ----

test("a change after the reveal lands in scored and leaves blind alone; set back to the blind value still exports the final one", () => {
  const data = load();
  const state = newState(data);
  const supp = labelSupp(data, state, "play");
  const id = blindRows(cardOf(data, B))[0].id;
  const blindExport = buildExport(state, data).positions[B].blind;
  revealDraft(state, supp, T4);
  setLabel(state, supp, B, id, "never", "2026-11-10T10:31:00Z");
  let p = buildExport(state, data).positions[B];
  assert.deepEqual(p.blind, blindExport, "blind is byte-for-byte what it was before the reveal");
  assert.equal(p.scored.labels[id], "never");
  setLabel(state, supp, B, id, "play", "2026-11-10T10:32:00Z");
  p = buildExport(state, data).positions[B];
  assert.equal(p.blind.labels[id], "play");
  assert.equal(p.scored.labels[id], "play", "the final value is exported though it equals the blind value");
});

test("a row first labelled after the reveal lands in scored and has no blind value; a later row on the page works the same", () => {
  const data = load();
  const state = newState(data);
  const supp = labelSupp(data, state);
  revealDraft(state, supp, T4);
  const later = laterRows(cardOf(data, A));
  assert.ok(later.length > 0, "the fixture has ranks 6-10 rows");
  setLabel(state, supp, A, later[0].id, "maybe", "2026-11-10T10:40:00Z");
  const p = buildExport(state, data).positions[A];
  assert.equal(p.scored.labels[later[0].id], "maybe");
  assert.equal(p.blind.labels[later[0].id], undefined);
  // and the seeded-revealed draft: a new row there is scored with no blind object at all
  const synth = draftOf(data, "synth-dme-adc");
  const fresh = blindRows(cardOf(data, E)).find((o) => state.positions[E].labels[o.id] === undefined);
  setLabel(state, synth, E, fresh.id, "never", "2026-11-10T10:41:00Z");
  const q = buildExport(state, data).positions[E];
  assert.equal(q.blind, undefined);
  assert.deepEqual(q.scored.labels, { [fresh.id]: "never" });
  assert.equal(q.revealed, true);
});

test("a fixture-revealed draft that this page did not reveal is not exported as revealed, and nothing seeded is re-exported", () => {
  const data = load();
  const state = newState(data);
  assert.equal(draftRevealState(draftOf(data, "synth-dme-adc"), state), "revealed");
  assert.deepEqual(buildExport(state, data).positions, {}, "no change here, no position");
});

test("\"no view\" exports null, an answered pick its ids, and the pick is exported where it was given", () => {
  const data = load();
  const state = newState(data);
  const supp = draftOf(data, "supp");
  setPick(state, supp, A, ["Ziggs", "Syndra"], T0);
  setPick(state, supp, B, null, T0);
  const x = buildExport(state, data);
  assert.deepEqual(x.positions[A].blind.would_pick, ["Ziggs", "Syndra"], "a pair root: two ids");
  assert.equal(Object.hasOwn(x.positions[B].blind, "would_pick"), true);
  assert.equal(x.positions[B].blind.would_pick, null);
  const top = draftOf(data, "top");
  setPick(state, top, D, "Camille", T0);
  assert.equal(buildExport(state, data).positions[D].blind.would_pick, "Camille", "a single root: a plain id string");
});

test("an unanswered pick is absent, not null", () => {
  const data = load();
  const supp = draftOf(data, "supp");
  const state = newState(data);
  setLabel(state, supp, B, blindRows(cardOf(data, B))[0].id, "play", T0);
  assert.equal(Object.hasOwn(buildExport(state, data).positions[B].blind, "would_pick"), false);
});

test("the pick is never exported as a half pair, a duplicate, an unknown id, or the wrong shape for its root", () => {
  const data = load();
  const supp = draftOf(data, "supp");
  const cases = [
    [A, ["Ziggs"], "half pair"],
    [A, "Ziggs", "a string at a pair root"],
    [A, ["Ziggs", "Ziggs"], "duplicate"],
    [A, ["Ziggs", "Nobodyatall"], "unknown id"],
    [B, ["Ashe", "Jinx"], "an array at a single root"],
    [B, "Nobodyatall", "unknown id at a single root"],
  ];
  for (const [id, value, why] of cases) {
    const state = newState(data);
    setPick(state, supp, id, null, T0);
    state.positions[id].pick.blind = value;
    state.positions[id].pick.current = value;
    const { exported, problems } = exportWithProblems(state, data);
    assert.equal(Object.hasOwn(exported.positions[id].blind, "would_pick"), false, why);
    assert.equal(problems.length, 1, why);
    assert.match(problems[0], new RegExp(id));
  }
});

test("a card with no own pick can be given one after the reveal: scored, and then the card counts as done", () => {
  const data = load();
  const state = newState(data);
  const supp = draftOf(data, "supp");
  const card = cardOf(data, B);
  // labels without a pick: a re-read of a card whose sitting never answered stage 1
  for (const o of blindRows(card)) setLabel(state, supp, B, o.id, "play", T0);
  for (const c of supp.cards.filter((c) => c.id !== B)) {
    setPick(state, supp, c.id, null, T1);
    for (const o of blindRows(c)) setLabel(state, supp, c.id, o.id, "maybe", T1);
  }
  assert.equal(draftRevealState(supp, state), "ready");
  assert.equal(cardDone(card, state), false, "no pick yet");
  revealDraft(state, supp, T2);
  assert.equal(setPick(state, supp, B, "Aphelios", T3), true);
  assert.equal(state.positions[B].pick.mode, "scored");
  assert.equal(state.positions[B].pick.blind, undefined);
  assert.equal(cardDone(card, state), true);
  const p = buildExport(state, data).positions[B];
  assert.equal(p.scored.would_pick, "Aphelios");
  assert.equal(Object.hasOwn(p.blind, "would_pick"), false, "it was not given blind");
});

test("a blind pick changed after the reveal keeps the blind pick and adds the scored one", () => {
  const data = load();
  const state = newState(data);
  const supp = draftOf(data, "supp");
  setPick(state, supp, B, "Ashe", T0);
  for (const o of blindRows(cardOf(data, B))) setLabel(state, supp, B, o.id, "play", T1);
  for (const c of supp.cards.filter((c) => c.id !== B)) {
    setPick(state, supp, c.id, null, T1);
    for (const o of blindRows(c)) setLabel(state, supp, c.id, o.id, "play", T1);
  }
  revealDraft(state, supp, T2);
  setPick(state, supp, B, "Jinx", T3);
  const p = buildExport(state, data).positions[B];
  assert.equal(p.blind.would_pick, "Ashe");
  assert.equal(p.scored.would_pick, "Jinx");
});

test("the own-pick pre-set is an ordinary label in the export: no via field anywhere", () => {
  const data = load();
  const state = newState(data);
  const supp = draftOf(data, "supp");
  const row = blindRows(cardOf(data, B))[0];
  setPick(state, supp, B, row.action[0], T0);
  assert.equal(state.positions[B].labels[row.id].via, "own-pick");
  const x = buildExport(state, data);
  assert.equal(x.positions[B].blind.labels[row.id], "play");
  assert.equal(JSON.stringify(x).includes("via"), false);
  assert.equal(JSON.stringify(x).includes("own-pick"), false);
});

test("only the card's own option ids are exported, verbatim from the run and in the run's order", () => {
  const data = load();
  const state = newState(data);
  const supp = draftOf(data, "supp");
  const card = cardOf(data, A);
  setPick(state, supp, A, null, T0);
  for (const o of blindRows(card)) setLabel(state, supp, A, o.id, "maybe", T1);
  const keys = Object.keys(buildExport(state, data).positions[A].blind.labels);
  assert.deepEqual(keys, card.options.filter((o) => o.row === "blind").map((o) => o.id));
  const runIds = Object.keys(RUN.positions.find((p) => p.id === A).options);
  for (const k of keys) assert.ok(runIds.includes(k));
});

// ---- rev ----

test("rev only rises: with every change, never on a no-op", () => {
  const data = load();
  const supp = draftOf(data, "supp");
  const state = newState(data);
  const seen = [state.rev];
  const bump = (did) => {
    seen.push(state.rev);
    return did;
  };
  const id = blindRows(cardOf(data, B))[0].id;
  assert.equal(bump(setLabel(state, supp, B, id, "play", T0)), true);
  assert.equal(bump(setLabel(state, supp, B, id, "play", T1)), false);
  assert.equal(bump(setNote(state, supp, B, "  x ", T1)), true);
  assert.equal(bump(setNote(state, supp, B, "x", T2)), false, "the same note, trimmed");
  assert.equal(bump(setPick(state, supp, B, null, T2)), true);
  assert.equal(bump(setPick(state, supp, B, null, T3)), false);
  assert.deepEqual(seen, [0, 1, 1, 2, 2, 3, 3]);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1]);
  assert.equal(buildExport(state, data).rev, 3);
});

// ---- the line verdict ----

test("the line is a string: turns' ids joined by +, turns by ' > ', in the order the run lists them", () => {
  assert.equal(lineText({ line: [["Zeri", "Alistar"], ["Bard"], ["Aatrox", "Ahri"]] }), "Zeri+Alistar > Bard > Aatrox+Ahri");
  assert.equal(lineText({ line: [["Zyra"]] }), "Zyra");
});

function revealedSupp(mutate) {
  const data = load(mutate);
  const state = newState(data);
  const supp = labelSupp(data, state);
  return { data, state, supp };
}

test("the line verdict is refused before the reveal, then lands in scored on the reference #1 with the line text", () => {
  const { data, state, supp } = revealedSupp((run) => {
    const p = run.positions.find((q) => q.id === A);
    const ref = p.readings.find((r) => r.arm === run.run.reference_arm);
    ref.ranked[0].line = [["Zyra", "Bard"], ["Aatrox"]];
  });
  assert.throws(() => setLineVerdict(state, data, supp, A, false, T3), /only after the reveal/);
  revealDraft(state, supp, T4);
  const top = referenceTop(data, cardOf(data, A));
  assert.equal(top.line, "Zyra+Bard > Aatrox");
  const card = cardOf(data, A);
  const refReading = card.readings.find((r) => r.arm === data.run.arms.findIndex((a) => a.id === data.run.reference_arm));
  assert.equal(top.option.id, card.options[refReading.ranked.find((e) => e[1] === 1)[0]].id, "the reference arm's #1");
  const rev = state.rev;
  assert.equal(setLineVerdict(state, data, supp, A, false, "2026-11-10T10:50:00Z"), true);
  assert.equal(state.rev, rev + 1);
  assert.equal(setLineVerdict(state, data, supp, A, false, "2026-11-10T10:51:00Z"), false, "the same verdict again is a no-op");
  const s = buildExport(state, data).positions[A].scored;
  assert.deepEqual(s.line, { option: top.option.id, line: "Zyra+Bard > Aatrox", ok: false });
  assert.equal(typeof s.line.line, "string");
  assert.equal(s.finished, "2026-11-10T10:50:00Z", "a line verdict is a scored change");
  assert.equal(setLineVerdict(state, data, supp, A, true, "2026-11-10T10:52:00Z"), true);
  assert.equal(buildExport(state, data).positions[A].scored.line.ok, true);
});

test("no line verdict where the line is empty (slot 19)", () => {
  const { data, state, supp } = revealedSupp((run) => {
    for (const id of [B]) {
      const ref = run.positions.find((q) => q.id === id).readings.find((r) => r.arm === run.run.reference_arm);
      for (const e of ref.ranked) {
        e.line = [];
        e.line_steps = [];
        e.line_side = [];
      }
    }
  });
  revealDraft(state, supp, T4);
  assert.equal(referenceTop(data, cardOf(data, B)).line, null);
  assert.throws(() => setLineVerdict(state, data, supp, B, true, T3), /no line to judge/);
  assert.equal(buildExport(state, data).positions[B].scored.line, undefined);
});

test("a line verdict does not survive being exported as anything but option + string line + ok", () => {
  const { data, state, supp } = revealedSupp();
  revealDraft(state, supp, T4);
  setLineVerdict(state, data, supp, B, true, T3);
  const line = buildExport(state, data).positions[B].scored.line;
  assert.deepEqual(Object.keys(line).sort(), ["line", "ok", "option"]);
});

// ---- the note ----

test("a note is exported when there is one, trimmed, and dates the mode it was written in", () => {
  const data = load();
  const supp = draftOf(data, "supp");
  const state = newState(data);
  assert.equal(setNote(state, supp, B, "Galio support is not this team.\n", T1), true);
  let p = buildExport(state, data).positions[B];
  assert.equal(p.note, "Galio support is not this team.");
  assert.deepEqual(p.blind, { started: T1, finished: T1, labels: {} });
  labelSupp(data, state);
  revealDraft(state, supp, T4);
  setNote(state, supp, B, "Changed my mind after the reveal.", T3 > T4 ? T3 : "2026-11-10T10:59:00Z");
  p = buildExport(state, data).positions[B];
  assert.equal(p.note, "Changed my mind after the reveal.");
  assert.equal(p.scored.finished, "2026-11-10T10:59:00Z");
  const quiet = newState(data);
  setLabel(quiet, supp, B, blindRows(cardOf(data, B))[0].id, "play", T1);
  assert.equal(Object.hasOwn(buildExport(quiet, data).positions[B], "note"), false);
});

// ---- the reveal's data ----

test("revealRows: ranked in rank order at the chosen arm, the best in-pool row and every labelled row present, near tie marked", () => {
  const data = load();
  const card = cardOf(data, A);
  const ref = data.run.arms.findIndex((a) => a.id === data.run.reference_arm);
  const { rows } = revealRows(data, card, ref);
  const ranks = rows.filter((r) => r.rank !== null).map((r) => r.rank);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), "rank order");
  assert.equal(rows.length >= card.options.filter((o) => o.row !== null).length, true, "every row of the card is there");
  assert.equal(rows.filter((r) => r.bestInPool).length, 1);
  const top = rows.find((r) => r.rank === 1);
  assert.equal(top.nearTie, true, "the #1 reads as a near tie when #2 is within the margin");
  const margin = data.run.margin;
  for (const r of rows.filter((x) => x.rank !== null)) {
    assert.equal(r.nearTie, Math.abs(top.value - r.value) <= margin + 1e-9, `${r.id} at ${r.value}`);
  }
  assert.equal(rows.every((r) => (r.controls ? r.rowKind !== null : r.rowKind === null)), true, "only a row takes a label");
  for (const r of rows.filter((x) => x.rank !== null && x.rank <= data.run.k)) assert.equal(typeof r.sideText, "string");
  const later = rows.filter((r) => r.rowKind === "later");
  assert.equal(later.length, laterRows(card).length, "the ranks 6-10 rows are offered");
});

test("revealRows at an arm with a partial or failed search says so and shows no row", () => {
  const data = load();
  const card = cardOf(data, B);
  card.readings[0].partial = true;
  assert.equal(revealRows(data, card, card.readings[0].arm).rows.length, 0);
  assert.match(revealRows(data, card, card.readings[0].arm).note, /cut/);
  card.readings[1].error = "boom";
  assert.match(revealRows(data, card, card.readings[1].arm).note, /boom/);
});

test("the own pick's place comes from the whole reference ranking; not ranked reads as not ranked; no view has no place", () => {
  const data = load();
  const card = cardOf(data, A);
  const first = card.reference_ranking[0];
  assert.equal(ownPickPlace(card, [...first[0]].reverse()).rank, first[1], "a pair compares as a set");
  assert.deepEqual(ownPickPlace(card, ["Nobody", "Else"]), { rank: null, value: null });
  assert.equal(ownPickPlace(card, null), null);
});

test("a stored state with a bad time is dropped on restore, so an export never carries one", () => {
  const data = load();
  const supp = draftOf(data, "supp");
  const state = newState(data);
  setLabel(state, supp, B, blindRows(cardOf(data, B))[0].id, "play", T0);
  const stored = JSON.parse(JSON.stringify(state));
  stored.positions[B].span.blind = { first: "yesterday", last: T1 };
  const back = restoreState(data, JSON.stringify(stored));
  assert.equal(back.positions[B].span.blind, undefined);
  const text = JSON.stringify(state);
  assert.deepEqual(restoreState(data, text).positions[B].span, state.positions[B].span, "a good state round-trips, notes and line verdicts included");
  const withExtras = newState(data);
  const { data: d2, state: s2, supp: p2 } = { data, state: withExtras, supp };
  labelSupp(d2, s2);
  revealDraft(s2, p2, T4);
  setNote(s2, p2, B, "kept", "2026-11-10T10:58:00Z");
  setLineVerdict(s2, d2, p2, B, false, "2026-11-10T10:59:00Z");
  const again = restoreState(d2, JSON.stringify(s2));
  assert.deepEqual(again.positions[B].note, s2.positions[B].note);
  assert.deepEqual(again.positions[B].line, s2.positions[B].line);
  assert.deepEqual(buildExport(again, d2), buildExport(s2, d2));
});

test("a #1 with nothing within the margin is not marked as a near tie; with a neighbour both are", () => {
  const lone = load((run) => {
    const p = run.positions.find((q) => q.id === A);
    const ref = p.readings.find((r) => r.arm === run.run.reference_arm);
    ref.ranked.forEach((e, i) => (e.value = 0.5 - i * 0.05));
  });
  const ref = lone.run.arms.findIndex((a) => a.id === lone.run.reference_arm);
  assert.equal(revealRows(lone, cardOf(lone, A), ref).rows.some((r) => r.nearTie), false);
  const pair = load();
  const rows = revealRows(pair, cardOf(pair, A), ref).rows;
  assert.deepEqual(rows.filter((r) => r.nearTie).map((r) => r.rank), [1, 2]);
});

// ---- fix round ----

test("base is the run's own count of fixture entries: 2 on a position echoing two verdicts, and whatever the run says", () => {
  const runBase = RUN.positions.find((p) => p.id === E);
  assert.equal(runBase.base, 2);
  assert.equal(runBase.verdicts.length, 2, "the run position echoes the entries base counts");
  const data = load();
  const synth = draftOf(data, "synth-dme-adc");
  const state = newState(data);
  const fresh = blindRows(cardOf(data, E)).find((o) => state.positions[E].labels[o.id] === undefined);
  setLabel(state, synth, E, fresh.id, "never", T1);
  assert.equal(buildExport(state, data).positions[E].base, runBase.base);
  const other = load((run) => (run.positions.find((p) => p.id === E).base = 5));
  const st2 = newState(other);
  setLabel(st2, draftOf(other, "synth-dme-adc"), E, fresh.id, "never", T1);
  assert.equal(buildExport(st2, other).positions[E].base, 5);
  const supp = draftOf(data, "supp");
  const s3 = newState(data);
  setLabel(s3, supp, B, blindRows(cardOf(data, B))[0].id, "play", T1);
  assert.equal(buildExport(s3, data).positions[B].base, 0);
});

test("a stored state with a damaged span is not silently dropped from the export: the position is refused by name", () => {
  const data = load();
  const supp = draftOf(data, "supp");
  const state = newState(data);
  setLabel(state, supp, B, blindRows(cardOf(data, B))[0].id, "play", T0);
  setLabel(state, supp, A, blindRows(cardOf(data, A))[0].id, "play", T0);
  const stored = JSON.parse(JSON.stringify(state));
  stored.positions[B].span.blind = { first: "yesterday", last: T1 };
  const back = restoreState(data, JSON.stringify(stored));
  const { exported, problems } = exportWithProblems(back, data);
  assert.equal(problems.length, 1);
  assert.match(problems[0], new RegExp(B));
  assert.match(problems[0], /blind/);
  assert.equal(exported.positions[B], undefined, "refused whole, not exported half");
  assert.ok(exported.positions[A], "the other position still exports");
});

test("earlierView lists each earlier entry: mode, finished, label count, own pick, note; plus the old verdicts and the review", () => {
  const data = load();
  const v = earlierView(cardOf(data, E), NAMES);
  assert.equal(v.entries.length, 2);
  const seeded = RUN.positions.find((p) => p.id === E).verdicts;
  seeded.forEach((e, i) => {
    assert.ok(v.entries[i].startsWith(e.mode));
    assert.ok(v.entries[i].includes(e.finished));
    assert.ok(v.entries[i].includes(Object.keys(e.labels).length + " label"));
    if (e.note) assert.ok(v.entries[i].includes(e.note));
    if (Object.hasOwn(e, "would_pick")) assert.ok(v.entries[i].includes("own pick: "));
  });
  assert.match(v.legacy, /^Old report: off-pool verdict (leave|stay in) the pool; role verdict /);
  assert.match(v.review, /^(Review: |No review text)/);
  assert.deepEqual(earlierView(cardOf(data, B), NAMES).entries, []);
});

// ---- branch-review fixes ----

const asRunWrites = (run) => {
  // the runner writes a single-root own pick as a one-element array
  const p = run.positions.find((q) => q.id === E);
  p.would_pick = { blind: ["Ahri"], current: ["Ahri"] };
};

test("I1: a seeded single-root pick (one-element array in the run) is held as its id; a pick changed after the reveal survives a reload and exports as a string", () => {
  const data = load(asRunWrites);
  const synth = draftOf(data, "synth-dme-adc");
  const state = newState(data);
  assert.equal(state.positions[E].pick.blind, "Ahri");
  assert.equal(state.positions[E].pick.current, "Ahri");
  assert.deepEqual(buildExport(state, data).positions, {}, "a seeded pick is not re-exported");
  assert.equal(setPick(state, synth, E, "Ezreal", T1), true);
  const back = restoreState(data, JSON.stringify(state));
  assert.deepEqual(back.positions[E].pick, state.positions[E].pick, "the change is kept on reload");
  assert.equal(back.positions[E].pick.current, "Ezreal");
  const x = buildExport(back, data).positions[E];
  assert.equal(x.scored.would_pick, "Ezreal");
  assert.equal(typeof x.scored.would_pick, "string");
});

test("I1: a state stored by an earlier page with a one-element array is read as the id, and a one-element array never exports", () => {
  const data = load();
  const stored = newState(data);
  stored.positions[E].pick = { blind: ["Ahri"], current: ["Ezreal"], mode: "scored", t: T1 };
  stored.positions[E].span.scored = { first: T1, last: T1 };
  const back = restoreState(data, JSON.stringify(stored));
  assert.equal(back.positions[E].pick.current, "Ezreal");
  const direct = newState(data);
  direct.positions[E].pick = { blind: "Ahri", current: ["Ezreal"], mode: "scored", t: T1 };
  direct.positions[E].span.scored = { first: T1, last: T1 };
  const { exported, problems } = exportWithProblems(direct, data);
  assert.deepEqual(problems, []);
  assert.equal(exported.positions[E].scored.would_pick, "Ezreal");
});

test("M1: a revealed card with ranks 6-10 rows still to label is not settled, so the unfinished filter keeps it; labelling them settles it", () => {
  const data = load();
  const state = newState(data);
  const supp = labelSupp(data, state);
  const cardA = cardOf(data, A);
  assert.equal(cardSettled(supp, cardA, state), true, "before the reveal, done is settled");
  revealDraft(state, supp, T4);
  assert.ok(laterRows(cardA).length > 0);
  assert.equal(cardSettled(supp, cardA, state), false);
  for (const o of laterRows(cardA)) setLabel(state, supp, A, o.id, "maybe", T4);
  assert.equal(cardSettled(supp, cardA, state), true);
});

test("M3: a depth check that could not run is not read as changed", () => {
  const data = load();
  const card = structuredClone(cardOf(data, A));
  card.depth_check = { horizon: 3, stable: null, same_first: null, same_top_3: null, top_3: [] };
  assert.match(depthNote(card, NAMES), /could not be made/);
  assert.doesNotMatch(depthNote(card, NAMES), /changed/);
  card.depth_check = null;
  assert.match(depthNote(card, NAMES), /could not be made/);
  card.depth_check = { horizon: 3, stable: true, same_first: true, same_top_3: true, top_3: [] };
  assert.equal(depthNote(card, NAMES), null);
  card.depth_check = { horizon: 3, stable: false, same_first: false, same_top_3: true, top_3: [["Ahri"]] };
  assert.match(depthNote(card, NAMES), /#1 changed and the top 3 held/);
});

test("M5: an earlier line verdict and note are the current ones on a re-read, and are not exported unless changed", () => {
  const base = load();
  const top = referenceTop(base, cardOf(base, E));
  assert.ok(top.line, "E has a line to judge");
  const data = load((run) => {
    const p = run.positions.find((q) => q.id === E);
    const last = p.verdicts[p.verdicts.length - 1];
    last.line = { option: top.option.id, line: top.line, ok: false };
    last.note = "an earlier note";
  });
  const synth = draftOf(data, "synth-dme-adc");
  const card = cardOf(data, E);
  const state = newState(data);
  assert.equal(currentLineVerdict(card, state.positions[E], top), false);
  assert.equal(currentNote(card, state.positions[E]), "an earlier note");
  assert.equal(setLineVerdict(state, data, synth, E, false, T1), false, "the same verdict again is a no-op");
  assert.equal(setNote(state, synth, E, " an earlier note ", T1), false, "the same note again is a no-op");
  assert.equal(state.rev, 0);
  assert.deepEqual(buildExport(state, data).positions, {});
  assert.equal(setLineVerdict(state, data, synth, E, true, T2), true);
  assert.equal(currentLineVerdict(card, state.positions[E], top), true);
  assert.equal(buildExport(state, data).positions[E].scored.line.ok, true);
  assert.equal(setNote(state, synth, E, "a new note", T3), true);
  assert.equal(buildExport(state, data).positions[E].note, "a new note");
});
