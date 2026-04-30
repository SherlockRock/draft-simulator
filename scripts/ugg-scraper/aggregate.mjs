// scripts/ugg-scraper/aggregate.mjs
//
// Pure functions that collapse per-champion-per-role matchup data into the
// flat shape consumed by the engine: { [aliasA]: { [aliasB]: diff } }.
// Diff is *normalized* — matchup winrate minus the champion's solo winrate
// in that role. Otherwise weak champions look counter-prone everywhere.

/**
 * Build the flat counters JSON.
 *
 * @param {object} matchupsByChampion  { [championId]: { [role]: [matchupRecord, ...] } }
 *   Each matchupRecord is { championId, wins, matches, winRate } (i.e. already decoded).
 * @param {object} winratesByChampion  { [alias]: { [role]: { wr, n } } }
 * @param {object} idToAlias           { [championId: number]: alias }
 * @param {object} opts
 * @param {number} [opts.minMatches]   threshold below which to drop a matchup (default 30)
 * @returns {object}                   { [aliasA]: { [aliasB]: diff } } — diff is normalized
 */
export function buildCounters(
  matchupsByChampion,
  winratesByChampion,
  idToAlias,
  opts = {},
) {
  const minMatches = opts.minMatches ?? 30;
  const out = {};

  for (const [championId, byRole] of Object.entries(matchupsByChampion)) {
    const alias = idToAlias[championId];
    if (!alias) continue;
    const champWinrates = winratesByChampion[alias];
    if (!champWinrates) continue;

    for (const [role, matchups] of Object.entries(byRole)) {
      const soloWr = champWinrates[role]?.wr;
      if (soloWr === undefined) continue;

      for (const m of matchups) {
        if (!m || m.matches < minMatches) continue;
        const enemyAlias = idToAlias[m.championId];
        if (!enemyAlias) continue;
        const diff = m.winRate - soloWr;
        out[alias] ??= {};
        // Multiple roles may carry a matchup against the same enemy. Average
        // them, weighted by sample size.
        const prev = out[alias][enemyAlias];
        if (prev === undefined) {
          out[alias][enemyAlias] = { diff, n: m.matches };
        } else {
          const totalN = prev.n + m.matches;
          out[alias][enemyAlias] = {
            diff: (prev.diff * prev.n + diff * m.matches) / totalN,
            n: totalN,
          };
        }
      }
    }
  }

  // Strip the sample size — the engine only consumes the diff.
  const flat = {};
  for (const [a, opp] of Object.entries(out)) {
    flat[a] = {};
    for (const [b, { diff }] of Object.entries(opp)) {
      flat[a][b] = Number(diff.toFixed(4));
    }
  }
  return flat;
}
