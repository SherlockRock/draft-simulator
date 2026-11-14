// The results tab: the pure readers of the run's `metrics` block (review-logic.mjs) and the tab's glue against the
// page-glue test's fake DOM would need the whole fake again, so the glue half lives in page-glue.test.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assemblePageData, loadNames } from "./build-review-page.mjs";
import {
  HEAT_STEPS,
  armChoice,
  badLineLines,
  cellModel,
  countText,
  draftRevealState,
  gridModel,
  NOT_JUDGEABLE,
  heatLegend,
  linesHeader,
  upperBoundLines,
  heatStep,
  revealChangesView,
  hoverLines,
  namedPositions,
  neverEverywhereLine,
  positionVisible,
  receiptLines,
  restoreState,
  revealChangesLine,
  ruleLine,
  secondLine,
  selectionNote,
  sensitivityLines,
  worklistView,
} from "./review-logic.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const RUN = JSON.parse(fs.readFileSync(path.join(HERE, "testdata/tiny-run.json"), "utf8"));
const NAMES = loadNames(REPO);
const A = "2026-10-04-supp-pinch-slot-17-dme"; // unrevealed draft
const E = "2026-10-07-synth-dme-adc-pinch-slot-19"; // revealed by its seed (holds a scored entry)

function mx(over = {}) {
  const base = {
    positions: 5, speaking: 5, non_speaking: 0,
    never: [0, 0, 0, 0], near: [0, 0, 0, 0], unjudged: [0, 0, 0, 0], play: [0, 0, 0, 0], no_play: [0, 0, 0, 0], neither_play: [0, 0, 0, 0],
    pick: [0, 0, 0, 0], pick_off: [0, 0, 0, 0], with_pick: 4, pick_off_eligible: 2,
    never_1_by_class: { in_pool: 0, off_pool_base: 0, off_pool_graded: 0 }, top_in_pool: 3,
    pick_median_rank: 3, pick_median_rank_absent: false, pick_absent: 0, pick_median_regret: 0.15, opp_charge_lead: 0,
    bad_line: 0, judged_line: 0, unjudged_line: 0, no_line: 0,
  };
  return { ...base, ...over };
}
function arm(id, role, p, q, metrics, positions = {}, extra = {}) {
  const empty = Object.fromEntries(["never_1", "never_3", "near_1", "near_3", "unjudged_1", "unjudged_3", "pick_3", "pick_3_out", "not_speaking", "bad_line_1", "unjudged_line_1"].map((k) => [k, []]));
  return { id, role, p, q, readable: true, unknown_r_kept: 0, metrics: mx(metrics), positions: { ...empty, ...positions }, ...extra };
}
function outcome(over = {}) {
  return { roster_arms: 4, readable: 4, ties: ["roster:0.1:0.05"], pick: "roster:0.1:0.05", edge: [], receipt: null, ...over };
}
function metrics(over = {}) {
  return {
    ks: [1, 3, 5, 10], margin: 0.01, reference: "roster:0.1:0.05",
    labels: { positions: 5, labelled_positions: 4, options: 20, blind_options: 18, scored_only_options: 2, own_picks: 4, blind_picks: 3, fallback_labels: 1, fallback_picks: 0 },
    arms: [
      arm("pool_or_roster", "pool_or_roster", null, null, { never: [2, 3, 0, 0] }),
      arm("roster:0.1:0.05", "roster", 0.1, 0.05, { never: [3, 4, 0, 0], pick: [0, 2, 0, 0] }, { never_1: [A, E, "x"] }),
      arm("roster:0.1:0.15", "roster", 0.1, 0.15, { never: [0, 1, 0, 0], pick: [0, 3, 0, 0] }),
      arm("roster:0.15:0.05", "roster", 0.15, 0.05, { never: [1, 1, 0, 0], near: [1, 0, 0, 0], unjudged: [2, 0, 0, 0] }),
      arm("roster:0.15:0.15", "roster", 0.15, 0.15, { never: [6, 7, 0, 0], non_speaking: 1, speaking: 4 }),
      arm("floor:0.1", "floor", null, null, { never: [1, 2, 0, 0] }, {}, { unknown_r_kept: 2 }),
    ],
    rule: outcome(),
    sensitivity: { margins: [{ margin: 0.005, pick: "roster:0.1:0.15", readable: 48 }, { margin: 0.02, pick: null, readable: 0 }], leave_out: [{ draft: "supp", pick: "roster:0.1:0.05", readable: 47 }] },
    second_line: { differs: false, outcome: outcome() },
    never_everywhere: [],
    r_by_label: [{ bucket: "r < 0.1", play: 0, maybe: 1, never: 2 }],
    reveal_changes: { blind_labels: 18, blind_picks: 3, labels: [], picks: [], drafts_revealed: ["synth-dme-adc"], reveals_without_change: [] },
    worklist: { lines_at: "roster:0.1:0.05", unlabelled_rows: [], unjudged_lines: [] },
    ...over,
  };
}
const find = (m, id) => m.arms.find((a) => a.id === id);

// ---- the cell model ----

test("a cell prints the count, ≥n where positions are unjudged, (+n) for near ties, and says its marks in words", () => {
  const m = metrics({ rule: outcome({ ties: ["roster:0.1:0.05", "roster:0.1:0.15"], edge: [{ axis: "Q", side: "top", value: 0.15, text: "on the grid's edge (Q = 0.15): read r_by_label and the floor rows before widening" }] }) });
  const g = gridModel(m);
  const at = (p, q) => g.rows[g.ps.indexOf(p)][g.qs.indexOf(q)];
  assert.equal(at(0.15, 0.05).text, "≥1(+1)", "unjudged and a near tie at once");
  assert.equal(at(0.1, 0.15).text, "0");
  assert.deepEqual(at(0.1, 0.05).tags, ["rule's pick", "current defaults", "on the grid's edge"]);
  assert.deepEqual(at(0.1, 0.15).tags, ["tied with the pick"]);
  assert.ok(at(0.15, 0.15).tags.includes("1 of 5 do not speak"));
  // no mark of the pick, defaults or the edge on a cell that is none of them
  assert.deepEqual(at(0.15, 0.05).tags, []);
  assert.equal(countText(mx({ never: [4, 0, 0, 0], unjudged: [0, 0, 0, 0], near: [0, 0, 0, 0] }), 0), "4");
});

test("the edge flag marks the pick's cell in words; non-readable arms say so", () => {
  const edge = { axis: "Q", side: "top", value: 0.15, text: "on the grid's edge (Q = 0.15): read r_by_label and the floor rows before widening" };
  const m = metrics({ rule: outcome({ pick: "roster:0.1:0.15", ties: ["roster:0.1:0.15"], edge: [edge] }) });
  const max = 6;
  const pick = cellModel(find(m, "roster:0.1:0.15"), m, max);
  assert.ok(pick.tags.includes("on the grid's edge") && pick.tags.includes("rule's pick"));
  const other = cellModel(find(m, "roster:0.1:0.05"), m, max);
  assert.equal(other.tags.includes("on the grid's edge"), false);
  m.arms[1].readable = false;
  assert.ok(cellModel(find(m, "roster:0.1:0.05"), m, max).tags.includes("not readable"));
});

test("the grid holds the roster arms by P and Q, pool_or_roster and the floor rows apart and not among the cells", () => {
  const g = gridModel(metrics());
  assert.deepEqual(g.ps, [0.1, 0.15]);
  assert.deepEqual(g.qs, [0.05, 0.15]);
  assert.equal(g.rows.flat().filter(Boolean).length, 4);
  assert.equal(g.por.id, "pool_or_roster");
  assert.deepEqual(g.floors.map((f) => f.id), ["floor:0.1"]);
  assert.equal(g.floors[0].unknownR, 2);
  assert.equal(g.max, 6, "the scale reads roster arms only: the floor and pool_or_roster counts do not stretch it");
  const m = metrics();
  m.arms = m.arms.filter((a) => a.id !== "roster:0.15:0.15");
  assert.equal(gridModel(m).rows[1][1], null, "a missing arm is a gap, not a zero");
});

// ---- the colour step ----

test("the colour step: zero is the lightest, the largest count the darkest, monotone in between", () => {
  assert.equal(HEAT_STEPS, 4);
  assert.equal(heatStep(0, 10), 0);
  assert.equal(heatStep(0, 0), 0, "no count anywhere: every cell is the lightest step, not NaN");
  assert.equal(heatStep(10, 10), HEAT_STEPS - 1);
  assert.equal(heatStep(1, 10), 1, "a non-zero count is never the zero step");
  let last = 0;
  for (let v = 0; v <= 12; v++) {
    const s = heatStep(v, 12);
    assert.ok(s >= last && s < HEAT_STEPS, `step ${s} at ${v}`);
    last = s;
  }
});

// ---- the hover text ----

test("the hover text gives never@3, pick@3 and the positions behind each count, and names no position of an unrevealed draft", () => {
  const m = metrics();
  const a = find(m, "roster:0.1:0.05");
  const visible = (id) => id === E;
  const text = hoverLines(a, visible).join("\n");
  assert.match(text, /never@1 3, never@3 4, pick@3 2 of 4 with an own pick/);
  assert.match(text, /never@1 at: .*\b2026-10-07-synth-dme-adc-pinch-slot-19\b/);
  assert.equal(text.includes(A), false, "an unrevealed draft's position is not named");
  assert.match(text, /\+2 in drafts not yet revealed \(not named\)/);
  const all = hoverLines(a, () => true).join("\n");
  assert.ok(all.includes(A));
  assert.equal(namedPositions([], visible), "none");
  assert.equal(namedPositions([A], visible), "1 in drafts not yet revealed (not named)");
});

test("hover text marks a non-readable arm, the pool_or_roster row and a comparison row in words", () => {
  const m = metrics();
  m.arms[2].readable = false;
  assert.match(hoverLines(m.arms[2], () => true).join("\n"), /not readable/);
  assert.match(hoverLines(m.arms[0], () => true)[0], /not a candidate for the pick/);
  assert.match(hoverLines(m.arms[5], () => true)[0], /not selectable/);
});

// ---- blind: which positions the tab may name ----

test("a position is named only once its draft is revealed; reading it never reveals anything", () => {
  const data = assemblePageData(structuredClone(RUN), { names: NAMES, icons: () => "AAAA" });
  const state = restoreState(data, null);
  const before = JSON.stringify(state);
  assert.equal(positionVisible(data, state, A), false, "an unrevealed supp draft");
  assert.equal(positionVisible(data, state, E), true, "the seeded scored entry holds its draft revealed");
  assert.equal(positionVisible(data, state, "no-such-position"), false);
  const m = metrics();
  hoverLines(m.arms[1], (id) => positionVisible(data, state, id));
  worklistView({ lines_at: "x", unlabelled_rows: [{ position: A, rows: ["r"] }], unjudged_lines: [] }, (id) => positionVisible(data, state, id));
  assert.equal(JSON.stringify(state), before, "the readers do not write to the page state");
  assert.equal(draftRevealState(data.drafts.find((d) => d.cards.some((c) => c.id === A)), state), "blind");
});

test("the worklist lists unlabelled rows and #1 lines only for revealed drafts and counts the rest", () => {
  const w = worklistView({
    lines_at: "roster:0.1:0.05",
    unlabelled_rows: [{ position: A, rows: ["o1", "o2"] }, { position: E, rows: ["o3"] }],
    unjudged_lines: [{ position: A, option: "secret-option", line: "L1" }, { position: E, option: "o3", line: "L2" }],
  }, (id) => id === E);
  assert.deepEqual(w.unlabelled, [{ position: E, rows: ["o3"] }]);
  assert.equal(w.hiddenRows, 2);
  assert.deepEqual(w.unjudgedLines.map((l) => l.position), [E]);
  assert.equal(w.hiddenLines, 1);
  assert.equal(JSON.stringify(w).includes("secret-option"), false);
});

test("never_everywhere and the receipt's leave/enter lists name only visible positions", () => {
  assert.equal(neverEverywhereLine([], () => true), "none");
  assert.match(neverEverywhereLine([A, E], (id) => id === E), /^2026-10-07-.*\+1 in drafts not yet revealed/);
  const r = { reference: "a", pick: "b", from: mx(), to: mx(), leaves_top_3: [A], enters_top_3: [E], unstable: { positions: [A, "secret-pos-2"], from: mx(), to: mx() }, stable: { positions: [E, "secret-pos-3", "secret-pos-4"], from: mx(), to: mx() } };
  const text = receiptLines(r, (id) => id === E).join("\n");
  assert.equal(text.includes(A), false);
  assert.equal(text.includes("secret-pos"), false, "the split's ids are gated too");
  assert.match(text, /depth check did not hold \(2 positions: 2 in drafts not yet revealed \(not named\)\)/);
  assert.match(text, /the others \(3 positions: 2026-10-07-synth-dme-adc-pinch-slot-19 \+2 in drafts not yet revealed/);
  assert.match(text, /leaves the top 3 at: 1 in drafts not yet revealed/);
  assert.match(text, /enters the top 3 at: 2026-10-07/);
});

// ---- arm selection ----

test("a table click selects a run arm for the cards; a floor row is no arm of the run and selects nothing", () => {
  const data = assemblePageData(structuredClone(RUN), { names: NAMES, icons: () => "AAAA" });
  assert.equal(armChoice(data, "roster:0.15:0.05"), data.run.arms.findIndex((a) => a.id === "roster:0.15:0.05"));
  assert.equal(armChoice(data, "floor:0.1"), -1);
  assert.equal(armChoice(data, "nope"), -1);
  const state = restoreState(data, null);
  const idx = armChoice(data, "roster:0.15:0.05");
  assert.match(selectionNote(data, state, idx), /^Cards show: P 0\.15 {2}Q 0\.05\./);
  assert.match(selectionNote(data, state, armChoice(data, "roster:0.1:0.05")), /\(reference\)/);
});

// ---- the lines ----

test("the rule line says N of M readable, or that no arm is readable and what follows", () => {
  assert.equal(ruleLine(outcome({ readable: 3, roster_arms: 48 })), "3 of 48 arms readable. Pick: roster:0.1:0.05");
  assert.match(ruleLine(outcome({ readable: 2, roster_arms: 48, ties: ["a", "b"], pick: "a" })), /Pick: a \(tied on the three keys: a, b\)/);
  assert.match(ruleLine(outcome({ readable: 0, roster_arms: 48, pick: null, ties: [] })), /^0 of 48 arms readable, so the rule names no pick\. The worklist below/);
});

test("sensitivity, the second line, bad_line@1 and reveal_changes say what the tool states", () => {
  assert.deepEqual(sensitivityLines(metrics().sensitivity), ["ε 0.005: roster:0.1:0.15 (48 readable)", "ε 0.02: no pick (0 readable)", "without supp: roster:0.1:0.05 (47 readable)"]);
  assert.match(secondLine({ differs: true, outcome: outcome() }), /DIFFERS from the blind read/);
  assert.match(secondLine({ differs: false, outcome: outcome({ readable: 0, roster_arms: 6, pick: null }) }), /0 of 6 arms readable, pick none readable \(same as the blind read\)/);
  const m = metrics();
  find(m, "roster:0.1:0.05").metrics.bad_line = 2;
  find(m, "roster:0.1:0.05").metrics.judged_line = 5;
  find(m, "roster:0.1:0.05").metrics.unjudged_line = 3;
  find(m, "roster:0.1:0.05").metrics.no_line = 1;
  assert.deepEqual(badLineLines(m), ["reference = pick, roster:0.1:0.05: 2 bad of 5 judged, 3 unjudged, 1 with no line"]);
  m.rule.pick = "roster:0.1:0.15";
  assert.equal(badLineLines(m).length, 2);
  assert.match(badLineLines(m)[1], /^pick, roster:0\.1:0\.15: 0 bad of 0 judged, 0 unjudged, 0 with no line$/);
  assert.match(revealChangesLine(metrics().reveal_changes), /^0 of 18 blind labels and 0 of 3 blind picks changed after the reveal; drafts revealed: synth-dme-adc; reveals with no change: none$/);
});

test("heatStep at mid-bin values (max 12): 4 -> 1, 5 -> 2, 8 -> 2, 9 -> 3", () => {
  assert.deepEqual([1, 4, 5, 8, 9, 12].map((v) => heatStep(v, 12)), [1, 1, 2, 2, 3, 3]);
  assert.deepEqual([1, 2, 3, 4].map((v) => heatStep(v, 4)), [1, 2, 3, 3]);
});

test("the key says which counts each step stands for", () => {
  assert.deepEqual(heatLegend(12), [{ step: 0, text: "0" }, { step: 1, text: "1-4" }, { step: 2, text: "5-8" }, { step: 3, text: "9-12" }]);
  assert.deepEqual(heatLegend(0), [{ step: 0, text: "0" }]);
  assert.deepEqual(heatLegend(2).map((b) => b.text), ["0", "1", "2"]);
});

test("reveal_changes on the tab keeps only visible positions", () => {
  const rc = { labels: [{ position: A, option: "o" }, { position: E, option: "o" }], picks: [{ position: A }] };
  const v = revealChangesView(rc, (id) => id === E);
  assert.deepEqual(v.labels.map((c) => c.position), [E]);
  assert.deepEqual(v.picks, []);
});

test("the worklist keeps lines_at as given, null included", () => {
  assert.equal(worklistView({ lines_at: null, unlabelled_rows: [], unjudged_lines: [] }, () => true).linesAt, null);
});

test("the receipt's second line is the summary's, word for word (the Rust readable-run snapshot's numbers)", () => {
  const from = mx({ near: [0, 0, 0, 0], play: [1, 2, 0, 0], no_play: [0, 0, 0, 0], neither_play: [0, 0, 0, 0], pick_median_rank: 3.5, pick_absent: 0, with_pick: 2, pick_median_regret: 0.45, opp_charge_lead: 0 });
  const to = mx({ near: [0, 0, 0, 0], play: [2, 2, 0, 0], no_play: [0, 0, 0, 0], neither_play: [0, 0, 0, 0], pick_median_rank: 2, pick_absent: 0, with_pick: 2, pick_median_regret: 0.1, opp_charge_lead: 0 });
  const r = { reference: "a", pick: "b", from, to, leaves_top_3: [], enters_top_3: [], unstable: { positions: [], from, to }, stable: { positions: [], from, to } };
  const lines = receiptLines(r, () => true);
  assert.equal(lines[1], "also near@3 0 → 0, play@1 1 → 2, play@3 2 → 2, no_play@3 0 → 0 (neither 0 → 0), own pick median rank 3.5 → 2 (absent 0 of 2 → 0 of 2), median regret 0.450 → 0.100, opp_charge_lead 0 → 0");
  assert.match(lines[0], /^never@1 /);
  assert.match(lines[2], /^own pick leaves the top 3 at: none$/, "the existing lines keep their place after it");
  const inf = receiptLines({ ...r, from: { ...from, pick_median_rank: null, pick_median_rank_absent: true }, to: { ...to, pick_median_rank: null, with_pick: 0, pick_median_regret: null } }, () => true)[1];
  assert.match(inf, /own pick median rank ∞ → none \(absent 0 of 2 → 0 of 0\), median regret 0\.450 → none/);
});

test("the worklist header says how many lines the page cannot judge, and the marker is per line; both stay behind positionVisible", () => {
  const w = worklistView({
    lines_at: "roster:0.15:0.05", unlabelled_rows: [], not_judgeable: 1,
    unjudged_lines: [{ position: A, option: "o", line: "L", judgeable: true }, { position: E, option: "o2", line: "L2", judgeable: false }],
  }, (id) => id === E);
  assert.equal(linesHeader(w), "#1 lines at roster:0.15:0.05 with no line verdict: 2 (1 not judgeable on the page: it offers a verdict only on the reference arm's #1 line)");
  assert.deepEqual(w.unjudgedLines.map((l) => [l.position, l.judgeable]), [[E, false]]);
  assert.equal(NOT_JUDGEABLE, "  [not judgeable on the page]");
  assert.equal(JSON.stringify(w).includes('"o"'), false);
});

test("the ≥ upper bounds list every arm with an unjudged position, floor rows included", () => {
  const m = metrics();
  find(m, "floor:0.1").metrics.unjudged = [2, 0, 0, 0];
  find(m, "roster:0.15:0.05").metrics.unjudged = [2, 1, 0, 0];
  assert.deepEqual(upperBoundLines(m), ["roster:0.15:0.05  ≤3 / ≤2", "floor:0.1  ≤3 / ≤2"]);
  assert.match(hoverLines(find(m, "floor:0.1"), () => true).join("\n"), /upper bounds \(never \+ unjudged\): ≤3 \/ ≤2/);
});

// ---- slice B, task 5: weighted arms on the results tab (design T23) ----

test("T23: a weighted arm is not in the grid; the cells, the axes and the colour scale are what they were", () => {
  const before = gridModel(metrics());
  const m = metrics();
  // At the reference's own P and Q, with a count the grid would pick up if it filtered on the rule, not the role.
  m.arms.push(arm("roster:0.1:0.05:w2", "weight", 0.1, 0.05, { never: [99, 99, 0, 0] }, {}, { readable: false }));
  m.arms.push(arm("roster:0.3:0.4:w2", "weight", 0.3, 0.4, { never: [1, 1, 0, 0] }, {}, { readable: false }));
  assert.deepEqual(gridModel(m), before, "no cell, axis, scale or floor row moves");
  assert.equal(before.rows.flat().filter(Boolean).length, 4);
});

test("T23: a weighted arm's hover names it, and never says 'not readable' for its role", () => {
  const w = arm("roster:0.1:0.05:w2", "weight", 0.1, 0.05, { never: [2, 2, 0, 0] }, {}, { readable: false });
  const text = hoverLines(w, () => true).join("\n");
  assert.match(text, /weighted arm/);
  assert.match(text, /not a candidate for the pick/);
  assert.equal(/not readable/.test(text), false, "the grid is where an arm is not readable; a weighted arm is read by the w read");
  assert.equal(text.includes("comparison row, not selectable"), false);
  const reading = hoverLines(arm("roster:0.1:0.05", "roster", 0.1, 0.05, {}, {}, { readable: false }), () => true).join("\n");
  assert.match(reading, /not readable/, "a roster arm that does not read still says so");
});
