// scripts/champion-positions/invariants.mjs
// Pre-write checks shared by refresh-champion-positions, update-champions,
// compile-champion-meta and validate-compiled-data (design § 5, § 7 risk 5).

/** The compiled champion-meta vocabulary. `UTILITY` is Riot's name for the
 * same role and is rejected by the engine loader (data_loader.rs parse_role). */
export const META_POSITIONS = Object.freeze(["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "SUPPORT"]);

/**
 * Validate champion rows before a script writes them anywhere.
 * @param {Array<{id: string, name: string, positions: string[]}>} rows
 * @param {{label: string, expectedCount?: number, requirePositions?: boolean}} opts
 * @throws {Error} listing every violation, one per line
 */
export function assertChampionRows(rows, { label, expectedCount, requirePositions = true }) {
  const problems = [];
  if (expectedCount !== undefined && rows.length !== expectedCount) {
    problems.push(`${label}: ${rows.length} champions, expected ${expectedCount}`);
  }
  const seenIds = new Set();
  const seenNames = new Set();
  for (const row of rows) {
    const id = typeof row.id === "string" && row.id ? row.id : "<missing id>";
    if (id === "<missing id>") problems.push(`${label}: a row has no id (name ${row.name})`);
    if (seenIds.has(id)) problems.push(`${label}: duplicate id ${id}`);
    seenIds.add(id);
    if (typeof row.name !== "string" || !row.name) {
      problems.push(`${label}: ${id} has no name`);
    } else {
      if (seenNames.has(row.name)) problems.push(`${label}: duplicate name ${row.name} (ids differ — an id-casing change reads as add+drop)`);
      seenNames.add(row.name);
    }
    if (!Array.isArray(row.positions)) {
      problems.push(`${label}: ${id} positions is not an array`);
      continue;
    }
    if (row.positions.length === 0 && requirePositions) {
      problems.push(`${label}: ${id} has no positions (an empty list is a zero feasibility mask — hand-enter positions until the next retrain)`);
    }
    const seenPositions = new Set();
    for (const position of row.positions) {
      if (!META_POSITIONS.includes(position)) {
        problems.push(`${label}: ${id} position ${position} is not one of ${META_POSITIONS.join("/")}`);
      }
      if (seenPositions.has(position)) problems.push(`${label}: ${id} duplicate position ${position}`);
      seenPositions.add(position);
    }
    problems.push(...positionSharesProblems(row, label));
    problems.push(...playableProblems(row, label));
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
}

function sameSet(a, b) {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/**
 * The `positionShares` invariant (champion-role-shares design § 4.1), one problem per line: when the
 * field is present it is an object keyed by ALL FIVE roles — or, the legacy shape of the 2026-09-05
 * frozen tables, by exactly the listed positions (an absent role's share is 0) — every value a finite
 * number in [0, 1], and the largest share > 0 (a present all-zero row would divide the factor and the
 * grade by zero — Codex r3). NO ordering rule: an override may reorder or substitute `positions`, so
 * neither the compile, the validator nor the loaders assume `positions[0]` holds the maximum — every
 * consumer divides by `max(shares)` (judge I2). Absent is allowed — a hand-entered champion the source
 * lacks. Shared by the refresh, the compile and the validator.
 * @param {{id?: string, positions?: string[], positionShares?: unknown}} row
 * @returns {string[]}
 */
export function positionSharesProblems(row, label) {
  const shares = row.positionShares;
  if (shares === undefined) return [];
  const id = typeof row.id === "string" && row.id ? row.id : "<missing id>";
  if (typeof shares !== "object" || shares === null || Array.isArray(shares)) {
    return [`${label}: ${id} positionShares is not an object keyed by role`];
  }
  const positions = Array.isArray(row.positions) ? row.positions : [];
  const problems = [];
  const keys = Object.keys(shares);
  const outside = keys.filter((role) => !META_POSITIONS.includes(role));
  for (const role of outside) {
    problems.push(`${label}: ${id} positionShares names ${role}, which is not one of ${META_POSITIONS.join("/")}`);
  }
  if (outside.length === 0 && !sameSet(keys, [...META_POSITIONS]) && !sameSet(keys, positions)) {
    problems.push(`${label}: ${id} positionShares keys [${keys.join(",")}] are neither the five roles nor exactly the listed positions [${positions.join(",")}]`);
  }
  let max = -Infinity;
  for (const [role, value] of Object.entries(shares)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      problems.push(`${label}: ${id} positionShares.${role} = ${value} is not a finite number in [0, 1]`);
    } else if (value > max) {
      max = value;
    }
  }
  if (keys.length > 0 && max <= 0) {
    problems.push(`${label}: ${id} positionShares are all zero — the factor and the grade divide by the largest share`);
  }
  return problems;
}

/**
 * The `playable` invariant (champion-role-shares design § 4.1): when present, a non-empty array of
 * vocabulary roles without duplicates that contains every listed position — the engine's legality set
 * (`positions ⊆ playable ⊆ vocabulary`); a narrowing override would prune a listed role (U4). Absent is
 * allowed: the loaders fall back to the positions.
 * @param {{id?: string, positions?: string[], playable?: unknown}} row
 * @returns {string[]}
 */
export function playableProblems(row, label) {
  const playable = row.playable;
  if (playable === undefined) return [];
  const id = typeof row.id === "string" && row.id ? row.id : "<missing id>";
  if (!Array.isArray(playable)) return [`${label}: ${id} playable is not an array`];
  const problems = [];
  if (playable.length === 0) problems.push(`${label}: ${id} playable is empty`);
  const seen = new Set();
  for (const role of playable) {
    if (!META_POSITIONS.includes(role)) problems.push(`${label}: ${id} playable role ${role} is not one of ${META_POSITIONS.join("/")}`);
    if (seen.has(role)) problems.push(`${label}: ${id} duplicate playable role ${role}`);
    seen.add(role);
  }
  const positions = Array.isArray(row.positions) ? row.positions : [];
  for (const role of positions) {
    if (!seen.has(role)) problems.push(`${label}: ${id} playable lacks the listed position ${role}`);
  }
  return problems;
}
