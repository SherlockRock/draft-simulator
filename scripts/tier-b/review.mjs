#!/usr/bin/env node
// One command for the loop's run step: the Rust runner, then the page beside its JSON.
//
//   node scripts/tier-b/review.mjs [--fixtures <dir>]
//
// Runs `cargo run --release -p engine-core --bin tier_b_review` with TIER_B_JSON under
// docs/plans/<date>-tier-b-review/<run id, colons as dashes>/run.json, TIER_B_RUN_ID set here (so the directory
// carries the id the JSON does) and TIER_B_FIXTURES when --fixtures is given; then builds review.html beside it
// and prints both paths. `--record` is reserved for slice 2.
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

function runStep(command, args, options) {
  const done = spawnSync(command, args, { stdio: "inherit", ...options });
  if (done.error) throw new Error(`${command}: ${done.error.message}`);
  if (done.status !== 0) throw new Error(`${command} ${args.slice(0, 3).join(" ")} exited with ${done.status}`);
}

// Runs the runner and builds the page. `fixtures` is a directory or null (the real corpus).
function runReview({ fixtures = null, repo = REPO, now = new Date() } = {}) {
  const runId = runIdFor(now);
  const paths = reviewPaths(runId, repo);
  fs.mkdirSync(paths.dir, { recursive: true });
  const env = { ...process.env, TIER_B_JSON: paths.runJson, TIER_B_RUN_ID: runId };
  if (fixtures) env.TIER_B_FIXTURES = path.resolve(fixtures);
  try {
    runStep("cargo", ["run", "--release", "-p", "engine-core", "--bin", "tier_b_review"], { cwd: repo, env });
  } catch (e) {
    try {
      fs.rmdirSync(paths.dir); // a failed run leaves no empty directory (rmdir refuses a non-empty one)
    } catch (ignored) {
      // kept: it holds something
    }
    throw e;
  }
  runStep(process.execPath, [path.join(HERE, "build-review-page.mjs"), paths.runJson, paths.page], { cwd: repo });
  console.log(`run:  ${paths.runJson}`);
  console.log(`page: ${paths.page}`);
  console.log(`run directory: ${paths.dir} (${(dirBytes(paths.dir) / 1048576).toFixed(1)} MB; kept: the run JSON records what the page showed, and nothing deletes it)`);
  return { runId, ...paths };
}

function main(argv) {
  let fixtures = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--fixtures") {
      fixtures = argv[++i];
      if (!fixtures) throw new Error("--fixtures needs a directory");
    } else if (argv[i] === "--record") {
      throw new Error("--record is reserved for slice 2 and does nothing yet");
    } else {
      throw new Error(`unknown argument ${argv[i]}\nusage: review.mjs [--fixtures <dir>]`);
    }
  }
  runReview({ fixtures: fixtures ? callerPath(fixtures) : null });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`review: ${e.message}`);
    process.exitCode = 2;
  }
}

export { callerPath, dirBytes, reviewPaths, runIdFor, runReview };
