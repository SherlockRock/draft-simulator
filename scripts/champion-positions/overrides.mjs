// scripts/champion-positions/overrides.mjs
// The compile's per-champion overrides (data/overrides/champion-overrides.json), applied last. Pure,
// so the rules that are not a plain merge have a `node --test` (champion-role-shares design § 4.1, U4):
//   - `positionShares` is MEASURED DATA and cannot be overridden (the shares are keyed by role, not by
//     the positions' order, so a `positions` override leaves them alone — no ordering invariant on a
//     stored row);
//   - `playable` overrides WIDEN, never narrow: the result is the union of what the row had (or its
//     positions, when it had none) and the override — a narrowing escape hatch would re-create the
//     hard-mask misclassification the pick-count floor removes, one champion at a time;
//   - a `positions` override is unioned into `playable` too, so `positions ⊆ playable` holds after
//     the overrides (the compile re-checks it through `assertChampionRows`).
import { META_POSITIONS } from "./invariants.mjs";

/** The union of role lists in vocabulary order. */
function unionRoles(...lists) {
  const all = new Set(lists.flat());
  return META_POSITIONS.filter((role) => all.has(role));
}

/**
 * Deep merge override fields onto a champion entry. Object values merge one level deep, arrays and
 * scalars replace, `playable` unions, `positionShares` is refused; keys starting with "_" are skipped.
 * @param {object} champion the compiled entry
 * @param {object | undefined} overrides the champion's block of champion-overrides.json
 * @throws {Error} when the override names `positionShares`
 */
export function applyOverrides(champion, overrides) {
  if (!overrides) return champion;
  if ("positionShares" in overrides) {
    throw new Error(`${champion.id}: positionShares is measured data and cannot be overridden (champion-role-shares design § 4.1)`);
  }
  const result = { ...champion };
  for (const [key, value] of Object.entries(overrides)) {
    if (key.startsWith("_")) continue;
    if (key === "playable") {
      result.playable = unionRoles(champion.playable ?? champion.positions ?? [], value);
    } else if (typeof value === "object" && !Array.isArray(value) && value !== null) {
      result[key] = { ...result[key], ...value };
    } else {
      result[key] = value;
    }
  }
  if ("positions" in overrides && result.playable !== undefined) {
    result.playable = unionRoles(result.playable, result.positions);
  }
  return result;
}
