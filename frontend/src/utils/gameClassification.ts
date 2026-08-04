import type { CanvasDraft, CanvasGroup, GameType } from "./schemas";

/**
 * The whole "what counts as a real game" rule, in one place.
 * See docs/designs/canvas-game-classification-design.md (D4, D6, D8).
 *
 * Kept out of canvasSearch.ts on purpose: the header chip, the settings dialog
 * and the custom-group Team work all need this and none of them should have to
 * import the search module.
 */

export type SearchScope = "all" | "official" | "scrim";

export const SCOPE_VALUES: readonly SearchScope[] = ["all", "official", "scrim"];

/** Effective classification of one draft, with the structural fallback applied. */
export const effectiveGameType = (
    // D4: the card-level override column is designed into this chain but not
    // built — CanvasDraft has no gameType field yet, and reading one would need a
    // cast the project forbids. The parameter is taken now so the counted
    // predicate and the scope filter are card-aware from the start and can never
    // disagree once the column lands.
    _canvasDraft: CanvasDraft | undefined,
    group: CanvasGroup | undefined
): GameType | undefined => {
    if (!group) return undefined;
    const stored = group.metadata.gameType;
    if (stored !== undefined) return stored;
    // D6: an untagged SERIES group counts as a scrim. This is the only place in
    // the codebase that knows that. It covers localStorage canvases (which a DB
    // migration cannot reach), any future path that creates a series group
    // without seeding the field, and the window between deploy and migration.
    // Untagged CUSTOM groups stay undefined — the asymmetry is deliberate.
    return group.type === "series" ? "scrim" : undefined;
};

/** Does this draft contribute to a team's record and pick/ban buckets? */
export const isCountedDraft = (
    canvasDraft: CanvasDraft | undefined,
    group: CanvasGroup | undefined
): boolean => {
    const effective = effectiveGameType(canvasDraft, group);
    return effective === "scrim" || effective === "official";
};

/** Card-free wrapper for the two call sites that only have a group. */
export const isCountedGroup = (group: CanvasGroup | undefined): boolean =>
    isCountedDraft(undefined, group);

/**
 * One line telling the user what the selected classification actually does to
 * THIS group. It lives here, beside the rule it describes, because it is a
 * statement of the model rather than dialog chrome.
 *
 * The untagged case branches on group type on purpose: Untagged and Scratch are
 * both uncounted on a CUSTOM group, but on a SERIES group untagged falls back to
 * scrim and counts (D6). Collapsing the two branches would make the dropdown
 * offer two options that look interchangeable and never say otherwise — which is
 * exactly the confusion this exists to remove. Do not "simplify" it.
 */
export const gameTypeHint = (
    gameType: GameType | null,
    willBeSeries: boolean
): string => {
    switch (gameType) {
        case "official":
            return "Official — counts toward team records and pick/ban tendencies.";
        case "scrim":
            return "Scrim — counts toward team records and pick/ban tendencies.";
        case "scratch":
            return "Scratch — deliberately excluded from team records.";
        default:
            return willBeSeries
                ? "Untagged — a series with no tag still counts as a scrim."
                : "Untagged — not counted. Tag it Scrim or Official to include it.";
    }
};

/**
 * Scope predicate for canvas search. Takes the EFFECTIVE type (never the raw
 * stored field), so "all" accepts untagged series — the population the D6
 * fallback exists to protect.
 */
export const matchesScope = (
    effective: GameType | undefined,
    scope: SearchScope
): boolean => {
    if (effective === undefined || effective === "scratch") return false;
    return scope === "all" || effective === scope;
};
