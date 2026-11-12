// `tier-b:review --record`: one parseable line appended to history.jsonl, nothing on a failed run. The runner is
// stubbed: a Node test never spawns a real cargo build. Everything is written under a temp directory.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { appendHistory, collapseWorklist, historyLine, historyPath, runReview } from "./review.mjs";

const NOW = new Date("2026-11-11T10:20:30Z");

function runJson({ metrics = true } = {}) {
  const reference = {
    id: "roster:0.1:0.05",
    metrics: { positions: 2, speaking: 2, never: [1, 1, 1, 1], pick: [1, 2, 2, 2] },
  };
  const run = {
    schema: "tier-b-run/1",
    run: {
      id: "2026-11-11T10:20:30Z",
      engine: { name: "reference", commit: "abc1234", dirty: false },
      data: { fm_version: "fm-x", meta_version: "16.13.1", positions_patch: "16.19" },
      arms: [
        { id: "pool_or_roster", rule: "pool_or_roster" },
        { id: "roster:0.1:0.05", rule: "roster", p: 0.1, q: 0.05 },
        { id: "roster:0.15:0", rule: "roster", p: 0.15, q: 0 },
      ],
    },
    positions: [{}, {}],
    load_errors: [],
  };
  if (metrics) {
    run.metrics = {
      margin: 0.01,
      reference: reference.id,
      labels: { options: 12, blind_options: 8 },
      arms: [reference],
      rule: { pick: "roster:0.15:0", readable: 2, roster_arms: 2, edge: [{ text: "on the grid's edge (P = 0.15)" }] },
      second_line: { differs: false },
    };
  }
  return run;
}

// A stand-in for `exec`: the "cargo" step writes the run JSON and a summary where TIER_B_JSON says; the page step
// does nothing.
function stub({ metrics = true, fail = null } = {}) {
  const calls = [];
  const exec = (command, args, options) => {
    calls.push(command === "cargo" ? "cargo" : "page");
    if (fail === calls.at(-1)) throw new Error(`${calls.at(-1)} failed`);
    if (command === "cargo") {
      const json = options.env.TIER_B_JSON;
      fs.writeFileSync(json, JSON.stringify(runJson({ metrics })));
      fs.writeFileSync(path.join(path.dirname(json), "summary.txt"), "SUMMARY\n");
    }
  };
  return { exec, calls };
}

function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tier-b-record-"));
  const fixtures = path.join(dir, "fixtures");
  fs.mkdirSync(fixtures);
  return { dir, fixtures };
}

const lines = (file) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean);

test("--record appends exactly one parseable line, from a labelled run", () => {
  const { dir, fixtures } = temp();
  const { exec } = stub();
  runReview({ fixtures, repo: dir, now: NOW, record: true, exec });
  const file = path.join(fixtures, "history.jsonl");
  const got = lines(file);
  assert.equal(got.length, 1);
  const line = JSON.parse(got[0]);
  assert.equal(line.date, "2026-11-11");
  assert.equal(line.commit, "abc1234");
  assert.deepEqual(line.data, { fm_version: "fm-x", meta_version: "16.13.1", positions_patch: "16.19" });
  assert.deepEqual(line.grid, { p: [0.1, 0.15], q: [0, 0.05], w: [1], arms: 3 });
  assert.equal(line.corpus.positions, 2);
  assert.deepEqual(line.labels, { options: 12, blind_options: 8 });
  assert.equal(line.reference.arm, "roster:0.1:0.05");
  assert.deepEqual(line.reference.metrics.never, [1, 1, 1, 1]);
  assert.equal(line.rule.pick, "roster:0.15:0");
  assert.deepEqual(line.rule.edge, ["on the grid's edge (P = 0.15)"]);
  // A second record adds a second line and leaves the first alone.
  runReview({ fixtures, repo: dir, now: new Date("2026-11-12T10:20:30Z"), record: true, exec: stub().exec });
  assert.equal(lines(file).length, 2);
  assert.equal(lines(file)[0], got[0]);
});

test("without --record nothing is appended", () => {
  const { dir, fixtures } = temp();
  runReview({ fixtures, repo: dir, now: NOW, exec: stub().exec });
  assert.equal(fs.existsSync(path.join(fixtures, "history.jsonl")), false);
});

test("a failed run appends nothing, at either step", () => {
  for (const fail of ["cargo", "page"]) {
    const { dir, fixtures } = temp();
    assert.throws(() => runReview({ fixtures, repo: dir, now: NOW, record: true, exec: stub({ fail }).exec }), /failed/);
    assert.equal(fs.existsSync(path.join(fixtures, "history.jsonl")), false, fail);
  }
});

test("a run with no labels refuses to record and appends nothing", () => {
  const { dir, fixtures } = temp();
  assert.throws(
    () => runReview({ fixtures, repo: dir, now: NOW, record: true, exec: stub({ metrics: false }).exec }),
    /no labels/,
  );
  assert.equal(fs.existsSync(path.join(fixtures, "history.jsonl")), false);
});

test("the history goes beside the fixtures: --fixtures, else the repo's fixtures/tier-b", () => {
  assert.equal(historyPath("/x/fx", "/repo"), path.join("/x/fx", "history.jsonl"));
  assert.equal(historyPath(null, "/repo"), path.join("/repo", "packages/engine-core/fixtures/tier-b/history.jsonl"));
});

test("a history file without a final newline still gets the new line on a line of its own", () => {
  const { dir } = temp();
  const file = path.join(dir, "history.jsonl");
  fs.writeFileSync(file, '{"a":1}');
  appendHistory(file, { b: 2 });
  assert.deepEqual(lines(file).map((l) => JSON.parse(l)), [{ a: 1 }, { b: 2 }]);
});

test("the summary the runner wrote is printed", () => {
  const { dir, fixtures } = temp();
  const written = [];
  const real = process.stdout.write;
  process.stdout.write = (chunk) => (written.push(String(chunk)), true);
  try {
    runReview({ fixtures, repo: dir, now: NOW, exec: stub().exec });
  } finally {
    process.stdout.write = real;
  }
  assert.ok(written.join("").includes("SUMMARY"));
});

test("historyLine names what is missing", () => {
  assert.throws(() => historyLine(runJson({ metrics: false })), /no labels/);
});

test("the terminal summary collapses the worklist to counts and names the file with the rest", () => {
  const text = [
    "head",
    "Worklist",
    "  unlabelled rows: 3 over 2 positions",
    "    pos-a: 2",
    "      Alistar+Zeri|top=Rumble",
    "      Leona+Zyra|top=Rumble",
    "    pos-b: 1",
    "      Thresh+Zyra|top=Rumble",
    "  #1 lines at roster:0.1:0.05 with no line verdict: 1",
    "    pos-a: Leona+Zeri|top=Rumble — Bard",
    "",
  ].join("\n");
  const got = collapseWorklist(text, "/x/summary.txt");
  assert.equal(
    got,
    [
      "head",
      "Worklist",
      "  unlabelled rows: 3 over 2 positions",
      "    pos-a: 2",
      "    pos-b: 1",
      "  #1 lines at roster:0.1:0.05 with no line verdict: 1",
      "  (the rows and lines in full: /x/summary.txt)",
      "",
    ].join("\n"),
  );
  assert.equal(collapseWorklist("no worklist here\n", "/x"), "no worklist here\n");
});

// ---- slice B, task 5: the history line's new fields, --open-holdout (design T25, T26) ----

// The run JSON of a slice B run: a weighted arm, a holdout position, the holdout read where opened.
function sliceBRun({ open = false, holdout = 1, weighted = true } = {}) {
  const run = runJson();
  run.positions = [{}, {}, {}, {}];
  for (let i = 0; i < holdout; i++) run.positions[i].split = "holdout";
  if (weighted) {
    run.run.arms.push({ id: "roster:0.1:0.05:w1.5", rule: "roster", p: 0.1, q: 0.05, w: 1.5 });
    run.run.arms.push({ id: "roster:0.1:0.05:w0.5", rule: "roster", p: 0.1, q: 0.05, w: 0.5 });
    run.metrics.weight = { at: { p: 0.1, q: 0.05 }, w0: 1, pick: 1, verdict: { recommend: null, reason: "x" }, leave_out: [], arms: [] };
  }
  if (open) run.run.holdout_open = true;
  const cell = { positions: 1, never: [1, 1, 0, 0], pick: [0, 0, 0, 0] };
  run.metrics.holdout = open ? { positions: holdout, sealed: false, reference: cell, pick: { ...cell, never: [2, 2, 0, 0] } } : { positions: holdout, sealed: true, labels: { options: 3 } };
  return run;
}

test("T25: the line gains grid.w (sorted, w0 included), the corpus split and holdout.opened; sealed carries no read", () => {
  const line = historyLine(sliceBRun());
  assert.deepEqual(line.grid.w, [0.5, 1, 1.5]);
  assert.deepEqual(line.grid.p, [0.1, 0.15], "a weighted arm adds no P or Q");
  assert.deepEqual(line.grid.q, [0, 0.05]);
  assert.equal(line.grid.arms, 5);
  assert.deepEqual(line.corpus, { positions: 4, development: 3, holdout: 1, load_errors: 0 });
  assert.deepEqual(line.holdout, { opened: false, labels: { options: 3 } });
  assert.equal(JSON.stringify(line).includes("sealed"), false, "nothing of the sealed metrics is written");
});

test("T25: opened, the line carries the holdout read: positions, the reference and the pick cells", () => {
  const line = historyLine(sliceBRun({ open: true, holdout: 2 }));
  assert.equal(line.holdout.opened, true);
  assert.equal(line.holdout.positions, 2);
  assert.deepEqual(line.holdout.reference.never, [1, 1, 0, 0]);
  assert.deepEqual(line.holdout.pick.never, [2, 2, 0, 0]);
  assert.equal(line.corpus.holdout, 2);
  assert.equal(line.corpus.development, 2);
});

test("T25: a run with no weighted arm and no holdout position still gives grid.w [1], development = positions, holdout 0", () => {
  const line = historyLine(runJson());
  assert.deepEqual(line.grid.w, [1]);
  assert.deepEqual(line.corpus, { positions: 2, development: 2, holdout: 0, load_errors: 0 });
  assert.deepEqual(line.holdout, { opened: false });
});

test("T25: the slice-2 line in the fixtures still parses, and every field it has is a field the new line keeps", () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../packages/engine-core/fixtures/tier-b/history.jsonl");
  const old = lines(file).map((l) => JSON.parse(l));
  assert.ok(old.length >= 1);
  const fresh = historyLine(runJson());
  for (const l of old) for (const k of Object.keys(l)) assert.ok(k in fresh, `the new line keeps ${k}`);
  assert.equal(old[0].holdout, undefined, "the old line has no holdout key: readers must treat absence as not opened");
});

test("T26: --open-holdout sets TIER_B_HOLDOUT=open for the binary and records, without --record", () => {
  const { dir, fixtures } = temp();
  const seen = [];
  const inner = stub().exec;
  const exec = (command, args, options) => (seen.push(command === "cargo" ? options.env.TIER_B_HOLDOUT : "page"), inner(command, args, options));
  runReview({ fixtures, repo: dir, now: NOW, openHoldout: true, exec, env: {} });
  assert.equal(seen[0], "open");
  assert.equal(lines(path.join(fixtures, "history.jsonl")).length, 1, "opening implies --record");
});

test("T26: without --open-holdout the binary is run with no TIER_B_HOLDOUT at all", () => {
  const { dir, fixtures } = temp();
  let got;
  runReview({ fixtures, repo: dir, now: NOW, env: { PATH: "x" }, exec: (c, a, o) => { if (c === "cargo") got = o.env; } });
  assert.equal("TIER_B_HOLDOUT" in got, false);
});

test("T26: a TIER_B_HOLDOUT in the environment without --open-holdout is refused before anything runs", () => {
  for (const value of ["open", "", "yes"]) {
    const { dir, fixtures } = temp();
    const calls = [];
    assert.throws(
      () => runReview({ fixtures, repo: dir, now: NOW, record: true, env: { TIER_B_HOLDOUT: value }, exec: (c) => calls.push(c) }),
      /use --open-holdout/,
      JSON.stringify(value),
    );
    assert.deepEqual(calls, [], "nothing was run");
    assert.equal(fs.existsSync(path.join(fixtures, "history.jsonl")), false);
    assert.equal(fs.readdirSync(dir).includes("docs"), false, "no run directory was made");
  }
  // with the flag, the inherited value is simply overridden
  const { dir, fixtures } = temp();
  runReview({ fixtures, repo: dir, now: NOW, openHoldout: true, env: { TIER_B_HOLDOUT: "yes" }, exec: stub().exec });
});

test("T26: an opening already in the history is warned about, naming its run, and the run goes on and records", () => {
  const { dir, fixtures } = temp();
  const file = path.join(fixtures, "history.jsonl");
  fs.writeFileSync(file, [{ run: "2026-11-01T00:00:00Z" }, { run: "2026-11-05T01:02:03Z", holdout: { opened: true } }, { run: "2026-11-06T00:00:00Z", holdout: { opened: false } }].map((l) => JSON.stringify(l)).join("\n") + "\n");
  const warned = [];
  runReview({ fixtures, repo: dir, now: NOW, openHoldout: true, env: {}, warn: (m) => warned.push(m), exec: stub().exec });
  assert.equal(warned.length, 1);
  assert.match(warned[0], /2026-11-05T01:02:03Z/);
  assert.equal(warned[0].includes("2026-11-06T00:00:00Z"), false, "an unopened line is not an opening");
  assert.equal(lines(file).length, 4, "it went on, and the second look is on record");
});

test("T26: no warning without an opening in the history, and none on a run that does not open", () => {
  const { dir, fixtures } = temp();
  fs.writeFileSync(path.join(fixtures, "history.jsonl"), JSON.stringify({ run: "r", holdout: { opened: true } }) + "\n");
  const warned = [];
  runReview({ fixtures, repo: dir, now: NOW, env: {}, warn: (m) => warned.push(m), exec: stub().exec });
  assert.deepEqual(warned, [], "a development run beside an old opening says nothing");
  const other = temp();
  runReview({ fixtures: other.fixtures, repo: other.dir, now: NOW, openHoldout: true, env: {}, warn: (m) => warned.push(m), exec: stub().exec });
  assert.deepEqual(warned, [], "no history, no warning");
});

test("T25 fix: the holdout's label counts are in the line, sealed or opened, and no rank is", () => {
  for (const open of [false, true]) {
    const run = sliceBRun({ open, holdout: 2 });
    run.metrics.holdout.labels = { positions: 2, labelled_positions: 1, options: 7, blind_options: 5, scored_only_options: 2, own_picks: 1, blind_picks: 1 };
    const line = historyLine(run);
    assert.deepEqual(line.holdout.labels, run.metrics.holdout.labels, `open ${open}`);
    assert.equal(line.holdout.opened, open);
  }
  const none = sliceBRun({ holdout: 0 });
  delete none.metrics.holdout;
  assert.equal("labels" in historyLine(none).holdout, false, "no holdout positions, no counts");
});

test("T25 fix: opened, holdout.weights carries each weighted arm's holdout block, in the shape the summary writes", () => {
  const run = sliceBRun({ open: true });
  const side = (never, readable) => ({ positions: 1, never, pick: [0, 0, 0, 0], readable });
  run.metrics.weight.arms = [
    { w: 1, id: "roster:0.1:0.05", development: side([1, 1, 0, 0], true), holdout: side([1, 1, 0, 0], true) },
    { w: 1.5, id: "roster:0.1:0.05:w1.5", development: side([0, 0, 0, 0], true), holdout: side([0, 1, 0, 0], false) },
    { w: 0.5, id: "roster:0.1:0.05:w0.5", development: side([2, 2, 0, 0], true) },
  ];
  const line = historyLine(run);
  assert.deepEqual(line.holdout.weights.map((x) => x.w), [1, 1.5]);
  assert.deepEqual(line.holdout.weights[1].holdout, side([0, 1, 0, 0], false));
  const sealed = sliceBRun();
  sealed.metrics.weight.arms = run.metrics.weight.arms;
  assert.equal("weights" in historyLine(sealed).holdout, false, "sealed: nothing of the holdout's read");
});
