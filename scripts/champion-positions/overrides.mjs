// scripts/champion-positions/overrides.mjs
// The compile's per-champion overrides (data/overrides/champion-overrides.json), applied last. Pure,
// so the one rule that is not a plain merge can be tested: `positionShares` is REPLACED whole, never
// merged, and an override that names `positions` for a champion whose row carries `positionShares`
// must name `positionShares` too (engine-role-grade design § 1). A merge would keep stale keys — a
// role the new list no longer holds — and fail the key-set invariant; a positions override alone
// would leave the shares keyed by the OLD list, so the engine would grade the new primary by a share
// that is not its own.

/**
 * Deep merge override fields onto a champion entry. Object values merge one level deep, arrays and
 * scalars replace, `positionShares` replaces whole; keys starting with "_" are skipped.
 * @param {object} champion the compiled entry
 * @param {object | undefined} overrides the champion's block of champion-overrides.json
 * @throws {Error} naming both keys when `positions` is overridden without `positionShares` on a row that has shares
 */
export function applyOverrides(champion, overrides) {
  if (!overrides) return champion;
  if ("positions" in overrides && !("positionShares" in overrides) && champion.positionShares !== undefined) {
    throw new Error(
      `${champion.id}: the override sets positions but not positionShares, and the row carries positionShares — `
      + "an override that changes the positions of a champion with shares must replace positionShares whole "
      + "(the shares are keyed by the listed roles; a stale map would grade the new primary by another role's share)",
    );
  }
  const result = { ...champion };
  for (const [key, value] of Object.entries(overrides)) {
    if (key.startsWith("_")) continue;
    if (key === "positionShares") {
      result[key] = value;
    } else if (typeof value === "object" && !Array.isArray(value) && value !== null) {
      result[key] = { ...result[key], ...value };
    } else {
      result[key] = value;
    }
  }
  return result;
}
