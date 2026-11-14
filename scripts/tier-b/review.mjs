#!/usr/bin/env node
// One command for the loop's run step: the Rust runner, then the page beside its JSON.
//
//   node scripts/tier-b/review.mjs [--fixtures <dir>] [--record] [--open-holdout]
//
// Runs `cargo run --release -p engine-core --bin tier_b_review` with TIER_B_JSON under
// docs/plans/<date>-tier-b-review/<run id, colons as dashes>/run.json, TIER_B_RUN_ID set here (so the directory
// carries the id the JSON does) and TIER_B_FIXTURES when --fixtures is given; then builds review.html beside it
// and prints both paths. The runner also writes summary.txt beside the JSON; it is printed here.
//
// `--record` then appends exactly one JSON line to history.jsonl in the fixtures directory (the real one, or the
// --fixtures one): date, commit, data versions, grid, corpus size, label counts, the reference arm's metrics, the
// rule's pick. It is the last step, so a run that failed anywhere appends nothing, and a run with no labels (no
// `metrics` in its JSON) refuses to record rather than write an empty line.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");

// UTC `YYYY-MM-DDTHH:MM:SSZ`.
function runIdFor(date) {
  return date.toISOString().slice(0, 19) + "Z";
}

// Where a run's files go: docs/plans/<date>-tier-b-review/<run id with colons replaced by dashes>/.
function reviewPaths(runId, repo = REPO) {
  const dir = path.join(repo, "docs/plans", `${runId.slice(0, 10)}-tier-b-review`, runId.replace(/:/g, "-"));
  return { dir, runJson: path.join(dir, "run.json"), page: path.join(dir, "review.html") };
}

// A relative path the user typed is relative to where they typed it: `pnpm` runs scripts from the repo root and
// says where it was called from in INIT_CWD.
function callerPath(p, env = process.env, cwd = process.cwd()) {
  return path.resolve(env.INIT_CWD || cwd, p);
}

// Total bytes of the files under a directory.
function dirBytes(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirBytes(p) : fs.statSync(p).size;
  }
  return total;
}

const DEFAULT_FIXTURES = "packages/engine-core/fixtures/tier-b";

// Where --record appends: history.jsonl beside the fixtures (`load_dir` reads *.json only, so it is not loaded).
function historyPath(fixtures, repo = REPO) {
  return path.join(fixtures ? path.resolve(fixtures) : path.join(repo, DEFAULT_FIXTURES), "history.jsonl");
}

// The one line --record appends, from a parsed run JSON. Throws where there is nothing to record.
function historyLine(run) {
  const m = run.metrics;
  if (!m) throw new Error("the run has no labels, so there is nothing to record");
  const reference = m.arms.find((a) => a.id === m.reference);
  if (!reference) throw new Error(`the reference arm ${m.reference} is not in the run's metrics`);
  const roster = run.run.arms.filter((a) => a.p !== undefined && a.q !== undefined && a.w === undefined);
  const sorted = (xs) => [...new Set(xs)].sort((a, b) => a - b);
  const w0 = m.weight && typeof m.weight.w0 === "number" ? m.weight.w0 : 1;
  const holdoutN = run.positions.filter((p) => p.split === "holdout").length;
  const opened = run.run.holdout_open === true;
  // The holdout's own read goes in only when it was opened; a sealed run writes nothing of it.
  const holdout = { opened };
  // Label counts carry no rank or value, so they are written sealed or opened (design section 5).
  if (m.holdout && m.holdout.labels) holdout.labels = m.holdout.labels;
  if (opened && m.holdout) {
    holdout.positions = m.holdout.positions;
    holdout.reference = m.holdout.reference;
    holdout.pick = m.holdout.pick;
  }
  if (opened && m.weight && Array.isArray(m.weight.arms)) {
    holdout.weights = m.weight.arms.filter((a) => a.holdout !== undefined).map((a) => ({ w: a.w, holdout: a.holdout }));
  }
  return {
    date: run.run.id.slice(0, 10),
    run: run.run.id,
    commit: run.run.engine.commit,
    dirty: run.run.engine.dirty,
    data: run.run.data,
    grid: { p: sorted(roster.map((a) => a.p)), q: sorted(roster.map((a) => a.q)), w: sorted([w0, ...run.run.arms.filter((a) => a.w !== undefined).map((a) => a.w)]), arms: run.run.arms.length },
    corpus: { positions: run.positions.length, development: run.positions.length - holdoutN, holdout: holdoutN, load_errors: run.load_errors.length },
    margin: m.margin,
    labels: m.labels,
    reference: { arm: reference.id, metrics: reference.metrics },
    rule: {
      pick: m.rule.pick,
      readable: m.rule.readable,
      roster_arms: m.rule.roster_arms,
      edge: m.rule.edge.map((e) => e.text),
      second_line_differs: m.second_line.differs,
    },
    holdout,
  };
}

// The runs of the history's lines that opened the holdout (a line from before slice B has no `holdout`).
function earlierOpenings(file) {
  if (!fs.existsSync(file)) return [];
  const runs = [];
  for (const text of fs.readFileSync(file, "utf8").split("\n")) {
    if (!text.trim()) continue;
    try {
      const line = JSON.parse(text);
      if (line && line.holdout && line.holdout.opened === true) runs.push(String(line.run));
    } catch (e) {
      // a line that does not parse is not an opening this can name
    }
  }
  return runs;
}

// Appends one line, on a line of its own even where the file lacks a final newline.
function appendHistory(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let prefix = "";
  if (fs.existsSync(file)) {
    const size = fs.statSync(file).size;
    if (size > 0) {
      const fd = fs.openSync(file, "r");
      try {
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 0x0a) prefix = "\n";
      } finally {
        fs.closeSync(fd);
      }
    }
  }
  fs.appendFileSync(file, `${prefix}${JSON.stringify(line)}\n`);
}

// The terminal copy of the summary: the worklist collapsed to counts per position (the unlabelled rows and the
// unjudged #1 lines are listed in full in summary.txt, which the last line names).
function collapseWorklist(text, summaryPath) {
  const lines = text.split("\n");
  const at = lines.indexOf("Worklist");
  if (at < 0) return text;
  const out = lines.slice(0, at + 1);
  let tail = false;
  for (const line of lines.slice(at + 1)) {
    if (tail || /^ {6}/.test(line)) continue; // a row id, or the lines listed under "#1 lines"
    out.push(line);
    if (/^ {2}#1 lines at /.test(line)) tail = true;
  }
  out.push(`  (the rows and lines in full: ${summaryPath})`);
  return out.join("\n").replace(/\n+$/, "") + "\n";
}

function runStep(command, args, options) {
  const done = spawnSync(command, args, { stdio: "inherit", ...options });
  if (done.error) throw new Error(`${command}: ${done.error.message}`);
  if (done.status !== 0) throw new Error(`${command} ${args.slice(0, 3).join(" ")} exited with ${done.status}`);
}

// Runs the runner and builds the page. `fixtures` is a directory or null (the real corpus). `exec` is the
// process runner (injected by tests, which must not build the Rust binary).
// `openHoldout` sets TIER_B_HOLDOUT=open for the binary and implies `record`. A TIER_B_HOLDOUT already in `env`
// without it is refused, before anything runs: the environment is forwarded to the binary, which would otherwise
// open the holdout with no history line. `warn` is injected by tests.
function runReview({ fixtures = null, repo = REPO, now = new Date(), record = false, exec = runStep, openHoldout = false, env: inherited = process.env, warn = console.warn } = {}) {
  if (!openHoldout && inherited.TIER_B_HOLDOUT !== undefined) {
    throw new Error("TIER_B_HOLDOUT is set in the environment: use --open-holdout, which records the opening, instead of setting it");
  }
  if (openHoldout) {
    record = true;
    const earlier = earlierOpenings(historyPath(fixtures, repo));
    if (earlier.length > 0) warn(`warning: the holdout was already opened by run ${earlier.join(", ")}; this is another look, and it is recorded`);
  }
  const runId = runIdFor(now);
  const paths = reviewPaths(runId, repo);
  fs.mkdirSync(paths.dir, { recursive: true });
  const env = { ...inherited, TIER_B_JSON: paths.runJson, TIER_B_RUN_ID: runId };
  if (openHoldout) env.TIER_B_HOLDOUT = "open";
  if (fixtures) env.TIER_B_FIXTURES = path.resolve(fixtures);
  try {
    exec("cargo", ["run", "--release", "-p", "engine-core", "--bin", "tier_b_review"], { cwd: repo, env });
  } catch (e) {
    try {
      fs.rmdirSync(paths.dir); // a failed run leaves no empty directory (rmdir refuses a non-empty one)
    } catch (ignored) {
      // kept: it holds something
    }
    throw e;
  }
  exec(process.execPath, [path.join(HERE, "build-review-page.mjs"), paths.runJson, paths.page], { cwd: repo });
  const summary = path.join(paths.dir, "summary.txt");
  if (fs.existsSync(summary)) process.stdout.write(collapseWorklist(fs.readFileSync(summary, "utf8"), summary));
  console.log(`run:  ${paths.runJson}`);
  console.log(`page: ${paths.page}`);
  console.log(`run directory: ${paths.dir} (${(dirBytes(paths.dir) / 1048576).toFixed(1)} MB; kept: the run JSON records what the page showed, and nothing deletes it)`);
  if (record) {
    // Last, after every step that can fail: a failed run appends nothing.
    const file = historyPath(fixtures, repo);
    appendHistory(file, historyLine(JSON.parse(fs.readFileSync(paths.runJson, "utf8"))));
    console.log(`history: appended one line to ${file}`);
  }
  return { runId, ...paths };
}

function main(argv) {
  let fixtures = null;
  let record = false;
  let openHoldout = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--fixtures") {
      fixtures = argv[++i];
      if (!fixtures) throw new Error("--fixtures needs a directory");
    } else if (argv[i] === "--record") {
      record = true;
    } else if (argv[i] === "--open-holdout") {
      openHoldout = true;
    } else {
      throw new Error(`unknown argument ${argv[i]}\nusage: review.mjs [--fixtures <dir>] [--record] [--open-holdout]`);
    }
  }
  runReview({ fixtures: fixtures ? callerPath(fixtures) : null, record, openHoldout });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`review: ${e.message}`);
    process.exitCode = 2;
  }
}

export { appendHistory, callerPath, collapseWorklist, dirBytes, historyLine, historyPath, reviewPaths, runIdFor, runReview };
