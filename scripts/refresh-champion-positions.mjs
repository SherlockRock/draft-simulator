#!/usr/bin/env node
/**
 * Refresh the `positions` field of frontend/src/data/champions.json from a
 * play-rate source (design docs/designs/champion-meta-positions-refresh-design.md § 5).
 *
 *   node scripts/refresh-champion-positions.mjs [--source corpus|ugg] [--in PATH] [--out PATH]
 *                                               [--force] [--skip-feasibility]
 *
 * corpus (default): data/training/role_percentages.json — the TRAIN split's
 *   per-champion role shares written by scripts/model/prepare.py; patches from
 *   data/training/patch_vocab.json. Exists only where prepare.py ran.
 * ugg: data/compiled/winrates.json per-role match counts — the documented
 *   fallback for a machine without the corpus, UNMEASURED AT PARITY (design § 2:
 *   the file on disk is patch 16_8, seven+ patches stale, because PATCH is a
 *   hard-coded constant in scripts/ugg-scraper/constants.mjs; at 0.10 it scored
 *   0.607 both-sides against the corpus's 0.785). `games` in the provenance block
 *   is then champion-matches (per-role n summed), written with gamesUnit.
 *
 * Rule: positions = roles with share >= 0.10 ordered by share, argmax always
 * kept, no hysteresis; a champion the source lacks keeps its list. Only the
 * `positions` values and the root `positionsSource` block change; the array
 * order, the champion set and every other field are preserved. The script
 * never adds or removes champions — that is update-champions.mjs's job.
 *
 * Prints the diff (primary flips with rates, roles lost/gained, kept champions)
 * and, when the corpus and scripts/model/.venv are present, the both-sides
 * feasibility of the evaluable holdout under the new table next to the previous
 * run's. Gate (recurring runs only, i.e. when the input already carries a
 * positionsSource block): abort with exit 2 and write nothing if feasibility
 * drops more than 2 points, more than 10 primaries flip, or feasibility cannot
 * be measured while the previous run recorded one; --force overrides (and, for
 * the same source kind, carries the previous number forward marked carriedFrom).
 *
 * A champion released after the corpus freeze has no games here and keeps
 * whatever the file holds (Meraki's list or a hand entry); if that is [] the
 * compile's non-empty check fails — hand-enter positions until the next
 * retrain. Run this right after prepare.py and before the Task 5 harness, then
 * `node scripts/compile-champion-meta.mjs && node scripts/validate-compiled-data.mjs`.
 */
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { parseArgs } from "node:util";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { assertChampionRows } from "./champion-positions/invariants.mjs";
import {
  POSITIONS_THRESHOLD, ratesFromCorpus, ratesFromUgg, refreshPositions, diffPositions,
  buildProvenance, formatPositionsSource, evaluateGate, formatDiff,
} from "./champion-positions/derive.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CHAMPIONS_PATH = join(ROOT, "frontend", "src", "data", "champions.json");
const CORPUS_PATH = join(ROOT, "data", "training", "role_percentages.json");
const PATCH_VOCAB_PATH = join(ROOT, "data", "training", "patch_vocab.json");
const UGG_PATH = join(ROOT, "data", "compiled", "winrates.json");
const SIBLING_SETS_PATH = join(ROOT, "data", "training", "sibling_sets.csv");
const PYTHON = join(ROOT, "scripts", "model", ".venv", "bin", "python");
const FEASIBILITY_SCRIPT = join(ROOT, "scripts", "model", "positions_feasibility.py");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function loadSource(source) {
  if (source === "corpus") {
    if (!existsSync(CORPUS_PATH)) {
      throw new Error(`${CORPUS_PATH} not found — run scripts/model/prepare.py on this machine, or use --source ugg`);
    }
    const { rates, games, kind } = ratesFromCorpus(readJson(CORPUS_PATH));
    const patches = Object.keys(readJson(PATCH_VOCAB_PATH).patch_to_index);
    return { rates, games, kind, patches };
  }
  if (source === "ugg") {
    const doc = readJson(UGG_PATH);
    const { rates, games, kind } = ratesFromUgg(doc);
    return { rates, games, kind, patches: [doc.patch] };
  }
  throw new Error(`--source must be corpus or ugg, got ${source}`);
}

/** Both-sides feasibility through the one Python implementation; undefined when the corpus is not here. */
function measureFeasibility(rows) {
  if (!existsSync(SIBLING_SETS_PATH) || !existsSync(PYTHON)) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "refresh-positions-"));
  const tmp = join(dir, "champions.json");
  try {
    writeFileSync(tmp, JSON.stringify({ champions: rows }));
    const proc = spawnSync(PYTHON, [FEASIBILITY_SCRIPT, "--champions", tmp], {
      cwd: join(ROOT, "scripts", "model"), encoding: "utf-8",
    });
    if (proc.status !== 0) throw new Error(`positions_feasibility.py failed:\n${proc.stderr}`);
    const result = JSON.parse(proc.stdout);
    // 3 dp: the design's provenance example, every pinned log string and the
    // gate's 0.02 limit all work at 3 dp; 4 dp here would print 0.7854 against
    // an expected 0.785 and trip Task 8's stop rule on a false mismatch.
    return { sets: result.sets, bothSides: Number(result.bothSides.toFixed(3)) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const { values } = parseArgs({
    options: {
      source: { type: "string", default: "corpus" },
      in: { type: "string", default: CHAMPIONS_PATH },
      out: { type: "string" },
      force: { type: "boolean", default: false },
      "skip-feasibility": { type: "boolean", default: false },
    },
  });
  const outPath = values.out ?? values.in;

  const doc = readJson(values.in);
  const { rates, games, kind, patches } = loadSource(values.source);
  console.log(`source: ${kind} patches=${patches.join(",")} games=${games}${kind === "ugg" ? " (champion-matches)" : ""} champions=${rates.size} threshold=${POSITIONS_THRESHOLD}`);
  if (kind === "ugg") {
    console.log("WARNING: --source ugg is the unmeasured-at-parity fallback (winrates.json is patch " + patches[0] + ", scraped with a hard-coded PATCH; 0.607 both-sides vs the corpus's 0.785 at the last measurement). Prefer the corpus when it is on this machine.");
  }

  const { rows, kept } = refreshPositions(doc.champions, rates);
  assertChampionRows(rows, { label: "refresh", expectedCount: doc.champions.length, requirePositions: false });
  const diff = diffPositions(doc.champions, rows);
  console.log(formatDiff(diff, rates, kept));
  const empty = rows.filter((row) => row.positions.length === 0).map((row) => row.id);
  if (empty.length > 0) {
    console.log(`WARNING: ${empty.length} champion(s) still have no positions (no source data): ${empty.join(", ")} — the compile will refuse them; hand-enter positions until the next retrain`);
  }

  const feasibility = values["skip-feasibility"] ? undefined : measureFeasibility(rows);
  const previous = doc.positionsSource;
  if (feasibility) {
    const prev = previous?.feasibility?.bothSides;
    console.log(`both-sides feasibility (${feasibility.sets} holdout sets): ${feasibility.bothSides.toFixed(3)}${prev === undefined ? " (no previous run recorded)" : ` (previous run ${prev.toFixed(3)})`}`);
  } else {
    console.log("both-sides feasibility: not measured (no data/training corpus or scripts/model/.venv on this machine, or --skip-feasibility)");
  }

  const gate = evaluateGate({ previous, primaryFlips: diff.primaryFlips.length, feasibility, force: values.force });
  if (!gate.armed) console.log("gate: not armed (first run — no previous positionsSource block); eyeball the flip list before committing");
  for (const reason of gate.reasons) console.log(`gate: ${reason}`);
  if (gate.abort) {
    console.error("ABORT: gate failed; nothing written. Re-run with --force after reading the diff if the change is intended.");
    process.exit(2);
  }
  if (gate.armed && !gate.abort) console.log("gate: PASS");

  // What the block records: the measured number, or — only under --force, when
  // this run could not measure, the previous one could, and the SOURCE KIND is
  // the same — the previous number carried forward, marked with the run it
  // came from (an existing marker is preserved, so a chain of carries still
  // points at the run that measured). Across a kind change nothing is carried:
  // a u.gg table must not inherit the corpus's 0.785.
  const canCarry = gate.armed && values.force && previous?.feasibility && previous.kind === kind;
  const recordedFeasibility = feasibility
    ?? (canCarry
      ? { ...previous.feasibility, carriedFrom: previous.feasibility.carriedFrom ?? { generatedAt: previous.generatedAt, kind: previous.kind } }
      : undefined);
  if (recordedFeasibility?.carriedFrom) console.log(`feasibility carried forward from the ${recordedFeasibility.carriedFrom.generatedAt} run (unmeasured here)`);
  if (!feasibility && gate.armed && values.force && previous?.feasibility && previous.kind !== kind) {
    console.log(`feasibility NOT carried: previous run was ${previous.kind}, this run is ${kind}`);
    console.log("WARNING: the feasibility drop clause is unarmed until the next MEASURED run writes a number");
  }

  // Root keys: version/updatedAt first, then every other root key the file had
  // (none today), then the rebuilt positionsSource and champions.
  const { version, updatedAt, positionsSource: _previous, champions: _old, ...rest } = doc;
  const output = {
    version,
    updatedAt,
    ...rest,
    positionsSource: buildProvenance({
      kind, patches, games, threshold: POSITIONS_THRESHOLD, generatedAt: new Date().toISOString(),
      feasibility: recordedFeasibility,
      gamesUnit: kind === "ugg" ? "champion-matches" : undefined,
      unmeasuredAtParity: kind === "ugg" ? true : undefined,
    }),
    champions: rows,
  };
  writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");
  console.log(`positionsSource: ${formatPositionsSource(output.positionsSource)}`);
  console.log(`wrote ${outPath}`);
}

try {
  main();
} catch (err) {
  console.error("Error:", err.message);
  process.exit(1);
}
