export interface EnterCandidate {
    id: string;
    name: string;
}

export type EnterAction = { type: "commit"; champion: EnterCandidate } | { type: "skip" };

export interface EnterResolutionInput {
    searchText: string;
    /** Filtered grid items in display order. */
    filteredItems: EnterCandidate[];
    /** Full champion list — exact-name matching ignores the role filter. */
    allChampions: EnterCandidate[];
    /** Arrow keys moved the highlight since the last filter change. */
    armed: boolean;
    highlightedItem: EnterCandidate | null;
    isAvailable: (championId: string) => boolean;
}

// Design D2: Enter commits when the search text resolves to an available
// champion (exact name match wins, else first available filtered result) or
// when the highlight was arrow-armed onto an available tile; otherwise skip.
// The armed highlight outranks the search text because typing disarms — the
// arming is always the more recent gesture.
export const resolveEnterAction = (input: EnterResolutionInput): EnterAction => {
    if (
        input.armed &&
        input.highlightedItem &&
        input.isAvailable(input.highlightedItem.id)
    ) {
        return { type: "commit", champion: input.highlightedItem };
    }

    const normalized = input.searchText.trim().toLowerCase();
    if (normalized === "") return { type: "skip" };

    const exact =
        input.allChampions.find(
            (champion) => champion.name.trim().toLowerCase() === normalized
        ) ?? null;
    if (exact) {
        return input.isAvailable(exact.id)
            ? { type: "commit", champion: exact }
            : { type: "skip" };
    }

    const firstAvailable =
        input.filteredItems.find((champion) => input.isAvailable(champion.id)) ?? null;
    return firstAvailable
        ? { type: "commit", champion: firstAvailable }
        : { type: "skip" };
};
