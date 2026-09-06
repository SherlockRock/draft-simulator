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
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
}
