#!/usr/bin/env node
/**
 * Refresh the `positions` field of frontend/src/data/champions.json from a
 * play-rate source (design docs/designs/champion-meta-positions-refresh-design.md § 5).
 *
 *   node scripts/refresh-champion-positions.mjs [--source corpus|ugg] [--in PATH] [--out PATH]
 *                                               [--force] [--skip-feasibility]
 *                                               [--field playable|positions]
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
 * `positions` values, the `positionShares` map beside them (all five roles'
 * shares, 3 dp — champion-role-shares design § 4.1), the `playable` list (the
 * engine's legality set: the listed roles plus every role with at least 10
 * picks per 10,000 train games of the deciding patch, never fewer than 50 —
 * corpus source only; --source ugg has no train games and omits it) and the
 * root `positionsSource` block change; the array order, the champion set and
 * every other field are preserved. The script never adds or removes champions
 * — that is update-champions.mjs's job.
 *
 * Feasibility is measured on `--field` (default playable = `playable ?? positions`
 * per row, exactly what the engines read; positions = the listed roles, the
 * pre-slice-A mask). The field names the RULE, whatever the table carries — a
 * ugg table (no playable) measured under the playable rule is what the engines
 * would read from it, so it compares against the corpus number; the output says
 * how many rows fell back. The provenance records the field with the number,
 * and the gate's drop clause is armed only when the previous run measured the
 * SAME field — otherwise both numbers print and the clause stays unarmed for
 * this run (the flip clause is unaffected). A forced UNMEASURED run carries the
 * previous number forward with its field, marked carriedFrom — across a source
 * kind change too, so a corpus measurement survives a forced ugg run.
 *
 * Recency (corpus source, 2026-10-06): a champion's shares are the NEWEST
 * patch's in role_percentages.json's `by_patch` block with >= 300 train picks
 * of that champion (derive.mjs MIN_PICKS), falling back patch by patch and then
 * to the pooled shares — so the primary follows the latest patch instead of
 * the window's pooled average (Camille: SUPPORT 0.71 pooled, TOP 0.56 on the
 * newest patch). The provenance block records rule, decidingPatch and every
 * champion decided otherwise (`fallback`). If patch_vocab.json names a patch
 * newer than any in `by_patch`, the newest corpus patch has NO train games
 * (the time split put it all in val/test) — narrow the window with prepare.py
 * --min-patch; the script warns and the deciding patch is the newest that has
 * train games.
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
  POSITIONS_THRESHOLD, RECENCY_RULE, PLAYABLE_MIN_PICK_RATE, PLAYABLE_MIN_PICKS, THIN_PATCH_GAMES,
  ratesFromCorpus, ratesFromUgg, refreshPositions, diffPositions,
  buildProvenance, formatPositionsSource, evaluateGate, carryForward, formatDiff, comparePatches,
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
    const corpus = ratesFromCorpus(readJson(CORPUS_PATH));
    const vocabPatches = Object.keys(readJson(PATCH_VOCAB_PATH).patch_to_index).sort(comparePatches);
    const trainless = vocabPatches.filter((patch) => !corpus.patches.includes(patch));
    if (trainless.length > 0) {
      console.log(`WARNING: patch_vocab.json names ${trainless.join(",")} but the TRAIN split has no games there (the time split put the newest edge in val/test) — the deciding patch is ${corpus.decidingPatch}, not the corpus's newest ${vocabPatches[vocabPatches.length - 1]}; narrow the window with prepare.py --min-patch if the newest patch should decide`);
    }
    // `patches` in the provenance = the window the corpus holds (patch_vocab),
    // as before; the rule's fields say which of them decided.
    return { ...corpus, patches: vocabPatches, rule: RECENCY_RULE };
  }
  if (source === "ugg") {
    const doc = readJson(UGG_PATH);
    const { rates, games, kind } = ratesFromUgg(doc);
    return { rates, games, kind, patches: [doc.patch] };
  }
  throw new Error(`--source must be corpus or ugg, got ${source}`);
}

/** Both-sides feasibility through the one Python implementation, on `field`
 * (playable | positions — the script falls back to positions for a row without
 * playable and reports the field it actually measured); undefined when the
 * corpus is not here. */
function measureFeasibility(rows, field) {
  if (!existsSync(SIBLING_SETS_PATH) || !existsSync(PYTHON)) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "refresh-positions-"));
  const tmp = join(dir, "champions.json");
  try {
    writeFileSync(tmp, JSON.stringify({ champions: rows }));
    const proc = spawnSync(PYTHON, [FEASIBILITY_SCRIPT, "--champions", tmp, "--field", field], {
      cwd: join(ROOT, "scripts", "model"), encoding: "utf-8",
    });
    if (proc.status !== 0) throw new Error(`positions_feasibility.py failed:\n${proc.stderr}`);
    const result = JSON.parse(proc.stdout);
    // 3 dp: the design's provenance example, every pinned log string and the
    // gate's 0.02 limit all work at 3 dp; 4 dp here would print 0.7854 against
    // an expected 0.785 and trip Task 8's stop rule on a false mismatch.
    return { sets: result.sets, bothSides: Number(result.bothSides.toFixed(3)), field: result.field, fallbackRows: result.fallbackRows };
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
      field: { type: "string", default: "playable" },
    },
  });
  const outPath = values.out ?? values.in;
  if (values.field !== "playable" && values.field !== "positions") {
    throw new Error(`--field must be playable or positions, got ${values.field}`);
  }

  const doc = readJson(values.in);
  const { rates, pooled, games, kind, patches, rule, minPicks, decidingPatch, decidingGames, chosen, fallback, picks, trainGames } = loadSource(values.source);
  console.log(`source: ${kind} patches=${patches.join(",")} games=${games}${kind === "ugg" ? " (champion-matches)" : ""} champions=${rates.size} threshold=${POSITIONS_THRESHOLD}`);
  if (kind === "ugg") {
    console.log("WARNING: --source ugg is the unmeasured-at-parity fallback (winrates.json is patch " + patches[0] + ", scraped with a hard-coded PATCH; 0.607 both-sides vs the corpus's 0.785 at the last measurement). Prefer the corpus when it is on this machine.");
    console.log("WARNING: --source ugg has no train games, so `playable` is omitted (a stale one is dropped) and the engines fall back to the listed positions as their legality set");
  }
  if (rule) {
    const byPatch = new Map();
    for (const patch of chosen.values()) byPatch.set(patch, (byPatch.get(patch) ?? 0) + 1);
    const tally = [...byPatch.entries()].sort((a, b) => b[1] - a[1]).map(([patch, n]) => `${patch} x${n}`).join(", ");
    console.log(`rule: ${rule} — shares from the newest patch with >= ${minPicks} train picks per champion; deciding patch ${decidingPatch} (${decidingGames} train games); decided by: ${tally}`);
    const fallbackEntries = Object.entries(fallback);
    console.log(`fallback (${fallbackEntries.length}): ${fallbackEntries.map(([id, by]) => `${id} -> ${by}`).join(", ")}`);
    // The playable floor (champion-role-shares § 4.1): the rate and what it is in picks on the
    // deciding patch; each champion is held to its OWN deciding patch's train games.
    console.log(`playable rule: listed roles + roles with >= ${PLAYABLE_MIN_PICK_RATE * 10000} picks per 10k train games of the champion's deciding patch (${(PLAYABLE_MIN_PICK_RATE * decidingGames).toFixed(1)} picks on ${decidingPatch}), never fewer than ${PLAYABLE_MIN_PICKS}`);
    if (decidingGames < THIN_PATCH_GAMES) {
      console.log(`WARNING: the deciding patch ${decidingPatch} has only ${decidingGames} train games (< ${THIN_PATCH_GAMES}) — the ${PLAYABLE_MIN_PICKS}-pick minimum governs the floor and noise-admitted playable pairs are possible; read the playable diff line before committing`);
    }
  }
  // The floor's inputs exist only for the corpus source (M4): without them playable is omitted.
  const floor = kind === "corpus" ? { picks, trainGames } : undefined;

  const { rows, kept } = refreshPositions(doc.champions, rates, POSITIONS_THRESHOLD, floor);
  assertChampionRows(rows, { label: "refresh", expectedCount: doc.champions.length, requirePositions: false });
  const diff = diffPositions(doc.champions, rows);
  console.log(formatDiff(diff, rates, kept, pooled, rows));
  const empty = rows.filter((row) => row.positions.length === 0).map((row) => row.id);
  if (empty.length > 0) {
    console.log(`WARNING: ${empty.length} champion(s) still have no positions (no source data): ${empty.join(", ")} — the compile will refuse them; hand-enter positions until the next retrain`);
  }

  const feasibility = values["skip-feasibility"] ? undefined : measureFeasibility(rows, values.field);
  const previous = doc.positionsSource;
  if (feasibility) {
    const prev = previous?.feasibility?.bothSides;
    const prevField = previous?.feasibility?.field ?? "unknown";
    const fellBack = feasibility.fallbackRows > 0 ? `; ${feasibility.fallbackRows} of ${rows.length} rows have no playable and were read through their positions` : "";
    console.log(`both-sides feasibility (${feasibility.sets} holdout sets, field ${feasibility.field}${fellBack}): ${feasibility.bothSides.toFixed(3)}${prev === undefined ? " (no previous run recorded)" : ` (previous run ${prev.toFixed(3)} on field ${prevField})`}`);
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

  // What the block records (derive.mjs carryForward): the measured block (with its field and the
  // fallback count), or — under --force, when this run could not measure and the previous one
  // recorded a number — the previous block carried forward WITH its field, marked with the run it
  // came from (a chain of carries still points at the run that measured), across a source-kind
  // change too: a measured corpus run → a forced unmeasured ugg run → a corpus run must not lose the
  // first measurement. The marker's kind says which source measured it.
  const recordedFeasibility = carryForward({ feasibility, previous, force: values.force });
  if (recordedFeasibility?.carriedFrom) console.log(`feasibility carried forward from the ${recordedFeasibility.carriedFrom.generatedAt} ${recordedFeasibility.carriedFrom.kind} run (unmeasured here; field ${recordedFeasibility.field ?? "unknown"})`);

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
      rule, minPicks, decidingPatch, decidingGames, fallback,
      playableRule: floor ? { minPickRate: PLAYABLE_MIN_PICK_RATE, minPicks: PLAYABLE_MIN_PICKS, decidingPatch, decidingGames } : undefined,
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
