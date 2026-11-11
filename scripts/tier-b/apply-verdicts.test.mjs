import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { applyExport, applyPosition, draftOf, foldVerdicts, loadChampionIds, rootOf, samePick, spliceProblem, spliceVerdicts, validateVerdicts } from "./apply-verdicts.mjs";
import { callerPath, dirBytes, reviewPaths, runIdFor } from "./review.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const DATA = path.join(REPO, "packages/engine-core/tests/data/tier-b-review");
// Frozen copies of four real fixtures as they stood before any sitting (git 416b1fc). The live corpus gains
// `verdicts` with every sitting, and these tests need positions that hold none: a test export's `base: 0`
// against a labelled fixture reads as stale.
const UNLABELLED = path.join(DATA, "unlabelled");
const read = (name) => JSON.parse(fs.readFileSync(path.join(DATA, name), "utf8"));
const FOLD_VECTORS = read("fold-vectors.json");
const REFUSAL_VECTORS = read("refusal-vectors.json");
const POSITION = read("labelled-position.json");
const CHAMPIONS = loadChampionIds(REPO);

const GALIO = "Galio+MonkeyKing|top=Rumble,jungle=MonkeyKing,mid=Galio";
const SYNDRA = "MonkeyKing+Syndra|top=Rumble,jungle=MonkeyKing,mid=Syndra";
const AHRI = "Ahri+LeeSin|top=Rumble,jungle=LeeSin,mid=Ahri";
const RUN = "2026-11-09T15:00:00Z";
const STAMPS = { fm_version: "fm-export-stamp", positions_patch: "16.99" };
const span = (a, b) => ({ started: `2026-11-09T15:${a}:00Z`, finished: `2026-11-09T15:${b}:00Z` });

// The labelled position with its two sample entries taken off: a position nobody has judged.
function blank() {
  const fixture = structuredClone(POSITION);
  delete fixture.verdicts;
  return fixture;
}
const ctx = (rev, extra = {}) => ({ run: RUN, rev, data: STAMPS, draftScored: false, champions: CHAMPIONS, ...extra });

// ---- the shared vectors -------------------------------------------------------------------------

test("every fold vector folds as stated, lines included", () => {
  for (const v of FOLD_VECTORS) {
    const fold = foldVerdicts(v.entries);
    assert.deepEqual(fold.blind, v.blind, `${v.name}: blind`);
    assert.deepEqual(fold.current, v.current, `${v.name}: current`);
    for (const [key, got] of [["blind_pick", fold.blindPick], ["current_pick", fold.currentPick]]) {
      if (Object.prototype.hasOwnProperty.call(v, key)) {
        assert.notEqual(got, undefined, `${v.name}: ${key} was answered`);
        assert.ok(samePick(got, v[key]), `${v.name}: ${key} ${JSON.stringify(got)} vs ${JSON.stringify(v[key])}`);
      } else {
        assert.equal(got, undefined, `${v.name}: ${key} was never answered`);
      }
    }
    if (Object.prototype.hasOwnProperty.call(v, "lines")) assert.deepEqual(fold.lines, v.lines, `${v.name}: lines`);
    assert.equal(fold.revealed, v.revealed, `${v.name}: revealed`);
  }
});

test("the fold vectors' entries are all entries the validator accepts", () => {
  for (const v of FOLD_VECTORS) {
    assert.deepEqual(validateVerdicts(POSITION, v.entries, CHAMPIONS), [], v.name);
  }
});

test("the position's own sample entries are accepted", () => {
  assert.deepEqual(validateVerdicts(POSITION, POSITION.verdicts, CHAMPIONS), []);
});

test("every refusal vector is refused naming the vector's field", () => {
  for (const v of REFUSAL_VECTORS) {
    const errors = validateVerdicts(POSITION, v.entries, CHAMPIONS);
    assert.equal(errors.length, 1, `${v.name}: refused`);
    assert.equal(errors[0].field, v.field, `${v.name}: ${errors[0].reason}`);
  }
});

// The refusal vectors an export can produce: apply must refuse to write each one, and leave the fixture alone.
function exportWith(change) {
  const pos = { base: 0, blind: { ...span("01", "02"), labels: { [GALIO]: "play" } } };
  const context = ctx(1);
  change(pos, context);
  return { pos, context };
}
const INDUCED = {
  "a half pair would_pick at the pair root": (p) => { p.blind.would_pick = "Galio"; },
  "the same champion twice in would_pick": (p) => { p.blind.would_pick = ["Galio", "Galio"]; },
  "an unknown champion in would_pick": (p) => { p.blind.would_pick = ["Galio", "Nobody"]; },
  "a comp missing the locked pick": (p) => { p.blind.labels = { "Galio+MonkeyKing|jungle=MonkeyKing,mid=Galio": "play" }; },
  "an action champion that is already a locked pick": (p) => { p.blind.labels = { "Galio+Rumble|top=Rumble,mid=Galio": "play" }; },
  "an unsorted pair in a label": (p) => { p.blind.labels = { "MonkeyKing+Galio|top=Rumble,jungle=MonkeyKing,mid=Galio": "play" }; },
  "an unknown label": (p) => { p.blind.labels = { [GALIO]: "good" }; },
  "a line verdict in a blind entry": (p) => { p.blind.line = { option: GALIO, line: "Zyra", ok: true }; },
  "positions_patch null": (p, c) => { c.data = { fm_version: "fm", positions_patch: null }; },
  "a timestamp that is not UTC": (p) => { p.blind.started = "2026-11-09T14:00:00+01:00"; },
  "line.line given as an array": (p) => {
    p.revealed = true;
    p.scored = { ...span("03", "04"), labels: {}, line: { option: GALIO, line: ["Zyra"], ok: true } };
  },
};

test("apply refuses to write each refusal vector an export can produce, and leaves the fixture as it was", () => {
  const fixture = blank();
  for (const v of REFUSAL_VECTORS) {
    const change = INDUCED[v.name];
    if (!change) continue;
    const { pos, context } = exportWith(change);
    const result = applyPosition(fixture, pos, context);
    assert.equal(result.outcome.kind, "refused", v.name);
    assert.equal(result.fixture, fixture, `${v.name}: the fixture is returned untouched`);
  }
  // The vectors no export can produce (an entry order, a missing key) are covered by the validator test above.
  const covered = new Set(Object.keys(INDUCED));
  const rest = REFUSAL_VECTORS.filter((v) => !covered.has(v.name)).map((v) => v.name).sort();
  assert.deepEqual(rest, ["a blind entry after a scored one", "an undated empty reveal: no started or finished"]);
});

// ---- the three branches ---------------------------------------------------------------------------

test("a first apply writes a blind entry stamped with the run, rev and the export's data stamps", () => {
  const fixture = blank();
  const pos = { base: 0, blind: { ...span("01", "05"), would_pick: ["MonkeyKing", "Galio"], labels: { [SYNDRA]: "never", [GALIO]: "play" } } };
  const { fixture: next, outcome } = applyPosition(fixture, pos, ctx(4));
  assert.equal(outcome.kind, "applied");
  assert.equal(next.verdicts.length, 1);
  assert.deepEqual(next.verdicts[0], {
    started: "2026-11-09T15:01:00Z",
    finished: "2026-11-09T15:05:00Z",
    mode: "blind",
    from: { run: RUN, rev: 4 },
    fm_version: "fm-export-stamp",
    positions_patch: "16.99",
    would_pick: ["MonkeyKing", "Galio"],
    labels: { [GALIO]: "play", [SYNDRA]: "never" },
  });
  assert.notEqual(next.verdicts[0].fm_version, fixture.source.fm_version, "from the export, not the file");
  assert.equal(fixture.verdicts, undefined, "the input is not mutated");
});

test("replay: the same rev again writes nothing; an older rev writes nothing and says so", () => {
  const pos = { base: 0, blind: { ...span("01", "05"), labels: { [GALIO]: "play" } } };
  const once = applyPosition(blank(), pos, ctx(5)).fixture;
  const again = applyPosition(once, pos, ctx(5));
  assert.equal(again.outcome.kind, "replay");
  assert.equal(again.fixture, once);
  const older = applyPosition(once, { base: 0, blind: { ...span("01", "03"), labels: { [GALIO]: "never" } } }, ctx(3));
  assert.equal(older.outcome.kind, "older");
  assert.match(older.outcome.message, /older/);
  assert.equal(older.fixture, once);
});

test("a rev above what the run wrote is read on: a replay needs rev at or above the export's", () => {
  const once = applyPosition(blank(), { base: 0, blind: { ...span("01", "05"), labels: { [GALIO]: "play" } } }, ctx(5)).fixture;
  const next = applyPosition(once, { base: 0, blind: { ...span("01", "09"), labels: { [GALIO]: "play", [SYNDRA]: "never" } } }, ctx(6));
  assert.equal(next.outcome.kind, "applied");
  assert.deepEqual(next.fixture.verdicts[1].labels, { [SYNDRA]: "never" });
});

test("stale: entries beyond the base from another run refuse the position and leave it as it was", () => {
  const foreign = {
    started: "2026-11-10T09:00:00Z", finished: "2026-11-10T09:05:00Z", mode: "blind",
    from: { run: "2026-11-10T08:00:00Z", rev: 40 }, fm_version: "fm", positions_patch: "16.19", labels: { [GALIO]: "never" },
  };
  const fixture = { ...blank(), verdicts: [foreign] };
  const result = applyPosition(fixture, { base: 0, blind: { ...span("01", "05"), labels: { [GALIO]: "play" } } }, ctx(7));
  assert.equal(result.outcome.kind, "stale");
  assert.match(result.outcome.message, /2026-11-10T08:00:00Z/);
  assert.equal(result.fixture, fixture);
  // The same entry inside the page's base is history the page saw, not news.
  const seen = applyPosition(fixture, { base: 1, blind: { ...span("01", "05"), labels: { [GALIO]: "play" } } }, ctx(7));
  assert.equal(seen.outcome.kind, "applied");
  assert.equal(seen.fixture.verdicts.length, 2);
  // A fixture shorter than the page's base is another corpus.
  assert.equal(applyPosition(blank(), { base: 2, blind: { ...span("01", "05"), labels: {} } }, ctx(7)).outcome.kind, "stale");
});

test("blind play, scored maybe, scored play writes the last play", () => {
  const blind = { ...span("01", "05"), labels: { [GALIO]: "play" } };
  let fixture = applyPosition(blank(), { base: 0, blind }, ctx(1)).fixture;
  fixture = applyPosition(fixture, { base: 0, blind, revealed: true, scored: { ...span("06", "07"), labels: { [GALIO]: "maybe" } } }, ctx(2)).fixture;
  assert.deepEqual(fixture.verdicts.map((e) => e.mode), ["blind", "scored"]);
  const last = applyPosition(fixture, { base: 0, blind, revealed: true, scored: { ...span("06", "09"), labels: { [GALIO]: "play" } } }, ctx(3));
  assert.equal(last.outcome.kind, "applied");
  assert.deepEqual(last.fixture.verdicts.map((e) => [e.mode, e.labels]), [["blind", { [GALIO]: "play" }], ["scored", { [GALIO]: "maybe" }], ["scored", { [GALIO]: "play" }]]);
  const fold = foldVerdicts(last.fixture.verdicts);
  assert.equal(fold.blind[GALIO], "play");
  assert.equal(fold.current[GALIO], "play");
  assert.deepEqual(validateVerdicts(last.fixture, last.fixture.verdicts, CHAMPIONS), []);
});

test("a partial export then a fuller one writes only the difference", () => {
  let fixture = applyPosition(blank(), { base: 0, blind: { ...span("01", "02"), labels: { [SYNDRA]: "never" } } }, ctx(1)).fixture;
  const fuller = applyPosition(fixture, { base: 0, blind: { ...span("01", "04"), would_pick: ["Galio", "MonkeyKing"], labels: { [SYNDRA]: "never", [GALIO]: "play", [AHRI]: "maybe" } } }, ctx(2));
  assert.equal(fuller.outcome.kind, "applied");
  assert.equal(fuller.fixture.verdicts.length, 2);
  assert.deepEqual(fuller.fixture.verdicts[1].labels, { [AHRI]: "maybe", [GALIO]: "play" });
  assert.deepEqual(fuller.fixture.verdicts[1].would_pick, ["Galio", "MonkeyKing"]);
  fixture = fuller.fixture;
  const nothing = applyPosition(fixture, { base: 0, blind: { ...span("01", "05"), would_pick: ["MonkeyKing", "Galio"], labels: { [SYNDRA]: "never", [GALIO]: "play", [AHRI]: "maybe" } } }, ctx(3));
  assert.equal(nothing.outcome.kind, "applied");
  assert.equal(nothing.fixture.verdicts.length, 2, "an own pick in the other order is the same pick");
  assert.deepEqual(nothing.outcome.entries, []);
});

test("a reveal with no change writes one empty scored entry, and a second apply writes none", () => {
  const blind = { ...span("01", "05"), labels: { [GALIO]: "play" } };
  const revealed = { base: 0, blind, revealed: true, scored: { ...span("06", "06"), labels: {} } };
  const first = applyPosition(blank(), revealed, ctx(2));
  assert.deepEqual(first.fixture.verdicts.map((e) => [e.mode, e.labels]), [["blind", { [GALIO]: "play" }], ["scored", {}]]);
  assert.deepEqual(first.fixture.verdicts[1].started, "2026-11-09T15:06:00Z");
  assert.deepEqual(validateVerdicts(first.fixture, first.fixture.verdicts, CHAMPIONS), []);
  const second = applyPosition(first.fixture, { ...revealed, scored: { ...span("06", "30"), labels: {} } }, ctx(9));
  assert.equal(second.fixture.verdicts.length, 2, "the fixture holds a scored entry already");
  // A scored change that nets to nothing against the current fold adds none either.
  const netted = applyPosition(first.fixture, { ...revealed, scored: { ...span("06", "30"), labels: { [GALIO]: "play" } } }, ctx(10));
  assert.equal(netted.fixture.verdicts.length, 2);
});

test("an export without a scored block means no reveal yet: no scored entry is ever written for it", () => {
  const blind = { ...span("01", "05"), labels: { [GALIO]: "play" } };
  const first = applyPosition(blank(), { base: 0, blind, revealed: false }, ctx(1));
  const again = applyPosition(first.fixture, { base: 0, blind: { ...blind, ...span("01", "09") }, revealed: false }, ctx(2));
  assert.deepEqual(again.fixture.verdicts.map((e) => e.mode), ["blind"]);
});

test("other fields and their order are untouched; verdicts sits immediately before review", () => {
  const fixture = blank();
  const before = Object.keys(fixture);
  assert.equal(before.at(-1), "review");
  const { fixture: next } = applyPosition(fixture, { base: 0, blind: { ...span("01", "05"), labels: { [GALIO]: "play" } } }, ctx(1));
  assert.deepEqual(Object.keys(next), [...before.slice(0, -1), "verdicts", "review"]);
  for (const key of before) assert.equal(next[key], fixture[key], `${key} is the same value`);
  // With verdicts already there, it keeps its place.
  const again = applyPosition(next, { base: 0, blind: { ...span("01", "09"), labels: { [GALIO]: "play", [SYNDRA]: "never" } } }, ctx(2));
  assert.deepEqual(Object.keys(again.fixture), Object.keys(next));
  // And without a review key it goes last.
  const noReview = blank();
  delete noReview.review;
  assert.equal(Object.keys(applyPosition(noReview, { base: 0, blind: { ...span("01", "05"), labels: { [GALIO]: "play" } } }, ctx(1)).fixture).at(-1), "verdicts");
});

test("the entry's keys come in the fixture's order", () => {
  const entry = applyPosition(blank(), {
    base: 0, blind: { ...span("01", "05"), would_pick: null, labels: { [GALIO]: "play" } }, note: "n",
  }, ctx(1)).fixture.verdicts[0];
  assert.deepEqual(Object.keys(entry), ["started", "finished", "mode", "from", "fm_version", "positions_patch", "would_pick", "labels", "note"]);
});

// ---- own picks -----------------------------------------------------------------------------------

test("own picks compare as sets; null (no view) differs from absent and from a pick", () => {
  const withPick = (value) => ({ ...blank(), verdicts: value === undefined ? [] : [{ ...stamp("blind", 1), would_pick: value }] });
  const run = (fixture, pick) => applyPosition(fixture, { base: fixture.verdicts.length, blind: { ...span("01", "05"), labels: {}, ...(pick === undefined ? {} : { would_pick: pick }) } }, ctx(9, {})).fixture.verdicts.length - fixture.verdicts.length;
  assert.equal(run(withPick(["Galio", "MonkeyKing"]), ["MonkeyKing", "Galio"]), 0, "the same set");
  assert.equal(run(withPick(["Galio", "MonkeyKing"]), ["Galio", "Ahri"]), 1, "another pair");
  assert.equal(run(withPick(["Galio", "MonkeyKing"]), null), 1, "null after a pick is a change");
  assert.equal(run(withPick(null), null), 0, "null after null");
  assert.equal(run(withPick(null), ["Galio", "MonkeyKing"]), 1, "a pick after null");
  assert.equal(run(withPick(undefined), null), 1, "null when nothing was answered is an answer");
  assert.equal(run(withPick(["Galio", "MonkeyKing"]), undefined), 0, "absent leaves it");
});

function stamp(mode, rev, run = "2026-11-08T10:00:00Z") {
  return { started: "2026-11-08T10:00:00Z", finished: "2026-11-08T10:01:00Z", mode, from: { run, rev }, fm_version: "fm", positions_patch: "16.19" };
}

// ---- blind means blind, per draft ---------------------------------------------------------------

test("a blind entry is refused when the draft already holds a scored entry; a blind export that adds nothing is not", () => {
  const fixture = blank();
  const withBlind = { base: 0, blind: { ...span("01", "05"), labels: { [GALIO]: "play" } } };
  const refused = applyPosition(fixture, withBlind, ctx(1, { draftScored: true }));
  assert.equal(refused.outcome.kind, "refused");
  assert.match(refused.outcome.message, /already holds a scored entry/);
  assert.equal(refused.fixture, fixture);
  const known = { ...blank(), verdicts: [{ ...stamp("blind", 1), labels: { [GALIO]: "play" } }] };
  const quiet = applyPosition(known, { base: 1, blind: { ...span("01", "05"), labels: { [GALIO]: "play" } } }, ctx(1, { draftScored: true }));
  assert.equal(quiet.outcome.kind, "applied");
  assert.equal(quiet.fixture.verdicts.length, 1);
  // A scored block is fine on a revealed draft.
  const scored = applyPosition(known, { base: 1, blind: { ...span("01", "05"), labels: { [GALIO]: "play" } }, revealed: true, scored: { ...span("06", "07"), labels: { [SYNDRA]: "never" } } }, ctx(2, { draftScored: true }));
  assert.equal(scored.outcome.kind, "applied");
  assert.deepEqual(scored.fixture.verdicts.map((e) => e.mode), ["blind", "scored"]);
});

test("a line verdict goes in a scored entry only; a blind block that carries one is a malformed export", () => {
  const blind = { ...span("01", "05"), labels: { [GALIO]: "play" } };
  const line = { option: GALIO, line: "Zyra", ok: false };
  const base = applyPosition(blank(), { base: 0, blind, revealed: true, scored: { ...span("06", "07"), labels: {}, line } }, ctx(1));
  assert.deepEqual(base.fixture.verdicts.map((e) => [e.mode, e.line]), [["blind", undefined], ["scored", line]]);
  assert.ok(!Object.prototype.hasOwnProperty.call(base.fixture.verdicts[0], "line"));
  const same = { base: 0, blind, revealed: true, scored: { ...span("06", "08"), labels: {}, line } };
  assert.equal(applyPosition(base.fixture, same, ctx(2)).fixture.verdicts.length, 2, "the same verdict again");
  const flipped = applyPosition(base.fixture, { ...same, scored: { ...same.scored, line: { ...line, ok: true } } }, ctx(3));
  assert.deepEqual(flipped.fixture.verdicts[2].line, { ...line, ok: true });
  const other = applyPosition(base.fixture, { ...same, scored: { ...same.scored, line: { ...line, line: "Lux" } } }, ctx(3));
  assert.equal(other.fixture.verdicts.length, 3, "another line text is another pair");
  const bad = applyPosition(blank(), { base: 0, blind: { ...blind, line } }, ctx(1));
  assert.equal(bad.outcome.kind, "refused");
});

// ---- notes -----------------------------------------------------------------------------------------

test("a note is written when it differs from the fixture's last note, on the entry written", () => {
  const blind = { ...span("01", "05"), labels: { [GALIO]: "play" } };
  const withNote = applyPosition(blank(), { base: 0, blind, note: "first thought" }, ctx(1));
  assert.equal(withNote.fixture.verdicts.length, 1);
  assert.equal(withNote.fixture.verdicts[0].note, "first thought");
  const both = applyPosition(blank(), { base: 0, blind, revealed: true, scored: { ...span("06", "07"), labels: { [SYNDRA]: "never" } }, note: "late" }, ctx(1));
  assert.deepEqual(both.fixture.verdicts.map((e) => e.note), [undefined, "late"], "the last entry written");
  // The same note again is not written; a changed one is.
  const same = applyPosition(withNote.fixture, { base: 0, blind: { ...blind, ...span("01", "09") }, note: "first thought" }, ctx(2));
  assert.equal(same.fixture.verdicts.length, 1);
  const changed = applyPosition(withNote.fixture, { base: 0, blind: { ...blind, ...span("01", "09") }, note: "second thought" }, ctx(2));
  assert.equal(changed.fixture.verdicts.length, 2);
  assert.deepEqual(changed.fixture.verdicts[1].labels, {});
  assert.equal(changed.fixture.verdicts[1].mode, "blind");
  assert.equal(changed.fixture.verdicts[1].finished, "2026-11-09T15:09:00Z", "dated by the blind span");
  // The file order decides "last": a fixture note of its own is the one compared with.
  const sample = { ...blank(), verdicts: POSITION.verdicts.map((e) => ({ ...e, from: { run: RUN, rev: 0 } })) };
  const sampleNote = POSITION.verdicts[0].note;
  assert.equal(applyPosition(sample, { base: 2, blind: { ...span("01", "05"), labels: {} }, note: sampleNote }, ctx(3)).fixture.verdicts.length, 2);
});

test("a note alone is a scored entry once the position is revealed, a blind one before", () => {
  const blind = { ...span("01", "05"), labels: { [GALIO]: "play" } };
  const revealedFixture = applyPosition(blank(), { base: 0, blind, revealed: true, scored: { ...span("06", "06"), labels: {} } }, ctx(1)).fixture;
  const note = applyPosition(revealedFixture, { base: 0, blind, revealed: true, scored: { ...span("06", "20"), labels: {} }, note: "after" }, ctx(2));
  assert.equal(note.fixture.verdicts.at(-1).mode, "scored");
  assert.equal(note.fixture.verdicts.at(-1).finished, "2026-11-09T15:20:00Z");
  // A note on a draft that is revealed elsewhere cannot be a blind entry.
  const refused = applyPosition(blank(), { base: 0, blind, note: "x" }, ctx(1, { draftScored: true }));
  assert.equal(refused.outcome.kind, "refused");
});

test("the reveal record carries the note when there is one", () => {
  const blind = { ...span("01", "05"), labels: { [GALIO]: "play" } };
  const r = applyPosition(blank(), { base: 0, blind, revealed: true, scored: { ...span("06", "06"), labels: {} }, note: "n" }, ctx(1));
  assert.deepEqual(r.fixture.verdicts.map((e) => e.note), [undefined, "n"]);
});

// ---- malformed exports ------------------------------------------------------------------------------

test("a malformed position export is refused by name", () => {
  const fixture = blank();
  for (const pos of [{ base: -1 }, { base: 0, revealed: true }, { base: 0, scored: { ...span("01", "02"), labels: {} } }, { base: 0, blind: { labels: {} } }, { base: 0, blind: { ...span("01", "02"), labels: {}, extra: 1 } }, "x"]) {
    const r = applyPosition(fixture, pos, ctx(1));
    assert.equal(r.outcome.kind, "refused", JSON.stringify(pos));
    assert.equal(r.fixture, fixture);
  }
});

// ---- the files --------------------------------------------------------------------------------------

// Every temp directory is removed when the file finishes, a failing test included.
const CLEANUP = [];
after(() => {
  for (const dir of CLEANUP) fs.rmSync(dir, { recursive: true, force: true });
});
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tier-b-apply-"));
  CLEANUP.push(dir);
  return dir;
}
function tempCorpus(names) {
  const dir = scratch();
  for (const n of names) fs.copyFileSync(path.join(UNLABELLED, n), path.join(dir, n));
  return dir;
}
const text = (dir, n) => fs.readFileSync(path.join(dir, n), "utf8");
const ID = (n) => n.replace(/\.json$/, "");

// A legal option for this fixture's root: an action alone (no comp), not a locked pick.
function optionFor(fixtureText) {
  const fixture = JSON.parse(fixtureText);
  const root = rootOf(fixture);
  const free = ["Annie", "Ashe", "Brand", "Cassiopeia"].filter((c) => !root.moverPicks.includes(c) && !fixture.position.some((e) => e.champion === c));
  return { root, option: root.kind === "pair" ? `${free[0]}+${free[1]}` : free[0], other: root.kind === "pair" ? `${free[0]}+${free[2]}` : free[1] };
}

const SUPP_A = "2026-09-29-supp-pinch-slot-17-dme.json";
const SUPP_B = "2026-10-04-supp-pinch-slot-17-dme.json";
const AD16 = "2026-09-29-ad-pinch-slot-16-kittens.json";
const TOP7 = "2026-10-04-top-pinch-slot-7-kittens.json";

function exportOf(rev, positions, run = RUN) {
  return { schema: "tier-b-verdicts/1", run, rev, data: STAMPS, positions };
}

test("applyExport edits the file as text: only the new verdicts block differs, on a file JSON.stringify would reformat", () => {
  const dir = tempCorpus([AD16, SUPP_A]);
  const before = text(dir, AD16);
  const { option } = optionFor(before);
  assert.notEqual(JSON.stringify(JSON.parse(before), null, 2) + "\n", before, "this fixture is not in JSON.stringify's layout");
  const out = applyExport(exportOf(3, { [ID(AD16)]: { base: 0, blind: { ...span("01", "05"), labels: { [option]: "maybe" } } } }), dir);
  assert.equal(out.results[0].outcome.kind, "applied");
  const after = text(dir, AD16);
  const entry = out.results[0].outcome.entries[0];
  const block = `  "verdicts": [\n    ${JSON.stringify(entry, null, 2).split("\n").join("\n    ")}\n  ],\n`;
  assert.equal(after.replace(block, ""), before, "removing the block gives back the original bytes");
  assert.equal(after.indexOf(block) + block.length, after.indexOf('  "review"'));
  assert.equal(text(dir, SUPP_A), fs.readFileSync(path.join(UNLABELLED, SUPP_A), "utf8"), "the other file is untouched");
});

test("applyExport appends: a later apply keeps every earlier byte", () => {
  const dir = tempCorpus([TOP7]);
  const { option, other } = optionFor(text(dir, TOP7));
  applyExport(exportOf(1, { [ID(TOP7)]: { base: 0, blind: { ...span("01", "02"), labels: { [option]: "play" } } } }), dir);
  const first = text(dir, TOP7);
  const out = applyExport(exportOf(2, { [ID(TOP7)]: { base: 0, blind: { ...span("01", "04"), labels: { [option]: "play", [other]: "never" } } } }), dir);
  assert.equal(out.results[0].outcome.kind, "applied");
  const second = text(dir, TOP7);
  assert.ok(second.startsWith(first.slice(0, first.indexOf("\n  ],\n"))), "the first entry's bytes are kept as they were");
  assert.equal(JSON.parse(second).verdicts.length, 2);
  // A replay writes nothing: the bytes do not move.
  applyExport(exportOf(2, { [ID(TOP7)]: { base: 0, blind: { ...span("01", "04"), labels: { [option]: "play", [other]: "never" } } } }), dir);
  assert.equal(text(dir, TOP7), second);
});

test("a refused position is left byte-identical while the rest of the export applies", () => {
  const dir = tempCorpus([AD16, TOP7]);
  const ad = optionFor(text(dir, AD16));
  const top = text(dir, TOP7);
  const out = applyExport(exportOf(1, {
    [ID(AD16)]: { base: 0, blind: { ...span("01", "02"), labels: { [ad.option]: "play" } } },
    [ID(TOP7)]: { base: 0, blind: { ...span("01", "02"), labels: { "Annie+Nobody": "play" } } },
    "2026-01-01-no-such-position": { base: 0, blind: { ...span("01", "02"), labels: {} } },
  }), dir);
  const kinds = Object.fromEntries(out.results.map((r) => [r.id, r.outcome.kind]));
  assert.deepEqual(kinds, { [ID(AD16)]: "applied", [ID(TOP7)]: "refused", "2026-01-01-no-such-position": "refused" });
  assert.equal(text(dir, TOP7), top);
  assert.deepEqual(out.written.map((f) => path.basename(f)), [AD16]);
  assert.equal(JSON.parse(text(dir, AD16)).verdicts.length, 1);
});

test("blind means blind per draft: a scored entry on one card refuses a blind entry on another card of the draft", () => {
  const dir = tempCorpus([SUPP_A, SUPP_B, AD16]);
  const a = optionFor(text(dir, SUPP_A));
  const b = optionFor(text(dir, SUPP_B));
  const ad = optionFor(text(dir, AD16));
  // Sitting 1 reveals the supp draft on card A only (card B's blind labels are not applied yet).
  applyExport(exportOf(5, {
    [ID(SUPP_A)]: { base: 0, blind: { ...span("01", "05"), labels: { [a.option]: "play" } }, revealed: true, scored: { ...span("06", "07"), labels: { [a.option]: "never" } } },
  }), dir);
  const supp = text(dir, SUPP_B);
  // An export from an older page that still has blind rows for card B: refused, the file is as it was.
  const out = applyExport(exportOf(2, {
    [ID(SUPP_B)]: { base: 0, blind: { ...span("01", "05"), labels: { [b.option]: "play" } } },
    [ID(AD16)]: { base: 0, blind: { ...span("01", "05"), labels: { [ad.option]: "play" } } },
  }, "2026-11-09T12:00:00Z"), dir);
  const kinds = Object.fromEntries(out.results.map((r) => [r.id, r.outcome.kind]));
  assert.deepEqual(kinds, { [ID(SUPP_B)]: "refused", [ID(AD16)]: "applied" });
  assert.equal(text(dir, SUPP_B), supp);
});

test("one export may reveal a draft on one card and carry the blind labels of the others", () => {
  const dir = tempCorpus([SUPP_A, SUPP_B]);
  const a = optionFor(text(dir, SUPP_A));
  const b = optionFor(text(dir, SUPP_B));
  const out = applyExport(exportOf(8, {
    [ID(SUPP_A)]: { base: 0, blind: { ...span("01", "05"), labels: { [a.option]: "play" } }, revealed: true, scored: { ...span("09", "09"), labels: {} } },
    [ID(SUPP_B)]: { base: 0, blind: { ...span("02", "06"), labels: { [b.option]: "never" } }, revealed: true, scored: { ...span("09", "09"), labels: {} } },
  }), dir);
  assert.deepEqual(out.results.map((r) => r.outcome.kind), ["applied", "applied"]);
  for (const n of [SUPP_A, SUPP_B]) assert.deepEqual(JSON.parse(text(dir, n)).verdicts.map((e) => e.mode), ["blind", "scored"]);
});

test("applyExport rejects an export it cannot read before touching anything", () => {
  const dir = tempCorpus([TOP7]);
  const before = text(dir, TOP7);
  for (const bad of [{ ...exportOf(1, {}), schema: "tier-b-verdicts/2" }, { ...exportOf(1, {}), data: undefined }, { ...exportOf(1, {}), run: "yesterday" }, { ...exportOf(1, {}), rev: 1.5 }]) {
    assert.throws(() => applyExport(bad, dir));
  }
  assert.equal(text(dir, TOP7), before);
});

test("spliceVerdicts fills an empty array, appends, and inserts before review", () => {
  const entry = { ...stamp("blind", 1), labels: {} };
  const empty = '{\n  "id": "x",\n  "verdicts": [],\n  "review": "r"\n}\n';
  assert.deepEqual(JSON.parse(spliceVerdicts(empty, [entry])).verdicts, [entry]);
  const one = spliceVerdicts('{\n  "id": "x",\n  "review": "r"\n}\n', [entry]);
  assert.deepEqual(JSON.parse(one).verdicts, [entry]);
  assert.deepEqual(Object.keys(JSON.parse(one)), ["id", "verdicts", "review"]);
  assert.deepEqual(JSON.parse(spliceVerdicts(one, [entry])).verdicts, [entry, entry]);
  const last = spliceVerdicts('{\n  "id": "x"\n}\n', [entry]);
  assert.deepEqual(Object.keys(JSON.parse(last)), ["id", "verdicts"]);
});

// ---- the command ------------------------------------------------------------------------------------

function cli(args) {
  const done = spawnSync(process.execPath, [path.join(HERE, "apply-verdicts.mjs"), ...args], { encoding: "utf8" });
  return { code: done.status, out: done.stdout, err: done.stderr };
}

test("the command prints what it did per position and exits non-zero when one was refused", () => {
  const dir = tempCorpus([AD16, TOP7]);
  const ad = optionFor(text(dir, AD16));
  const file = path.join(scratch(), "export.json");
  fs.writeFileSync(file, JSON.stringify(exportOf(1, { [ID(AD16)]: { base: 0, blind: { ...span("01", "02"), labels: { [ad.option]: "play" } } } })));
  const ok = cli([file, "--fixtures", dir, "--no-review"]);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, new RegExp(`${ID(AD16)}: wrote blind`));
  const replay = cli([file, "--fixtures", dir, "--no-review"]);
  assert.equal(replay.code, 0);
  assert.match(replay.out, /replay/);
  fs.writeFileSync(file, JSON.stringify(exportOf(2, { [ID(TOP7)]: { base: 0, blind: { ...span("01", "02"), labels: { "Annie+Nobody": "play" } } } })));
  const refused = cli([file, "--fixtures", dir, "--no-review"]);
  assert.equal(refused.code, 1);
  assert.match(refused.out, /refused/);
  fs.writeFileSync(file, JSON.stringify({ schema: "other" }));
  assert.equal(cli([file, "--fixtures", dir, "--no-review"]).code, 2);
  assert.equal(cli([]).code, 2);
});

// ---- the small pieces ---------------------------------------------------------------------------------

test("draft derivation mirrors the runner's", () => {
  assert.equal(draftOf("2026-10-04-supp-pinch-slot-17-dme"), "supp");
  assert.equal(draftOf("2026-09-29-top-pinch-slot-19-kittens"), "top");
  assert.equal(draftOf("2026-10-07-synth-dme-adc-pinch-slot-17"), "synth-dme-adc");
  assert.equal(draftOf("2026-10-07-mystery"), "2026-10-07-mystery");
  assert.equal(draftOf("labelled-position"), "labelled-position");
  assert.equal(draftOf("2026-10-07--pinch-x"), "2026-10-07--pinch-x");
});

test("review names its run directory from the run id it sets", () => {
  assert.equal(runIdFor(new Date("2026-11-09T14:03:22.456Z")), "2026-11-09T14:03:22Z");
  const p = reviewPaths("2026-11-09T14:03:22Z", "/repo");
  assert.equal(p.dir, path.join("/repo", "docs/plans", "2026-11-09-tier-b-review", "2026-11-09T14-03-22Z"));
  assert.equal(p.runJson, path.join(p.dir, "run.json"));
  assert.ok(!p.dir.includes(":"));
});

// ---- rules pinned after review (M1, M2, M4) -----------------------------------------------------------

test("replay is decided before stale: a foreign run's entries beyond the base do not turn a replay into a refusal", () => {
  const r1 = { base: 0, blind: { ...span("01", "05"), labels: { [GALIO]: "play" } } };
  const first = applyPosition(blank(), r1, ctx(5)).fixture;
  const other = "2026-11-09T16:00:00Z";
  const second = applyPosition(first, { base: 1, blind: { ...span("01", "05"), labels: { [SYNDRA]: "never" } } }, { ...ctx(3), run: other });
  assert.equal(second.outcome.kind, "applied");
  const again = applyPosition(second.fixture, r1, ctx(5));
  assert.equal(again.outcome.kind, "replay", "step 1 comes before step 2");
});

test("the scored diff is taken against the fold after the blind entry", () => {
  const blind = { ...span("01", "05"), labels: { [GALIO]: "play" } };
  const r = applyPosition(blank(), { base: 0, blind, revealed: true, scored: { ...span("06", "07"), labels: { [GALIO]: "play" } } }, ctx(1));
  assert.deepEqual(r.fixture.verdicts.map((e) => [e.mode, e.labels]), [["blind", { [GALIO]: "play" }], ["scored", {}]]);
});

test("the last note in the file is the one compared, with two earlier notes there", () => {
  const withNotes = { ...blank(), verdicts: [{ ...stamp("blind", 1), labels: {}, note: "a" }, { ...stamp("blind", 2), labels: {}, note: "b" }] };
  const run = (note) => applyPosition(withNotes, { base: 2, blind: { ...span("01", "05"), labels: {} }, note }, ctx(3)).fixture.verdicts.length;
  assert.equal(run("b"), 2, "the last note again: not written");
  assert.equal(run("a"), 3, "an earlier note is a change");
});

test("a later run on a revealed position writes no new empty reveal entry", () => {
  const revealedBefore = { ...blank(), verdicts: [{ ...stamp("blind", 1), labels: { [GALIO]: "play" } }, { ...stamp("scored", 2), labels: {} }] };
  const later = { base: 2, blind: { ...span("01", "05"), labels: { [GALIO]: "play" } }, revealed: true, scored: { ...span("06", "07"), labels: {} } };
  const r = applyPosition(revealedBefore, later, ctx(1, {}));
  assert.equal(r.fixture.verdicts.length, 2);
  assert.deepEqual(r.outcome.entries, []);
});

test("in the scored block null (no view) is an answer and absent is not", () => {
  const blind = { ...span("01", "05"), labels: {}, would_pick: ["Galio", "MonkeyKing"] };
  const known = { ...blank(), verdicts: [{ ...stamp("blind", 1), would_pick: ["Galio", "MonkeyKing"], labels: {} }] };
  const scoredBlock = (extra) => ({ base: 1, blind, revealed: true, scored: { ...span("06", "07"), labels: {}, ...extra } });
  const withNull = applyPosition(known, scoredBlock({ would_pick: null }), ctx(2));
  const scored = withNull.fixture.verdicts.filter((e) => e.mode === "scored");
  assert.equal(scored.length, 1);
  assert.ok(Object.prototype.hasOwnProperty.call(scored[0], "would_pick") && scored[0].would_pick === null);
  const absent = applyPosition(known, scoredBlock({}), ctx(2));
  assert.ok(!Object.prototype.hasOwnProperty.call(absent.fixture.verdicts.at(-1), "would_pick"));
  // Already "no view" in the current fold: another null changes nothing.
  const noView = { ...known, verdicts: [...known.verdicts, { ...stamp("scored", 2), would_pick: null, labels: {} }] };
  assert.equal(applyPosition(noView, { ...scoredBlock({ would_pick: null }), base: 2 }, ctx(3)).fixture.verdicts.length, 2);
});

function layouts(original) {
  const value = JSON.parse(original);
  return {
    "a hand-written empty array with a space": original.replace(/^ {2}"review":/m, '  "verdicts": [ ],\n  "review":'),
    "four-space indentation": JSON.stringify(value, null, 4) + "\n",
    "tab indentation": JSON.stringify(value, null, "\t") + "\n",
  };
}

test("a fixture laid out so the splice would duplicate the key, or put it elsewhere, is refused and left as it was", () => {
  for (const [name, edited] of Object.entries(layouts(fs.readFileSync(path.join(UNLABELLED, AD16), "utf8")))) {
    const dir = scratch();
    fs.writeFileSync(path.join(dir, AD16), edited);
    const { option } = optionFor(edited);
    const out = applyExport(exportOf(1, { [ID(AD16)]: { base: 0, blind: { ...span("01", "02"), labels: { [option]: "play" } } } }), dir);
    assert.equal(out.results[0].outcome.kind, "refused", name);
    assert.match(out.results[0].outcome.message, /nothing written/, name);
    assert.equal(text(dir, AD16), edited, `${name}: bytes unchanged`);
    assert.deepEqual(out.written, []);
  }
});

test("spliceProblem names a duplicate key, a moved key and a text that is not the intended fixture", () => {
  const intended = { id: "x", verdicts: [], review: "r" };
  assert.equal(spliceProblem('{\n  "id": "x",\n  "verdicts": [],\n  "review": "r"\n}\n', intended), null);
  assert.match(spliceProblem('{\n  "id": "x",\n  "verdicts": [ ],\n  "verdicts": [],\n  "review": "r"\n}\n', intended), /exactly one/);
  assert.match(spliceProblem('{\n  "id": "x",\n  "review": "r",\n  "verdicts": []\n}\n', intended), /immediately before review/);
  assert.match(spliceProblem('{\n  "id": "y",\n  "verdicts": [],\n  "review": "r"\n}\n', intended), /intended fixture/);
  assert.match(spliceProblem("{", intended), /not JSON/);
});

test("the command reads an export that starts with a byte-order mark", () => {
  const dir = tempCorpus([AD16]);
  const { option } = optionFor(text(dir, AD16));
  const file = path.join(scratch(), "export.json");
  fs.writeFileSync(file, "﻿" + JSON.stringify(exportOf(1, { [ID(AD16)]: { base: 0, blind: { ...span("01", "02"), labels: { [option]: "play" } } } })));
  const done = cli([file, "--fixtures", dir, "--no-review"]);
  assert.equal(done.code, 0, done.err);
  fs.writeFileSync(file, "﻿{ not json");
  const bad = cli([file, "--fixtures", dir, "--no-review"]);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /export\.json: .*UTF-8/);
});

// ---- the run-wide high-water mark (I1, the user's ruling; a deviation from design 3b rule 1) ----------------

test("an intermediate export applied after the newest one writes nothing, though the position's own last change was reverted", () => {
  const dir = tempCorpus([AD16, TOP7]);
  const ad = optionFor(text(dir, AD16));
  const top = optionFor(text(dir, TOP7));
  const at = (rev, adLabel, topLabel) => exportOf(rev, {
    [ID(AD16)]: { base: 0, blind: { ...span("01", "09"), labels: { [ad.option]: adLabel } } },
    [ID(TOP7)]: { base: 0, blind: { ...span("01", "09"), labels: { [top.option]: topLabel } } },
  });
  // rev 1: x = play on AD16, y = maybe on TOP7. rev 2: x = never. rev 3: x = play again. rev 4: y = never.
  const rev1 = at(1, "play", "maybe");
  const rev2 = at(2, "never", "maybe");
  const rev4 = at(4, "play", "never");
  applyExport(rev1, dir);
  applyExport(rev4, dir); // AD16: nothing differs, so it gets no stamp at rev 4; TOP7 is stamped 4
  const adBytes = text(dir, AD16);
  const out = applyExport(rev2, dir);
  assert.deepEqual(out.results.map((r) => r.outcome.kind), ["older", "older"]);
  assert.match(out.results[0].outcome.message, /already applied rev 4/);
  assert.equal(text(dir, AD16), adBytes, "the file still says what the page says");
  assert.deepEqual(out.written, []);
  assert.equal(foldVerdicts(JSON.parse(text(dir, AD16)).verdicts).current[ad.option], "play");
});

test("the mark may sit on a different position than the one the older export would change", () => {
  const dir = tempCorpus([AD16, TOP7]);
  const ad = optionFor(text(dir, AD16));
  const top = optionFor(text(dir, TOP7));
  applyExport(exportOf(5, { [ID(TOP7)]: { base: 0, blind: { ...span("01", "05"), labels: { [top.option]: "play" } } } }), dir);
  const before = text(dir, AD16);
  const out = applyExport(exportOf(3, { [ID(AD16)]: { base: 0, blind: { ...span("01", "03"), labels: { [ad.option]: "never" } } } }), dir);
  assert.equal(out.results[0].outcome.kind, "older");
  assert.equal(text(dir, AD16), before);
  // The same rev as the mark is a replay everywhere; a rev above it goes through.
  assert.equal(applyExport(exportOf(5, { [ID(AD16)]: { base: 0, blind: { ...span("01", "05"), labels: { [ad.option]: "never" } } } }), dir).results[0].outcome.kind, "replay");
  assert.equal(applyExport(exportOf(6, { [ID(AD16)]: { base: 0, blind: { ...span("01", "06"), labels: { [ad.option]: "never" } } } }), dir).results[0].outcome.kind, "applied");
});

test("another run's mark does not block a fresh run's export", () => {
  const dir = tempCorpus([AD16, TOP7]);
  const ad = optionFor(text(dir, AD16));
  const top = optionFor(text(dir, TOP7));
  applyExport(exportOf(50, { [ID(TOP7)]: { base: 0, blind: { ...span("01", "05"), labels: { [top.option]: "play" } } } }), dir);
  const fresh = "2026-11-12T09:00:00Z";
  const out = applyExport(exportOf(1, { [ID(AD16)]: { base: 0, blind: { ...span("01", "05"), labels: { [ad.option]: "maybe" } } } }, fresh), dir);
  assert.equal(out.results[0].outcome.kind, "applied");
});

// ---- branch-review fixes: where relative paths resolve, and the run directory's size ------------------------

test("callerPath resolves against INIT_CWD when pnpm sets it, else the working directory; absolute paths stand", () => {
  assert.equal(callerPath("export.json", { INIT_CWD: "/home/me/dl" }, "/repo"), path.resolve("/home/me/dl", "export.json"));
  assert.equal(callerPath("export.json", {}, "/repo"), path.resolve("/repo", "export.json"));
  assert.equal(callerPath("/abs/e.json", { INIT_CWD: "/home/me/dl" }, "/repo"), path.resolve("/abs/e.json"));
});

test("the command reads a relative export and --fixtures from INIT_CWD, not from where the script runs", () => {
  const home = scratch();
  const dir = path.join(home, "corpus");
  fs.mkdirSync(dir);
  fs.copyFileSync(path.join(UNLABELLED, AD16), path.join(dir, AD16));
  const { option } = optionFor(text(dir, AD16));
  fs.writeFileSync(path.join(home, "export.json"), JSON.stringify(exportOf(1, { [ID(AD16)]: { base: 0, blind: { ...span("01", "02"), labels: { [option]: "play" } } } })));
  const done = spawnSync(process.execPath, [path.join(HERE, "apply-verdicts.mjs"), "export.json", "--fixtures", "corpus", "--no-review"], {
    encoding: "utf8", cwd: REPO, env: { ...process.env, INIT_CWD: home },
  });
  assert.equal(done.status, 0, done.stderr);
  assert.equal(JSON.parse(text(dir, AD16)).verdicts.length, 1);
});

test("dirBytes totals the files under a directory, nested ones included", () => {
  const dir = scratch();
  fs.mkdirSync(path.join(dir, "a"));
  fs.writeFileSync(path.join(dir, "x"), "12345");
  fs.writeFileSync(path.join(dir, "a", "y"), "123");
  assert.equal(dirBytes(dir), 8);
});
