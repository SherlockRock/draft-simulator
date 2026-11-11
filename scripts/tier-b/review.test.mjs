// `tier-b:review --record`: one parseable line appended to history.jsonl, nothing on a failed run. The runner is
// stubbed: a Node test never spawns a real cargo build. Everything is written under a temp directory.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
  assert.deepEqual(line.grid, { p: [0.1, 0.15], q: [0, 0.05], arms: 3 });
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
