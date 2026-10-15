// scripts/champion-positions/winrate.mjs
// The baked `winRate` (champion-role-shares design D5 / § 6): the share-weighted mean of the
// u.gg win rates over the roles u.gg has data for, renormalised to the share mass it covers, so a
// champion's one number follows how it is actually played rather than the first listed role's
// figure alone (Pantheon: half top, half support). A role without a share — a legacy listed-key
// map, a hand row — counts as share 0. When the covered mass is below 0.5 (judge M7) the mean would
// speak for a minority of the champion's games, so today's rule stands: the first listed position
// with data, else any role with data, else 0.

export const WINRATE_MIN_COVERED_MASS = 0.5;

/** The rule today's compile used, kept as the fallback. */
function legacyWinRate(byRole, positions) {
  for (const pos of positions ?? []) {
    const entry = byRole[pos];
    if (entry) return { winRate: entry.wr, rule: "listed" };
  }
  const fallback = Object.values(byRole)[0];
  return fallback ? { winRate: fallback.wr, rule: "any" } : { winRate: 0, rule: "none" };
}

/**
 * @param {Record<string, {wr: number, n?: number}> | undefined} byRole u.gg's rows for the champion, keyed by meta position
 * @param {string[] | undefined} positions the row's listed positions
 * @param {Record<string, number> | undefined} shares the row's positionShares (five keys, or the legacy listed keys)
 * @returns {{winRate: number, rule: "shares" | "listed" | "any" | "none", coveredMass: number}}
 */
export function shareWeightedWinRate(byRole, positions, shares) {
  if (!byRole || Object.keys(byRole).length === 0) return { winRate: 0, rule: "none", coveredMass: 0 };
  let mass = 0;
  let weighted = 0;
  for (const [role, entry] of Object.entries(byRole)) {
    const share = shares?.[role] ?? 0;
    mass += share;
    weighted += share * entry.wr;
  }
  if (mass >= WINRATE_MIN_COVERED_MASS) return { winRate: weighted / mass, rule: "shares", coveredMass: mass };
  return { ...legacyWinRate(byRole, positions), coveredMass: mass };
}

/**
 * The compile's per-champion report: how many winRates the share rule set, how many fell back and
 * why, and the largest moves against the previous compiled file (when one was there to read).
 * @param {Array<{id: string, winRate: number, rule: string, coveredMass: number, previous?: number}>} rows
 */
export function formatWinRateReport(rows, { largest = 5 } = {}) {
  const byRule = {};
  for (const row of rows) byRule[row.rule] = (byRule[row.rule] ?? 0) + 1;
  const lines = [
    `winRate: share-weighted mean on ${byRule.shares ?? 0} champions; today's rule on ${rows.length - (byRule.shares ?? 0)}` +
      ` (covered mass < ${WINRATE_MIN_COVERED_MASS} or no shares: listed ${byRule.listed ?? 0}, any ${byRule.any ?? 0}, none ${byRule.none ?? 0})`,
  ];
  const moved = rows
    .filter((row) => typeof row.previous === "number" && row.previous !== row.winRate)
    .map((row) => ({ ...row, delta: row.winRate - row.previous }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  if (rows.some((row) => typeof row.previous === "number")) {
    lines.push(`winRate moved on ${moved.length} of ${rows.length} champions against the previous compile`);
    for (const row of moved.slice(0, largest)) {
      lines.push(`  ${row.id}: ${row.previous.toFixed(4)} -> ${row.winRate.toFixed(4)} (${row.delta >= 0 ? "+" : ""}${row.delta.toFixed(4)}, mass ${row.coveredMass.toFixed(3)}, ${row.rule})`);
    }
  }
  return lines;
}
