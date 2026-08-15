/**
 * Strip membership, append/remove only (design D3).
 *
 * There is deliberately no reorder: reordering means removing and re-adding.
 * That answers a DIFFERENT axis from D6a (reordering cells within a grid),
 * which is a real requirement and is served by the grid swap.
 */
// `championById`, NOT `resolveChampion`. The latter carries a legacy
// numeric-index fallback (`constants.ts:376-385`) so a championId of "12"
// resolves to champions[12] — annotation championIds are canonical per §2 and
// have no legacy, and using the fallback would also make D18's duplicate
// predicate inconsistent with what is stored.
import { championById, type Champion } from "./constants";

export type StripChip = { id: string; resolved: Champion | null };

/**
 * Strip ids paired with their champion record, order preserved.
 *
 * An id that resolves to nothing is KEPT and marked (design D16). Champion
 * images are bundled build-time imports, so an id from a newer champion set
 * resolves to nothing on an older client — and the note still means what its
 * author meant. Dropping the id is silent data loss; rendering nothing shows a
 * gap that reads as a layout bug rather than as missing data.
 */
export const resolveStripChampions = (championIds: readonly string[]): StripChip[] =>
    championIds.map((id) => ({ id, resolved: championById.get(id) ?? null }));

export const addToStrip = (
    championIds: readonly string[],
    championId: string
): string[] =>
    championIds.includes(championId) ? [...championIds] : [...championIds, championId];

export const removeFromStrip = (
    championIds: readonly string[],
    championId: string
): string[] => championIds.filter((id) => id !== championId);

/**
 * The availability predicate `ChampionPickerCore` already takes (design D18).
 *
 * Scoped to ONE strip on purpose: the same champion in different annotations is
 * how it legitimately sits in two tiers of a champion pool.
 */
export const isChampionAvailableForStrip =
    (championIds: readonly string[]) =>
    (championId: string): boolean =>
        !championIds.includes(championId);
