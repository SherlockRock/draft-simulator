// scripts/champion-positions/derive.mjs
// The refresh rule of docs/designs/champion-meta-positions-refresh-design.md
// § 3–§ 5: positions = roles with play-rate share >= POSITIONS_THRESHOLD,
// ordered by share, argmax always kept, no hysteresis; a champion the source
// lacks keeps its list. Pure functions; the CLI is refresh-champion-positions.mjs.
//
// Recency (2026-10-06, revisits design § 2 ii): the shares a champion is scored
// on come from the NEWEST patch it has >= MIN_PICKS train picks on, not from the
// pooled window — pooling 16.15 and 16.16 made Camille SUPPORT 0.71 while 16.16
// alone had her TOP 0.56 (Shen and Xerath flipped the same way). The pooled
// shares are the fallback for a champion below MIN_PICKS on every patch. The
// choice is made ONCE, in ratesFromCorpus, so every consumer of `rates`
// (positions here, slice 8's positionShares later) reads the same shares.
import { META_POSITIONS } from "./invariants.mjs";

/** Design § 3. Pinned against SYNTH_ROLE_THRESHOLD in roles.py and
 * solver_roles_test.rs by scripts/model/test_roles_unit.py. */
export const POSITIONS_THRESHOLD = 0.10;
/** Recency rule: a patch decides a champion's shares only with at least this
 * many train PICKS of that champion on it (the corpus file's `games` are picks;
 * one game is ten). On 16.15/16.16 the rarest champion had 2,657 pooled picks,
 * so this is a floor for a champion released mid-window, not a tuning knob. */
export const MIN_PICKS = 300;
/** The name the provenance block records for the rule above. */
export const RECENCY_RULE = "latest-patch";
/** Design § 5 gate: a recurring run that flips more primaries than this aborts. */
export const MAX_PRIMARY_FLIPS = 10;
/** Design § 5 gate: a recurring run whose both-sides feasibility falls more
 * than this below the previous run's aborts. */
export const MAX_FEASIBILITY_DROP = 0.02;

/**
 * @param {Record<string, number>} shares meta-vocabulary role -> play-rate share
 * @param {number} threshold
 * @returns {string[]} listed positions, primary first
 */
export function derivePositions(shares, threshold = POSITIONS_THRESHOLD) {
  const ranked = META_POSITIONS
    .map((role, order) => ({ role, share: shares[role] ?? 0, order }))
    .sort((a, b) => b.share - a.share || a.order - b.order);
  const listed = ranked.filter((entry) => entry.share >= threshold).map((entry) => entry.role);
  return listed.length > 0 ? listed : [ranked[0].role];
}

function zeroShares() {
  return Object.fromEntries(META_POSITIONS.map((role) => [role, 0]));
}

/** "16.17" -> [16, 17]; throws on anything else. */
export function parsePatch(text) {
  const match = /^(\d+)\.(\d+)$/.exec(String(text));
  if (!match) throw new Error(`patch must be MAJOR.MINOR, got ${JSON.stringify(text)}`);
  return [Number(match[1]), Number(match[2])];
}

/** Release order: numeric on (major, minor), so 16.9 < 16.17 < 17.1 (a string sort gets both wrong). */
export function comparePatches(a, b) {
  const [aMajor, aMinor] = parsePatch(a);
  const [bMajor, bMinor] = parsePatch(b);
  return aMajor - bMajor || aMinor - bMinor;
}

/**
 * role_percentages.json (prepare.py, TRAIN split) -> rates by alias, with the
 * recency rule applied: each champion's shares are the newest patch's in its
 * `by_patch` block with >= minPicks picks; a champion below minPicks on every
 * patch falls back to the pooled `meta_roles`. Returns both maps so the
 * operator report can print the pooled share next to the deciding one.
 *
 * @returns {{rates: Map<string, Record<string, number>>, pooled: Map<string, Record<string, number>>,
 *   games: number, kind: "corpus", patches: string[], decidingPatch: string, decidingGames: number,
 *   minPicks: number, chosen: Map<string, string>, fallback: Record<string, string>}}
 *   `chosen` maps alias -> the patch that decided (or "pooled"); `fallback` lists only the
 *   champions NOT decided by `decidingPatch` (the newest patch), alias -> what decided instead.
 */
export function ratesFromCorpus(doc, { minPicks = MIN_PICKS } = {}) {
  const rates = new Map();
  const pooled = new Map();
  const chosen = new Map();
  const fallback = {};
  const perPatchPicks = new Map();
  let picks = 0;
  for (const entry of Object.values(doc)) {
    if (!entry.meta_roles) {
      throw new Error(`role_percentages.json entry ${entry.alias} has no meta_roles block — regenerate with prepare.py (the roles block spells the support role UTILITY)`);
    }
    if (!entry.by_patch || Object.keys(entry.by_patch).length === 0) {
      throw new Error(`role_percentages.json entry ${entry.alias} has no by_patch block — regenerate with prepare.py (the recency rule needs per-patch shares)`);
    }
    pooled.set(entry.alias, { ...zeroShares(), ...entry.meta_roles });
    picks += entry.games;
    let patchPicks = 0;
    for (const [patch, block] of Object.entries(entry.by_patch)) {
      parsePatch(patch);
      patchPicks += block.games;
      perPatchPicks.set(patch, (perPatchPicks.get(patch) ?? 0) + block.games);
    }
    if (patchPicks !== entry.games) {
      throw new Error(`role_percentages.json entry ${entry.alias}: by_patch picks sum to ${patchPicks} but games is ${entry.games} — the per-patch block must partition the pooled picks`);
    }
  }
  if (picks % 10 !== 0) {
    throw new Error(`role_percentages.json games sum to ${picks}, not a multiple of 10 — one game is ten picks`);
  }
  const patches = [...perPatchPicks.keys()].sort(comparePatches);
  for (const [patch, n] of perPatchPicks) {
    if (n % 10 !== 0) throw new Error(`role_percentages.json by_patch picks on ${patch} sum to ${n}, not a multiple of 10`);
  }
  const decidingPatch = patches[patches.length - 1];
  for (const entry of Object.values(doc)) {
    const newestFirst = Object.keys(entry.by_patch).sort(comparePatches).reverse();
    const deciding = newestFirst.find((patch) => entry.by_patch[patch].games >= minPicks);
    if (deciding) {
      rates.set(entry.alias, { ...zeroShares(), ...entry.by_patch[deciding].meta_roles });
      chosen.set(entry.alias, deciding);
      if (deciding !== decidingPatch) fallback[entry.alias] = deciding;
    } else {
      rates.set(entry.alias, pooled.get(entry.alias));
      chosen.set(entry.alias, "pooled");
      fallback[entry.alias] = "pooled";
    }
  }
  return {
    rates, pooled, games: picks / 10, kind: "corpus", patches, decidingPatch,
    decidingGames: perPatchPicks.get(decidingPatch) / 10, minPicks, chosen, fallback,
  };
}

/** data/compiled/winrates.json (u.gg per-role match counts) -> rates by alias.
 * `games` here is the sum of per-role match counts (champion-matches). */
export function ratesFromUgg(doc) {
  const rates = new Map();
  let total = 0;
  for (const [alias, byRole] of Object.entries(doc.byChampion)) {
    const counts = Object.entries(byRole).map(([role, cell]) => [role, cell.n]);
    const sum = counts.reduce((acc, [, n]) => acc + n, 0);
    if (sum === 0) continue;
    const shares = zeroShares();
    for (const [role, n] of counts) shares[role] = n / sum;
    rates.set(alias, shares);
    total += sum;
  }
  return { rates, games: total, kind: "ugg" };
}

/**
 * @param {Array<{id: string, positions: string[]}>} rows champions.json rows, any extra fields preserved
 * @param {Map<string, Record<string, number>>} rates
 * @returns {{rows: object[], kept: string[]}}
 */
export function refreshPositions(rows, rates, threshold = POSITIONS_THRESHOLD) {
  const kept = [];
  const out = rows.map((row) => {
    const shares = rates.get(row.id);
    if (!shares) {
      kept.push(row.id);
      return { ...row, positions: [...row.positions] };
    }
    const positions = derivePositions(shares, threshold);
    return { ...row, positions, positionShares: listedShares(positions, shares) };
  });
  return { rows: out, kept };
}

/**
 * `positionShares` (engine-role-grade design § 1, G10): the share of each LISTED role, 3 dp, keyed in
 * the positions' order — the primary first, so `positionShares[positions[0]]` is the maximum by
 * construction. Written only for a champion the source has; a kept row keeps whatever it had.
 */
function listedShares(positions, shares) {
  return Object.fromEntries(positions.map((role) => [role, Number((shares[role] ?? 0).toFixed(3))]));
}

function meanLength(rows) {
  return rows.reduce((acc, row) => acc + row.positions.length, 0) / rows.length;
}

/** Champion-level diff, before vs after, same ids in the same order. */
export function diffPositions(before, after) {
  if (before.length !== after.length || before.some((row, i) => row.id !== after[i].id)) {
    throw new Error("diffPositions: inputs are not aligned by id — the refresh never adds, removes or reorders champions");
  }
  const primaryFlips = [];
  const lost = [];
  const gained = [];
  let changedSets = 0;
  before.forEach((old, i) => {
    const next = after[i];
    const from = old.positions[0] ?? null;
    const to = next.positions[0] ?? null;
    if (from !== to) primaryFlips.push({ id: old.id, from, to });
    const oldSet = new Set(old.positions);
    const newSet = new Set(next.positions);
    for (const role of META_POSITIONS) {
      if (oldSet.has(role) && !newSet.has(role)) lost.push({ id: old.id, role });
      if (!oldSet.has(role) && newSet.has(role)) gained.push({ id: old.id, role });
    }
    if (oldSet.size !== newSet.size || [...oldSet].some((role) => !newSet.has(role))) changedSets += 1;
  });
  return { primaryFlips, lost, gained, changedSets, meanBefore: meanLength(before), meanAfter: meanLength(after) };
}

/** The champions.json root block, key order as documented in the plan.
 * `gamesUnit` and `unmeasuredAtParity` are written only for the ugg source,
 * whose `games` is a sum of per-role match counts (champion-matches) and
 * whose feasibility has never been measured at parity with the corpus. */
export function buildProvenance({ kind, patches, games, threshold, generatedAt, feasibility, gamesUnit, unmeasuredAtParity, rule, minPicks, decidingPatch, decidingGames, fallback }) {
  const block = { kind, patches, games };
  if (gamesUnit !== undefined) block.gamesUnit = gamesUnit;
  if (unmeasuredAtParity !== undefined) block.unmeasuredAtParity = unmeasuredAtParity;
  // The recency rule (corpus source only): which patch decided the shares, the
  // pick floor, and every champion something else decided (newest patch too thin).
  if (rule !== undefined) {
    block.rule = rule;
    block.minPicks = minPicks;
    block.decidingPatch = decidingPatch;
    block.decidingGames = decidingGames;
    block.fallback = fallback ?? {};
  }
  block.threshold = threshold;
  block.generatedAt = generatedAt;
  if (feasibility !== undefined) block.feasibility = feasibility;
  return block;
}

/** One line for every log surface (compile, validator, backend boot — the
 * backend keeps a verbatim CommonJS copy). Says the feasibility, whether it
 * was carried forward unmeasured, and whether the source is unmeasured at parity. */
export function formatPositionsSource(block) {
  if (!block) return "none recorded (Meraki verbatim)";
  const f = block.feasibility;
  const feasibility = f
    ? `${f.bothSides}${f.carriedFrom ? ` (carried from ${f.carriedFrom.generatedAt})` : ""}`
    : "unmeasured";
  const fallbackCount = block.fallback ? Object.keys(block.fallback).length : 0;
  const rule = block.rule
    ? ` rule=${block.rule} deciding=${block.decidingPatch}${fallbackCount > 0 ? ` fallback=${fallbackCount}` : ""}`
    : "";
  return `${block.kind} patches=${block.patches.join(",")}${rule} threshold=${block.threshold} generated=${block.generatedAt} feasibility=${feasibility}${block.unmeasuredAtParity ? " [source unmeasured at parity]" : ""}`;
}

/**
 * Design § 5: the abort condition for the recurring case. Not armed when there
 * is no previous provenance block (the first run flips 37 primaries by design).
 */
export function evaluateGate({ previous, primaryFlips, feasibility, force }) {
  if (!previous) return { armed: false, abort: false, reasons: [] };
  const reasons = [];
  if (primaryFlips > MAX_PRIMARY_FLIPS) {
    reasons.push(`${primaryFlips} primary flips > ${MAX_PRIMARY_FLIPS}`);
  }
  const prev = previous.feasibility?.bothSides;
  const now = feasibility?.bothSides;
  if (typeof prev === "number" && typeof now === "number") {
    if (now < prev - MAX_FEASIBILITY_DROP) {
      const carried = previous.feasibility.carriedFrom
        ? ` (previous number carried from ${previous.feasibility.carriedFrom.generatedAt}, never measured for that table)`
        : "";
      reasons.push(`both-sides feasibility ${now.toFixed(3)} is ${(prev - now).toFixed(3)} below the previous ${prev.toFixed(3)} (limit ${MAX_FEASIBILITY_DROP})${carried}`);
    }
  } else if (typeof prev === "number") {
    // The previous run could measure and this one cannot (no corpus here, or
    // --skip-feasibility): writing a block without feasibility would disarm the
    // drop clause for every later run. Refuse unless forced; the CLI then
    // carries the previous number forward so the baseline survives.
    reasons.push(`feasibility unmeasured on this run while the previous run recorded ${prev.toFixed(3)} — refusing to write (use --force to carry the previous number forward)`);
  } else {
    reasons.push("feasibility not compared (the previous run recorded none — the drop clause stays unarmed until a measured run writes one)");
  }
  const violations = reasons.filter((r) => !r.startsWith("feasibility not compared"));
  if (violations.length > 0 && force) {
    return { armed: true, abort: false, reasons: [...reasons, "gate overridden by --force"] };
  }
  return { armed: true, abort: violations.length > 0, reasons };
}

function ratesText(shares) {
  if (!shares) return "";
  const parts = META_POSITIONS.filter((role) => (shares[role] ?? 0) >= 0.05)
    .sort((a, b) => shares[b] - shares[a])
    .map((role) => `${role} ${shares[role].toFixed(2)}`);
  return `(${parts.join(", ")})`;
}

/** The operator report printed by the CLI (design § 5 "prints the diff").
 * With `pooled` (the corpus source), each flip also shows the pooled-window
 * shares next to the deciding patch's, so a recency-driven flip is legible:
 * "Camille SUPPORT -> TOP (TOP 0.56, SUPPORT 0.44) | pooled (SUPPORT 0.71, TOP 0.29)".
 * With `rows` (the refreshed champions), a last line counts the champions with
 * and without `positionShares` (engine-role-grade design § 1). */
export function formatDiff(diff, rates, kept, pooled, rows) {
  const lines = [];
  lines.push(`primary flips (${diff.primaryFlips.length}):`);
  for (const flip of diff.primaryFlips) {
    const pooledText = pooled?.has(flip.id) ? ` | pooled ${ratesText(pooled.get(flip.id))}` : "";
    lines.push(`  ${flip.id.padEnd(14)} ${(flip.from ?? "[]").padEnd(8)} -> ${flip.to.padEnd(8)} ${ratesText(rates.get(flip.id))}${pooledText}`);
  }
  lines.push(`roles lost (${diff.lost.length}): ${diff.lost.map((p) => `${p.id} ${p.role}`).join(", ")}`);
  lines.push(`roles gained (${diff.gained.length}): ${diff.gained.map((p) => `${p.id} ${p.role}`).join(", ")}`);
  lines.push(`kept (no source data) (${kept.length}): ${kept.join(", ")}`);
  lines.push(`champions whose set changed: ${diff.changedSets}; mean positions per champion ${diff.meanBefore.toFixed(2)} -> ${diff.meanAfter.toFixed(2)}`);
  if (rows) {
    const without = rows.filter((row) => row.positionShares === undefined).map((row) => row.id);
    lines.push(`champions with positionShares: ${rows.length - without.length}; without (no source data, kept as they were): ${without.length}${without.length ? ` (${without.join(", ")})` : ""}`);
  }
  return lines.join("\n");
}
