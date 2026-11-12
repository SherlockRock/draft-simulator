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
// (positions here, the five-role positionShares beside them) reads the same shares.
//
// Legality (docs/designs/champion-role-shares-design.md § 4.1, D2/D3): beside
// `positions` the refresh writes `playable` — the roles the ENGINE may seat the
// champion in — as the listed roles plus every role whose picks on the deciding
// patch reach PLAYABLE_MIN_PICK_RATE per train game of that patch (never fewer
// than PLAYABLE_MIN_PICKS). Two floors of the same magnitude, named apart:
// MIN_PICKS says which PATCH decides a CHAMPION's shares; PLAYABLE_MIN_PICK_RATE
// says which CHAMPION-ROLE pairs are legal. And `positionShares` carries all
// five roles (0 is legal), so a weight can read any role's share.
import { META_POSITIONS } from "./invariants.mjs";

/** Design § 3. Pinned against SYNTH_ROLE_THRESHOLD in roles.py and
 * solver_roles_test.rs by scripts/model/test_roles_unit.py. */
export const POSITIONS_THRESHOLD = 0.10;
/** Recency rule: a patch decides a champion's shares only with at least this
 * many train PICKS of that champion on it (the corpus file's `games` are picks;
 * one game is ten). On 16.15/16.16 the rarest champion had 2,657 pooled picks,
 * so this is a floor for a champion released mid-window, not a tuning knob. */
export const MIN_PICKS = 300;
/** Legality floor (champion-role-shares § 4.1, D3): a role is playable when the
 * champion's picks in it on the deciding patch reach this many per train game
 * of that patch — 10 per 10,000 games, 277 picks on 16.19 (277,103 train games).
 * Measured on the 16.19 holdout: 433 pairs, both-sides feasibility 0.976, zero
 * listed roles below it. */
export const PLAYABLE_MIN_PICK_RATE = 10 / 10_000;
/** The absolute minimum under the rate (judge M1): on a deciding patch thinner
 * than ~50,000 games the rate floor admits noise pairs; 50 picks stops that. No
 * effect today (277 > 50). */
export const PLAYABLE_MIN_PICKS = 50;
/** Legality floor on the champion's OWN games (engine slice B, ruled 2026-11-11, S1 2026-11-12): a role
 * the positions do not list is playable only when it holds at least this share of the champion's picks
 * on its deciding patch, read on the 3-dp share the table stores (`storedShare`), so the floor is
 * checkable from the compiled file alone. On the 16.19 table it removes 22 of 433 playable pairs
 * (Lee Sin support 0.9 %, Kai'Sa top 1.9 %, ...) and no listed role; Tristana top (1.964 %, stored 0.020)
 * stays. */
export const PLAYABLE_MIN_OWN_SHARE = 0.02;
/** The refresh warns when the deciding patch has fewer train games than this. */
export const THIN_PATCH_GAMES = 50_000;
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
 *   minPicks: number, chosen: Map<string, string>, fallback: Record<string, string>,
 *   picks: Map<string, number>, trainGames: Map<string, number>}}
 *   `chosen` maps alias -> the patch that decided (or "pooled"); `fallback` lists only the
 *   champions NOT decided by `decidingPatch` (the newest patch), alias -> what decided instead.
 *   `picks` and `trainGames` are the playable floor's inputs (champion-role-shares § 4.1): the
 *   champion's picks on the patch that decided it and that patch's OWN train games — for a
 *   pooled-fallback champion, its pooled picks and the window's games.
 */
export function ratesFromCorpus(doc, { minPicks = MIN_PICKS } = {}) {
  const rates = new Map();
  const pooled = new Map();
  const chosen = new Map();
  const fallback = {};
  const picks = new Map();
  const trainGames = new Map();
  const perPatchPicks = new Map();
  let totalPicks = 0;
  for (const entry of Object.values(doc)) {
    if (!entry.meta_roles) {
      throw new Error(`role_percentages.json entry ${entry.alias} has no meta_roles block — regenerate with prepare.py (the roles block spells the support role UTILITY)`);
    }
    if (!entry.by_patch || Object.keys(entry.by_patch).length === 0) {
      throw new Error(`role_percentages.json entry ${entry.alias} has no by_patch block — regenerate with prepare.py (the recency rule needs per-patch shares)`);
    }
    pooled.set(entry.alias, { ...zeroShares(), ...entry.meta_roles });
    totalPicks += entry.games;
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
  if (totalPicks % 10 !== 0) {
    throw new Error(`role_percentages.json games sum to ${totalPicks}, not a multiple of 10 — one game is ten picks`);
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
      picks.set(entry.alias, entry.by_patch[deciding].games);
      trainGames.set(entry.alias, perPatchPicks.get(deciding) / 10);
      if (deciding !== decidingPatch) fallback[entry.alias] = deciding;
    } else {
      rates.set(entry.alias, pooled.get(entry.alias));
      chosen.set(entry.alias, "pooled");
      picks.set(entry.alias, entry.games);
      trainGames.set(entry.alias, totalPicks / 10);
      fallback[entry.alias] = "pooled";
    }
  }
  return {
    rates, pooled, games: totalPicks / 10, kind: "corpus", patches, decidingPatch,
    decidingGames: perPatchPicks.get(decidingPatch) / 10, minPicks, chosen, fallback, picks, trainGames,
  };
}

/**
 * The playable set (champion-role-shares § 4.1): `positions ∪ { r : picks(r) >= max(minPickRate ×
 * trainGames, minPicks) }`, in vocabulary order. `picks` are the champion's picks on the patch that
 * decided its shares and `trainGames` that patch's train games (`ratesFromCorpus`), so `shares[r] ×
 * picks` is the role's picks there. The union is the construction, not a check: a listed role with
 * 20 picks on a thin patch stays playable (Codex R2).
 * @param {string[]} positions
 * @param {Record<string, number>} shares
 * @param {number} picks
 * @param {number} trainGames
 * @returns {string[]}
 */
export function playableRoles(positions, shares, picks, trainGames, { minPickRate = PLAYABLE_MIN_PICK_RATE, minPicks = PLAYABLE_MIN_PICKS, minOwnShare = PLAYABLE_MIN_OWN_SHARE } = {}) {
  const floor = Math.max(minPickRate * trainGames, minPicks);
  // `share × picks` is the role's pick COUNT (the shares are count / total): rounded, because the float
  // product can sit an ulp under the integer it encodes and miss an integer floor.
  return META_POSITIONS.filter((role) => positions.includes(role)
    || (Math.round((shares[role] ?? 0) * picks) >= floor && storedShare(shares[role]) >= minOwnShare));
}

/** A share as the table stores it (3 dp): what `fiveShares` writes and the own-games floor reads. */
export function storedShare(share) {
  return Number((share ?? 0).toFixed(3));
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
 * @param {number} threshold
 * @param {{picks: Map<string, number>, trainGames: Map<string, number>, minPickRate?: number, minPicks?: number} | undefined} floor
 *   the playable floor's inputs (`ratesFromCorpus`); undefined for a source without train games
 *   (`--source ugg`, design § 4.1 M4) — then `playable` is OMITTED, and a stale one from an earlier
 *   corpus run is dropped so `positions ⊆ playable` cannot break when the positions move.
 * @returns {{rows: object[], kept: string[]}}
 */
export function refreshPositions(rows, rates, threshold = POSITIONS_THRESHOLD, floor = undefined) {
  // Two floors of the same magnitude, named apart (design § 4.1): `ratesFromCorpus`'s result carries
  // `minPicks` = MIN_PICKS, the RECENCY floor; the playable floor's `minPicks` is PLAYABLE_MIN_PICKS.
  // Passing the corpus result itself as the floor would read the wrong one — refuse it.
  if (floor && "chosen" in floor) {
    throw new Error("refreshPositions: the floor is { picks, trainGames[, minPickRate, minPicks] } — not ratesFromCorpus's result, whose minPicks is the recency floor");
  }
  const kept = [];
  const out = rows.map((row) => {
    const shares = rates.get(row.id);
    if (!shares) {
      kept.push(row.id);
      return { ...row, positions: [...row.positions] };
    }
    const positions = derivePositions(shares, threshold);
    const { playable: _stale, ...rest } = row;
    const next = { ...rest, positions, positionShares: fiveShares(shares) };
    if (floor) {
      next.playable = playableRoles(positions, shares, floor.picks.get(row.id), floor.trainGames.get(row.id), floor);
    }
    return next;
  });
  return { rows: out, kept };
}

/**
 * `positionShares` (champion-role-shares § 4.1): ALL FIVE roles' shares, 3 dp, in vocabulary order; 0
 * is legal. Not keyed by the positions' order — there is no ordering invariant on a stored row (an
 * override may reorder `positions`); every consumer divides by `max(shares)`. Written only for a
 * champion the source has; a kept row keeps whatever it had (the legacy listed-key shape included).
 */
function fiveShares(shares) {
  return Object.fromEntries(META_POSITIONS.map((role) => [role, storedShare(shares[role])]));
}

/** The roles the engine may seat the champion in: `playable`, or the positions when the row has none. */
function playableOf(row) {
  return row.playable ?? row.positions;
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
  const playableLost = [];
  const playableGained = [];
  let changedSets = 0;
  before.forEach((old, i) => {
    const next = after[i];
    const from = old.positions[0] ?? null;
    const to = next.positions[0] ?? null;
    if (from !== to) primaryFlips.push({ id: old.id, from, to });
    const oldSet = new Set(old.positions);
    const newSet = new Set(next.positions);
    // playable: a row without the field is its positions (the engine's fallback).
    const oldPlayable = new Set(playableOf(old));
    const newPlayable = new Set(playableOf(next));
    for (const role of META_POSITIONS) {
      if (oldSet.has(role) && !newSet.has(role)) lost.push({ id: old.id, role });
      if (!oldSet.has(role) && newSet.has(role)) gained.push({ id: old.id, role });
      if (oldPlayable.has(role) && !newPlayable.has(role)) playableLost.push({ id: old.id, role });
      if (!oldPlayable.has(role) && newPlayable.has(role)) playableGained.push({ id: old.id, role });
    }
    if (oldSet.size !== newSet.size || [...oldSet].some((role) => !newSet.has(role))) changedSets += 1;
  });
  return {
    primaryFlips, lost, gained, changedSets, meanBefore: meanLength(before), meanAfter: meanLength(after),
    playableGained, playableLost,
  };
}

/** The champions.json root block, key order as documented in the plan.
 * `gamesUnit` and `unmeasuredAtParity` are written only for the ugg source,
 * whose `games` is a sum of per-role match counts (champion-matches) and
 * whose feasibility has never been measured at parity with the corpus. */
export function buildProvenance({ kind, patches, games, threshold, generatedAt, feasibility, gamesUnit, unmeasuredAtParity, rule, minPicks, decidingPatch, decidingGames, fallback, playableRule }) {
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
  // The playable floor (corpus source only, champion-role-shares § 4.1): the
  // rate, the absolute minimum, and the patch whose train games normalise it.
  // The FIELD the feasibility was measured on travels inside `feasibility`.
  if (playableRule !== undefined) block.playableRule = playableRule;
  block.threshold = threshold;
  block.generatedAt = generatedAt;
  if (feasibility !== undefined) block.feasibility = feasibility;
  return block;
}

/** One line for every log surface (compile, validator, backend boot — the
 * backend keeps a verbatim CommonJS copy). Says the feasibility, whether it
 * was carried forward unmeasured, the field it was measured on (positions or
 * playable; absent on a block from before the field), and whether the source
 * is unmeasured at parity. */
export function formatPositionsSource(block) {
  if (!block) return "none recorded (Meraki verbatim)";
  const f = block.feasibility;
  const feasibility = f
    ? `${f.bothSides}${f.carriedFrom ? ` (carried from ${f.carriedFrom.generatedAt})` : ""}${f.field ? ` field=${f.field}` : ""}`
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
  // The field each number was measured on (champion-role-shares § 4.2 hop 5): the
  // drop clause compares like with like — a positions-field 0.738 against a
  // playable-field 0.976 says nothing about a drop. A block from before the
  // field is "unknown" and never arms the clause.
  const prevField = previous.feasibility?.field ?? "unknown";
  const nowField = feasibility?.field ?? "unknown";
  if (typeof prev === "number" && typeof now === "number" && prevField !== nowField) {
    reasons.push(`feasibility drop clause unarmed: previous run measured ${prevField} (${prev}), this run measured ${nowField} (${now})`);
  } else if (typeof prev === "number" && typeof now === "number") {
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
  const violations = reasons.filter((r) => !r.startsWith("feasibility not compared") && !r.startsWith("feasibility drop clause unarmed"));
  if (violations.length > 0 && force) {
    return { armed: true, abort: false, reasons: [...reasons, "gate overridden by --force"] };
  }
  return { armed: true, abort: violations.length > 0, reasons };
}

/**
 * What the provenance records as feasibility (the CLI's carry-forward, champion-role-shares § 4.2 hop 5):
 * the measured block; or — under --force, when this run could not measure and the previous run recorded
 * one — the previous block carried forward WITH its field and marked with the run it came from (an
 * existing marker is preserved, so a chain of carries still points at the run that measured). Across a
 * source-kind change too: a measured corpus run → a forced unmeasured ugg run → a corpus run must not
 * lose the first measurement (the marker says which kind measured it). Unmeasured without --force:
 * nothing — the gate refuses such a run unless forced.
 * @returns {object | undefined}
 */
export function carryForward({ feasibility, previous, force }) {
  if (feasibility) return feasibility;
  if (!force || !previous?.feasibility) return undefined;
  return {
    ...previous.feasibility,
    carriedFrom: previous.feasibility.carriedFrom ?? { generatedAt: previous.generatedAt, kind: previous.kind },
  };
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
 * With `rows` (the refreshed champions), a line counts the champions with and
 * without `positionShares`, and a last line counts the playable (champion, role)
 * pairs with the ones gained and lost (champion-role-shares § 4.1 — the diff
 * line is the only control on playable churn, ≈ 16 pairs per refresh). */
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
    const pairs = rows.reduce((acc, row) => acc + playableOf(row).length, 0);
    const pair = (p) => `${p.id} ${p.role}`;
    const gainedPlayable = diff.playableGained ?? [];
    const lostPlayable = diff.playableLost ?? [];
    lines.push(`playable pairs: ${pairs} (absent playable counts as the positions); gained (${gainedPlayable.length}): ${gainedPlayable.map(pair).join(", ")}; lost (${lostPlayable.length}): ${lostPlayable.map(pair).join(", ")}`);
  }
  return lines.join("\n");
}
