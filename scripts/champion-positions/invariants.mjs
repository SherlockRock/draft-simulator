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
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
}

/**
 * The `positionShares` invariant (engine-role-grade design § 1, G10), one problem per line: when the
 * field is present it is an object whose key set equals the positions set, every value a finite number
 * in (0, 1], and the value at `positions[0]` the maximum (ties allowed). Absent is allowed — a
 * hand-entered champion the source lacks. Shared by the refresh, the compile and the validator (the
 * engine grades a champion by `share(role) / share(primary)`, so a reordered primary or a stale key
 * would price a role wrongly without this).
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
  for (const role of Object.keys(shares)) {
    if (!positions.includes(role)) problems.push(`${label}: ${id} positionShares names ${role}, which positions does not list`);
  }
  for (const role of positions) {
    if (!(role in shares)) problems.push(`${label}: ${id} positionShares lacks the listed role ${role}`);
  }
  for (const [role, value] of Object.entries(shares)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
      problems.push(`${label}: ${id} positionShares.${role} = ${value} is not a finite number in (0, 1]`);
    }
  }
  const primary = positions[0];
  if (primary !== undefined && typeof shares[primary] === "number") {
    for (const [role, value] of Object.entries(shares)) {
      if (typeof value === "number" && value > shares[primary]) {
        problems.push(`${label}: ${id} positionShares.${role} = ${value} exceeds the primary ${primary}'s ${shares[primary]} — positions[0] must be the argmax`);
      }
    }
  }
  return problems;
}
