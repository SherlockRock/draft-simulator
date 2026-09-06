// scripts/champion-positions/derive.mjs
// The refresh rule of docs/designs/champion-meta-positions-refresh-design.md
// § 3–§ 5: positions = roles with play-rate share >= POSITIONS_THRESHOLD,
// ordered by share, argmax always kept, no hysteresis; a champion the source
// lacks keeps its list. Pure functions; the CLI is refresh-champion-positions.mjs.
import { META_POSITIONS } from "./invariants.mjs";

/** Design § 3. Pinned against SYNTH_ROLE_THRESHOLD in roles.py and
 * solver_roles_test.rs by scripts/model/test_roles_unit.py. */
export const POSITIONS_THRESHOLD = 0.10;
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

/** role_percentages.json (prepare.py, TRAIN split) -> rates by alias. */
export function ratesFromCorpus(doc) {
  const rates = new Map();
  let picks = 0;
  for (const entry of Object.values(doc)) {
    if (!entry.meta_roles) {
      throw new Error(`role_percentages.json entry ${entry.alias} has no meta_roles block — regenerate with prepare.py (the roles block spells the support role UTILITY)`);
    }
    rates.set(entry.alias, { ...zeroShares(), ...entry.meta_roles });
    picks += entry.games;
  }
  if (picks % 10 !== 0) {
    throw new Error(`role_percentages.json games sum to ${picks}, not a multiple of 10 — one game is ten picks`);
  }
  return { rates, games: picks / 10, kind: "corpus" };
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
    return { ...row, positions: derivePositions(shares, threshold) };
  });
  return { rows: out, kept };
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
export function buildProvenance({ kind, patches, games, threshold, generatedAt, feasibility, gamesUnit, unmeasuredAtParity }) {
  const block = { kind, patches, games };
  if (gamesUnit !== undefined) block.gamesUnit = gamesUnit;
  if (unmeasuredAtParity !== undefined) block.unmeasuredAtParity = unmeasuredAtParity;
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
  return `${block.kind} patches=${block.patches.join(",")} threshold=${block.threshold} generated=${block.generatedAt} feasibility=${feasibility}${block.unmeasuredAtParity ? " [source unmeasured at parity]" : ""}`;
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

/** The operator report printed by the CLI (design § 5 "prints the diff"). */
export function formatDiff(diff, rates, kept) {
  const lines = [];
  lines.push(`primary flips (${diff.primaryFlips.length}):`);
  for (const flip of diff.primaryFlips) {
    lines.push(`  ${flip.id.padEnd(14)} ${(flip.from ?? "[]").padEnd(8)} -> ${flip.to.padEnd(8)} ${ratesText(rates.get(flip.id))}`);
  }
  lines.push(`roles lost (${diff.lost.length}): ${diff.lost.map((p) => `${p.id} ${p.role}`).join(", ")}`);
  lines.push(`roles gained (${diff.gained.length}): ${diff.gained.map((p) => `${p.id} ${p.role}`).join(", ")}`);
  lines.push(`kept (no source data) (${kept.length}): ${kept.join(", ")}`);
  lines.push(`champions whose set changed: ${diff.changedSets}; mean positions per champion ${diff.meanBefore.toFixed(2)} -> ${diff.meanAfter.toFixed(2)}`);
  return lines.join("\n");
}
