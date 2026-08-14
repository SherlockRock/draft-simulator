/**
 * Strip membership, append/remove only (design D3).
 *
 * There is deliberately no reorder: reordering means removing and re-adding.
 * That answers a DIFFERENT axis from D6a (reordering cells within a grid),
 * which is a real requirement and is served by the grid swap.
 */
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
